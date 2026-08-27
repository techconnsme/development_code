# Manual Statement Entry, File Linking & No-OCR Upload — Design

**Date:** 2026-08-27
**Status:** Approved in brainstorming (2026-08-27)
**Related:** `api/src/routes/bank-statements.ts`, `api/src/routes/card-statements.ts`, `api/src/routes/file-storage.ts`, `api/src/routes/invoices.ts`, `api/src/lib/list-filters.ts`, `frontend/src/pages/FileUpload.tsx`, `frontend/src/pages/FileStorage.tsx`, `frontend/src/pages/BankStatements.tsx`, `frontend/src/pages/CardStatements.tsx`, `frontend/src/pages/Invoices.tsx`, `frontend/src/components/DocumentPickerModal.tsx`, `docs/superpowers/specs/2026-08-26-manual-booking-design.md` (linking infrastructure this builds on)

## 1. Problem

The bookkeeping subpages assume every bank statement, card statement, and invoice enters the system through OCR. Three gaps result:

1. **No manual entry.** A paper statement, or a scan OCR cannot read, has no path into the system at all. The user cannot key in a bank/card statement by hand.
2. **Hand-keyed invoices cannot reference their supporting document.** The Create Invoice modal exists but `POST /invoices` accepts no `file_id`, so a manually-created invoice has no attached file and the File Storage badge shows "Stored — not linked", inviting someone to re-import the same document later.
3. **Every upload burns AI tokens.** The upload flow always calls `import-document` after storing the file (even the "Others" channel — the result is just ignored). A user who wants a file archived for audit only, or who intends to key in the data themselves, cannot skip OCR.

The workflow this feature unlocks: scan or paper statement → upload **without** AI analysis → key the statement in **manually** → **link** it to the uploaded file → File Storage shows the file as linked, so nobody re-imports it, and the statement flows through the unchanged downstream pipeline (review → confirm → JE generation → matching).

## 2. Locked scope decisions (brainstorming 2026-08-27)

1. **Entry point for manual statements lives on the statement pages** — a "+ Manual Entry" button on Bank Statements and Card Statements, opening an inline editor. No new subpage, no navigation changes.
2. **Invoices are included as an attachment gap only** — the existing Create Invoice modal gains optional file attachment; no new invoice editor.
3. **No-OCR files can be analyzed later** — an "Analyze" action on `ocr_status='skipped'` files calls the existing `import-document` endpoint.
4. **Manual statements pass through the existing review page** before posting (created as `status='draft'`, user redirected to the review page, same as the OCR path). One pipeline, two front doors.
5. **One file per statement/invoice** via a `source_file_id` / `file_id` column (1:1 with the OCR path). Junction-table multi-file bundles rejected as YAGNI.
6. **Linking is never blocked** — picking an already-linked file shows a non-blocking amber warning (the manual-booking convention); the link endpoint itself validates tenancy only.
7. **Out of scope:** CSV/spreadsheet import, multi-file bundles per statement, unlink action (replacing a link is allowed), editing OCR-provenance links, draft/approval workflow for statements, Recycle Bin UI, backfilling `invoices.source` beyond the file_id rule in §4.

## 3. Architecture

**Approach (approved): dedicated link columns + provenance columns.** `bank_statements`, `card_statements` each gain `source_file_id TEXT` (→ `file_records.id`) and `source TEXT` (`'ocr'` | `'manual'`); `invoices` gains `source TEXT` only (it already has `file_id`). All reads that surface "is this file linked?" (`buildFileListSql`, `GET /file-storage/:id/linked-records`, the `?unlinked=1` filter) extend their joins with `OR <table>.source_file_id = fr.id`. `file_records.ocr_status` gains the value `'skipped'` (TEXT column — no DDL).

Rejected alternatives:

- **Reuse `r2_key` for manual links** — `r2_key` means "extracted from this file by OCR". It drives card duplicate rejection (`SELECT id FROM card_statements WHERE r2_key = ?`), bank JE-generation dedup (skips entries when another live statement shares the `r2_key`), and delete cascades (deleting a statement soft-deletes `file_records` with the same `r2_key`). Overloading it would make a manually-linked file look already-imported and would soft-delete the user's file if the statement is deleted.
- **Junction table** (like `journal_entry_files`) — no current need for multiple files per statement; a later migration to a junction is mechanical if bundles ever matter.

## 4. Data model

### 4.1 Migration — `api/src/db/migration-manual-statements.sql`

```sql
ALTER TABLE bank_statements ADD COLUMN source_file_id TEXT;
ALTER TABLE bank_statements ADD COLUMN source TEXT;
ALTER TABLE card_statements ADD COLUMN source_file_id TEXT;
ALTER TABLE card_statements ADD COLUMN source TEXT;
ALTER TABLE invoices ADD COLUMN source TEXT;

UPDATE bank_statements SET source = 'ocr' WHERE source IS NULL;
UPDATE card_statements SET source = 'ocr' WHERE source IS NULL;
-- Historically exact: every invoice with a file_id came through OCR import;
-- every hand-keyed invoice (Create Invoice modal) has file_id NULL.
UPDATE invoices SET source = 'ocr' WHERE source IS NULL AND file_id IS NOT NULL;
UPDATE invoices SET source = 'manual' WHERE source IS NULL;

CREATE INDEX IF NOT EXISTS idx_bank_stmt_source_file ON bank_statements(source_file_id);
CREATE INDEX IF NOT EXISTS idx_card_stmt_source_file ON card_statements(source_file_id);
```

- New manual statements insert `source='manual'`; the OCR import paths stamp `source='ocr'` on insert from now on (so the backfill stays a one-shot).
- House conventions: `ALTER TABLE` re-runs error harmlessly ("duplicate column name"); no `--` comments inside statement strings executed by JS tooling; verify with `PRAGMA table_info` after `wrangler d1 execute` — never assume applied. `schema.sql` updated to match for fresh DBs.

## 5. Backend

All new endpoints follow the existing pattern: `const tenantId = c.get('client_user_id') || user.id`; every write audit-logged via the file-local `auditLog()` helper; literal routes registered BEFORE `/:id` param routes in their file.

### 5.1 `POST /file-storage/upload` — `skip_ocr` flag

Optional boolean body field. When true, the initial `ocr_status` is `'skipped'` instead of `'pending'` (today the endpoint hardcodes `{ text: '', status: 'pending' }`). Everything else unchanged — the endpoint already stores to R2 without running OCR. Backward compatible: existing callers omit the flag.

### 5.2 `POST /bank-statements/manual`

```jsonc
{
  "bank_name": "HSBC", "account_number": "123-456789-001", "branch": "...",
  "currency": "HKD", "statement_year": 2026, "statement_month": 7,
  "period_start": "2026-07-01", "period_end": "2026-07-31",
  "opening_balance": 100000, "closing_balance": 95000,
  "source_file_id": "fs-abcd1234",
  "transactions": [
    { "transaction_date": "2026-07-03", "description": "TRANSFER FROM X",
      "deposit_amount": 5000, "withdrawal_amount": 0, "balance": 105000, "reference": "" }
  ]
}
```

- Validates: `bank_name` non-empty; `transactions` 1–500 rows; each row has exactly one of `deposit_amount` / `withdrawal_amount` > 0 (a row with neither or both is a 400 naming the row index); dates match `YYYY-MM-DD`; `source_file_id` (when present) belongs to the tenant and is not soft-deleted, else 400 naming it.
- Creates the statement with `status='draft'`, `source='manual'`, `file_name = 'Manual — <bank_name> <YYYY-MM>'` (display-only; `r2_key` stays NULL), then the transactions with `sort_order` = array index. Audit: `create` `bank_statement` with `{ source: 'manual', transactions: n, source_file_id }`.
- Returns `{ id, transaction_count }` → frontend navigates to `/bank-statements/review/:id`.
- No closed-period guard on creation (statements are not journal entries); the period guard applies later when JEs are generated on confirm, as today.

### 5.3 `POST /card-statements/manual`

Mirror of §5.2 with card fields: `card_issuer`, `card_network`, `card_number_last4`, `cardholder_name`, `credit_limit`, `minimum_payment`, `payment_due_date`, `period` fields, and `transactions[]` of `{ transaction_date, description, amount, transaction_type?, foreign_currency?, foreign_amount?, category?, reference? }` (amounts positive; `transaction_type` validated against the existing value set when provided). Same validation posture, `status='draft'`, `source='manual'`, same redirect to `/card-statements/review/:id`.

### 5.4 `PUT /bank-statements/:id/link-file` and `PUT /card-statements/:id/link-file`

Body `{ file_id }`. Guards: statement exists, belongs to tenant, not soft-deleted (404); `file_id` tenancy + not soft-deleted (400 naming it). Sets `source_file_id` (replacing an existing link is allowed — the audit payload records old and new). The "file already linked elsewhere" warning is NOT enforced here — the frontend shows it from `linked-records` before the call (§6.4). Audit: `update` `<entity>` `{ linked_file_id, replaced_file_id? }`.

### 5.5 `GET /file-storage/:id/linked-records` — extension

The statement joins gain the manual branch:

```sql
LEFT JOIN bank_statements bs ON (bs.r2_key = fr.r2_key OR bs.source_file_id = fr.id)
  AND bs.user_id = fr.user_id AND bs.deleted_at IS NULL
```

(same for `card_statements`), and the returned labels distinguish provenance: an OCR-linked statement reads "bank statement — HSBC (from AI-OCR)"; a manual one reads "bank statement — HSBC (manually entered)". `buildFileLinks` in `api/src/lib/manual-booking.ts` gains the source parameter.

### 5.6 `buildFileListSql` — extension (`api/src/lib/list-filters.ts`)

- Statement/card joins gain the same `(r2_key = fr.r2_key OR source_file_id = fr.id)` branch.
- SELECT list gains `bs.source as stmt_source, cs.source as card_source, i.source as inv_source`.
- The `?unlinked=1` clause needs **no change** — it tests `i.id IS NULL AND bs.id IS NULL AND cs.id IS NULL`, which the extended joins now satisfy for manual links too (a manually-linked file stops appearing in the Expenses → Others picker, which is the point).
- `tests/list-filters.test.ts` (existing) gains cases for the OR-join and unlinked semantics.

### 5.7 `POST /invoices` — optional `file_id`

`createSchema` gains `file_id: z.string().optional()`. When present: tenancy + not soft-deleted check (400 naming it), stored on the INSERT, included in the audit payload. The INSERT also stamps `source='manual'` (hand-keyed path; the OCR import path stamps `'ocr'` on its own inserts — one-line change there). Existing callers unchanged.

## 6. Frontend

### 6.1 FileUpload — second submit button

Next to **Upload & Analyze**, a secondary button **"Save without AI Analysis" / 「儲存（不用 AI 分析）」/「储存（不用 AI 分析）」**. It runs the same per-file loop (validation, description, channel/folder destination) but calls only `/file-storage/upload` with `skip_ocr: true` — no `import-document`, no mismatch dialog, no token-usage card, no review queue. Batch progress counts uploads only. Success toast: "Saved N file(s) without AI analysis — run Analyze later from File Storage." Then the existing redirect to `/file-storage`.

### 6.2 FileStorage — `'skipped'` badge + Analyze action

- `summaryStatus` gains a branch for `ocr_status === 'skipped'`, ordered **after** the needs-review and linked checks (a skipped file that was later manually linked shows "Manually Linked", not "Stored (no AI)"): gray-blue badge **"Stored (no AI)"** — tooltip "Saved without AI analysis. Click Analyze to extract data."
- The linked-record branch splits by provenance: teal **"Manually Linked"** when the link is a `stmt_source`/`card_source`/`inv_source` of `'manual'`; green **"AI-OCR Processed"** otherwise. Tooltips updated to match.
- Rows with `ocr_status === 'skipped'` get an **Analyze** action (sparkles icon button in the row actions area). It POSTs the existing `/file-storage/:id/import-document`, shows a spinner during the 20–40 s run, then invalidates file-storage queries. If the response is `password_required`, the existing `EncryptedPdfModal` opens. Result records surface through the existing review-queue banner — there is no mismatch dialog here because no channel was pre-selected.

### 6.3 BankStatements / CardStatements — manual entry editor

- **"+ Manual Entry"** button in each page header opens an inline full-width editor panel above the list (list stays visible; same placement pattern as the manual-booking editor).
- *Header row:* bank name (or card issuer) + account number / last-4, year + month pickers, currency (default HKD), optional period dates, optional opening/closing balance.
- *Transaction grid:* date · description · deposit · withdrawal · balance · add/remove row. Entering a deposit zeroes the withdrawal cell and vice-versa; balance auto-fills as previous balance + deposit − withdrawal but stays editable. Live footer totals (total deposits, withdrawals, net).
- *Attach supporting file:* a chip area opening `DocumentPickerModal` (existing component, cap 1 — single-select mode for this use). On selection the page calls `linked-records`; a non-empty result renders the amber warning naming existing links while the file is chosen.
- **Save** → `POST …/manual`; success toast "Manual statement created — review to post"; navigate to the statement's review page. **Cancel** discards.
- All strings via `tr()` EN/繁/简.

### 6.4 Link File action on existing statements

In a statement's expanded row, statements with `r2_key IS NULL` (i.e. `source='manual'`) show **"Link File"**. It opens the same single-select picker with the same pre-warning, then `PUT …/link-file`. OCR-provenance statements (which already have their exact source file) show nothing. The attached file renders as a chip in the expanded row that opens the standard inline preview.

### 6.5 Invoices — Create modal attachment

The Create Invoice modal gains an "Attach supporting file" section: single-select `DocumentPickerModal`, amber already-linked warning, chip display. Submit passes `file_id` on `POST /invoices`. The invoice detail panel already renders `file_id` attachments — no change there.

## 7. Error handling

| Case | Result |
|---|---|
| `skip_ocr` on upload | No error path — flag only changes initial `ocr_status` |
| Manual statement: 0 transactions, both/neither amount per row, bad date | 400 naming the offending row |
| `source_file_id` / `file_id` not owned, missing, or soft-deleted | 400 naming the offender; nothing written |
| Link target statement missing / not tenant's / deleted | 404 |
| Replace existing link | Allowed; audit records old → new |
| Analyze on a `skipped` file that is encrypted | `password_required` → `EncryptedPdfModal` |
| Analyze fails / OCR unreadable | Existing error surface (badge "Could not read"); file remains stored |
| Auth/role | Existing middleware: 401 / 403 |

## 8. Testing

House conventions (no unit framework):

1. Measure API `tsc` error baseline in Task 0; keep identical; zero new errors in touched files.
2. Frontend `npm run build` clean after every frontend task.
3. Throwaway `npx tsx tests/*.test.ts` with mock db: manual statement validation matrix (row amount rules, date format, tenancy rejection of `source_file_id`); link-file replace semantics; `buildFileListSql` OR-join + `unlinked` coverage incl. manual links; badge-provenance labels via `buildFileLinks`.
4. Live round-trip on a test tenant: upload a PDF with `skip_ocr` → badge "Stored (no AI)" → create manual statement linked to it → badge "Manually Linked" → file no longer in `?unlinked=1` → review/confirm the statement → JEs generate → hard-clean all test rows (statement, transactions, JEs, audit rows; file hard-delete pattern per existing cleanup scripts).
5. Playwright, non-mutating: "Save without AI Analysis" button visible; manual entry editor opens from Bank Statements; badge states render (route-intercepted responses).
6. Migration verified with `PRAGMA table_info` on all three tables after `wrangler d1 execute`.

## 9. Deploy & rollback

Order: commit (explicit paths only — the working tree holds unrelated uncommitted changes that stay untouched) → run `migration-manual-statements.sql` on `opcc-crm-db` via `wrangler d1 execute` → PRAGMA verify → deploy API worker → smoke `POST …/manual` + `linked-records` + upload `skip_ocr` → deploy frontend to Pages → live verification (§8.4) → record deployed URLs + API version in memory.

Rollback is safe: everything is additive (new columns stay NULL/'ocr'/'manual', `'skipped'` rows just render as "Stored"). Redeploying the previous worker/frontend leaves unused columns.

## 10. Risks & mitigations

- **`POST /invoices` is a shared endpoint** (Create Invoice modal, possibly others): the new field is optional; existing callers unchanged; regression covered by round-trip + existing invoice flows in Playwright suite.
- **OR-join correctness**: a manual statement can never match both branches (no `r2_key`), so no row duplication; mock-db tests pin this.
- **`ocr_status='skipped'` vs existing status consumers**: the `/issues` badge counts only `failed`/`unclear` — skipped files are intentionally not "issues"; `summaryStatus` handles the new value explicitly. Grep for `ocr_status` consumers during implementation and account for each.
- **Concurrent sessions / dirty tree**: all work in an isolated worktree; commits add files by explicit path only.
- **Balance-column trust**: manual running-balance is a convenience, not a validation — closing-balance mismatch is not blocked (matches OCR path, where the review page already surfaces balance checks).
