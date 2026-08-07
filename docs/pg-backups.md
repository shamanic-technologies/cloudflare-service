# Daily Postgres backups to R2

Neon PITR is 24 hours and lives inside the vendor. This job puts a restorable
copy of every fleet database on Cloudflare R2 every day, so that corruption
noticed two days later is still recoverable, and so that losing access to the
Neon account is not the same thing as losing the data.

It runs as a **second Railway service on this repo** (`pg-backup-cron`), built
from `Dockerfile.backup` and started with `node dist/backup/index.js`. The
always-on HTTP service is untouched; the two only share library code.

## What one run does

For every configured database, sequentially:

1. `pg_dump --format=custom` streams straight into an R2 multipart upload. The
   dump is never written to disk and never buffered whole — memory stays around
   32 MB regardless of database size (runs-service is ~19 GB).
2. The same byte stream feeds a SHA256 hasher and `pg_restore --list`. The
   listing is the integrity proof: it parses the archive header and table of
   contents, so it fails on a truncated or corrupt archive.
3. The dump of a database that had tables yesterday and has none today is
   **rejected**. A small archive is not automatically wrong (an empty database
   really does dump to ~885 bytes) — an archive that lost every table is.
4. Backups past the retention window are pruned, never below `BACKUP_MIN_KEEP`.

A database that fails does not stop the others. Every failure is logged, sent to
Sentry, written into the run summary, and makes the process exit non-zero.

## Objects written

```
pg-backups/<database>/<stamp>.dump           # pg_dump custom-format archive
pg-backups/<database>/<stamp>.toc.txt        # pg_restore --list output
pg-backups/<database>/<stamp>.manifest.json  # bytes, sha256, TOC summary, timings
pg-backups/_runs/<stamp>.json                # per-run summary
pg-backups/_runs/latest.json                 # same, always the most recent run
```

`<stamp>` is `2026-08-07T030000Z`, so lexical order is chronological order.

## Adding or removing a database — no code change, no redeploy

The database list is **not in the code and not in Railway variables**. Each
database is a key-service platform key named `pg-backup-dsn-<name>` whose value
is the connection string:

```bash
curl -X POST "$KEY_SERVICE_URL/platform-keys" \
  -H "X-Api-Key: $KEY_SERVICE_API_KEY" -H 'Content-Type: application/json' \
  -d '{"provider":"pg-backup-dsn-runs-service","key":"postgresql://…"}'
```

The job lists platform keys at startup, takes every provider matching
`pg-backup-dsn-*`, and backs up exactly those. Deleting the platform key removes
the database from the next run. The consolidation from ~29 Neon projects to 1-2
is therefore a key-service change only.

### Register the DIRECT Neon endpoint, not the pooler

Strip `-pooler` from the host before registering a Neon DSN. The pooled endpoint
is PgBouncer in transaction mode and cannot hold the session-level snapshot
`pg_dump` needs, so a pooled DSN either fails or produces an inconsistent dump.

## Operating the Railway service

`pg-backup-cron` lives in the Distribute.you project, deploys from `main`, and is
configured with `dockerfilePath = Dockerfile.backup`, `cronSchedule = 0 3 * * *`,
`restartPolicyType = NEVER`.

Two Railway details that cost time if you do not know them:

- **A cron run does NOT create a new deployment.** Railway re-runs the container
  of the existing deployment on schedule, so polling the deployments list for a
  new row waits forever. Read `deploymentLogs` on the current deployment id, or
  read `_runs/latest.json` from R2.
- **There is no `DOCKERFILE` value in Railway's `Builder` enum.** Setting
  `dockerfilePath` on the service instance is what selects the Dockerfile;
  leave `builder` alone. Sending `builder: "DOCKERFILE"` fails the whole
  mutation with an opaque `Problem processing request`.

To force a run for testing, set `cronSchedule` to something imminent, wait for
the container to start, then **put the daily schedule back** — a `*/5` schedule
left in place starts a second run on top of the one still dumping.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `KEY_SERVICE_URL` / `KEY_SERVICE_API_KEY` | — | how every credential is resolved |
| `SENTRY_DSN` | — | **required**; the job refuses to start without it |
| `BACKUP_DB_KEY_PREFIX` | `pg-backup-dsn-` | platform-key prefix that defines the database list |
| `BACKUP_R2_PREFIX` | `pg-backups` | R2 key prefix |
| `BACKUP_RETENTION_DAYS` | `30` | age past which a backup is pruned |
| `BACKUP_MIN_KEEP` | `7` | newest backups never pruned, whatever their age |
| `BACKUP_MONITOR_SLUG` | `pg-backup-daily` | Sentry cron monitor slug |
| `BACKUP_CRON_SCHEDULE` | `0 3 * * *` | schedule declared to Sentry; must match the Railway cron |

No database credential and no R2 credential is ever a Railway variable.

## Alerting

The job opens a Sentry cron monitor check-in before it starts and closes it with
`ok` or `error`. That covers both failure modes:

- a run that **fails** → `error` check-in plus one `captureException` per
  database, and a non-zero exit that Railway records as a failed cron;
- a run that **never happened** → Sentry raises a missed check-in against
  `BACKUP_CRON_SCHEDULE`.

`pg-backups/_runs/latest.json` is the equivalent signal readable straight from
R2: if its `startedAt` is not from today, no backup ran.

## Verifying a backup without restoring it

`<stamp>.manifest.json` carries `bytes`, `sha256` and a TOC summary
(`entryCount`, `tableCount`, per-type counts). `<stamp>.toc.txt` is the full
`pg_restore --list` output — a readable archive with the expected tables in it.
Re-hashing the downloaded `.dump` and comparing to `sha256` proves transfer
integrity.

## Restoring

R2 has no egress fee, so a restore costs nothing.

```bash
aws s3 cp --endpoint-url "https://$ACCOUNT_ID.r2.cloudflarestorage.com" \
  "s3://$BUCKET/pg-backups/runs-service/2026-08-07T030000Z.dump" ./restore.dump

pg_restore --list ./restore.dump | head            # what is in it
pg_restore --no-owner --no-privileges \
  --dbname "postgresql://…/scratch" ./restore.dump  # a THROWAWAY database
```

Never restore into a fleet database. Create a scratch Neon project (or a local
`postgres:17` container), restore there, and compare.
