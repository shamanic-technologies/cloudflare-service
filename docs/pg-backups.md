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
| `BACKUP_CRON_SCHEDULE` | `0 3,15 * * *` | schedule declared to Sentry; must match the box cron |
| `BACKUP_STALL_MINUTES` | `10` | a dump with no byte from pg_dump for this long is ENDED |
| `BACKUP_DB_BUDGET_MINUTES` | `60` | one database's dump is ended past this |
| `BACKUP_RUN_BUDGET_MINUTES` | `240` | databases not started by then are reported failed, the run ends |

No database credential and no R2 credential is ever a Railway variable.

## A backup never holds a database for days (BACKUP-HANG-1106)

`pg_dump` runs in ONE transaction and holds a read lock on every table it dumps
until it ends. On 2026-11-03 the R2 upload of lead_service stopped reading:
pg_dump's COPY waited on its client for 3.5 days, and on 2026-11-06 a schema
change queued behind those locks and took lead-service down for ~40 min.

Limits, sized on the measured runs of 2026-11-01..06 (slowest database 19 min,
slowest run 78 min, one run every 12 h):

| Limit | Value | Practice it follows |
|---|---|---|
| no byte from pg_dump | 10 min | I/O-inactivity timeout (rsync `--timeout`, curl `--speed-time`): a dead consumer, never a slow one |
| one database | 60 min | ~3x the slowest observed dump; a job deadline like Kubernetes `activeDeadlineSeconds` |
| whole run | 4 h | well inside the 12 h between runs, so two runs never overlap |
| R2 socket idle | 5 min, connect 30 s | the AWS SDK default is NO timeout; `requestTimeout` is an inactivity limit, retried by the SDK |
| lock wait at start | `--lock-wait-timeout=2min` | pg_dump's own guard against queueing behind an exclusive lock |

An ended dump: pg_dump and pg_restore get SIGTERM, SIGKILL 30 s later, the
multipart upload is aborted, the database is reported failed with the reason,
and the next database starts. Killing pg_dump closes its connection, so the
server ends the COPY and releases the locks. The box's `backup-cron.sh` adds an
outer `timeout` and a `flock` so a run can never pile up behind another.

## Alerting

**The alert is RED on dashboard v2 Monitoring > Box > Watchdogs, check
`pg-backup`** (no email). The process prints one `PG_BACKUP_SUMMARY {json}` line
per run; `backup-cron.sh` stores it and `pg-backup-watchdog.sh` (every 30 min)
reports it: red when the last run failed a database, ended without a summary,
runs past its budget, or no complete backup exists from the last 13 h. The
plotted value is the hours since the last run where every database dumped.

Sentry is a secondary trace only. Why it never surfaced the 3.5-day hang: the
monitor was declared for ONE run a day while the box runs two, and it had been
`error` on every run since 2026-11-01 (3 databases failing on permissions), so
one more red check-in on a page nobody reads changed nothing.

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
