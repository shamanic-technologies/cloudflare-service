import { decryptPlatformKey, listPlatformKeys } from "../lib/key-client.js";
import type { R2Config } from "../lib/r2-client.js";

/**
 * Configuration surface for the daily Postgres backup job.
 *
 * The database list is NOT hardcoded: every database to back up is registered
 * in key-service as a platform key named `<DB_KEY_PREFIX><name>` whose value is
 * the Postgres connection string. Adding or removing a database is therefore a
 * key-service write, never a code change or a redeploy. It also keeps every
 * credential out of Railway variables (see repo no-gos).
 */

export const DEFAULT_DB_KEY_PREFIX = "pg-backup-dsn-";
export const DEFAULT_R2_PREFIX = "pg-backups";
export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_MIN_KEEP = 7;
export const DEFAULT_MONITOR_SLUG = "pg-backup-daily";
export const DEFAULT_CRON_SCHEDULE = "0 3 * * *";

/*
 * Time limits (BACKUP-HANG-1106). A pg_dump holds an ACCESS SHARE lock on every
 * table of its database for as long as it runs, so a dump that stalls blocks
 * every schema change of that service. On 2026-11-03 one stalled for 3.5 days
 * on lead_service and its next ALTER TABLE took lead-service down for ~40 min.
 *
 * - Stall: no byte out of pg_dump for 5 min ends the dump. pgBackRest ends a
 *   backup whose stream is silent for `io-timeout` (default 60 s); our stream
 *   also crosses the R2 multipart upload, whose own socket timeout (2 min, see
 *   r2-client) must be able to fire and retry first, so the stall limit sits
 *   above two of those.
 * - Per database: 60 min. pgBackRest's `db-timeout` default is 30 min per
 *   query; our slowest database (runs-service, 2.5 GB) takes 8-15 min, so 60 min
 *   is 4x the worst run measured (2026-11-04..06), never hit by a healthy dump.
 * - Whole run: 6 h, the same `maxRuntime` the Sentry monitor declares and half
 *   the 12 h between the 03:00 and 15:00 UTC runs, so two runs never overlap.
 *   A healthy run takes 33-77 min.
 * - Lock wait: pg_dump `--lock-wait-timeout` (PostgreSQL docs) so a dump stuck
 *   behind a migration fails instead of queueing every reader behind it.
 */
export const DEFAULT_STALL_TIMEOUT_SECONDS = 300;
export const DEFAULT_DB_TIMEOUT_MINUTES = 60;
export const DEFAULT_RUN_TIMEOUT_MINUTES = 360;
export const DEFAULT_LOCK_WAIT_TIMEOUT_SECONDS = 120;

export interface BackupSettings {
  dbKeyPrefix: string;
  r2Prefix: string;
  retentionDays: number;
  minKeep: number;
  monitorSlug: string;
  cronSchedule: string;
  stallTimeoutSeconds: number;
  dbTimeoutMinutes: number;
  runTimeoutMinutes: number;
  lockWaitTimeoutSeconds: number;
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return parsed;
}

/** A time limit of 0 would mean "no limit", which is exactly the bug: refuse it. */
function readPositiveInt(name: string, fallback: number): number {
  const value = readInt(name, fallback);
  if (value === 0) throw new Error(`${name} must be greater than 0`);
  return value;
}

export function loadSettings(): BackupSettings {
  return {
    dbKeyPrefix: process.env.BACKUP_DB_KEY_PREFIX || DEFAULT_DB_KEY_PREFIX,
    r2Prefix: process.env.BACKUP_R2_PREFIX || DEFAULT_R2_PREFIX,
    retentionDays: readInt("BACKUP_RETENTION_DAYS", DEFAULT_RETENTION_DAYS),
    minKeep: readInt("BACKUP_MIN_KEEP", DEFAULT_MIN_KEEP),
    monitorSlug: process.env.BACKUP_MONITOR_SLUG || DEFAULT_MONITOR_SLUG,
    cronSchedule: process.env.BACKUP_CRON_SCHEDULE || DEFAULT_CRON_SCHEDULE,
    stallTimeoutSeconds: readPositiveInt("BACKUP_STALL_TIMEOUT_SECONDS", DEFAULT_STALL_TIMEOUT_SECONDS),
    dbTimeoutMinutes: readPositiveInt("BACKUP_DB_TIMEOUT_MINUTES", DEFAULT_DB_TIMEOUT_MINUTES),
    runTimeoutMinutes: readPositiveInt("BACKUP_RUN_TIMEOUT_MINUTES", DEFAULT_RUN_TIMEOUT_MINUTES),
    lockWaitTimeoutSeconds: readPositiveInt(
      "BACKUP_LOCK_WAIT_TIMEOUT_SECONDS",
      DEFAULT_LOCK_WAIT_TIMEOUT_SECONDS
    ),
  };
}

/**
 * Turn the platform-key provider list into the set of databases to back up.
 * Exported separately from the network call so it is directly unit-testable.
 */
export function selectDatabaseProviders(providers: string[], prefix: string): string[] {
  return providers
    .filter((p) => p.startsWith(prefix) && p.length > prefix.length)
    .sort((a, b) => a.localeCompare(b));
}

/** A database name must be usable as an R2 key segment. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function databaseNameFromProvider(provider: string, prefix: string): string {
  const name = provider.slice(prefix.length);
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `Platform key "${provider}" yields an unusable database name "${name}" (expected ${NAME_PATTERN})`
    );
  }
  return name;
}

export interface BackupTarget {
  /** Short name, used as the R2 folder for this database's dumps. */
  name: string;
  /** key-service platform-key provider the DSN came from. */
  provider: string;
  dsn: string;
}

const CALLER = {
  callerMethod: "CRON",
  callerPath: "/jobs/pg-backup",
};

/**
 * Discover every database to back up. Fails loud: an unreachable key-service or
 * an undecryptable DSN aborts the whole run — backing up an unknown subset of
 * the fleet while reporting success is exactly the failure this job exists to
 * prevent.
 */
export async function discoverTargets(settings: BackupSettings): Promise<BackupTarget[]> {
  const providers = selectDatabaseProviders(await listPlatformKeys(), settings.dbKeyPrefix);

  if (providers.length === 0) {
    throw new Error(
      `No platform keys matching "${settings.dbKeyPrefix}*" in key-service — nothing to back up`
    );
  }

  const targets: BackupTarget[] = [];
  for (const provider of providers) {
    const name = databaseNameFromProvider(provider, settings.dbKeyPrefix);
    const { key } = await decryptPlatformKey(provider, CALLER);
    if (!key.startsWith("postgres://") && !key.startsWith("postgresql://")) {
      throw new Error(`Platform key "${provider}" is not a Postgres connection string`);
    }
    targets.push({ name, provider, dsn: key });
  }
  return targets;
}

/** R2 credentials come from the same platform keys the HTTP service uses. */
export async function loadR2Config(): Promise<R2Config> {
  const [accessKeyId, secretAccessKey, accountId, bucketName, publicDomain] = await Promise.all([
    decryptPlatformKey("cloudflare-r2-access-key-id", CALLER),
    decryptPlatformKey("cloudflare-r2-secret-access-key", CALLER),
    decryptPlatformKey("cloudflare-r2-account-id", CALLER),
    decryptPlatformKey("cloudflare-r2-bucket-name", CALLER),
    decryptPlatformKey("cloudflare-r2-public-domain", CALLER),
  ]);

  return {
    accessKeyId: accessKeyId.key,
    secretAccessKey: secretAccessKey.key,
    accountId: accountId.key,
    bucketName: bucketName.key,
    publicDomain: publicDomain.key,
  };
}
