# Expanded GJE Modal — Design

**Date:** 2026-08-27
**Status:** Approved in brainstorming (2026-08-27)
**Related:** `api/src/routes/bookkeeping.ts` (POST /entries, reverse, delete), `frontend/src/pages/Bookkeeping.tsx` (GJE modal + list), `api/src/lib/period-guard.ts`, `api/src/lib/journal-filters.ts`

## 1. Problem

Creating a GL booking by hand is possible today only through a modal buried in the GJE tab, and it lacks what a complete accounting system needs for manual vouchers:

- No link to supporting documents in R2 (HK Companies Ordinance s.373 requires accounting records to be supported; auditors check this).
- No warning when a document is already linked to another record.
- Voucher numbers are free-typed (no guaranteed audit sequence).
- Entries created via `POST /bookkeeping/entries` silently get `entry_source='auto'`, making hand-keyed vouchers indistinguishable from automation.
- No visibility of who created an entry.

## 2. Locked scope decisions (brainstorming 2026-08-27)

1. **Expand existing GJE modal** (not a new subpage); the existing GJE "Create Journal Entry" modal is enlarged to fit all new features. Both the modal and any future manual booking page share the same backend endpoint so rules never diverge.
2. **Post immediately** — no draft/approval workflow. Correction is by reversal entry (HK practice: posted vouchers are never edited or destroyed).
3. **Auto-numbered vouchers** with override: `MJ-YYYYMM-NNN`, server-assigned by default, but users can override.
4. **Multiple documents per booking** (audit bundles: invoice + receipt + contract).
5. **HK-practice extras included:** reverse-entry action on the GJE tab list; non-blocking warning when posting with no documents; similar-entry duplicate warning. Included by default: closed-period hint on the date picker, created-by stamp in the list, audit-log entries on every action.
6. **Modal expansion** — the existing popup is made larger to accommodate the new sections (attachments, voucher preview). No multi-step or tabbed interface.
7. **Out of scope:** draft/approval workflow, JE templates, editing posted entries (correct via reversal), Recycle Bin UI for JEs, multi-currency, inline new-file upload from the booking form, backfilling `created_by` on historical rows.

## 3. Architecture

Approach A (approved): extend the existing `POST /bookkeeping/entries` pipeline (DR=CR validation, leaf-account guard, closed-period guard, `bookkeeperMiddleware`, `auditLog` all reused) plus one junction table and two small read endpoints. Rejected alternative: a separate `/manual-bookings` route family — duplicates validation logic and guarantees drift, the exact anti-pattern the codebase recently cleaned up (divergent JE status filters, duplicated categorization rules).

## 4. Data model

### 4.1 Migration — `api/src/db/migration-gje-expanded.sql`

```sql
CREATE TABLE IF NOT EXISTS journal_entry_files (
  entry_id        TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  file_record_id  TEXT NOT NULL REFERENCES file_records(id),
  attached_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entry_id, file_record_id)
);
CREATE INDEX IF NOT EXISTS idx_jef_file ON journal_entry_files(file_record_id);

ALTER TABLE journal_entries ADD COLUMN created_by TEXT;

UPDATE journal_entries SET entry_source = 'manual'
WHERE entry_source = 'auto' AND reference_type IS NULL;
```

- `journal_entry_files` is the many-to-many link between bookings and `file_records`. The `(file_record_id)` index powers the "where else is this file linked?" reverse lookup.
- `created_by` stores the **operator** who typed the entry (firm staff when booking through `X-Active-Client`; otherwise the tenant user) as a small JSON snapshot `{"id": ..., "name": ..., "email": ...}` so the stamp survives renames. `journal_entries.user_id` remains the tenant. Historical rows stay NULL (list shows "—").
- `schema.sql` updated to match for fresh DBs.
- House conventions observed: no `--` comments inside statement strings executed by JS tooling; `ALTER TABLE` is one-shot (re-run errors harmlessly with "duplicate column name"); verify with `PRAGMA table_info` after running — never assume a `.sql` file was applied.

### 4.2 No other schema changes

`journal_entries` / `journal_lines` are otherwise untouched. Document linkage is entirely via the junction table (a JSON column on `journal_entries` was rejected — no indexable reverse lookup).

## 5. Backend

### 5.1 `POST /bookkeeping/entries` — extended, backward-compatible

Schema changes (all additions optional; existing callers keep supplying their own numbers):

| Field | Change |
|---|---|
| `entry_number` | Becomes optional. When absent the server assigns `MJ-YYYYMM-NNN`: `YYYYMM` from `entry_date`, `NNN` = max existing seq for that tenant+prefix scanned over **all** rows including tombstoned ones (numbers are never reused). Existing callers keep supplying their own numbers. |
| `file_ids` | Optional `string[]`, max 10. Each must belong to the tenant and not be soft-deleted, else 400 naming the offenders. Valid rows inserted into `journal_entry_files`. |
| `duplicate_acknowledged` | Optional bool; see §5.2. |
| `entry_source` | Now explicitly set to `'manual'` for everything created through this endpoint (fixes the silent `'auto'` default). |
| `created_by` | Stamped with the authenticated operator snapshot (§4.1). |

Existing guards unchanged and still enforced: DR=CR within 0.001; every account exists, is active, and is a leaf (`findParentAccountError`); 2–200 lines; `checkPeriodOpen(db, tenantId, entry_date)`; `bookkeeperMiddleware`; `auditLog(db, user.id, 'create', 'journal_entry', id, {...})` — the audit payload gains the attached file ids and whether the duplicate warning was acknowledged.

Status stays `'posted'` on creation (decision §2.2).

### 5.2 Similar-entry duplicate check

Before insert (same request): query the tenant's live entries (`jeLive()`) for rows with the same `entry_date`, total debit within 0.01 of the new entry's total debit, and sharing at least one account code with the new lines. If any exist and `duplicate_acknowledged !== true` → **409** `{ error_code: 'similar_entry_exists', similar_entries: [{ id, entry_number, description, total_debit }] }`. The frontend re-submits with `duplicate_acknowledged: true` after user confirmation. The check never blocks — it costs one confirmation click.

### 5.3 New endpoints

All in existing route files, same auth/tenancy pattern (`tenantId = c.get('client_user_id') || user.id`):

1. **`GET /bookkeeping/entries/manual`** — list for manual entries. Filter: `entry_source='manual' AND reference_type IS NULL` — i.e. bookings from the modal plus anything hand-keyed, while Petty Cash (`reference_type='petty_cash'`) and every auto-generated entry (all carry a reference_type) stay out. Uses `jeLive()`. Supports the same date-range params as `GET /entries`. Response rows: `id, entry_number, entry_date, description, total_debit, total_credit, status, created_by, files: [{ id, filename }]`, lines, and a `reversed: boolean` flag (a live JE with `reference_type='journal'` and `reference_id = <this id>` exists).
2. **`GET /bookkeeping/entries/next-number?date=YYYY-MM-DD`** — returns the voucher number that would be assigned (§5.1 rule) for the form's read-only preview. No write.
3. **`GET /file-storage/:id/linked-records`** *(in file-storage.ts)* — for one `file_records` row of the tenant, returns every record it is already attached to:
   - invoices/receipts via `file_records.invoice_id` (soft-delete-clean invoice row; label with invoice/receipt number, counterparty, total);
   - bank statements and card statements via `r2_key` equality;
   - other journal entries via `journal_entry_files` (entry_number + entry_date). During creation the entry doesn't exist yet, so no exclusion parameter is needed.
   Empty array = clean file. Read-only.

### 5.4 Existing endpoints — two behavior changes (flagged and approved)

- **`POST /entries/:id/reverse`**: keeps its existing `-REV` auto-numbering (`MJ-202608-004-REV` — traceable to the original voucher). Adds what is missing today: stamps `entry_source='manual'` + `created_by` on the reversal, rejects tombstoned originals (409), and enforces the period guard on the reversal date (today; 400). The reversal keeps `reference_type='journal'`, `reference_id=<original id>` (existing convention).
- **`DELETE /entries/:id`**: switches from hard delete to **tombstone** — sets `deleted_at` (leaves `status` untouched), keeps lines. Rationale: HK practice corrects posted vouchers by reversal, not destruction; tombstoning retires the voucher number permanently (auto-number scan includes tombstones) and leaves a recoverable trail. UX impact on the GJE tab: none visible (`jeLive()` excludes tombstones exactly as it excluded deleted rows). Recycle Bin UI for JEs is out of scope.

## 6. Frontend

### 6.1 Modal expansion — `frontend/src/pages/Bookkeeping.tsx`

The existing "Create Journal Entry" modal is expanded to include:

- **Header row:** date (default today), description, and the voucher preview from `GET /entries/next-number?date=…`, read-only by default with an override field. Re-fetched when the date changes.
- **Line grid:** per line — account code input with `datalist` autocomplete bidirectionally synced to a leaf-account `select` (`filterLeafAccounts`), line description, debit, credit (setting one zeroes the other), add/remove line (minimum 2). Live balance footer: total Dr / total Cr / difference with ✓ Balanced / ⚠ Unbalanced. (Existing, unchanged.)
- **Attachments section:** (new) `[+ attach documents]` opens a document picker modal over `GET /file-storage`: search + type filter, multi-select checkboxes, preview pane (same iframe pattern). Selections appear as removable chips in the editor. Cap 10 (matches server limit).
- **Closed-period hint:** page loads `GET /bookkeeping/closed-periods` once; if the chosen date falls inside a closed period, a red inline message appears under the date and Post is disabled.
- **Post enabled only when:** balanced, ≥2 lines, all accounts selected, period open.
- **Actions:** **Cancel** (discards form state) and **Post Entry** → `POST /bookkeeping/entries` with `file_ids`; success toast names the assigned voucher number and the modal closes; mutations invalidate `['entries']` and the file-storage queries.

### 6.2 Document Picker Modal — `frontend/src/components/DocumentPickerModal.tsx`

New component:
- Search + type filter (bank statements, card statements, invoices, receipts, other)
- Multi-select checkboxes
- Preview pane (iframe using `${WORKER_API_BASE}/file-storage/${id}/download?inline=1&token=…${iframeClientParam()}`)
- Cap 10 attachments (matches server limit)

### 6.3 GJE Tab List Enhancements

- **Reverse button:** Each row gets a reverse action (confirm dialog naming the reversal voucher that will be created → `POST /entries/:id/reverse`)
- **Reversed badge:** Rows whose voucher has a live reversal show a **↩ reversed** badge
- **Created by column:** Shows `created_by?.name || created_by?.email || '—'`

### 6.4 Warnings

- **No documents:** clicking Post with zero attachments switches the button into an amber *"Post without documents"* confirm state with a one-line note that HK companies should keep supporting records; second click posts. Non-blocking.
- **Duplicate:** on a `similar_entry_exists` 409, a modal lists the similar vouchers (number, description, amount) with **Cancel** / **Post anyway**; the latter re-submits with `duplicate_acknowledged: true`.
- **Already linked:** On selecting a file, the page calls `GET /file-storage/:id/linked-records` (results cached per file id). Non-empty result → **amber warning** naming every existing link (e.g. "invoice_001414.pdf is already linked to invoice INV-001414 — Pastel Tech, HK$15,300") which stays visible while that file is attached. Posting remains allowed.

### 6.5 Conventions

All strings via `tr()`; API via the shared `api()` helper; errors toast server messages verbatim.

## 7. Error handling

| Case | Result |
|---|---|
| Unbalanced / <2 lines | Blocked client-side; server 400 backstop |
| Account unknown, inactive, or non-leaf | 400 (`findParentAccountError` convention) |
| Date inside a closed period | 400 (`checkPeriodOpen`) + client disables Post |
| `file_ids` not owned / soft-deleted / nonexistent | 400 naming the offending ids; nothing written |
| >10 attachments | 400 |
| Voucher collision (user-typed path only) | 409 friendly "number already used" |
| Similar live entry exists | 409 `similar_entry_exists` + matches; re-submit acknowledged |
| Reverse target not live | 409 |
| Delete/reverse in a closed period | 400 |
| Auth/role | Existing middleware: 401 / 403 |

Every write audit-logged: `create` (with file ids + duplicate-acknowledged flag), `reverse`, `delete` (tombstone).

## 8. Testing

House conventions (no unit framework):

1. **Measure the API `tsc` error baseline before touching anything and keep it identical**; zero new errors in touched files.
2. Frontend build clean.
3. Throwaway `npx tsx tests/*.test.ts` with mock db (`tests/bank-resolver.test.ts` pattern) for pure logic: voucher sequencing (never reuses tombstoned numbers; month rollover), the similar-entry predicate (same date + total ±0.01 + shared account; excludes tombstones), linked-records assembly across invoices / bank statements / card statements / journal links.
4. Live round-trip on a test tenant, then clean everything back: create with 2 attachments → trial balance balances to the cent → duplicate 409 → acknowledge → reversal posts and ↩ badge appears → delete tombstones → `linked-records` reflects each step → hard-clean all test rows (JEs, junction rows, audit rows).
5. Playwright, non-mutating: sidebar entry visible; page opens; editor opens; unbalanced Post disabled; closed-period date disables Post; warning banners render (route-intercepted responses).
6. Migration verified with `PRAGMA table_info(journal_entries)` + junction-table probe after running.

## 9. Deploy & rollback

Order: commit (only this feature's files) → run `migration-gje-expanded.sql` on `opcc-crm-db` via `wrangler d1 execute` → verify via PRAGMA → deploy API worker → smoke `next-number` / create / `linked-records` → deploy frontend to Pages → live verification (§8.4) → record deployed URLs + API version in memory.

Rollback is safe: everything is additive. Redeploying the previous worker leaves an unused junction table and an unused nullable column.

## 10. Risks & mitigations

- **Shared endpoint touched** (existing callers): all additions are optional fields; `entry_number` remains user-suppliable; regression surface covered by round-trip + existing modal smoke.
- **`entry_number` UNIQUE includes tombstones**: auto-number scan includes tombstones, so numbers are never reused and collisions are impossible on the auto path.
- **`created_by` ALTER one-shot**: re-running the migration errors harmlessly on the ALTER (accepted house convention); CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS are idempotent.
