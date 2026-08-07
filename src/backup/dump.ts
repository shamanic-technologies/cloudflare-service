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
    ["--format=custom", "--no-owner", "--no-privileges", "--dbname", params.dsn],
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
  dump.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
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

  const uploadPromise = uploadStreamToR2(
    params.r2Config,
    params.r2Key,
    uploadBody,
    "application/octet-stream",
    { partSizeBytes: options.partSizeBytes, queueSize: options.queueSize }
  );

  const [dumpCode, listCode, uploadResult] = await Promise.all([
    exitCodeOf(dump),
    exitCodeOf(list),
    uploadPromise.then(
      (url) => ({ ok: true as const, url }),
      (err: unknown) => ({ ok: false as const, err })
    ),
  ]);

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
