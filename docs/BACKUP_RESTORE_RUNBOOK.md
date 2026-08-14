# Backup & Restore Runbook — TeCS (OPCC CRM)

> Last updated: 2026-08-14 · All commands run from `api/` with
> `CLOUDFLARE_ACCOUNT_ID=8c00cc4647a9cf5d8deb5d6a354001e0`

## What is backed up

| Data | Mechanism | Retention |
|------|-----------|-----------|
| **D1 database** (`opcc-crm-db`) | Cloudflare **Time Travel** (built-in PITR) | 30 days (Workers Paid), 7 days (Free) |
| **R2 files** (`opcc-crm-files`) | Backup worker `opcc-crm-r2-backup` copies every uploaded/overwritten object into `opcc-crm-files-backup` under a versioned key | Forever (until manually pruned) |

Nothing to enable — both are always on. Deletes in the source bucket never touch the backup bucket.

## 1. Roll back the DATABASE (D1 Time Travel)

Get the current bookmark:
```bash
npx wrangler d1 time-travel info opcc-crm-db
```

Get the bookmark for a past moment (Unix ts or ISO-8601):
```bash
npx wrangler d1 time-travel info opcc-crm-db --timestamp="2026-08-14T08:44:00+08:00"
```

Restore (DESTRUCTIVE — overwrites the live DB in place, cancels in-flight queries):
```bash
npx wrangler d1 time-travel restore opcc-crm-db --timestamp="2026-08-14T08:44:00+08:00"
```

Undo a restore: the restore command prints the previous bookmark — restore back to it.

Limits: 10 restores / 10 min. Restore is in-place; there is no clone/fork.

## 2. Restore FILES (R2 backup bucket)

List backup copies (guarded endpoint on the backup worker):
```bash
curl "https://opcc-crm-r2-backup.ruhan-farhan.workers.dev/list?key=tecs-backup-2026&prefix=<optional>"
```

Backup keys look like: `<eventTime-ISO>/<original-key>` e.g.
`2026-08-14T08-44-12-148Z/u-83161e0c/fs-xxxxx-Invoice.pdf`

Restore a single file (download the backup copy, put it back to its original key):
```bash
npx wrangler r2 object get "opcc-crm-files-backup/<versioned-key>" --local /tmp/restored-file.pdf
npx wrangler r2 object put "opcc-crm-files/<original-key>" --file /tmp/restored-file.pdf
```

## 3. Restoring BOTH together (the common case)

The DB and files must be rolled back as a pair, or you get orphans:

1. Restore the D1 database to time T (section 1).
2. Restore any files deleted or overwritten after T (section 2 — look for versioned keys whose original keys no longer exist, or simply restore from backups near T).

## Infrastructure (for reference)

- Backup worker: `backup-worker/` in the repo — queue consumer + guarded `/list` endpoint
- Queue: `opcc-crm-r2-backup` (1 producer = R2 notification, 1 consumer = worker)
- Buckets: source `opcc-crm-files`, backup `opcc-crm-files-backup`
- Notification: `object-create` events only — deletes never propagate, so backups accumulate intentionally
- Deploy changes: `cd api && CLOUDFLARE_ACCOUNT_ID=8c00cc4647a9cf5d8deb5d6a354001e0 npx -y wrangler@4 deploy --config ../backup-worker/wrangler.toml`
