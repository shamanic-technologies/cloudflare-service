# cloudflare-service

R2 file storage for the fleet (public files, images) plus the daily Postgres
backup job (`src/backup`, see `docs/pg-backups.md`).

## Rule: private data never goes to the public bucket

- `cloudflare-r2-bucket-name` is the PUBLIC bucket: its r2.dev domain serves
  every object to anyone by URL. Only files meant to be public go there
  (uploads, images).
- Anything private (database dumps, manifests, run summaries, any export) goes
  to the PRIVATE bucket named by platform key `cloudflare-r2-private-bucket-name`
  (`distribute-private`, no public domain). The backup job reads its bucket
  ONLY through `loadBackupR2Config()` (`src/backup/config.ts`).
- A missing private-bucket key fails loud. Never a fallback to the public bucket.
- Why: until 2026-11-27 every nightly dump sat in the public bucket,
  world-readable (SECRETS-ROTATE-1127). `tests/unit/backup-config.test.ts`
  pins that the backup path never asks for the public key.
