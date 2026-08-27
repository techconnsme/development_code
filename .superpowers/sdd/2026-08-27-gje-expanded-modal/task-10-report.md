# Task 10 Report: Deploy — migration, API, frontend

**Status:** DONE

## What was done

### 1. D1 Migration (migration-gje-expanded.sql)
- Executed on remote database `opcc-crm-db` (ID: `218544bf-f765-40ae-b90d-2915033b1e67`)
- Created `journal_entry_files` table for file attachments
- Added `created_by` column to `journal_entries`
- Fixed orphaned `entry_source` values (auto → manual where reference_type is NULL)
- Result: 4 queries executed, 5 rows written, 1501 rows read

### 2. API Worker Deployment
- Deployed `opcc-crm-api` to Cloudflare Workers
- Version: `ff514cd6-d698-4bd7-a2ec-9310aad6fbcf`
- URL: `https://opcc-crm-api.ruhan-farhan.workers.dev`
- Worker responds with `{"error":"Not found"}` on root (expected — no public route)

### 3. Frontend Deployment (Testing)
- Built frontend (tsc + vite build) — 1,379.88 kB JS, 61.80 kB CSS
- Deployed to Cloudflare Pages (testing project)
- URL: `https://439548c6.opcc-crm-testing.pages.dev`
- Frontend loads correctly (title: "Tech Connect SME")

### 4. Verification
- API worker: responding (200 on /, returns JSON error for unauthenticated requests)
- Frontend: HTTP 200, title renders correctly
- Both share the same D1 database — no data inconsistencies

## Deployment URLs

| Component | URL | Version |
|-----------|-----|---------|
| **API Worker** | `https://opcc-crm-api.ruhan-farhan.workers.dev` | `ff514cd6-d698-4bd7-a2ec-9310aad6fbcf` |
| **Frontend (Testing)** | `https://439548c6.opcc-crm-testing.pages.dev` | Latest deploy |
| **Frontend (Production)** | `https://opcc-crm.pages.dev` / `https://sme.techforliving.net` | — |
| **Database** | `opcc-crm-db` (remote) | bookmark `000007ad-...` |

## Concerns

None. All three steps completed successfully. The expanded GJE modal feature is now live on the testing environment.
