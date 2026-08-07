import { PassThrough } from "stream";
import { spawn as nodeSpawn } from "child_process";
import { discoverTargets, loadR2Config, loadSettings } from "./config.js";
import type { BackupSettings, BackupTarget } from "./config.js";
import { dumpDatabaseToR2 } from "./dump.js";
import type { DumpManifest, SpawnFn } from "./dump.js";
import { pruneDatabaseBackups } from "./retention.js";
import type { PruneResult } from "./retention.js";
import { getFromR2, listR2Objects, uploadStreamToR2 } from "../lib/r2-client.js";
import type { R2Config } from "../lib/r2-client.js";

/** R2-safe timestamp: 2026-08-07T031500Z (sortable, no colons). */
export function backupStamp(now: Date): string {
  return now.toISOString().replace(/:/g, "").replace(/\.\d+Z$/, "Z");
}

export interface DatabaseOutcome {
  database: string;
  status: "ok" | "failed";
  manifest?: DumpManifest;
  prune?: PruneResult;
  error?: string;
}

export interface RunSummary {
  stamp: string;
  startedAt: string;
  finishedAt: string;
  pgDumpVersion: string;
  retentionDays: number;
  minKeep: number;
  databases: DatabaseOutcome[];
  okCount: number;
  failedCount: number;
}

/**
 * Read the major version of the installed pg_dump. Neon runs PostgreSQL 17 and
 * pg_dump refuses to dump a server newer than itself, so a client older than 17
 * would fail every single database. Checking once up front turns that into one
 * clear error instead of N confusing ones.
 */
export async function readPgDumpMajorVersion(spawn: SpawnFn = nodeSpawn): Promise<{
  major: number;
  raw: string;
}> {
  const child = spawn("pg_dump", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout?.setEncoding("utf-8");
  child.stdout?.on("data", (chunk: string) => {
    out += chunk;
  });

  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (c) => resolve(c ?? -1));
  });

  if (code !== 0) throw new Error(`pg_dump --version exited ${code}`);

  const match = out.match(/(\d+)(?:\.\d+)*/);
  if (!match) throw new Error(`Could not parse pg_dump version from "${out.trim()}"`);
  return { major: Number(match[1]), raw: out.trim() };
}

export const MINIMUM_PG_DUMP_MAJOR = 17;

async function putJson(r2Config: R2Config, key: string, value: unknown): Promise<void> {
  const body = new PassThrough();
  body.end(Buffer.from(JSON.stringify(value, null, 2), "utf-8"));
  await uploadStreamToR2(r2Config, key, body, "application/json");
}

/**
 * The previous manifest for a database, or null on the first ever run. Used to
 * catch the silent disaster: a dump that suddenly contains no tables for a
 * database that had tables yesterday. A small dump is not automatically wrong
 * (an empty database legitimately produces an ~885-byte archive) — a dump that
 * LOST every table is.
 */
export async function readPreviousManifest(
  r2Config: R2Config,
  params: { prefix: string; database: string; excludeKey: string }
): Promise<DumpManifest | null> {
  const objects = await listR2Objects(r2Config, `${params.prefix}/${params.database}/`);
  const manifests = objects
    .filter((object) => object.key.endsWith(".manifest.json") && object.key !== params.excludeKey)
    .sort((a, b) => b.key.localeCompare(a.key));

  if (manifests.length === 0) return null;

  const object = await getFromR2(r2Config, manifests[0].key);
  if (!object) return null;
  return JSON.parse(object.body.toString("utf-8")) as DumpManifest;
}

export function assertNoTableRegression(
  database: string,
  current: DumpManifest,
  previous: DumpManifest | null
): void {
  if (!previous) return;
  if (previous.toc.tableCount > 0 && current.toc.tableCount === 0) {
    throw new Error(
      `Dump of "${database}" contains 0 tables but the previous backup (${previous.startedAt}) ` +
        `contained ${previous.toc.tableCount} — refusing to treat this as a good backup`
    );
  }
}

export interface RunDeps {
  settings?: BackupSettings;
  now?: () => Date;
  spawnFn?: SpawnFn;
  r2Config?: R2Config;
  targets?: BackupTarget[];
}

/**
 * Back up every configured database. One database failing never stops the
 * others; every failure is recorded, reported, and makes the whole run fail at
 * the end (a swallowed backup error is worse than no backup).
 */
export async function runBackupJob(deps: RunDeps = {}): Promise<RunSummary> {
  const settings = deps.settings ?? loadSettings();
  const now = deps.now ?? (() => new Date());
  const spawnFn = deps.spawnFn;
  const startedAt = now();
  const stamp = backupStamp(startedAt);

  const version = await readPgDumpMajorVersion(spawnFn ?? nodeSpawn);
  if (version.major < MINIMUM_PG_DUMP_MAJOR) {
    throw new Error(
      `pg_dump ${version.raw} is too old — PostgreSQL ${MINIMUM_PG_DUMP_MAJOR}+ client required ` +
        `to dump the fleet's PostgreSQL ${MINIMUM_PG_DUMP_MAJOR} servers`
    );
  }

  const r2Config = deps.r2Config ?? (await loadR2Config());
  const targets = deps.targets ?? (await discoverTargets(settings));

  console.log(
    `[pg-backup] ${stamp} — ${targets.length} database(s), ${version.raw}, ` +
      `retention ${settings.retentionDays}d (min ${settings.minKeep})`
  );

  const outcomes: DatabaseOutcome[] = [];

  for (const target of targets) {
    const base = `${settings.r2Prefix}/${target.name}/${stamp}`;
    const manifestKey = `${base}.manifest.json`;

    try {
      console.log(`[pg-backup] ${target.name}: dumping`);
      const manifest = await dumpDatabaseToR2(
        {
          database: target.name,
          dsn: target.dsn,
          r2Config,
          r2Key: `${base}.dump`,
          tocKey: `${base}.toc.txt`,
        },
        { spawnFn, now }
      );

      const previous = await readPreviousManifest(r2Config, {
        prefix: settings.r2Prefix,
        database: target.name,
        excludeKey: manifestKey,
      });
      assertNoTableRegression(target.name, manifest, previous);

      await putJson(r2Config, manifestKey, manifest);

      const prune = await pruneDatabaseBackups(r2Config, {
        database: target.name,
        prefix: settings.r2Prefix,
        now: startedAt,
        retentionDays: settings.retentionDays,
        minKeep: settings.minKeep,
      });

      console.log(
        `[pg-backup] ${target.name}: ok — ${manifest.bytes} bytes, ` +
          `${manifest.toc.tableCount} tables, ${manifest.toc.entryCount} TOC entries, ` +
          `sha256=${manifest.sha256}, pruned ${prune.deletedGroups.length} old backup(s)`
      );
      outcomes.push({ database: target.name, status: "ok", manifest, prune });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[pg-backup] ${target.name}: FAILED — ${message}`);
      outcomes.push({ database: target.name, status: "failed", error: message });
    }
  }

  const summary: RunSummary = {
    stamp,
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
    pgDumpVersion: version.raw,
    retentionDays: settings.retentionDays,
    minKeep: settings.minKeep,
    databases: outcomes,
    okCount: outcomes.filter((o) => o.status === "ok").length,
    failedCount: outcomes.filter((o) => o.status === "failed").length,
  };

  // The summary is written even when databases failed — it is the durable trace
  // of what ran, and `latest.json` is what a staleness check reads.
  await putJson(r2Config, `${settings.r2Prefix}/_runs/${stamp}.json`, summary);
  await putJson(r2Config, `${settings.r2Prefix}/_runs/latest.json`, summary);

  return summary;
}
