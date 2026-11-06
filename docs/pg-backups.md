# Daily Postgres backups to R2

Neon PITR is 24 hours and lives inside the vendor. This job puts a restorable
copy of every fleet database on Cloudflare R2 every day, so that corruption
noticed two days later is still recoverable, and so that losing access to the
Neon account is not the same thing as losing the data.

It runs on the Hetzner box as a one-shot container (`pg-backup`, same image as
this service, started with `npm run start:backup`), launched by the host cron
`/root/distribute/backup-cron.sh` at **03:00 and 15:00 UTC**. The always-on HTTP
service is untouched; the two only share library code.

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

## Time limits: a dump never holds a database for days

`pg_dump` holds an ACCESS SHARE lock on every table of its database for its
whole life, so a dump that stalls blocks every schema change of that service.
On 2026-11-03 one stalled for 3.5 days on lead_service (the upload stopped
reading, pg_dump sat blocked writing); the next `ALTER TABLE` timed out and
lead-service answered 503 for ~40 min (BACKUP-HANG-1106). Now:

| Limit | Default | Source |
|---|---|---|
| Stall: no byte out of pg_dump | 5 min (`BACKUP_STALL_TIMEOUT_SECONDS`) | pgBackRest `io-timeout` (60 s) ends a silent stream; ours sits above two R2 socket timeouts so the SDK retry fires first |
| One database | 60 min (`BACKUP_DB_TIMEOUT_MINUTES`) | pgBackRest `db-timeout` 30 min; our slowest dump (runs-service, 2.5 GB) takes 8-15 min |
| Whole run | 6 h (`BACKUP_RUN_TIMEOUT_MINUTES`) | Sentry `maxRuntime`; half the 12 h between runs, so runs never overlap |
| Lock wait | 120 s (`BACKUP_LOCK_WAIT_TIMEOUT_SECONDS`) | pg_dump `--lock-wait-timeout` |
| R2 socket silent | 2 min | AWS SDK v3 has NO default socket timeout |

A tripped limit kills pg_dump (its connection closes, its locks go), aborts the
upload, records the database as FAILED, and the run moves to the next one. A
database reached after the run's budget is spent is FAILED too, never skipped.
The process itself exits 10 min after the run budget whatever hangs.

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

The database list is **not in the code and not in env variables**. Each
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
| `BACKUP_CRON_SCHEDULE` | `0 3 * * *` | schedule declared to Sentry |
| `BACKUP_*_TIMEOUT_*` | see Time limits | |

No database credential and no R2 credential is ever an env variable.

## Alerting: red on dashboard v2 Monitoring

The run prints one `[pg-backup] RESULT {json}` line. `backup-cron.sh` posts it
as the box check `pg-backup` (features-service `/internal/box-checks/runs`),
drawn on **Monitoring > Box > Watchdogs**: red when any database got no backup
(the failed ones and their errors are in the details), and red on its own when
no run reported for 3x the 12 h cadence. No email.

The Sentry cron check-in stays as a second trace. It did not surface the
2026-11-03 hang: the monitor had been `error` on every run since 2026-10-30 (3
databases failing every time) and nobody reads Sentry.

`pg-backups/_runs/latest.json` is the same verdict readable straight from R2.

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
