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

/**
 * How long a dump may go without pg_dump producing a single byte, and how long
 * it may run at all (BACKUP-HANG-1106). Both END the dump: pg_dump and
 * pg_restore are killed (TERM, then KILL after `killGraceMs`), the R2 upload is
 * aborted, and the dump fails with the reason. Killing pg_dump closes its
 * connection, so the server ends the COPY and releases every lock the dump's
 * transaction held.
 *
 * A dump stops producing bytes when ANY consumer stops reading (R2 socket,
 * pg_restore): `pipe()` pauses pg_dump's stdout, which is exactly what held
 * lead_service for 3.5 days.
 */
export const DEFAULT_STALL_MS = 10 * 60_000;
export const DEFAULT_KILL_GRACE_MS = 30_000;

/** Postgres-native guard: pg_dump never queues forever behind an exclusive lock. */
export const PG_DUMP_LOCK_WAIT_TIMEOUT = "2min";

export class DumpAbortedError extends Error {
  constructor(
    readonly database: string,
    readonly kind: "stalled" | "over_budget",
    message: string
  ) {
    super(message);
    this.name = "DumpAbortedError";
  }
}

function exitCodeOf(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === null) {
        reject(new Error(`${child.spawnfile} terminated by signal ${signal}`));
        return;
      }
      resolve(code);
    });
  });
}

export interface DumpOptions {
  spawnFn?: SpawnFn;
  partSizeBytes?: number;
  queueSize?: number;
  /** Injected for tests; production uses the real clock. */
  now?: () => Date;
  /** End the dump when pg_dump produced no byte for this long. */
  stallMs?: number;
  /** End the dump once it has run this long: the database's time budget. */
  budgetMs?: number;
  /** Between SIGTERM and SIGKILL when a dump is ended. */
  killGraceMs?: number;
  /** How often the stall/budget guard looks (tests shorten it). */
  checkEveryMs?: number;
}

export async function dumpDatabaseToR2(
  params: {
    database: string;
    dsn: string;
    r2Config: R2Config;
    r2Key: string;
    tocKey: string;
  },
  options: DumpOptions = {}
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
      `--lock-wait-timeout=${PG_DUMP_LOCK_WAIT_TIMEOUT}`,
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
  let lastByteAt = Date.now();
  dump.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    lastByteAt = Date.now();
    hash.update(chunk);
  });

  const uploadBody = new PassThrough();
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

  const uploadAbort = new AbortController();
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

  // The guard: a dump that stops moving, or runs past its budget, is ENDED.
  const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  let aborted: DumpAbortedError | null = null;
  const end = (error: DumpAbortedError) => {
    if (aborted) return;
    aborted = error;
    console.error(`[pg-backup] ${params.database}: ENDING DUMP — ${error.message}`);
    for (const child of [dump, list]) child.kill("SIGTERM");
    setTimeout(() => {
      for (const child of [dump, list]) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    }, killGraceMs).unref();
    uploadAbort.abort(error);
    uploadBody.destroy(error);
  };
  const guard = setInterval(() => {
    const nowMs = Date.now();
    if (options.budgetMs !== undefined && nowMs - startMs >= options.budgetMs) {
      end(
        new DumpAbortedError(
          params.database,
          "over_budget",
          `dump of "${params.database}" passed its time budget after ` +
            `${Math.round((nowMs - startMs) / 1000)}s (${bytes} bytes written)`
        )
      );
    } else if (nowMs - lastByteAt >= stallMs) {
      end(
        new DumpAbortedError(
          params.database,
          "stalled",
          `dump of "${params.database}" stalled: no byte from pg_dump for ` +
            `${Math.round((nowMs - lastByteAt) / 1000)}s (${bytes} bytes written)`
        )
      );
    }
  }, options.checkEveryMs ?? Math.min(30_000, Math.max(10, Math.floor(stallMs / 4))));
  guard.unref();

  const settled = await Promise.allSettled([
    exitCodeOf(dump),
    exitCodeOf(list),
    uploadPromise,
  ]).finally(() => clearInterval(guard));

  if (aborted) throw aborted;

  const [dumpSettled, listSettled, uploadSettled] = settled;
  if (dumpSettled.status === "rejected") throw dumpSettled.reason;
  if (listSettled.status === "rejected") throw listSettled.reason;
  const dumpCode = dumpSettled.value;
  const listCode = listSettled.value;
  const uploadResult =
    uploadSettled.status === "fulfilled"
      ? { ok: true as const, url: uploadSettled.value }
      : { ok: false as const, err: uploadSettled.reason as unknown };

  if (dumpCode !== 0) {
    throw new Error(
      `pg_dump failed for "${params.database}" (exit ${dumpCode}): ${dumpStderr.read().trim()}`
    );
  }
  if (!uploadResult.ok) {
    throw new Error(
      `R2 upload failed for "${params.database}": ${
        uploadResult.err instanceof Error ? uploadResult.err.message : String(uploadResult.err)
      }`
    );
  }
  if (listCode !== 0) {
    throw new Error(
      `pg_restore --list rejected the dump of "${params.database}" (exit ${listCode}): ${listStderr
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
