# Manual Statement Entry, File Linking & No-OCR Upload — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users key in bank/card statements by hand, link statements and hand-keyed invoices to uploaded files (with "linked" flags in File Storage), and upload files without AI analysis (analyzable later).

**Architecture:** Additive migration (`source_file_id` + `source` on both statement tables, `source` on invoices). New literal routes (`POST …/manual`, `PUT …/link-file`) modeled on the existing `/import` routes. The file-link read path (`buildFileListSql`, `linked-records`) extends its joins with `OR source_file_id = fr.id`. `'skipped'` becomes a new `file_records.ocr_status` value for no-AI uploads; File Storage gets an Analyze action that calls the existing `import-document`. Manual statements land as `status='draft'` and flow through the unchanged review pipeline.

**Tech Stack:** Cloudflare Worker (Hono) + D1 (SQLite) + R2; React + TypeScript + TanStack Query + Tailwind; `tr()` EN/繁/简 i18n; Playwright for non-mutating specs.

**Spec:** `docs/superpowers/specs/2026-08-27-manual-statements-file-linking-design.md` — read it before starting; this plan argues from it.

## Global Constraints

- **CONCURRENT SESSION:** Another AI agent session may be editing this codebase. All work happens in an isolated git worktree (Task 0). Never run `git add -A` / `git add .` / `git commit -a` — always add files by explicit path. Before editing any shared file, re-read its CURRENT content first.
- API typecheck baseline: measure in Task 0 (`npx tsc --noEmit` in `api/`), keep the count identical through all tasks; zero new errors in touched files.
- Frontend `npm run build` must stay clean after every frontend task.
- `tests/` is gitignored — test files there need `git add -f`.
- All frontend strings via `tr('EN', '繁體', '简体')`.
- Every API write audit-logged via the file-local `auditLog()` helper; tenancy always `const tenantId = c.get('client_user_id') || user.id`.
- House git convention: commit messages end with `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Migrations are plain SQL applied manually with `npx wrangler d1 execute opcc-crm-db --remote --file=…` from `api/` — no migrations runner. Verify with PRAGMA after running; never assume a `.sql` file was applied.
- `playwright-report/` dirties the tree on test runs — never commit it.
- Line numbers below were measured on `main` at commit `3ca6ce1`; they drift. Anchor edits by the quoted code, not the number. STOP and report if the surrounding logic no longer matches.

---

### Task 0: Setup — isolated worktree + baselines

**Files:** none modified

**Interfaces:** Produces the worktree path all later tasks assume (`<repo>/.claude/worktrees/manual-statements`) and the recorded `tsc` baseline count.

- [ ] **Step 1: Create an isolated worktree**

Use the `superpowers:using-git-worktrees` skill for the repo at `C:\Users\samue\Documents\Pastel\Tech_Connect_SME\Development_code\latest_code` (branch name: `manual-statements`). All subsequent tasks run inside that worktree.

- [ ] **Step 2: Measure the API typecheck baseline**

```bash
cd api && npx tsc --noEmit 2>&1 | tee /tmp/tsc-baseline.txt | tail -1
grep -c "error TS" /tmp/tsc-baseline.txt
```

Record the number. Every later `tsc` run must match it exactly, with no error pointing at a file this plan touches.

- [ ] **Step 3: Measure the frontend build baseline**

```bash
cd frontend && npm run build
```

Expected: clean build.

- [ ] **Step 4: Sanity-check the worktree state**

```bash
git log --oneline -3 && git status --short
```

Expected: clean tree at `main` HEAD (`3ca6ce1` or a descendant that still contains the spec commit).

---

### Task 1: Migration + schema.sql

**Files:**
- Create: `api/src/db/migration-manual-statements.sql`
- Modify: `api/src/db/schema.sql` (bank_statements ~lines 542-566, invoices ~lines 74-99)

**Interfaces:** Produces DB columns `bank_statements.source_file_id`, `bank_statements.source`, `card_statements.source_file_id`, `card_statements.source`, `invoices.source` — every later task's SQL assumes they exist.

- [ ] **Step 1: Write the migration file**

Create `api/src/db/migration-manual-statements.sql` with exactly:

```sql
-- Manual statement entry + file linking — schema
-- source_file_id: manual link to a file_records row (OCR path uses r2_key instead)
-- source: provenance — 'ocr' | 'manual'

ALTER TABLE bank_statements ADD COLUMN source_file_id TEXT;
ALTER TABLE bank_statements ADD COLUMN source TEXT;
ALTER TABLE card_statements ADD COLUMN source_file_id TEXT;
ALTER TABLE card_statements ADD COLUMN source TEXT;
ALTER TABLE invoices ADD COLUMN source TEXT;

UPDATE bank_statements SET source = 'ocr' WHERE source IS NULL;
UPDATE card_statements SET source = 'ocr' WHERE source IS NULL;
UPDATE invoices SET source = 'ocr' WHERE source IS NULL AND file_id IS NOT NULL;
UPDATE invoices SET source = 'manual' WHERE source IS NULL;

CREATE INDEX IF NOT EXISTS idx_bank_stmt_source_file ON bank_statements(source_file_id);
CREATE INDEX IF NOT EXISTS idx_card_stmt_source_file ON card_statements(source_file_id);
```

- [ ] **Step 2: Update schema.sql for fresh DBs**

In `api/src/db/schema.sql`:

1. In the `bank_statements` CREATE TABLE, after the `ocr_text TEXT,` line and before `status TEXT NOT NULL DEFAULT 'active',`, add:
   ```sql
     source_file_id TEXT,
     source TEXT,
   ```
2. In the `invoices` CREATE TABLE, after the `file_id` column (or any late column — match the existing formatting), add `source TEXT,`.
3. `card_statements` has NO CREATE TABLE in schema.sql (it lives only in `api/src/db/migration-card-statements.sql`) — add the same two columns to the CREATE TABLE in that migration file instead, with a trailing comment `-- source_file_id/source added 2026-08-27 (see migration-manual-statements.sql)`.

- [ ] **Step 3: Verify the SQL parses (local D1 dry run)**

```bash
cd api && npx wrangler d1 execute opcc-crm-db --local --file=src/db/migration-manual-statements.sql && npx wrangler d1 execute opcc-crm-db --local --command "PRAGMA table_info(bank_statements)" 2>&1 | grep -E "source_file_id|source"
```

Expected: both columns listed. (The local DB is disposable; this only checks the SQL is valid. Re-running the file errors on "duplicate column name" — that is the accepted house behavior for the ALTERs.)

- [ ] **Step 4: Commit**

```bash
git add api/src/db/migration-manual-statements.sql api/src/db/schema.sql api/src/db/migration-card-statements.sql
git commit -m "feat(db): manual-statements migration — source_file_id + source columns

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: `buildFileListSql` manual-link join + tests

**Files:**
- Modify: `api/src/lib/list-filters.ts`
- Test: `tests/list-filters.test.ts` (force-add)

**Interfaces:**
- Produces: SELECT list now includes `bs.source as stmt_source, cs.source as card_source, i.source as inv_source`; statement joins match `source_file_id` as well as `r2_key`. The `?unlinked=1` clause is unchanged and now excludes manually-linked files via the extended joins.

- [ ] **Step 1: Write the failing tests**

Append to `tests/list-filters.test.ts` (before the final `console.log`):

```ts
// ── manual-link join extension (2026-08-27) ──
const ml = buildFileListSql({ tenantId: 'u1' });
ok(/bs\.r2_key = fr\.r2_key OR bs\.source_file_id = fr\.id/.test(ml.sql), 'bank join covers r2_key OR source_file_id');
ok(/cs\.r2_key = fr\.r2_key OR cs\.source_file_id = fr\.id/.test(ml.sql), 'card join covers r2_key OR source_file_id');
ok(/bs\.source as stmt_source/.test(ml.sql) && /cs\.source as card_source/.test(ml.sql) && /i\.source as inv_source/.test(ml.sql), 'provenance aliases selected');
const mlUn = buildFileListSql({ tenantId: 'u1', unlinked: true });
ok(/bs\.id IS NULL/.test(mlUn.sql) && /cs\.id IS NULL/.test(mlUn.sql), 'unlinked still excludes statements (now incl. manual links)');
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx tsx tests/list-filters.test.ts
```

Expected: FAIL on the four new checks (`manual-link join…`, `card join…`, `provenance aliases…`).

- [ ] **Step 3: Extend the builder**

In `api/src/lib/list-filters.ts`, replace the SELECT + JOIN block (lines 14-27) with:

```ts
  let sql = `SELECT fr.id, fr.folder, fr.filename, fr.original_name, fr.file_type, fr.file_size,
    fr.description, fr.ocr_status, fr.category, fr.direction, fr.payment_status, fr.amount,
    fr.created_at, fr.updated_at,
    i.id as invoice_id, i.invoice_number, i.status as invoice_status, i.needs_review as invoice_needs_review,
    i.vendor_name, i.direction as invoice_direction, i.source as inv_source,
    c.name as customer_name,
    bs.id as statement_id, bs.bank_name as stmt_bank_name, bs.status as stmt_status, bs.source as stmt_source,
    cs.id as card_statement_id, cs.card_issuer, cs.status as card_status, cs.source as card_source
    FROM file_records fr
    LEFT JOIN invoices i ON i.file_id = fr.id AND i.user_id = fr.user_id AND i.deleted_at IS NULL
    LEFT JOIN customers c ON i.customer_id = c.id
    LEFT JOIN bank_statements bs ON (bs.r2_key = fr.r2_key OR bs.source_file_id = fr.id) AND bs.user_id = fr.user_id AND bs.deleted_at IS NULL
    LEFT JOIN card_statements cs ON (cs.r2_key = fr.r2_key OR cs.source_file_id = fr.id) AND cs.user_id = fr.user_id AND cs.deleted_at IS NULL
    WHERE fr.user_id = ? AND fr.deleted_at IS NULL`;
```

The `unlinked` block stays exactly as it is.

- [ ] **Step 4: Run tests — all pass**

```bash
npx tsx tests/list-filters.test.ts
```

Expected: `… passed, 0 failed`.

- [ ] **Step 5: Typecheck baseline unchanged**

```bash
cd api && npx tsc --noEmit 2>&1 | grep -c "error TS"
```

Must equal the Task 0 number.

- [ ] **Step 6: Commit**

```bash
git add api/src/lib/list-filters.ts && git add -f tests/list-filters.test.ts
git commit -m "feat(api): file list joins manual statement links via source_file_id

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Bank statement manual entry + link-file endpoints

**Files:**
- Modify: `api/src/routes/bank-statements.ts` (new routes before `bank.post('/import', …)` at ~line 1298; `source='ocr'` stamps on the two existing INSERTs at ~1327 and ~1397; list SELECT at ~line 148; detail SELECT in `bank.get('/:id', …)` at ~1152)

**Interfaces:**
- Produces: `POST /bank-statements/manual` → `{ id, status: 'draft', transactions_count }` (201); `PUT /bank-statements/:id/link-file` body `{ file_id }` → `{ id, source_file_id }`. List/detail rows now include `r2_key`, `source_file_id`, `source`.
- Consumes: Task 1 columns.

- [ ] **Step 1: Add the manual-entry route**

Re-read the file around `bank.post('/import', …)`. Insert directly ABOVE it:

```ts
// ── Manual entry (hand-keyed; optional source_file_id link) ──
bank.post('/manual', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const body = await c.req.json();
  const {
    bank_name, account_number, branch, currency,
    statement_year, statement_month, period_start, period_end,
    opening_balance, closing_balance, source_file_id,
    transactions
  } = body;

  if (!bank_name || !String(bank_name).trim()) return c.json({ error: 'bank_name required' }, 400);
  if (!Array.isArray(transactions) || transactions.length === 0) return c.json({ error: 'transactions must be a non-empty array' }, 400);
  if (transactions.length > 500) return c.json({ error: 'transactions: max 500 rows' }, 400);
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    if (!dateRe.test(tx.transaction_date || '')) return c.json({ error: `Row ${i + 1}: transaction_date must be YYYY-MM-DD` }, 400);
    if (!tx.description || !String(tx.description).trim()) return c.json({ error: `Row ${i + 1}: description required` }, 400);
    const dep = Number(tx.deposit_amount || 0);
    const wdl = Number(tx.withdrawal_amount || 0);
    if ((dep > 0) === (wdl > 0)) return c.json({ error: `Row ${i + 1}: exactly one of deposit_amount / withdrawal_amount must be > 0` }, 400);
  }
  if (source_file_id) {
    const f = await db.prepare(
      'SELECT id, filename FROM file_records WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    ).bind(source_file_id, tenantId).first();
    if (!f) return c.json({ error: `file_id ${source_file_id} not found for this account` }, 400);
  }

  const id = `bs-${uuidv4().slice(0, 8)}`;
  const storedBank = normalizeBankNameForStorage(bank_name);
  const ym = statement_year && statement_month ? ` ${statement_year}-${String(statement_month).padStart(2, '0')}` : '';
  await db.prepare(
    `INSERT INTO bank_statements (id, user_id, file_name, file_type, file_data, r2_key,
     bank_name, account_number, branch, currency, account_type,
     statement_year, statement_month, period_start, period_end,
     opening_balance, closing_balance, page_count, ocr_text, status, source_file_id, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, tenantId, `Manual — ${storedBank}${ym}`, 'application/pdf', '', null,
    storedBank, account_number || null, branch || null, currency || 'HKD', null,
    statement_year || null, statement_month || null, period_start || null, period_end || null,
    opening_balance ?? null, closing_balance ?? null, null, '', 'draft', source_file_id || null, 'manual').run();

  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    await db.prepare(
      `INSERT INTO bank_transactions (id, bank_statement_id, user_id, transaction_date, description,
       deposit_amount, withdrawal_amount, balance, account_type, reference, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(`bt-${uuidv4().slice(0, 8)}`, id, tenantId, tx.transaction_date, tx.description,
      Number(tx.deposit_amount || 0), Number(tx.withdrawal_amount || 0), tx.balance ?? 0,
      null, tx.reference || null, i).run();
  }

  await auditLog(db, user.id, 'create', 'bank_statement', id, { source: 'manual', transactions: transactions.length, source_file_id: source_file_id || null });
  return c.json({ id, status: 'draft', transactions_count: transactions.length }, 201);
});

// ── Link a manually-entered statement to a stored file (replace allowed) ──
bank.put('/:id/link-file', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const id = c.req.param('id');
  const { file_id } = await c.req.json();
  if (!file_id) return c.json({ error: 'file_id required' }, 400);
  const stmt = await db.prepare(
    'SELECT id, r2_key, source_file_id FROM bank_statements WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(id, tenantId).first<{ id: string; r2_key: string | null; source_file_id: string | null }>();
  if (!stmt) return c.json({ error: 'Not found' }, 404);
  if (stmt.r2_key) return c.json({ error: 'OCR-imported statements are already linked to their source file' }, 409);
  const f = await db.prepare(
    'SELECT id FROM file_records WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(file_id, tenantId).first();
  if (!f) return c.json({ error: `file_id ${file_id} not found for this account` }, 400);
  await db.prepare(
    "UPDATE bank_statements SET source_file_id = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
  ).bind(file_id, id, tenantId).run();
  await auditLog(db, user.id, 'update', 'bank_statement', id, { linked_file_id: file_id, replaced_file_id: stmt.source_file_id || null });
  return c.json({ id, source_file_id: file_id });
});
```

Route order note: both are safe — no existing 1-segment POST or 2-segment `PUT /:id/*` route is shadowed (`POST /:id/confirm` is 2-segment with a different literal tail).

- [ ] **Step 2: Stamp `source='ocr'` on the existing OCR-path INSERTs**

In this same file, the `bank.post('/import')` INSERT (~line 1327) and `bank.post('/upload')` INSERT (~line 1397) each gain the `source` column with the literal `'ocr'` value (add `source` to the column list, append `'ocr'` to the VALUES placeholders and bind list). Then enumerate every other writer:

```bash
grep -rn "INSERT INTO bank_statements" api/src/routes/
```

For each hit (expected: `file-storage.ts` ×2, `chat.ts` ×1), add `source` = `'ocr'` the same way. These are all OCR/chat-upload paths.

- [ ] **Step 3: Expose link fields on list + detail**

1. In `bank.get('/')` (~line 148), extend the SELECT's first line: `SELECT bs.id, bs.file_name, bs.bank_name,` → `SELECT bs.id, bs.file_name, bs.r2_key, bs.source_file_id, bs.source, bs.bank_name,`.
2. In `bank.get('/:id', …)` (~line 1152), add `r2_key, source_file_id, source` to the SELECT the same way (read the handler first; keep its shape).

- [ ] **Step 4: Write the mock-db test**

Create `tests/manual-statements.test.ts`:

```ts
// Tests for manual statement entry validation + link semantics.
// Run: npx tsx tests/manual-statements.test.ts
let pass = 0, fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) { pass++; } else { fail++; console.error(`FAIL: ${label}`); }
}

// The route handlers are exercised through Hono in the live round-trip (Task 13);
// here we pin the pure validation predicate shared by both statement endpoints.
export function validateManualRows(transactions: any[]): string | null {
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    if (!dateRe.test(tx.transaction_date || '')) return `Row ${i + 1}: transaction_date must be YYYY-MM-DD`;
    if (!tx.description || !String(tx.description).trim()) return `Row ${i + 1}: description required`;
    const dep = Number(tx.deposit_amount || 0);
    const wdl = Number(tx.withdrawal_amount || 0);
    if ((dep > 0) === (wdl > 0)) return `Row ${i + 1}: exactly one of deposit_amount / withdrawal_amount must be > 0`;
  }
  return null;
}

ok(validateManualRows([{ transaction_date: '2026-07-03', description: 'X', deposit_amount: 5, withdrawal_amount: 0 }]) === null, 'valid row passes');
ok(/Row 1/.test(validateManualRows([{ transaction_date: 'bad', description: 'X', deposit_amount: 5, withdrawal_amount: 0 }]) || ''), 'bad date names row');
ok(/exactly one/.test(validateManualRows([{ transaction_date: '2026-07-03', description: 'X', deposit_amount: 0, withdrawal_amount: 0 }]) || ''), 'neither amount rejected');
ok(/exactly one/.test(validateManualRows([{ transaction_date: '2026-07-03', description: 'X', deposit_amount: 5, withdrawal_amount: 5 }]) || ''), 'both amounts rejected');
ok(/description/.test(validateManualRows([{ transaction_date: '2026-07-03', description: ' ', deposit_amount: 5, withdrawal_amount: 0 }]) || ''), 'blank description rejected');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

**IMPORTANT:** to keep the route and the test from drifting, extract the loop body into `export function validateManualRows(transactions: any[]): string | null` in a new `api/src/lib/manual-statements.ts`, import it in both `bank-statements.ts` and `card-statements.ts` (Task 4), and have the test import it from there (delete the local copy above; the test's import line becomes `import { validateManualRows } from '../api/src/lib/manual-statements';`).

- [ ] **Step 5: Run tests + typecheck**

```bash
npx tsx tests/manual-statements.test.ts && cd api && npx tsc --noEmit 2>&1 | grep -c "error TS"
```

Expected: `5 passed, 0 failed`; typecheck count = baseline.

- [ ] **Step 6: Commit**

```bash
git add api/src/routes/bank-statements.ts api/src/lib/manual-statements.ts api/src/routes/file-storage.ts api/src/routes/chat.ts
git add -f tests/manual-statements.test.ts
git commit -m "feat(api): manual bank statement entry + link-file endpoint

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Card statement manual entry + link-file endpoints

**Files:**
- Modify: `api/src/routes/card-statements.ts` (new routes before `card.post('/import', …)` at ~line 239; `source='ocr'` stamp on the /import INSERT at ~264; list SELECT at ~line 102; detail SELECT in `card.get('/:id', …)` at ~493)

**Interfaces:**
- Produces: `POST /card-statements/manual` → `{ id, status: 'draft', transactions_count }` (201); `PUT /card-statements/:id/link-file` → `{ id, source_file_id }`. List/detail rows include `r2_key`, `source_file_id`, `source`.
- Consumes: `validateManualCardRows` semantics below; Task 1 columns; Task 3's `api/src/lib/manual-statements.ts` (add the card validator there).

- [ ] **Step 1: Add the card validators to `api/src/lib/manual-statements.ts`**

```ts
const CARD_TX_TYPES = ['purchase', 'payment', 'refund', 'fee', 'interest', 'cash_advance'];

export function validateManualCardTransactions(transactions: any[]): string | null {
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    if (!dateRe.test(tx.transaction_date || '')) return `Row ${i + 1}: transaction_date must be YYYY-MM-DD`;
    if (!tx.description || !String(tx.description).trim()) return `Row ${i + 1}: description required`;
    if (!(Number(tx.amount) > 0)) return `Row ${i + 1}: amount must be > 0`;
    if (tx.transaction_type && !CARD_TX_TYPES.includes(tx.transaction_type)) {
      return `Row ${i + 1}: transaction_type must be one of ${CARD_TX_TYPES.join(', ')}`;
    }
  }
  return null;
}
```

- [ ] **Step 2: Add the routes**

Insert directly ABOVE `card.post('/import', …)` (mirroring the bank route from Task 3 — full code, do not share the handler):

```ts
// ── Manual entry (hand-keyed; optional source_file_id link) ──
card.post('/manual', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const body = await c.req.json();
  const {
    card_issuer, card_network, card_number_last4, cardholder_name, currency,
    statement_year, statement_month, period_start, period_end,
    credit_limit, opening_balance, closing_balance, minimum_payment, payment_due_date,
    source_file_id, transactions
  } = body;

  if (!card_issuer || !String(card_issuer).trim()) return c.json({ error: 'card_issuer required' }, 400);
  if (!Array.isArray(transactions) || transactions.length === 0) return c.json({ error: 'transactions must be a non-empty array' }, 400);
  if (transactions.length > 500) return c.json({ error: 'transactions: max 500 rows' }, 400);
  const rowError = validateManualCardTransactions(transactions);
  if (rowError) return c.json({ error: rowError }, 400);
  if (source_file_id) {
    const f = await db.prepare(
      'SELECT id FROM file_records WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    ).bind(source_file_id, tenantId).first();
    if (!f) return c.json({ error: `file_id ${source_file_id} not found for this account` }, 400);
  }

  const id = `cs-${uuidv4().slice(0, 8)}`;
  const ym = statement_year && statement_month ? ` ${statement_year}-${String(statement_month).padStart(2, '0')}` : '';
  await db.prepare(
    `INSERT INTO card_statements (id, user_id, file_name, file_type, r2_key,
     card_issuer, card_network, card_number_last4, cardholder_name, currency,
     statement_year, statement_month, period_start, period_end,
     credit_limit, opening_balance, closing_balance, minimum_payment, payment_due_date,
     status, source_file_id, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, tenantId, `Manual — ${card_issuer}${ym}`, 'application/pdf', null,
    card_issuer || null, card_network || null, card_number_last4 || null, cardholder_name || null,
    currency || 'HKD', statement_year || null, statement_month || null,
    period_start || null, period_end || null,
    credit_limit ?? null, opening_balance ?? null, closing_balance ?? null,
    minimum_payment ?? null, payment_due_date || null,
    'draft', source_file_id || null, 'manual').run();

  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    await db.prepare(
      `INSERT INTO card_transactions (id, card_statement_id, user_id, transaction_date, posting_date,
       description, amount, transaction_type, foreign_currency, foreign_amount, category, reference, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(`ct-${uuidv4().slice(0, 8)}`, id, tenantId,
      tx.transaction_date, tx.posting_date || null, tx.description,
      Number(tx.amount) || 0, tx.transaction_type || null, tx.foreign_currency || null,
      tx.foreign_amount ?? null, tx.category || null, tx.reference || null, i).run();
  }

  await auditLog(c.env.DB, user.id, 'create', 'card_statement', id, { source: 'manual', transactions: transactions.length, source_file_id: source_file_id || null });
  return c.json({ id, status: 'draft', transactions_count: transactions.length }, 201);
});

// ── Link a manually-entered statement to a stored file (replace allowed) ──
card.put('/:id/link-file', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const id = c.req.param('id');
  const { file_id } = await c.req.json();
  if (!file_id) return c.json({ error: 'file_id required' }, 400);
  const stmt = await db.prepare(
    'SELECT id, r2_key, source_file_id FROM card_statements WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(id, tenantId).first<{ id: string; r2_key: string | null; source_file_id: string | null }>();
  if (!stmt) return c.json({ error: 'Not found' }, 404);
  if (stmt.r2_key) return c.json({ error: 'OCR-imported statements are already linked to their source file' }, 409);
  const f = await db.prepare(
    'SELECT id FROM file_records WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(file_id, tenantId).first();
  if (!f) return c.json({ error: `file_id ${file_id} not found for this account` }, 400);
  await db.prepare(
    "UPDATE card_statements SET source_file_id = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
  ).bind(file_id, id, tenantId).run();
  await auditLog(db, user.id, 'update', 'card_statement', id, { linked_file_id: file_id, replaced_file_id: stmt.source_file_id || null });
  return c.json({ id, source_file_id: file_id });
});
```

Add the import at the top: `import { validateManualCardTransactions } from '../lib/manual-statements';` (and Task 3 added `import { validateManualRows } from '../lib/manual-statements';` to `bank-statements.ts` — the bank route's inline loop is replaced by `const rowError = validateManualRows(transactions); if (rowError) return c.json({ error: rowError }, 400);`).

- [ ] **Step 3: Stamp `source='ocr'` + expose link fields**

1. `card.post('/import')` INSERT (~line 264): add `source` column with `'ocr'` (note this INSERT currently hardcodes `'draft'` in the VALUES — follow its existing style, appending `source` as a bound column or the literal `'ocr'`).
2. `card.get('/')` list SELECT (~line 102): prepend `id, r2_key, source_file_id, source,` after `SELECT`.
3. `card.get('/:id', …)` detail SELECT (~line 493): add the same three columns.

- [ ] **Step 4: Extend the test**

Append to `tests/manual-statements.test.ts` (switching its import to the lib):

```ts
import { validateManualCardTransactions } from '../api/src/lib/manual-statements';
ok(validateManualCardTransactions([{ transaction_date: '2026-07-03', description: 'X', amount: 120 }]) === null, 'card: valid row');
ok(/amount/.test(validateManualCardTransactions([{ transaction_date: '2026-07-03', description: 'X', amount: 0 }]) || ''), 'card: zero amount rejected');
ok(/transaction_type/.test(validateManualCardTransactions([{ transaction_date: '2026-07-03', description: 'X', amount: 5, transaction_type: 'wire' }]) || ''), 'card: bad type rejected');
```

- [ ] **Step 5: Run tests + typecheck; commit**

```bash
npx tsx tests/manual-statements.test.ts && cd api && npx tsc --noEmit 2>&1 | grep -c "error TS"
git add api/src/routes/card-statements.ts api/src/lib/manual-statements.ts api/src/routes/bank-statements.ts
git add -f tests/manual-statements.test.ts
git commit -m "feat(api): manual card statement entry + link-file endpoint

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: `linked-records` provenance labels

**Files:**
- Modify: `api/src/routes/file-storage.ts` (`files.get('/:id/linked-records')` at ~line 2074)
- Modify: `api/src/lib/manual-booking.ts` (`buildFileLinks`)
- Test: `tests/manual-statements.test.ts`

**Interfaces:**
- Produces: `linked-records` response rows now join manual links; `buildFileLinks(fileRow, jeRows)` consumes new optional fields `stmt_source`, `card_source` on `fileRow` and appends provenance to labels.
- Consumes: Task 1 columns.

- [ ] **Step 1: Extend the query**

In the `/:id/linked-records` handler, replace the statement JOINs:

```sql
LEFT JOIN bank_statements bs ON (bs.r2_key = fr.r2_key OR bs.source_file_id = fr.id)
  AND bs.user_id = fr.user_id AND bs.deleted_at IS NULL
LEFT JOIN card_statements cs ON (cs.r2_key = fr.r2_key OR cs.source_file_id = fr.id)
  AND cs.user_id = fr.user_id AND cs.deleted_at IS NULL
```

and add `bs.source as stmt_source, cs.source as card_source` to the SELECT list.

- [ ] **Step 2: Label provenance in `buildFileLinks`**

In `api/src/lib/manual-booking.ts`, change the two statement link pushes:

```ts
  if (fileRow?.statement_id) {
    const prov = fileRow.stmt_source === 'manual' ? ' (manually entered)' : ' (from AI-OCR)';
    links.push({
      kind: 'bank_statement', id: fileRow.statement_id,
      label: `Bank statement${fileRow.stmt_bank_name ? ` — ${fileRow.stmt_bank_name}` : ''}${prov}`,
    });
  }
  if (fileRow?.card_statement_id) {
    const prov = fileRow.card_source === 'manual' ? ' (manually entered)' : ' (from AI-OCR)';
    links.push({
      kind: 'card_statement', id: fileRow.card_statement_id,
      label: `Card statement${fileRow.card_issuer ? ` — ${fileRow.card_issuer}` : ''}${prov}`,
    });
  }
```

- [ ] **Step 3: Test the labels**

Append to `tests/manual-statements.test.ts`:

```ts
import { buildFileLinks } from '../api/src/lib/manual-booking';
const linksManual = buildFileLinks({ statement_id: 'bs-1', stmt_bank_name: 'HSBC', stmt_source: 'manual' }, []);
ok(linksManual.some(l => l.label.includes('manually entered')), 'linked-records: manual statement labeled');
const linksOcr = buildFileLinks({ card_statement_id: 'cs-1', card_issuer: 'Amex', card_source: 'ocr' }, []);
ok(linksOcr.some(l => l.label.includes('AI-OCR')), 'linked-records: OCR statement labeled');
ok(buildFileLinks({}, []).length === 0, 'linked-records: clean file → no links');
```

- [ ] **Step 4: Run + typecheck + commit**

```bash
npx tsx tests/manual-statements.test.ts && cd api && npx tsc --noEmit 2>&1 | grep -c "error TS"
git add api/src/routes/file-storage.ts api/src/lib/manual-booking.ts
git add -f tests/manual-statements.test.ts
git commit -m "feat(api): linked-records includes manual statement links with provenance

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Upload `skip_ocr` + `'ocr'` stamps in file-storage.ts

**Files:**
- Modify: `api/src/routes/file-storage.ts` (upload handler ~lines 2101-2205; INSERT sites ~168, ~409 bank / ~3094, ~3237 card / ~1243, ~1794 invoices)

**Interfaces:**
- Produces: `POST /file-storage/upload` accepts optional boolean `skip_ocr` → initial `ocr_status='skipped'`. All statements/invoices created by import in this file carry `source='ocr'`.

- [ ] **Step 1: Add the flag**

In `files.post('/upload')`:
1. Destructure `skip_ocr` alongside `description`.
2. Replace `const ocrResult = { text: '', status: 'pending' };` with `const ocrResult = { text: '', status: skip_ocr ? 'skipped' : 'pending' };`

Nothing else changes. (The `wsBroadcast` 'ocr_request' notification fires as before — informational only.)

- [ ] **Step 2: Stamp `source='ocr'` on import-created records**

Enumerate every INSERT this file makes into the three tables:

```bash
grep -n "INSERT INTO bank_statements\|INSERT INTO card_statements\|INSERT INTO invoices" api/src/routes/file-storage.ts
```

For each (expected: bank ~168 + ~409, card ~3094 + ~3237, invoices ~1243 + ~1794), add the `source` column with literal `'ocr'` following that INSERT's existing style (some hardcode literals in VALUES — e.g. the card one at ~3094 hardcodes `'draft'` — append the same way).

- [ ] **Step 3: Verify consumers of `ocr_status`**

```bash
grep -rn "ocr_status" api/src/ | grep -v "file_records"
```

Confirm nothing branches on statuses in a way that treats an unknown value as processing/pending. The `/issues` count (`failed`/`unclear`) intentionally ignores `'skipped'`.

- [ ] **Step 4: Typecheck + commit**

```bash
cd api && npx tsc --noEmit 2>&1 | grep -c "error TS"
git add api/src/routes/file-storage.ts
git commit -m "feat(api): skip_ocr upload flag + source='ocr' stamps on import path

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: `POST /invoices` optional `file_id`

**Files:**
- Modify: `api/src/routes/invoices.ts` (`createSchema` ~line 401, handler ~line 417)

**Interfaces:**
- Produces: `POST /invoices` accepts `file_id?: string` (tenancy-validated); created invoices carry `source='manual'` and the given `file_id`. Frontend Task 12 relies on both.

- [ ] **Step 1: Extend the schema**

In `createSchema`, add after the `expense_category` line:

```ts
  file_id: z.string().optional(),
```

- [ ] **Step 2: Extend the handler**

After the duplicate-invoice check and before the subtotal computation, insert:

```ts
  if (data.file_id) {
    const f = await db.prepare(
      'SELECT id FROM file_records WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    ).bind(data.file_id, tenantId).first();
    if (!f) return c.json({ error: `file_id ${data.file_id} not found for this account` }, 400);
  }
```

Then in the `INSERT INTO invoices` statement: add `file_id, source` to the column list, two more `?` to VALUES, and bind `data.file_id || null, 'manual'` at the end of the bind list. Update the audit `changes` payload to `{ invoice_number: data.invoice_number, total, file_id: data.file_id || null }`.

- [ ] **Step 3: Typecheck + commit**

```bash
cd api && npx tsc --noEmit 2>&1 | grep -c "error TS"
git add api/src/routes/invoices.ts
git commit -m "feat(api): POST /invoices accepts optional file_id; stamps source='manual'

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: DocumentPickerModal `max` prop + `FileAttachmentField`

**Files:**
- Modify: `frontend/src/components/DocumentPickerModal.tsx`
- Create: `frontend/src/components/FileAttachmentField.tsx`

**Interfaces:**
- Produces: `DocumentPickerModal` accepts `max?: number` (default 10). `FileAttachmentField` props: `{ value: PickedFile | null; onChange: (f: PickedFile | null) => void; label?: string }` — used by Tasks 11 and 12.

- [ ] **Step 1: Add the `max` prop to the picker**

In `DocumentPickerModal.tsx`:

1. Signature: add `max` to the props object and type: `… unlinkedOnly?: boolean; max?: number; }`.
2. After the `CATEGORIES` array: `const cap = max ?? MAX_ATTACHMENTS;`
3. Replace `const atCap = sel.length >= MAX_ATTACHMENTS;` with `const atCap = sel.length >= cap;`
4. In `toggle`: `if (prev.length >= cap) return prev;`
5. Footer count: `` `${sel.length}/${cap}` `` and the "Max 10" label becomes `` `${tr('Max', '最多', '最多')} ${cap}` ``.

- [ ] **Step 2: Create `FileAttachmentField.tsx`**

```tsx
import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { tr } from '../lib/i18nHelpers';
import { Paperclip, X, AlertTriangle } from 'lucide-react';
import DocumentPickerModal, { PickedFile } from './DocumentPickerModal';

/** Single-file attachment control with the "already linked elsewhere" warning. */
export default function FileAttachmentField({ value, onChange, label }: {
  value: PickedFile | null;
  onChange: (f: PickedFile | null) => void;
  label?: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const { data: linked } = useQuery({
    queryKey: ['file-linked-records', value?.id],
    queryFn: () => api(`/file-storage/${value!.id}/linked-records`),
    enabled: !!value,
  });
  const links: { kind: string; id: string; label: string }[] = linked?.links || [];

  return (
    <div className="space-y-1">
      <label className="text-xs text-muted-foreground">{label || tr('Supporting file', '附件', '附件')}</label>
      {value ? (
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 px-2 py-1 border rounded-md bg-muted/30 text-sm max-w-full">
            <Paperclip className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{value.filename}</span>
            <button type="button" onClick={() => onChange(null)} className="text-muted-foreground hover:text-destructive shrink-0">
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
          <button type="button" onClick={() => setPickerOpen(true)} className="text-xs text-primary hover:underline">
            {tr('Change', '更換', '更换')}
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setPickerOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-2 border rounded-md text-sm hover:bg-muted">
          <Paperclip className="h-4 w-4" />
          {tr('Attach file', '附加文件', '附加文件')}
        </button>
      )}
      {links.length > 0 && (
        <div className="flex items-start gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-md text-xs text-amber-800 dark:text-amber-200">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">{tr('This file is already linked to:', '此文件已連結至：', '此文件已连结至：')}</p>
            <ul className="list-disc ml-4 mt-0.5">
              {links.map(l => <li key={`${l.kind}-${l.id}`}>{l.label}</li>)}
            </ul>
            <p className="mt-1 text-amber-700 dark:text-amber-300">{tr('You can still attach it.', '仍可繼續附加。', '仍可继续附加。')}</p>
          </div>
        </div>
      )}
      {pickerOpen && (
        <DocumentPickerModal alreadyPicked={[]} max={1}
          onPick={(picked) => onChange(picked[0] || null)}
          onClose={() => setPickerOpen(false)} />
      )}
    </div>
  );
}
```

- [ ] **Step 3: Build + commit**

```bash
cd frontend && npm run build
git add src/components/DocumentPickerModal.tsx src/components/FileAttachmentField.tsx
git commit -m "feat(frontend): picker max prop + FileAttachmentField with linked-records warning

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: FileUpload — "Save without AI Analysis"

**Files:**
- Modify: `frontend/src/pages/FileUpload.tsx` (new handler + button beside "Upload & Analyze" at ~line 720)

**Interfaces:**
- Consumes: Task 6's `skip_ocr` body flag.

- [ ] **Step 1: Add the no-AI upload path**

Inside the `FileUpload` component (after `handleUpload`), add:

```tsx
  const uploadOnly = async (file: File): Promise<void> => {
    const token = localStorage.getItem('token');
    const activeClient = localStorage.getItem('activeClient');
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
    if (activeClient) {
      try { const c = JSON.parse(activeClient); if (c?.id) headers['X-Active-Client'] = c.id; } catch {}
    }
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
    await api('/file-storage/upload', {
      method: 'POST', baseUrl: WORKER_API_BASE,
      body: {
        filename: file.name, original_name: file.name, file_type: file.type, file_size: file.size,
        file_data: base64, folder: channelDef.folder, description, skip_ocr: true,
      },
    });
  };

  const handleUploadNoAi = async () => {
    if (files.length === 0) return;
    setUploading(true);
    setFileErrors({});
    setFileStatuses({});
    let okCount = 0;
    let idx = 0;
    for (const file of files) {
      const fileIdx = idx; idx++;
      setFileStatuses(prev => ({ ...prev, [fileIdx]: 'processing' }));
      try {
        await uploadOnly(file);
        okCount++;
        setFileStatuses(prev => ({ ...prev, [fileIdx]: 'success' }));
      } catch (e: any) {
        setFileStatuses(prev => ({ ...prev, [fileIdx]: 'error' }));
        setFileErrors(prev => ({ ...prev, [fileIdx]: e.message || 'Unknown error' }));
        break;
      }
    }
    setUploading(false);
    if (okCount === 0) return;
    setFiles([]);
    setDescription('');
    setRejected([]);
    queryClient.invalidateQueries({ queryKey: ['file-storage'] });
    toast.success(tr(
      `Saved ${okCount} file(s) without AI analysis — run Analyze later from File Storage.`,
      `已儲存 ${okCount} 個文件（未用 AI 分析）——之後可在文件庫按「分析」。',
      `已储存 ${okCount} 个文件（未用 AI 分析）——之后可在文件库按「分析」。`,
    ));
    setTimeout(() => nav('/file-storage'), 800);
  };
```

- [ ] **Step 2: Add the button**

In the submit row (the `div` containing the Clear / Upload & Analyze buttons, ~line 717), insert between them:

```tsx
              <button onClick={handleUploadNoAi} disabled={uploading}
                className="px-4 py-2 border rounded-md text-sm font-medium hover:bg-muted disabled:opacity-50 flex items-center gap-2">
                {uploading && <Loader2 className="h-4 w-4 animate-spin" />}
                {tr('Save without AI Analysis', '儲存（不用 AI）', '储存（不用 AI）')}
              </button>
```

- [ ] **Step 3: Build + Playwright check + commit**

```bash
cd frontend && npm run build
```

Add to a new `tests/manual-statements.spec.ts` (route-intercepted, non-mutating — follow `tests/manual-booking.spec.ts` for the login/interception harness):

```ts
test('upload page offers no-AI save', async ({ page }) => {
  await page.goto('/file-upload');
  await expect(page.getByRole('button', { name: /Save without AI Analysis|儲存（不用 AI）/ })).toBeVisible();
});
```

```bash
git add frontend/src/pages/FileUpload.tsx
git add -f tests/manual-statements.spec.ts
git commit -m "feat(frontend): Save-without-AI upload option

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: FileStorage — skipped badge, Manually Linked split, Analyze action

**Files:**
- Modify: `frontend/src/pages/FileStorage.tsx` (`FileItem` ~line 105, `summaryStatus` ~line 46, actions area ~line 269)

**Interfaces:**
- Consumes: Task 2's `stmt_source`/`card_source`/`inv_source` list fields; Task 6's `'skipped'` status; existing `/file-storage/:id/import-document`.

- [ ] **Step 1: Extend `FileItem`**

Add after `ocr_status?: string;`:

```ts
  stmt_source?: string;
  card_source?: string;
  inv_source?: string;
```

- [ ] **Step 2: Rework `summaryStatus`**

Replace the final `if (f.invoice_id || f.statement_id || f.card_statement_id)` block and the trailing `Stored` return with:

```ts
  if (f.invoice_id || f.statement_id || f.card_statement_id) {
    const manual = f.stmt_source === 'manual' || f.card_source === 'manual' || f.inv_source === 'manual';
    if (manual) {
      return { label: 'Manually Linked', labelZh: '手動連結', labelCn: '手动连结', cls: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300', tip: 'Manually linked to a record you entered.', tipZh: '已手動連結至您輸入的記錄。', tipCn: '已手动连结至您输入的记录。' };
    }
    return { label: 'AI-OCR Processed', labelZh: 'AI-OCR 已處理', labelCn: 'AI-OCR 已处理', cls: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300', tip: 'Auto-saved and linked to a record.', tipZh: '已自動儲存並連結至記錄。', tipCn: '已自动储存并连结至记录。' };
  }
  if (f.ocr_status === 'skipped') {
    return { label: 'Stored (no AI)', labelZh: '已儲存（未分析）', labelCn: '已储存（未分析）', cls: 'bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-300', tip: 'Saved without AI analysis. Click Analyze to extract data.', tipZh: '已儲存但未用 AI 分析。點擊「分析」以提取資料。', tipCn: '已储存但未用 AI 分析。点击「分析」以提取资料。' };
  }
  return { label: 'Stored', labelZh: '已儲存', labelCn: '已储存', cls: 'bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-300', tip: 'Saved to File Storage only — not linked to a record yet.', tipZh: '僅儲存於文件庫，尚未連結任何記錄。', tipCn: '仅储存于文件库，尚未连结任何记录。' };
```

(Badge priority order stays: encrypted → processing/pending → failed/unclear → needs-review → linked (split) → skipped → stored — a skipped file that later got manually linked shows "Manually Linked".)

- [ ] **Step 3: Add the Analyze button**

Add a module-level component in `FileStorage.tsx` (after `summaryStatus`):

```tsx
function AnalyzeButton({ f, onEncrypted }: { f: FileItem; onEncrypted: (f: FileItem) => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [running, setRunning] = useState(false);
  async function run() {
    setRunning(true);
    try {
      const headers: Record<string, string> = { 'Authorization': `Bearer ${localStorage.getItem('token') || ''}` };
      const activeClient = localStorage.getItem('activeClient');
      if (activeClient) { try { const c = JSON.parse(activeClient); if (c?.id) headers['X-Active-Client'] = c.id; } catch {} }
      const resp = await fetch(`${WORKER_API_BASE}/file-storage/${f.id}/import-document`, { method: 'POST', headers });
      const result = await resp.json().catch(() => ({}));
      if (result?.status === 'password_required' || result?.type === 'encrypted_pdf') { onEncrypted(f); return; }
      if (result?.error) throw new Error(result.error);
      if (result?.ocr_failed) throw new Error(tr(
        'Could not read this document. The file may be blurry or in an unsupported format.',
        '無法讀取此文件。文件可能模糊或格式不支援。',
        '无法读取此文件。文件可能模糊或格式不支持。',
      ));
      toast.success(tr('Analysis complete — records are ready for review.', '分析完成——記錄已可審核。', '分析完成——记录已可审核。'));
      queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0] || '').startsWith('file-storage') });
    } catch (e: any) {
      toast.error(e?.message || tr('Analysis failed', '分析失敗', '分析失败'));
    } finally {
      setRunning(false);
    }
  }
  return (
    <button onClick={(e) => { e.stopPropagation(); run(); }} disabled={running}
      title={tr('Run AI analysis on this file', '對此文件執行 AI 分析', '对此文件执行 AI 分析')}
      className="p-1 hover:bg-amber-100 rounded text-amber-600 inline-flex disabled:opacity-50">
      {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
    </button>
  );
}
```

Ensure `Loader2` and `Sparkles` are imported from `lucide-react` (add to the existing import if missing). In the file-row actions `<div className="flex gap-1 ml-2 shrink-0">`, add as the FIRST action:

```tsx
                {f.ocr_status === 'skipped' && (
                  <AnalyzeButton f={f} onEncrypted={onUnlockEncrypted} />
                )}
```

(`onUnlockEncrypted` is already threaded through `FolderTree` and opens the page-level `EncryptedPdfModal` via `setEncryptedPdf` — verify by reading the page's handler before wiring.)

- [ ] **Step 4: Build + Playwright check + commit**

Add to `tests/manual-statements.spec.ts`:

```ts
test('file storage badge states render', async ({ page }) => {
  // route-intercept GET */file-storage → one skipped file, one manually-linked file
  await page.route('**/api/file-storage?**', route => route.fulfill({ json: { data: [
    { id: 'fs-skip', filename: 'a.pdf', file_type: 'application/pdf', file_size: 100, folder: 'Bank Statements', created_at: '2026-08-27T00:00:00Z', ocr_status: 'skipped' },
    { id: 'fs-manual', filename: 'b.pdf', file_type: 'application/pdf', file_size: 100, folder: 'Bank Statements', created_at: '2026-08-27T00:00:00Z', ocr_status: 'skipped', statement_id: 'bs-1', stmt_source: 'manual' },
  ] } }));
  await page.goto('/file-storage');
  await expect(page.getByText('Stored (no AI)')).toBeVisible();
  await expect(page.getByText('Manually Linked')).toBeVisible();
});
```

Adapt the route URL/pattern to how the page actually fetches (read the page's `useQuery` first; match its real key and endpoint).

```bash
cd frontend && npm run build
git add frontend/src/pages/FileStorage.tsx && git add -f tests/manual-statements.spec.ts
git commit -m "feat(frontend): skipped/no-AI badge, Manually Linked split, Analyze action

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: Statement pages — manual entry editors + Link File

**Files:**
- Create: `frontend/src/components/ManualStatementEntry.tsx`
- Modify: `frontend/src/pages/BankStatements.tsx` (header ~line 410, expanded statement detail area, row rendering)
- Modify: `frontend/src/pages/CardStatements.tsx` (header ~line 199, expanded detail, row rendering)

**Interfaces:**
- Consumes: Task 3/4 endpoints; Task 8's `FileAttachmentField`; Tasks 3/4's list fields `r2_key`, `source_file_id`, `source`.
- Produces: `ManualBankStatementEntry` and `ManualCardStatementEntry` components, props `{ open: boolean; onClose: () => void }` — they navigate to the review page themselves on save.

- [ ] **Step 1: Create the editors**

Create `frontend/src/components/ManualStatementEntry.tsx`. Bank editor (complete):

```tsx
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import { tr } from '../lib/i18nHelpers';
import { Plus, Trash2, Loader2, FilePlus } from 'lucide-react';
import FileAttachmentField from './FileAttachmentField';
import { PickedFile } from './DocumentPickerModal';

interface BankRow { date: string; desc: string; deposit: string; withdrawal: string; balance: string }
const emptyBankRow: BankRow = { date: '', desc: '', deposit: '', withdrawal: '', balance: '' };

export function ManualBankStatementEntry({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [bankName, setBankName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [year, setYear] = useState(new Date().getFullYear());
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [openingBalance, setOpeningBalance] = useState('');
  const [closingBalance, setClosingBalance] = useState('');
  const [rows, setRows] = useState<BankRow[]>([{ ...emptyBankRow }]);
  const [file, setFile] = useState<PickedFile | null>(null);

  const saveMut = useMutation({
    mutationFn: (body: any) => api('/bank-statements/manual', { method: 'POST', body }),
    onSuccess: (r: any) => {
      queryClient.invalidateQueries({ queryKey: ['bank-statements'] });
      queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0] || '').startsWith('file-storage') });
      toast.success(tr('Manual statement created — review to post.', '已建立手動月結單——審核後入帳。', '已建立手动月结单——审核后入账。'));
      onClose();
      nav(`/bank-statements/review/${r.id}`);
    },
    onError: (e: any) => toast.error(e?.message || tr('Create failed', '建立失敗', '建立失败')),
  });

  if (!open) return null;

  function setRow(i: number, patch: Partial<BankRow>) {
    setRows(prev => prev.map((r, idx) => {
      if (idx !== i) return r;
      const next = { ...r, ...patch };
      if (patch.deposit !== undefined && Number(patch.deposit) > 0) next.withdrawal = '';
      if (patch.withdrawal !== undefined && Number(patch.withdrawal) > 0) next.deposit = '';
      return next;
    }));
  }

  function submit() {
    if (!bankName.trim()) { toast.error(tr('Bank name is required', '請填寫銀行名稱', '请填写银行名称')); return; }
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) { toast.error(tr(`Row ${i + 1}: date must be YYYY-MM-DD`, `第 ${i + 1} 行：日期格式須為 YYYY-MM-DD`, `第 ${i + 1} 行：日期格式须为 YYYY-MM-DD`)); return; }
      if (!r.desc.trim()) { toast.error(tr(`Row ${i + 1}: description required`, `第 ${i + 1} 行：請填寫描述`, `第 ${i + 1} 行：请填写描述`)); return; }
      if (!(Number(r.deposit) > 0) && !(Number(r.withdrawal) > 0)) { toast.error(tr(`Row ${i + 1}: enter a deposit or a withdrawal`, `第 ${i + 1} 行：請填寫存款或提款金額`, `第 ${i + 1} 行：请填写存款或提款金额`)); return; }
    }
    saveMut.mutate({
      bank_name: bankName.trim(),
      account_number: accountNumber.trim() || null,
      statement_year: year, statement_month: month,
      opening_balance: openingBalance === '' ? null : Number(openingBalance),
      closing_balance: closingBalance === '' ? null : Number(closingBalance),
      source_file_id: file?.id || null,
      transactions: rows.map(r => ({
        transaction_date: r.date, description: r.desc.trim(),
        deposit_amount: Number(r.deposit) || 0, withdrawal_amount: Number(r.withdrawal) || 0,
        balance: r.balance === '' ? 0 : Number(r.balance),
      })),
    });
  }

  return (
    <div className="bg-card border rounded-xl p-4 mb-4 space-y-3">
      <h3 className="font-bold flex items-center gap-2"><FilePlus className="h-4 w-4" /> {tr('Manual Bank Statement', '手動銀行月結單', '手动银行月结单')}</h3>
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
        <input value={bankName} onChange={e => setBankName(e.target.value)} placeholder={tr('Bank name *', '銀行名稱 *', '银行名称 *')} className="px-3 py-2 border rounded-md bg-background text-sm col-span-2" />
        <input value={accountNumber} onChange={e => setAccountNumber(e.target.value)} placeholder={tr('Account no.', '帳號', '账号')} className="px-3 py-2 border rounded-md bg-background text-sm col-span-2" />
        <input type="number" value={year} onChange={e => setYear(Number(e.target.value))} className="px-3 py-2 border rounded-md bg-background text-sm" />
        <select value={month} onChange={e => setMonth(Number(e.target.value))} className="px-3 py-2 border rounded-md bg-background text-sm">
          {Array.from({ length: 12 }, (_, i) => i + 1).map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <input value={openingBalance} onChange={e => setOpeningBalance(e.target.value)} type="number" step="0.01" placeholder={tr('Opening bal.', '期初結餘', '期初结余')} className="px-3 py-2 border rounded-md bg-background text-sm" />
        <input value={closingBalance} onChange={e => setClosingBalance(e.target.value)} type="number" step="0.01" placeholder={tr('Closing bal.', '期末結餘', '期末结余')} className="px-3 py-2 border rounded-md bg-background text-sm" />
      </div>
      <FileAttachmentField value={file} onChange={setFile} />
      <div className="border rounded-md overflow-hidden">
        <div className="grid grid-cols-[110px_1fr_100px_100px_110px_28px] gap-1 px-2 py-1 bg-muted/50 text-xs font-medium">
          <span>{tr('Date', '日期', '日期')}</span><span>{tr('Description', '描述', '描述')}</span>
          <span>{tr('Deposit', '存款', '存款')}</span><span>{tr('Withdrawal', '提款', '提款')}</span><span>{tr('Balance', '結餘', '结余')}</span><span />
        </div>
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[110px_1fr_100px_100px_110px_28px] gap-1 px-2 py-1 border-t items-center">
            <input type="date" value={r.date} onChange={e => setRow(i, { date: e.target.value })} className="px-1.5 py-1 border rounded bg-background text-xs" />
            <input value={r.desc} onChange={e => setRow(i, { desc: e.target.value })} className="px-1.5 py-1 border rounded bg-background text-xs" />
            <input type="number" step="0.01" value={r.deposit} onChange={e => setRow(i, { deposit: e.target.value })} className="px-1.5 py-1 border rounded bg-background text-xs" />
            <input type="number" step="0.01" value={r.withdrawal} onChange={e => setRow(i, { withdrawal: e.target.value })} className="px-1.5 py-1 border rounded bg-background text-xs" />
            <input type="number" step="0.01" value={r.balance} onChange={e => setRow(i, { balance: e.target.value })} className="px-1.5 py-1 border rounded bg-background text-xs" />
            <button type="button" onClick={() => setRows(prev => prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev)} className="text-destructive" title={tr('Remove row', '刪除行', '删除行')}><Trash2 className="h-3.5 w-3.5" /></button>
          </div>
        ))}
        <button type="button" onClick={() => setRows(prev => [...prev, { ...emptyBankRow }])}
          className="flex items-center gap-1 px-2 py-1.5 text-xs text-primary hover:underline border-t w-full">
          <Plus className="h-3 w-3" /> {tr('Add row', '加一行', '加一行')}
        </button>
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 border rounded-md text-sm">{tr('Cancel', '取消', '取消')}</button>
        <button onClick={submit} disabled={saveMut.isPending}
          className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium flex items-center gap-2 disabled:opacity-50">
          {saveMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {tr('Save & Review', '儲存並審核', '储存并审核')}
        </button>
      </div>
    </div>
  );
}
```

Then add `ManualCardStatementEntry` in the same file — identical chrome, differing grid/model:

- Header fields: `card_issuer *`, `card_network` (text), `card_number_last4`, `cardholder_name`, year, month (same pickers).
- Grid columns: date · description · amount (positive) · type (`select`: purchase/payment/refund/fee/interest/cash_advance, optional blank) — `grid-cols-[110px_1fr_100px_130px_28px]`.
- POST body: `card_statements/manual` with `transactions: rows.map(r => ({ transaction_date: r.date, description: r.desc, amount: Number(r.amount) || 0, transaction_type: r.type || null }))`.
- Validation: issuer required; per row: date, description, `amount > 0`.
- On success: invalidate `['card-statements']` + file-storage; `nav(\`/card-statements/review/${r.id}\`)`.

- [ ] **Step 2: Wire the pages**

For **BankStatements.tsx**:
1. Import `{ ManualBankStatementEntry }` from the new component file, plus `DocumentPickerModal`; add state: `const [manualOpen, setManualOpen] = useState(false);` and `const [linkFileFor, setLinkFileFor] = useState<string | null>(null);`.
2. In the header actions cluster (near `<h2 className="text-2xl font-bold">{t('bank.title')}</h2>`, ~line 410), add a button:
   ```tsx
   <button onClick={() => setManualOpen(true)}
     className="flex items-center gap-1.5 bg-primary text-primary-foreground px-3 py-2 rounded-md text-sm font-medium hover:opacity-90">
     <FilePlus className="h-4 w-4" /> {tr('Manual Entry', '手動輸入', '手动输入')}
   </button>
   ```
   (import `FilePlus` — already in the page's lucide import list).
3. Render `<ManualBankStatementEntry open={manualOpen} onClose={() => setManualOpen(false)} />` directly above the statements list.
4. In each statement row's summary line, where `file_name`/bank info renders, add a provenance chip when `s.source === 'manual'`:
   ```tsx
   {s.source === 'manual' && (
     <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300">{tr('Manual', '手動', '手动')}</span>
   )}
   ```
5. In the expanded statement detail area (where the CSV import button renders, ~line 567), add a **Link File** button when `!detail?.r2_key`:
   ```tsx
   {!detail?.r2_key && (
     <button onClick={() => setLinkFileFor(detail?.id || null)}
       className="flex items-center gap-1 px-2 py-0.5 text-xs rounded border hover:bg-muted"
       title={tr('Link a supporting file to this manually-entered statement', '為此手動月結單連結附件', '为此手动月结单连结附件')}>
       <Link2 className="h-3 w-3" /> {tr(detail?.source_file_id ? 'Change File' : 'Link File', '連結文件', '连结文件')}
     </button>
   )}
   ```
   And at page bottom, the picker + mutation:
   ```tsx
   {linkFileFor && (
     <DocumentPickerModal alreadyPicked={[]} max={1}
       onPick={async (picked) => {
         const id = linkFileFor; setLinkFileFor(null);
         if (!picked[0]) return;
         try {
           await api(`/bank-statements/${id}/link-file`, { method: 'PUT', body: { file_id: picked[0].id } });
           toast.success(tr('File linked.', '已連結文件。', '已连结文件。'));
           queryClient.invalidateQueries({ queryKey: ['bank-statements'] });
           queryClient.invalidateQueries({ queryKey: ['bank-statement', id] });
         } catch (e: any) { toast.error(e?.message || tr('Link failed', '連結失敗', '连结失败')); }
       }}
       onClose={() => setLinkFileFor(null)} />
   )}
   ```
   (Check the page's actual detail-query key — it is keyed by the expanded id; reuse that key. `DocumentPickerModal` and `Link2` need imports.)
6. Spec §6.4 — the linked file renders as a chip next to the Link File button once `detail?.source_file_id` is set:
   ```tsx
   {detail?.source_file_id && (
     <a href={`/file-storage?highlight=${detail.source_file_id}`}
       className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-border text-xs hover:bg-muted"
       title={tr('Open the linked file in File Storage', '到文件庫開啟已連結文件', '到文件库开启已连结文件')}>
       <Link2 className="h-3 w-3" /> {tr('Linked file', '已連結文件', '已连结文件')}
     </a>
   )}
   ```

For **CardStatements.tsx**: mirror every step (header button at ~line 199 using `ManualCardStatementEntry`, provenance chip, Link File + linked-file chip in the expanded area with `PUT /card-statements/:id/link-file`, detail key `['card-statement', id]`).

- [ ] **Step 3: Build + Playwright check + commit**

Add to `tests/manual-statements.spec.ts`:

```ts
test('statement pages offer manual entry', async ({ page }) => {
  await page.goto('/bank-statements');
  await expect(page.getByRole('button', { name: /Manual Entry|手動輸入/ })).toBeVisible();
  await page.goto('/card-statements');
  await expect(page.getByRole('button', { name: /Manual Entry|手動輸入/ })).toBeVisible();
});
```

```bash
cd frontend && npm run build
git add frontend/src/components/ManualStatementEntry.tsx frontend/src/pages/BankStatements.tsx frontend/src/pages/CardStatements.tsx
git add -f tests/manual-statements.spec.ts
git commit -m "feat(frontend): manual statement entry editors + Link File on statement pages

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 12: Invoice create modals — file attachment (3 pages)

**Files:**
- Modify: `frontend/src/pages/Invoices.tsx` (Create Receipt modal; `form` state ~line 60, modal ~line 452)
- Modify: `frontend/src/pages/AR.tsx` (create modal, mutation at ~line 104)
- Modify: `frontend/src/pages/AP.tsx` (create modal, mutation at ~line 106)

**Interfaces:**
- Consumes: Task 7's `file_id` on `POST /invoices`; Task 8's `FileAttachmentField`.

- [ ] **Step 1: Wire each modal identically**

In each of the three pages:
1. Import `FileAttachmentField` and `PickedFile`.
2. Add state near the form state: `const [attachFile, setAttachFile] = useState<PickedFile | null>(null);`
3. Inside the create modal's form (after the items/total section, before the Cancel/Create buttons), add:
   ```tsx
   <FileAttachmentField value={attachFile} onChange={setAttachFile} label={tr('Attach supporting file', '附加文件', '附加文件')} />
   ```
4. In the submit handler's `createMut.mutate({ … })` body, add `file_id: attachFile?.id || undefined,`.
5. In the mutation's `onSuccess`, add `setAttachFile(null);`.

Read each page's actual handler first — Invoices.tsx's `handleSubmit` (~line 145) and the AR/AP equivalents; the spread bodies differ slightly but the two insertions are the same shape.

- [ ] **Step 2: Build + commit**

```bash
cd frontend && npm run build
git add frontend/src/pages/Invoices.tsx frontend/src/pages/AR.tsx frontend/src/pages/AP.tsx
git commit -m "feat(frontend): attach supporting file in all three invoice create modals

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 13: Deploy + live round-trip

**Files:**
- Create: `tests/manual-statements-live.ts` (throwaway, force-add)

**Interfaces:** Consumes everything; produces deployed URLs recorded in memory.

- [ ] **Step 1: Run the migration on remote D1 + verify**

```bash
cd api
npx wrangler d1 execute opcc-crm-db --remote --file=src/db/migration-manual-statements.sql
npx wrangler d1 execute opcc-crm-db --remote --command "PRAGMA table_info(bank_statements)"
npx wrangler d1 execute opcc-crm-db --remote --command "PRAGMA table_info(card_statements)"
npx wrangler d1 execute opcc-crm-db --remote --command "PRAGMA table_info(invoices)"
```

Each PRAGMA must list the new columns.

- [ ] **Step 2: Deploy the API worker**

```bash
cd api && npx wrangler deploy
```

Record the version id from the output.

- [ ] **Step 3: Write and run the live round-trip**

`tests/manual-statements-live.ts` (tsx, follows `tests/manual-booking-live.ts`'s login + cleanup patterns; test tenant: Joseph Lin → client `u-8e3759d7` or `u-a21aaae1` via `X-Active-Client` — see the `pnr-context` skill for credentials):

1. Login once (avoid repeated `/auth/login` — shared worker throttles it).
2. Upload a small test PDF with `skip_ocr: true` → assert `ocr_status === 'skipped'` in the file list; assert the file appears in `GET /file-storage?unlinked=1`.
3. `POST /bank-statements/manual` with 2 transactions + `source_file_id` from step 2 → assert 201; assert `status='draft'`.
4. Assert the file no longer appears in `?unlinked=1`; `GET /file-storage/:id/linked-records` → one `bank_statement` link labeled "manually entered".
5. Validation checks: row with both amounts → 400; `source_file_id` of another tenant → 400.
6. `PUT /bank-statements/:id/link-file` with a second uploaded file → replace works (200), audit reflects old→new.
7. `POST /card-statements/manual` minimal (issuer + 1 tx) → 201.
8. `POST /invoices` with `file_id` → 201; linked-records shows the invoice.
9. Statement review round-trip: `GET /bank-statements/:id/review` → confirm (existing flow) → JEs generated → `GET /bookkeeping/entries?reference_type=bank_transaction` finds them.
10. **Cleanup (hard):** delete the created JEs (tombstone via DELETE /bookkeeping/entries/:id or direct D1 cleanup script following the manual-booking-live pattern), delete statements (`DELETE /bank-statements/:id` cascades transactions), hard-delete both test `file_records` rows + R2 objects (pattern in `api/hard-delete-joseph-uploads.sql`), delete the test invoice, delete audit rows for all created ids.

- [ ] **Step 4: Deploy the frontend**

Use the project's standard Pages deploy command — read `DEPLOYMENT_CONTEXT.md` first and match how previous deploys were made (historically `npx wrangler pages deploy` from `frontend/` against the `opcc-crm` Pages project / `opcc-crm-testing` for test builds).

- [ ] **Step 5: Verify on the deployed frontend**

Log in as Joseph Lin, pick the test client, and click through: Bank Statements → Manual Entry → editor opens; FileUpload → both buttons visible; FileStorage → Analyze on a skipped file. Fix anything broken, redeploy, re-verify.

- [ ] **Step 6: Record + report**

Commit the live script (`git add -f tests/manual-statements-live.ts` + commit). Save deployed URLs (API version + Pages URL) to memory per the TeCS convention, and **report the frontend testing URL to the user** (house rule after every deploy).

---

## Self-Review notes (already applied)

- Spec §5.2's "no closed-period guard on creation" is honored — manual routes create drafts only; the period guard applies at JE confirm (existing).
- Spec §5.6's "unlinked filter needs no change" is honored — Task 2 only extends joins.
- The plan deliberately does NOT add period-dedup 409s to the manual endpoints (spec §5.2 validation list is exhaustive; manual entry is a deliberate action — re-keying a corrected period is legitimate).
- `import-csv` endpoints already exist on statements (`POST /:id/import-csv`) — untouched, no conflict with `/manual` (different literal).
