# Deployment Context — TeCS (OPCC CRM)

> Saved: 2026-07-27 | Updated: 2026-08-13

## URLs — Testing vs Production

### 🧪 Testing (our dev work)

| Component | URL | Status |
|-----------|-----|--------|
| **Testing Frontend** | `https://opcc-crm-testing.pages.dev` | ✅ |
| **Testing Preview** | `https://a8435430.opcc-crm-testing.pages.dev` | ✅ Latest (2026-08-13) |
| **API Worker** (shared) | `https://opcc-crm-api.ruhan-farhan.workers.dev` | ✅ v aa93d928 |

> ⚠️ **Testing and Production share the same API Worker and D1 database.** Be careful with data changes.

### 🚀 Production (client-facing — DO NOT TOUCH)

| Component | URL |
|-----------|-----|
| **Custom Domain** | `https://sme.techforliving.net` |
| **Pages Production** | `https://opcc-crm.pages.dev` |
| **API Worker** | `https://opcc-crm-api.ruhan-farhan.workers.dev` |

### How to Deploy

```bash
# ── Testing (safe, our workspace) ──

# API Worker (shared with production — be careful):
cd api && CLOUDFLARE_ACCOUNT_ID=8c00cc4647a9cf5d8deb5d6a354001e0 npx wrangler deploy

# Frontend to Testing:
cd frontend && npm run build
CLOUDFLARE_ACCOUNT_ID=8c00cc4647a9cf5d8deb5d6a354001e0 npx wrangler pages deploy dist --project-name=opcc-crm-testing --branch=main --commit-dirty=true

# ── Production (client-facing — only when approved) ──

# Frontend to Production:
cd frontend && npm run build
CLOUDFLARE_ACCOUNT_ID=8c00cc4647a9cf5d8deb5d6a354001e0 npx wrangler pages deploy dist --project-name=opcc-crm --branch=production --commit-dirty=true
```

### Important: Production URL

The production frontend URL is **NOT** `main.opcc-crm.pages.dev`. The correct URLs are:
- **Production**: `https://opcc-crm.pages.dev`
- **Custom Domain**: `https://sme.techforliving.net`
- **Each deploy gets a unique preview URL**: `https://<random>.opcc-crm.pages.dev` (e.g. `de75dd51`)

The `main.opcc-crm.pages.dev` is just a branch alias, not the canonical production URL.

### Login
Currently logged in as `samuelleewinghong@hotmail.com` (member of Ruhan's account `8c00cc46...`).

### Two Cloudflare Pages Projects

| Project | URL | Purpose |
|---------|-----|---------|
| **opcc-crm-testing** | `opcc-crm-testing.pages.dev` | 🧪 Dev/testing — deploy here daily |
| **opcc-crm** | `opcc-crm.pages.dev` + `sme.techforliving.net` | 🚀 Production — deploy only when approved |

Both share the same Cloudflare account (`8c00cc4647a9cf5d8deb5d6a354001e0`), API Worker, and D1 database.

### Resolved
- ✅ **Ammar confirmed** — `samuelleewinghong@hotmail.com` is a member of `8c00cc4647a9cf5d8deb5d6a354001e0`
- ✅ Login works: `npx wrangler login` → `samuelleewinghong@hotmail.com`
- ✅ Deploy works directly on Ammar's account

---

## Test Deployment (Historical — `tryprograming@gmail.com`)

⚠️ **This was on a SEPARATE Cloudflare account** with its own D1 database. The `opcc-crm-8fy` Pages project no longer exists. The supervisor demo account (`muhammadruhan.farhan25@nixorcollege.edu.pk`) does NOT exist here — only the seed admin works. **Use the production URLs above, not this one.**

| Resource | URL / Value |
|----------|-------------|
| Frontend (Pages) | `https://d4c912c5.opcc-crm-8fy.pages.dev` (⚠️ stale/project deleted) |
| API (Worker) | `https://opcc-crm-api.tryprograming.workers.dev` |
| D1 Database | `opcc-crm-db` (ID: `10b873cc-74a2-4c8c-8f80-d659e6728b3c`) |
| R2 Bucket | `opcc-crm-files` |
| Admin Login | `admin@example.com` / `Admin123!` |

### Files Modified for This Deployment

- `api/wrangler.toml` — Created from `.example` with new account IDs
- `frontend/src/lib/api.ts` — Updated `WORKER_API_BASE` to new worker URL
- `frontend/functions/api/[[path]].ts` — Updated proxy target
- `frontend/public/_redirects` — Updated API worker URL

### Schema Issues Fixed

- `schema.sql` is the base; `user-roles-migration.sql` adds `status`, `must_change_password`, `parent_user_id`, `permission_tier` columns
- `migrate-once.sql` and `migrate-compliance.sql` failed (duplicate columns — already in schema.sql)
- `coa-hk.sql` failed (FK constraint — depends on seed data ordering)

---

## LLM Model Keys (from code analysis)

| Key | Provider | Endpoint | Used For |
|-----|----------|----------|----------|
| `DEEPSEEK_API_KEY` | DeepSeek | `api.deepseek.com/chat/completions` | Chat, OCR parsing, invoice extraction |
| `GLM_API_KEY` | Z.AI (GLM) | `api.z.ai/api/paas/v4/layout_parsing` | Document OCR (bank statements, PDFs) |
| `QWEN_API_KEY` | Alibaba DashScope | `dashscope-intl.aliyuncs.com` | Optional LLM fallback |

Keys are stored as **Cloudflare Worker Secrets** — cannot be read back via CLI. Must get values from Ammar/Ruhan.

---

## Deployment Commands Reference

### API Worker
```bash
cd api
npm install
npx wrangler deploy
```

### Frontend (Pages)
```bash
cd frontend
npm install
npm run build
npx wrangler pages deploy dist --project-name=opcc-crm --branch=production --commit-dirty=true
```

### D1 Database
```bash
cd api
npx wrangler d1 execute opcc-crm-db --remote --file=src/db/schema.sql
npx wrangler d1 execute opcc-crm-db --remote --file=user-roles-migration.sql
npx wrangler d1 execute opcc-crm-db --remote --file=src/db/seed.sql
```

### Secrets
```bash
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put GLM_API_KEY
npx wrangler secret put JWT_SECRET
```

---

## Key URLs from Original Setup

| Item | URL |
|------|-----|
| Production | `https://sme.techforliving.net` |
| Old API Worker | `https://opcc-crm-api.ruhan-farhan.workers.dev` |
| Old API Worker (alt) | `https://oppc-crm-api.ai-caseylai.workers.dev` ⚠️ **DO NOT USE** — `oppc` is a typo. Canonical worker is `opcc-crm-api.ruhan-farhan.workers.dev`. |
| Old Pages | `https://opcc-crm.pages.dev` |
| GitHub Repo | `https://github.com/techconnsme/development_code` |
| LLM Gateway | `https://llm.techforliving.net` |

## Original Accounts (from Handover Guide)

| Admin | `memonruhan731@gmail.com` / `Hamdan123` |
| Supervisor (Demo) | `muhammadruhan.farhan25@nixorcollege.edu.pk` / `password` |
| Joseph Lin (PnR) | `joseph.lin@pnr.hk` / `TCS9M6Q721!` |

## Recent Changes (2026-08-13)

### Cancel Upload Rollback
- Canceling the OCR type-mismatch dialog now calls `DELETE /file-storage/{id}` — soft-deletes the file row + linked bank statement/transactions, hard-deletes invoice drafts. Lower-tier 403s fall back to a warning toast.

### Relative Upload Time in File Storage
- File rows show a localized relative age ("2 minutes ago" / "2 分鐘前" / "2分钟前") via `Intl.RelativeTimeFormat` (locale map: en / zh-HK / zh-CN), full timestamp in the hover tooltip; ≥7 days shows the local date.
- Helper: `frontend/src/lib/time.ts` — `relativeTimeBucket(createdAt, now?)`, `parseCreatedAt(createdAt)` (parses DB UTC "YYYY-MM-DD HH:MM:SS").

### Invoice Channel Split (File Upload)
- `Bank-TXN Invoice` split into **Sales Invoice** (`sales_invoice`, forces `outgoing`) and **Purchase Invoice** (`purchase_invoice`, forces `incoming`); **Cash Invoice** renamed to **Cash Payment** (label only, key `cash_invoice` unchanged).
- Direction-based mismatch: OCR direction contradicting the chosen tab opens the mismatch dialog with the detected name ("Purchase Invoice"/"Sales Invoice") — Switch / Force / Cancel (Cancel rolls back).
- API: `POST /file-storage/:id/import-document` accepts optional `direction=outgoing|incoming`; a user-declared direction no longer raises `needs_direction_review` or the persisted `needs_review` 'direction' flag.

### Regression Suite
- Run the regression folder with: `npx playwright test --config playwright.regression.config.ts regression-tests/` (the main config's `testDir: './tests'` excludes it).
- Suite green: 10 tests passing incl. `regression-invoice-direction.spec.ts` (TC-DIR-01 mismatch+cancel rollback, TC-DIR-02 force direction + no review flag).
- Known one-liner follow-up: `regression-tests/run-regression-api.ts` SAMPLES path is one level too shallow (`tests/run-regression-api.ts` has the correct `../../../test-sample-real/PNR`).

## Recent Changes (2026-07-28)

### Card Statements Feature
- New `card_statements` + `card_transactions` tables in D1
- Full CRUD API at `/api/card-statements`
- OCR detection: `cardScore` auto-detects credit card statements
- DeepSeek AI parses card statements → draft with transactions
- `CardStatements.tsx`: list page with ContinuityChain, PendingReviewBanner, Eye/Pencil/Trash icons
- `CardStatementReview.tsx`: split-screen PDF review with editable transactions
- Import via File Upload → `import-document` → redirect to review

### Balance Check Audit
- `balance_status` + `balance_check` columns on `bank_statements` & `card_statements`
- Values: `ok` | `mismatch` | `corrected`
- ⚠/✏ badges on statement cards in both Bank & Card pages
- `is_edited` column on `bank_transactions` & `card_transactions`
- ✏ indicator on edited transaction rows

### Shared ContinuityChain Component
- `frontend/src/components/ContinuityChain.tsx` — shared by Bank & Card pages
- Groups by account/card number, color-coded gaps/overlaps/duplicates/balance mismatches
- `staleTime: 0` — always fetches fresh from API
- Drafts excluded from continuity queries

### Bug Fixes
- FileUpload: proper OCR pipeline (upload → import-document → navigate)
- Double `JSON.stringify` fixed in 6 pages
- File Storage upload zone removed (upload stays on File Upload page)
- Standalone supervisor client creation & viewing
- PendingReviewBanner: Shek's monochrome styling merged
