import { spawn as nodeSpawn } from "child_process";
import type { ChildProcess } from "child_process";
import { createHash } from "crypto";
import { PassThrough } from "stream";
import { uploadStreamToR2 } from "../lib/r2-client.js";
import type { R2Config } from "../lib/r2-client.js";

/**
 * One database dump: pg_dump's stdout is streamed straight into an R2
 * multipart upload while the same bytes are simultaneously fed to a SHA256
 * hasher and to `pg_restore --list`. Nothing is ever buffered whole, so an
 * 18 GB dump costs ~32 MB of container memory.
 *
 * `pg_restore --list` is the integrity proof: it parses the archive header and
 * table of contents, so it fails on a truncated or corrupt dump. Its output is
 * stored next to the dump as a `.toc.txt` sidecar, which makes "is this backup
 * readable, and what is in it?" answerable without restoring anything.
 */

export type SpawnFn = typeof nodeSpawn;

export interface TocSummary {
  entryCount: number;
  /** Count per archive entry type, e.g. { TABLE: 12, "TABLE DATA": 12, INDEX: 30 }. */
  entryTypes: Record<string, number>;
  tableCount: number;
}

export interface DumpManifest {
  database: string;
  r2Key: string;
  tocKey: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  bytes: number;
  sha256: string;
  toc: TocSummary;
}

// `<dumpId>; <tableOid> <oid> <TYPE> <schema> <name> <owner>` — the entry type
// is the run of ALL-CAPS tokens ("TABLE", "TABLE DATA", "FK CONSTRAINT",
// "MATERIALIZED VIEW"), which the lowercase schema name terminates.
const TOC_ENTRY = /^\s*\d+;\s+\d+\s+\d+\s+([A-Z][A-Z0-9]*(?:\s+[A-Z0-9]+)*)(?:\s|$)/;

/**
 * Parse `pg_restore --list` output. Entry lines look like:
 *   215; 1259 16385 TABLE public files postgres
 *   3412; 0 16385 TABLE DATA public files postgres
 * Comment lines start with ';'.
 */
export function parseTocListing(listing: string): TocSummary {
  const entryTypes: Record<string, number> = {};
  let entryCount = 0;

  for (const line of listing.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith(";")) continue;
    const match = TOC_ENTRY.exec(line);
    if (!match) continue;
    entryCount += 1;
    const type = match[1].trim();
    entryTypes[type] = (entryTypes[type] ?? 0) + 1;
  }

  return { entryCount, entryTypes, tableCount: entryTypes["TABLE"] ?? 0 };
}

function collect(stream: NodeJS.ReadableStream, limitBytes = 64 * 1024): { read: () => string } {
  let buffer = "";
  stream.setEncoding("utf-8");
  stream.on("data", (chunk: string) => {
    if (buffer.length < limitBytes) buffer += chunk;
  });
  return { read: () => buffer };
}

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function exitOf(child: ChildProcess): Promise<ChildExit> {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
}

function describeExit(exit: ChildExit): string {
  return exit.code === null ? `signal ${exit.signal}` : `exit ${exit.code}`;
}

/**
 * A dump that never finishes is worse than one that fails: pg_dump holds an
 * ACCESS SHARE lock on every table of the database for its whole life, so the
 * service's next ALTER TABLE queues behind it (BACKUP-HANG-1106, 2026-11-03:
 * 3.5 days on lead_service, then a 40-min lead-service outage). Every dump is
 * therefore ended — pg_dump killed, which closes its connection and releases
 * the locks — when either limit trips.
 */
export class DumpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DumpTimeoutError";
  }
}

export interface DumpOptions {
  spawnFn?: SpawnFn;
  partSizeBytes?: number;
  queueSize?: number;
  /** Injected for tests; production uses the real clock. */
  now?: () => Date;
  /** No byte out of pg_dump for this long ends the dump (a stall). */
  stallTimeoutMs: number;
  /** Total wall-clock budget for this one dump. */
  deadlineMs: number;
  /** Passed to pg_dump --lock-wait-timeout. */
  lockWaitTimeoutMs: number;
  /** Aborted by the caller (the whole run's budget ran out). */
  signal?: AbortSignal;
}

export async function dumpDatabaseToR2(
  params: {
    database: string;
    dsn: string;
    r2Config: R2Config;
    r2Key: string;
    tocKey: string;
  },
  options: DumpOptions
): Promise<DumpManifest> {
  const spawn = options.spawnFn ?? nodeSpawn;
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const startMs = Date.now();

  const dump = spawn(
    "pg_dump",
    [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      `--lock-wait-timeout=${options.lockWaitTimeoutMs}`,
      "--dbname",
      params.dsn,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  const list = spawn("pg_restore", ["--list"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const dumpStderr = collect(dump.stderr);
  const listStderr = collect(list.stderr);
  const listStdout = collect(list.stdout, 8 * 1024 * 1024);

  const hash = createHash("sha256");
  let bytes = 0;
  let lastByteMs = Date.now();
  dump.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    lastByteMs = Date.now();
    hash.update(chunk);
  });

  const uploadBody = new PassThrough();
  const uploadAbort = new AbortController();

  // First limit to trip wins; the dump and its listing are killed (closing the
  // database connection), the upload is aborted (no partial object left in R2).
  let timeoutError: DumpTimeoutError | null = null;
  const end = (message: string) => {
    if (timeoutError) return;
    timeoutError = new DumpTimeoutError(message);
    dump.kill("SIGKILL");
    list.kill("SIGKILL");
    uploadAbort.abort(timeoutError);
    // No error object here: the reason is reported once, by the throw below.
    uploadBody.destroy();
  };

  const tickMs = Math.max(
    10,
    Math.min(5_000, Math.floor(Math.min(options.stallTimeoutMs, options.deadlineMs) / 5))
  );
  const watchdog = setInterval(() => {
    const nowMs = Date.now();
    if (nowMs - lastByteMs >= options.stallTimeoutMs) {
      end(
        `pg_dump of "${params.database}" stalled: no byte for ${Math.round(
          (nowMs - lastByteMs) / 1000
        )}s after ${bytes} bytes (stall limit ${Math.round(options.stallTimeoutMs / 1000)}s); ` +
          `dump ended, its table locks released`
      );
    } else if (nowMs - startMs >= options.deadlineMs) {
      end(
        `pg_dump of "${params.database}" exceeded its ${Math.round(
          options.deadlineMs / 1000
        )}s budget after ${bytes} bytes; dump ended, its table locks released`
      );
    }
  }, tickMs);

  const onRunAbort = () =>
    end(`pg_dump of "${params.database}" ended: the run's time budget ran out`);
  if (options.signal?.aborted) onRunAbort();
  options.signal?.addEventListener("abort", onRunAbort, { once: true });
  dump.stdout.pipe(uploadBody);

  // The listing branch is best-effort on the PLUMBING but not on the RESULT:
  // pg_restore --list only needs the header + table of contents, so it may close
  // its stdin long before pg_dump is finished. Detaching the tee on that event
  // keeps the upload (the critical path) alive instead of killing pg_dump with
  // EPIPE. A non-zero pg_restore exit is still a hard failure below.
  const listInput = new PassThrough();
  let listDetached = false;
  const detachList = () => {
    if (listDetached) return;
    listDetached = true;
    dump.stdout.unpipe(listInput);
    listInput.destroy();
  };
  listInput.on("error", detachList);
  list.stdin.on("error", detachList);
  list.on("close", detachList);
  listInput.pipe(list.stdin);
  dump.stdout.pipe(listInput);

  const uploadPromise = uploadStreamToR2(
    params.r2Config,
    params.r2Key,
    uploadBody,
    "application/octet-stream",
    {
      partSizeBytes: options.partSizeBytes,
      queueSize: options.queueSize,
      signal: uploadAbort.signal,
    }
  );

  let dumpExit: ChildExit;
  let listExit: ChildExit;
  let uploadResult: { ok: true; url: string } | { ok: false; err: unknown };
  try {
    [dumpExit, listExit, uploadResult] = await Promise.all([
      exitOf(dump),
      exitOf(list),
      uploadPromise.then(
        (url) => ({ ok: true as const, url }),
        (err: unknown) => ({ ok: false as const, err })
      ),
    ]);
  } finally {
    clearInterval(watchdog);
    options.signal?.removeEventListener("abort", onRunAbort);
  }

  if (timeoutError) {
    const stderr = dumpStderr.read().trim();
    throw new DumpTimeoutError(
      stderr ? `${(timeoutError as Error).message} — pg_dump stderr: ${stderr}` : (timeoutError as Error).message
    );
  }

  if (dumpExit.code !== 0) {
    throw new Error(
      `pg_dump failed for "${params.database}" (${describeExit(dumpExit)}): ${dumpStderr
        .read()
        .trim()}`
    );
  }
  if (!uploadResult.ok) {
    throw new Error(
      `R2 upload failed for "${params.database}": ${
        uploadResult.err instanceof Error ? uploadResult.err.message : String(uploadResult.err)
      }`
    );
  }
  if (listExit.code !== 0) {
    throw new Error(
      `pg_restore --list rejected the dump of "${params.database}" (${describeExit(
        listExit
      )}): ${listStderr
        .read()
        .trim()}`
    );
  }

  const toc = parseTocListing(listStdout.read());
  const finishedAt = now();

  const manifest: DumpManifest = {
    database: params.database,
    r2Key: params.r2Key,
    tocKey: params.tocKey,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Date.now() - startMs,
    bytes,
    sha256: hash.digest("hex"),
    toc,
  };

  const tocBody = new PassThrough();
  tocBody.end(Buffer.from(listStdout.read(), "utf-8"));
  await uploadStreamToR2(params.r2Config, params.tocKey, tocBody, "text/plain; charset=utf-8");

  return manifest;
}
