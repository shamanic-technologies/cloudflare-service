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

export interface BackupSettings {
  dbKeyPrefix: string;
  r2Prefix: string;
  retentionDays: number;
  minKeep: number;
  monitorSlug: string;
  cronSchedule: string;
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

export function loadSettings(): BackupSettings {
  return {
    dbKeyPrefix: process.env.BACKUP_DB_KEY_PREFIX || DEFAULT_DB_KEY_PREFIX,
    r2Prefix: process.env.BACKUP_R2_PREFIX || DEFAULT_R2_PREFIX,
    retentionDays: readInt("BACKUP_RETENTION_DAYS", DEFAULT_RETENTION_DAYS),
    minKeep: readInt("BACKUP_MIN_KEEP", DEFAULT_MIN_KEEP),
    monitorSlug: process.env.BACKUP_MONITOR_SLUG || DEFAULT_MONITOR_SLUG,
    cronSchedule: process.env.BACKUP_CRON_SCHEDULE || DEFAULT_CRON_SCHEDULE,
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
