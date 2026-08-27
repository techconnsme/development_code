# Manual Statement Entry, File Linking & No-OCR Upload — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add manual bank/card statement entry, file linking for manually-created records, and a no-OCR upload option to the bookkeeping subpages.

**Architecture:** Extend existing statement and invoice endpoints with `source_file_id`/`source` columns for provenance tracking. Add `POST …/manual` endpoints for bank and card statements. Extend `linked-records` and `buildFileListSql` with OR-joins for manual links. Frontend: "Save without AI Analysis" button on FileUpload, manual entry editors on statement pages, file attachment on Create Invoice modal, and provenance-aware badges on File Storage.

**Tech Stack:** Cloudflare Worker (Hono) + D1 (SQLite) + R2; React + TypeScript + TanStack Query + Tailwind; `tr()` EN/繁/简 i18n; Playwright for non-mutating specs.

**Spec:** `docs/superpowers/specs/2026-08-27-manual-statements-file-linking-design.md` — read it before starting.

## Global Constraints

- **CONCURRENT SESSION:** Another AI agent session may be editing this codebase. All work happens in an isolated git worktree. Never run `git add -A` / `git add .` / `git commit -a` — always add files by explicit path. Never stash, revert, or commit changes that are not yours.
- `tsc` baseline must stay identical (zero new errors in touched files).
- `npm run build` clean after every frontend task.
- All user-facing strings via `tr()` with EN/繁/简.
- Every write audit-logged via the file-local `auditLog()` helper.
- Tenancy: `const tenantId = c.get('client_user_id') || user.id`.
- Migration = plain SQL applied via `wrangler d1 execute`; verify with `PRAGMA table_info` — never assume applied.
- Tests: throwaway `npx tsx tests/*.test.ts` with mock db; Playwright non-mutating.
- Commit only by explicit path. Co-Authored-By trailer on every commit.

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `api/src/db/migration-manual-statements.sql` | Schema migration: `source_file_id`, `source` columns + indexes |
| Modify | `api/src/db/schema.sql` | Add new columns to fresh-DB schema |
| Modify | `api/src/routes/bank-statements.ts` | Add `POST /manual` endpoint + stamp `source='ocr'` on import |
| Modify | `api/src/routes/card-statements.ts` | Add `POST /manual` endpoint + stamp `source='ocr'` on import + `PUT /:id/link-file` |
| Modify | `api/src/routes/file-storage.ts` | Extend `linked-records` OR-join; add `PUT /:id/link-file` for bank stmts |
| Modify | `api/src/routes/invoices.ts` | Add `file_id` to `createSchema`; stamp `source='ocr'` on import |
| Modify | `api/src/lib/list-filters.ts` | Extend `buildFileListSql` with OR-join + source columns |
| Modify | `api/src/lib/manual-booking.ts` | Extend `buildFileLinks` to show provenance labels |
| Modify | `frontend/src/pages/FileUpload.tsx` | "Save without AI Analysis" second submit button |
| Modify | `frontend/src/pages/FileStorage.tsx` | `'skipped'` badge + Analyze action + provenance-aware badges |
| Modify | `frontend/src/pages/BankStatements.tsx` | "+ Manual Entry" button + inline editor + "Link File" action |
| Modify | `frontend/src/pages/CardStatements.tsx` | "+ Manual Entry" button + inline editor + "Link File" action |
| Modify | `frontend/src/pages/Invoices.tsx` | File attachment section in Create Invoice modal |
| Create | `tests/manual-statements.test.ts` | Mock-db tests for validation, linking, badge logic |
| Create | `tests/manual-statements.spec.ts` | Playwright non-mutating checks |

---

### Task 1: Database Migration

**Files:**
- Create: `api/src/db/migration-manual-statements.sql`
- Modify: `api/src/db/schema.sql`

**Interfaces:**
- Produces: `source_file_id TEXT`, `source TEXT` on `bank_statements`, `card_statements`; `source TEXT` on `invoices`; two indexes.

- [ ] **Step 1: Create the migration file**

```sql
-- api/src/db/migration-manual-statements.sql
-- Manual statement entry + file linking (2026-08-27)

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

In `api/src/db/schema.sql`, find the `CREATE TABLE bank_statements` block and add before the closing `)`:

```sql
  source_file_id TEXT,
  source TEXT,
```

Do the same for `card_statements`. For `invoices`, add `source TEXT,` before the closing `)`.

- [ ] **Step 3: Run migration on dev DB and verify**

```bash
cd Tech_Connect_SME/Development_code/latest_code
wrangler d1 execute opcc-crm-db --file=api/src/db/migration-manual-statements.sql --remote
wrangler d1 execute opcc-crm-db --command="PRAGMA table_info(bank_statements)" --remote | grep source
wrangler d1 execute opcc-crm-db --command="PRAGMA table_info(card_statements)" --remote | grep source
wrangler d1 execute opcc-crm-db --command="PRAGMA table_info(invoices)" --remote | grep source
```

Expected: `source_file_id` and `source` appear on bank/card; `source` on invoices.

- [ ] **Step 4: Commit**

```bash
git add api/src/db/migration-manual-statements.sql api/src/db/schema.sql
git commit -m "feat(db): manual statement entry — source_file_id + source columns

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Backend — Bank Statement Manual Endpoint + OCR Source Stamp

**Files:**
- Modify: `api/src/routes/bank-statements.ts`

**Interfaces:**
- Produces: `POST /bank-statements/manual` → `{ id, transaction_count }`; existing import INSERTs stamp `source='ocr'`.

- [ ] **Step 1: Add `source='ocr'` to existing import INSERTs**

In `api/src/routes/bank-statements.ts`, find the two `INSERT INTO bank_statements` blocks (around lines 1327 and 1397). Add `source` to the column list and `'ocr'` to the VALUES. Example for the first one:

```sql
INSERT INTO bank_statements (id, user_id, file_name, file_type, file_data, r2_key,
  bank_name, account_number, branch, currency, account_type,
  statement_year, statement_month, period_start, period_end,
  opening_balance, closing_balance, page_count, ocr_text, source)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
```

And add `'ocr'` as the last bind parameter. Do the same for the second INSERT block (around line 1397).

- [ ] **Step 2: Add `POST /bank-statements/manual` endpoint**

Register this BEFORE any `/:id` param routes in the file. Add after the existing import endpoint:

```typescript
// ── Manual statement entry (no OCR) ──
bank.post('/manual', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const body = await c.req.json();
  const {
    bank_name, account_number, branch, currency,
    statement_year, statement_month, period_start, period_end,
    opening_balance, closing_balance, source_file_id,
    transactions,
  } = body as any;

  if (!bank_name?.trim()) return c.json({ error: 'bank_name is required' }, 400);
  if (!Array.isArray(transactions) || transactions.length === 0 || transactions.length > 500) {
    return c.json({ error: 'transactions must be 1–500 rows' }, 400);
  }

  // Validate source_file_id tenancy
  if (source_file_id) {
    const fileRow = await db.prepare(
      'SELECT id FROM file_records WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    ).bind(source_file_id, tenantId).first();
    if (!fileRow) return c.json({ error: `file_records id ${source_file_id} not found or not yours` }, 400);
  }

  // Validate transactions
  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    if (!tx.transaction_date || !/^\d{4}-\d{2}-\d{2}$/.test(tx.transaction_date)) {
      return c.json({ error: `Row ${i + 1}: transaction_date must be YYYY-MM-DD` }, 400);
    }
    if (!tx.description?.trim()) {
      return c.json({ error: `Row ${i + 1}: description is required` }, 400);
    }
    const hasDeposit = (tx.deposit_amount || 0) > 0;
    const hasWithdrawal = (tx.withdrawal_amount || 0) > 0;
    if (hasDeposit === hasWithdrawal) {
      return c.json({ error: `Row ${i + 1}: must have exactly one of deposit_amount or withdrawal_amount > 0` }, 400);
    }
  }

  const id = `bs-${uuidv4().slice(0, 8)}`;
  const fileName = `Manual — ${bank_name.trim()} ${statement_year || ''}-${String(statement_month || '').padStart(2, '0')}`.trim();

  await db.prepare(
    `INSERT INTO bank_statements (id, user_id, file_name, file_type, file_data, r2_key,
     bank_name, account_number, branch, currency, account_type,
     statement_year, statement_month, period_start, period_end,
     opening_balance, closing_balance, page_count, ocr_text, source, source_file_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, tenantId, fileName, 'application/pdf', '', null,
    bank_name.trim(), account_number || null, branch || null,
    currency || 'HKD', null,
    statement_year || null, statement_month || null,
    period_start || null, period_end || null,
    opening_balance ?? null, closing_balance ?? null,
    null, '', 'manual', source_file_id || null
  ).run();

  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    await db.prepare(
      `INSERT INTO bank_transactions (id, bank_statement_id, user_id, transaction_date, description,
       deposit_amount, withdrawal_amount, balance, account_type, reference, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      `bt-${uuidv4().slice(0, 8)}`, id, tenantId,
      tx.transaction_date, tx.description.trim(),
      tx.deposit_amount || 0, tx.withdrawal_amount || 0, tx.balance ?? 0,
      tx.account_type || null, tx.reference || null, i
    ).run();
  }

  await auditLog(db, tenantId, 'create', 'bank_statement', id, {
    source: 'manual', transactions: transactions.length, source_file_id: source_file_id || null,
  });
  return c.json({ id, transaction_count: transactions.length }, 201);
});
```

- [ ] **Step 3: Verify tsc compiles**

```bash
cd Tech_Connect_SME/Development_code/latest_code
npx tsc --noEmit 2>&1 | head -20
```

Expected: no new errors in `bank-statements.ts`.

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/bank-statements.ts
git commit -m "feat(api): manual bank statement endpoint + OCR source stamp

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Backend — Card Statement Manual Endpoint + Link-File + OCR Source Stamp

**Files:**
- Modify: `api/src/routes/card-statements.ts`

**Interfaces:**
- Produces: `POST /card-statements/manual` → `{ id, transaction_count }`; `PUT /card-statements/:id/link-file`; existing import INSERT stamps `source='ocr'`.

- [ ] **Step 1: Add `source='ocr'` to the existing import INSERT**

Find `INSERT INTO card_statements` around line 264. Add `source` to the column list and `'ocr'` as the last value.

- [ ] **Step 2: Add `POST /card-statements/manual` endpoint**

Register BEFORE `/:id` param routes:

```typescript
// ── Manual card statement entry (no OCR) ──
card.post('/manual', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const body = await c.req.json();
  const {
    card_issuer, card_network, card_number_last4, cardholder_name, currency,
    statement_year, statement_month, period_start, period_end,
    credit_limit, opening_balance, closing_balance, minimum_payment, payment_due_date,
    source_file_id, transactions,
  } = body as any;

  if (!card_issuer?.trim()) return c.json({ error: 'card_issuer is required' }, 400);
  if (!Array.isArray(transactions) || transactions.length === 0 || transactions.length > 500) {
    return c.json({ error: 'transactions must be 1–500 rows' }, 400);
  }

  if (source_file_id) {
    const fileRow = await db.prepare(
      'SELECT id FROM file_records WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    ).bind(source_file_id, tenantId).first();
    if (!fileRow) return c.json({ error: `file_records id ${source_file_id} not found or not yours` }, 400);
  }

  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    if (!tx.transaction_date || !/^\d{4}-\d{2}-\d{2}$/.test(tx.transaction_date)) {
      return c.json({ error: `Row ${i + 1}: transaction_date must be YYYY-MM-DD` }, 400);
    }
    if (!tx.description?.trim()) {
      return c.json({ error: `Row ${i + 1}: description is required` }, 400);
    }
  }

  const id = `cs-${uuidv4().slice(0, 8)}`;
  const fileName = `Manual — ${card_issuer.trim()} ${statement_year || ''}-${String(statement_month || '').padStart(2, '0')}`.trim();

  await db.prepare(
    `INSERT INTO card_statements (id, user_id, file_name, file_type, file_data, r2_key,
     card_issuer, card_network, card_number_last4, cardholder_name, currency,
     statement_year, statement_month, period_start, period_end,
     credit_limit, opening_balance, closing_balance, minimum_payment, payment_due_date,
     ocr_text, status, source, source_file_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, tenantId, fileName, 'application/pdf', '', null,
    card_issuer.trim(), card_network || null, card_number_last4 || null, cardholder_name || null,
    currency || 'HKD', statement_year || null, statement_month || null,
    period_start || null, period_end || null,
    credit_limit ?? null, opening_balance ?? null, closing_balance ?? null,
    minimum_payment ?? null, payment_due_date || null, '', 'draft', 'manual', source_file_id || null
  ).run();

  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    await db.prepare(
      `INSERT INTO card_transactions (id, card_statement_id, user_id, transaction_date, posting_date,
       description, amount, transaction_type, foreign_currency, foreign_amount, category, reference, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      `ct-${uuidv4().slice(0, 8)}`, id, tenantId,
      tx.transaction_date, tx.posting_date || null, tx.description.trim(),
      tx.amount || 0, tx.transaction_type || null, tx.foreign_currency || null,
      tx.foreign_amount || null, tx.category || null, tx.reference || null, i
    ).run();
  }

  await auditLog(db, tenantId, 'create', 'card_statement', id, {
    source: 'manual', transactions: transactions.length, source_file_id: source_file_id || null,
  });
  return c.json({ id, transaction_count: transactions.length }, 201);
});
```

- [ ] **Step 3: Add `PUT /card-statements/:id/link-file` endpoint**

```typescript
// ── Link file to statement ──
card.put('/:id/link-file', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const id = c.req.param('id');
  const body = await c.req.json();
  const { file_id } = body as { file_id: string };

  const existing = await db.prepare(
    'SELECT id, source_file_id FROM card_statements WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(id, tenantId).first<{ id: string; source_file_id: string | null }>();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  if (file_id) {
    const fileRow = await db.prepare(
      'SELECT id FROM file_records WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    ).bind(file_id, tenantId).first();
    if (!fileRow) return c.json({ error: `file_records id ${file_id} not found or not yours` }, 400);
  }

  const replacedFileId = existing.source_file_id;
  await db.prepare(
    "UPDATE card_statements SET source_file_id = ?, updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL"
  ).bind(file_id || null, id).run();

  await auditLog(db, tenantId, 'update', 'card_statement', id, {
    linked_file_id: file_id || null, replaced_file_id: replacedFileId,
  });
  return c.json({ success: true, id });
});
```

- [ ] **Step 4: Verify tsc compiles**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/card-statements.ts
git commit -m "feat(api): manual card statement endpoint + link-file + OCR source stamp

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Backend — Bank Statement Link-File + Linked-Records OR-Join

**Files:**
- Modify: `api/src/routes/file-storage.ts`

**Interfaces:**
- Produces: `PUT /bank-statements/:id/link-file` (via bank-statements route); extended `GET /file-storage/:id/linked-records` with OR-join + provenance labels.

- [ ] **Step 1: Add `PUT /bank-statements/:id/link-file` to bank-statements.ts**

In `api/src/routes/bank-statements.ts`, add before `/:id` routes:

```typescript
// ── Link file to bank statement ──
bank.put('/:id/link-file', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const id = c.req.param('id');
  const body = await c.req.json();
  const { file_id } = body as { file_id: string };

  const existing = await db.prepare(
    'SELECT id, source_file_id FROM bank_statements WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(id, tenantId).first<{ id: string; source_file_id: string | null }>();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  if (file_id) {
    const fileRow = await db.prepare(
      'SELECT id FROM file_records WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    ).bind(file_id, tenantId).first();
    if (!fileRow) return c.json({ error: `file_records id ${file_id} not found or not yours` }, 400);
  }

  const replacedFileId = existing.source_file_id;
  await db.prepare(
    "UPDATE bank_statements SET source_file_id = ?, updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL"
  ).bind(file_id || null, id).run();

  await auditLog(db, tenantId, 'update', 'bank_statement', id, {
    linked_file_id: file_id || null, replaced_file_id: replacedFileId,
  });
  return c.json({ success: true, id });
});
```

- [ ] **Step 2: Extend `linked-records` OR-join**

In `api/src/routes/file-storage.ts`, find the `linked-records` endpoint (around line 2074). Replace the statement JOINs:

```sql
-- Before:
LEFT JOIN bank_statements bs ON bs.r2_key = fr.r2_key AND bs.user_id = fr.user_id AND bs.deleted_at IS NULL
LEFT JOIN card_statements cs ON cs.r2_key = fr.r2_key AND cs.user_id = fr.user_id AND cs.deleted_at IS NULL

-- After:
LEFT JOIN bank_statements bs ON (bs.r2_key = fr.r2_key OR bs.source_file_id = fr.id)
  AND bs.user_id = fr.user_id AND bs.deleted_at IS NULL
LEFT JOIN card_statements cs ON (cs.r2_key = fr.r2_key OR cs.source_file_id = fr.id)
  AND cs.user_id = fr.user_id AND cs.deleted_at IS NULL
```

Also add `bs.source as stmt_source, cs.source as card_source` to the SELECT list.

- [ ] **Step 3: Update `buildFileLinks` to show provenance**

In `api/src/lib/manual-booking.ts`, update the `buildFileLinks` function. Add `source` fields to the `FileLink` interface and use them:

```typescript
export interface FileLink {
  kind: 'invoice' | 'receipt' | 'bank_statement' | 'card_statement' | 'journal_entry';
  id: string; label: string;
  source?: 'ocr' | 'manual';
}
```

Update the bank_statement and card_statement blocks in `buildFileLinks`:

```typescript
if (fileRow?.statement_id) {
  const provenance = fileRow.stmt_source === 'manual' ? ' (manually entered)' : ' (from AI-OCR)';
  links.push({
    kind: 'bank_statement', id: fileRow.statement_id,
    label: `Bank statement${fileRow.stmt_bank_name ? ` — ${fileRow.stmt_bank_name}` : ''}${provenance}`,
    source: fileRow.stmt_source || 'ocr',
  });
}
if (fileRow?.card_statement_id) {
  const provenance = fileRow.card_source === 'manual' ? ' (manually entered)' : ' (from AI-OCR)';
  links.push({
    kind: 'card_statement', id: fileRow.card_statement_id,
    label: `Card statement${fileRow.card_issuer ? ` — ${fileRow.card_issuer}` : ''}${provenance}`,
    source: fileRow.card_source || 'ocr',
  });
}
```

- [ ] **Step 4: Verify tsc compiles**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/file-storage.ts api/src/routes/bank-statements.ts api/src/lib/manual-booking.ts
git commit -m "feat(api): bank link-file + linked-records OR-join + provenance labels

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Backend — buildFileListSql OR-Join + Invoice file_id

**Files:**
- Modify: `api/src/lib/list-filters.ts`
- Modify: `api/src/routes/invoices.ts`

**Interfaces:**
- Produces: Extended `buildFileListSql` with OR-join and source columns; `POST /invoices` accepts optional `file_id`.

- [ ] **Step 1: Extend `buildFileListSql` in list-filters.ts**

Replace the bank/card JOINs:

```sql
-- Before:
LEFT JOIN bank_statements bs ON bs.r2_key = fr.r2_key AND bs.user_id = fr.user_id AND bs.deleted_at IS NULL
LEFT JOIN card_statements cs ON cs.r2_key = fr.r2_key AND cs.user_id = fr.user_id AND cs.deleted_at IS NULL

-- After:
LEFT JOIN bank_statements bs ON (bs.r2_key = fr.r2_key OR bs.source_file_id = fr.id)
  AND bs.user_id = fr.user_id AND bs.deleted_at IS NULL
LEFT JOIN card_statements cs ON (cs.r2_key = fr.r2_key OR cs.source_file_id = fr.id)
  AND cs.user_id = fr.user_id AND cs.deleted_at IS NULL
```

Add `bs.source as stmt_source, cs.source as card_source, i.source as inv_source` to the SELECT list.

- [ ] **Step 2: Add `file_id` to invoice `createSchema`**

In `api/src/routes/invoices.ts`, add to the `createSchema`:

```typescript
file_id: z.string().optional(),
```

- [ ] **Step 3: Handle `file_id` in invoice INSERT**

In the `POST /invoices` handler, after the existing INSERT, add:

```typescript
if (data.file_id) {
  const fileRow = await db.prepare(
    'SELECT id FROM file_records WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(data.file_id, tenantId).first();
  if (fileRow) {
    await db.prepare(
      "UPDATE invoices SET file_id = ?, source = 'manual' WHERE id = ?"
    ).bind(data.file_id, id).run();
  }
}
```

Also update the audit payload to include `file_id`.

- [ ] **Step 4: Stamp `source='ocr'` on invoice import**

In `api/src/routes/file-storage.ts`, find the invoice INSERT in the `import-document` handler. Add `source = 'ocr'` to the INSERT column list and `'ocr'` to the VALUES. (This is the path where OCR creates invoices.)

- [ ] **Step 5: Verify tsc compiles**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 6: Commit**

```bash
git add api/src/lib/list-filters.ts api/src/routes/invoices.ts api/src/routes/file-storage.ts
git commit -m "feat(api): buildFileListSql OR-join + invoice file_id + OCR source stamp

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Mock-DB Tests

**Files:**
- Create: `tests/manual-statements.test.ts`

**Interfaces:**
- Consumes: All backend endpoints from Tasks 2–5.

- [ ] **Step 1: Write test file**

```typescript
// tests/manual-statements.test.ts
// Throwaway mock-db tests for manual statement entry + file linking
// Run: npx tsx tests/manual-statements.test.ts

import { buildFileListSql } from '../api/src/lib/list-filters';
import { buildFileLinks } from '../api/src/lib/manual-booking';

let passed = 0;
let failed = 0;
function assert(condition: boolean, msg: string) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── buildFileListSql OR-join tests ──
console.log('\nbuildFileListSql — OR-join for manual links');
{
  const { sql } = buildFileListSql({ tenantId: 't1' });
  assert(sql.includes('bs.source_file_id = fr.id'), 'bank statement OR-join includes source_file_id');
  assert(sql.includes('cs.source_file_id = fr.id'), 'card statement OR-join includes source_file_id');
  assert(sql.includes('bs.source AS stmt_source'), 'SELECT includes stmt_source');
  assert(sql.includes('cs.source AS card_source'), 'SELECT includes card_source');
  assert(sql.includes('i.source AS inv_source'), 'SELECT includes inv_source');
}

console.log('\nbuildFileListSql — unlinked filter still works');
{
  const { sql, params } = buildFileListSql({ tenantId: 't1', unlinked: true });
  assert(sql.includes('i.id IS NULL AND bs.id IS NULL AND cs.id IS NULL'), 'unlinked clause present');
  assert(params.includes('t1'), 'tenantId in params');
}

// ── buildFileLinks provenance tests ──
console.log('\nbuildFileLinks — provenance labels');
{
  const links = buildFileLinks(
    { statement_id: 'bs-1', stmt_bank_name: 'HSBC', stmt_source: 'manual' }, []
  );
  assert(links.length === 1, 'one link returned');
  assert(links[0].label.includes('manually entered'), 'manual provenance in label');
  assert(links[0].source === 'manual', 'source field is manual');
}
{
  const links = buildFileLinks(
    { statement_id: 'bs-2', stmt_bank_name: 'HSBC', stmt_source: 'ocr' }, []
  );
  assert(links[0].label.includes('from AI-OCR'), 'OCR provenance in label');
  assert(links[0].source === 'ocr', 'source field is ocr');
}
{
  const links = buildFileLinks(
    { card_statement_id: 'cs-1', card_issuer: 'Visa', card_source: 'manual' }, []
  );
  assert(links[0].label.includes('manually entered'), 'card manual provenance');
}

// ── Summary ──
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
```

- [ ] **Step 2: Run tests**

```bash
cd Tech_Connect_SME/Development_code/latest_code
npx tsx tests/manual-statements.test.ts
```

Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add tests/manual-statements.test.ts
git commit -m "test: mock-db tests for manual statement entry + file linking

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Frontend — FileUpload "Save without AI Analysis" Button

**Files:**
- Modify: `frontend/src/pages/FileUpload.tsx`

**Interfaces:**
- Consumes: `skip_ocr` flag on `POST /file-storage/upload` (already implemented in backend).

- [ ] **Step 1: Add second submit handler**

In `FileUpload.tsx`, find the main upload submit function (the one that calls `import-document` after upload). Create a new async function `handleSaveWithoutAI` that:

1. Runs the same per-file loop (validation, description, channel/folder destination)
2. Calls only `/file-storage/upload` with `skip_ocr: true`
3. Does NOT call `import-document`
4. Shows a success toast: "Saved N file(s) without AI analysis — run Analyze later from File Storage."
5. Navigates to `/file-storage`

```typescript
const handleSaveWithoutAI = async () => {
  // Same file validation loop as handleUpload, but:
  // - Call POST /file-storage/upload with skip_ocr: true
  // - Do NOT call import-document
  // - Toast: "Saved N file(s) without AI analysis"
  // - Navigate to /file-storage
};
```

- [ ] **Step 2: Add the second submit button**

Next to the existing "Upload & Analyze" button, add:

```tsx
<button
  onClick={handleSaveWithoutAI}
  disabled={uploading || files.length === 0}
  className="px-4 py-2 border border-input bg-background hover:bg-accent hover:text-accent-foreground rounded-md text-sm font-medium transition-colors disabled:opacity-50"
>
  {tr('Save without AI Analysis', '儲存（不用 AI 分析）', '储存（不用 AI 分析）')}
</button>
```

- [ ] **Step 3: Verify build**

```bash
cd Tech_Connect_SME/Development_code/latest_code/frontend
npm run build 2>&1 | tail -5
```

Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/FileUpload.tsx
git commit -m "feat(frontend): Save without AI Analysis button on FileUpload

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Frontend — FileStorage Skipped Badge + Analyze Action + Provenance Badges

**Files:**
- Modify: `frontend/src/pages/FileStorage.tsx`

**Interfaces:**
- Consumes: `ocr_status === 'skipped'` from backend; `stmt_source`, `card_source`, `inv_source` from extended `buildFileListSql`.

- [ ] **Step 1: Add `source` fields to `FileItem` interface**

```typescript
interface FileItem {
  // ... existing fields ...
  stmt_source?: 'ocr' | 'manual';
  card_source?: 'ocr' | 'manual';
  inv_source?: 'ocr' | 'manual';
}
```

- [ ] **Step 2: Extend `summaryStatus` for skipped + provenance**

In the `summaryStatus` function, add the `'skipped'` branch **after** the needsReview and linked checks:

```typescript
// After the needsReview block, before the linked block:
if (f.ocr_status === 'skipped') {
  return {
    label: 'Stored (no AI)', labelZh: '已儲存（無 AI）', labelCn: '已储存（无 AI）',
    cls: 'bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400',
    tip: 'Saved without AI analysis. Click Analyze to extract data.',
    tipZh: '未經 AI 分析儲存。點擊「分析」以提取資料。',
    tipCn: '未经 AI 分析储存。点击「分析」以提取资料。',
  };
}
```

Update the linked/processed branch to split by provenance:

```typescript
if (f.invoice_id || f.statement_id || f.card_statement_id) {
  const isManual = f.stmt_source === 'manual' || f.card_source === 'manual' || f.inv_source === 'manual';
  if (isManual) {
    return {
      label: 'Manually Linked', labelZh: '手動連結', labelCn: '手动连结',
      cls: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300',
      tip: 'Linked to a manually entered record.',
      tipZh: '已連結至手動輸入的記錄。',
      tipCn: '已连结至手动输入的记录。',
    };
  }
  return {
    label: 'AI-OCR Processed', labelZh: 'AI-OCR 已處理', labelCn: 'AI-OCR 已处理',
    cls: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
    tip: 'Auto-saved and linked to a record.',
    tipZh: '已自動儲存並連結至記錄。',
    tipCn: '已自动储存并连结至记录。',
  };
}
```

- [ ] **Step 3: Add Analyze action button for skipped files**

Find the row actions area in FileStorage.tsx (where download/delete buttons are). For rows with `ocr_status === 'skipped'`, add:

```tsx
{f.ocr_status === 'skipped' && (
  <button
    onClick={() => handleAnalyze(f.id)}
    disabled={analyzingId === f.id}
    className="p-1 hover:bg-muted rounded"
    title={tr('Analyze', '分析', '分析')}
  >
    {analyzingId === f.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
  </button>
)}
```

Add state `const [analyzingId, setAnalyzingId] = useState<string | null>(null)` and the handler:

```typescript
const handleAnalyze = async (fileId: string) => {
  setAnalyzingId(fileId);
  try {
    await api(`/file-storage/${fileId}/import-document`, { method: 'POST' });
    toast.success(tr('Analysis complete', '分析完成', '分析完成'));
    queryClient.invalidateQueries({ queryKey: ['file-storage'] });
  } catch (err: any) {
    if (err?.message?.includes('password_required')) {
      // Open encrypted PDF modal — reuse existing pattern
    } else {
      toast.error(tr('Analysis failed', '分析失敗', '分析失败'));
    }
  } finally {
    setAnalyzingId(null);
  }
};
```

- [ ] **Step 4: Verify build**

```bash
npm run build 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/FileStorage.tsx
git commit -m "feat(frontend): skipped badge + Analyze action + provenance badges on FileStorage

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Frontend — BankStatements Manual Entry Editor

**Files:**
- Modify: `frontend/src/pages/BankStatements.tsx`

**Interfaces:**
- Consumes: `POST /bank-statements/manual` endpoint.

- [ ] **Step 1: Add state for manual entry panel**

```typescript
const [showManualEntry, setShowManualEntry] = useState(false);
```

- [ ] **Step 2: Add "+ Manual Entry" button in page header**

Find the page header area (where existing action buttons are). Add:

```tsx
<button
  onClick={() => setShowManualEntry(!showManualEntry)}
  className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90"
>
  <FilePlus className="h-4 w-4" />
  {tr('Manual Entry', '手動輸入', '手动输入')}
</button>
```

- [ ] **Step 3: Create the inline editor panel component**

Add a `ManualBankStatementEditor` component (can be in the same file or extracted). It includes:
- Header row: bank name input, account number, year/month pickers, currency, opening/closing balance
- Transaction grid: date · description · deposit · withdrawal · balance · add/remove row
- Attach file chip (using `DocumentPickerModal` in single-select mode)
- Save / Cancel buttons

Key logic:
- Entering a deposit zeroes the withdrawal cell and vice-versa
- Balance auto-fills as previous balance + deposit − withdrawal but stays editable
- Save calls `POST /bank-statements/manual`, shows toast, navigates to `/bank-statements/review/:id`

```tsx
function ManualBankStatementEditor({ onSave, onCancel }: { onSave: (data: any) => void; onCancel: () => void }) {
  const [bankName, setBankName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [year, setYear] = useState(new Date().getFullYear());
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [currency, setCurrency] = useState('HKD');
  const [openingBalance, setOpeningBalance] = useState<number | ''>('');
  const [closingBalance, setClosingBalance] = useState<number | ''>('');
  const [transactions, setTransactions] = useState([
    { transaction_date: '', description: '', deposit_amount: 0, withdrawal_amount: 0, balance: 0, reference: '' }
  ]);
  const [pickedFile, setPickedFile] = useState<PickedFile | null>(null);
  const [showPicker, setShowPicker] = useState(false);

  // ... grid logic, add/remove row, deposit/withdrawal mutual exclusion, balance auto-fill ...

  return (
    <div className="border rounded-lg p-4 mb-4 bg-muted/30">
      {/* Header fields */}
      {/* Transaction grid */}
      {/* File attachment chip */}
      {/* Save / Cancel */}
    </div>
  );
}
```

- [ ] **Step 4: Wire up the panel**

```tsx
{showManualEntry && (
  <ManualBankStatementEditor
    onSave={async (data) => {
      const res = await api('/bank-statements/manual', { method: 'POST', body: JSON.stringify(data) });
      toast.success(tr('Manual statement created — review to post', '手動報表已建立——請審核後入帳', '手动报表已建立——请审核后入账'));
      setShowManualEntry(false);
      navigate(`/bank-statements/review/${res.id}`);
    }}
    onCancel={() => setShowManualEntry(false)}
  />
)}
```

- [ ] **Step 5: Add "Link File" action on expanded rows**

In the expanded row for statements with `r2_key IS NULL` (i.e. `source='manual'`), add a "Link File" button that opens `DocumentPickerModal` in single-select mode, then calls `PUT /bank-statements/:id/link-file`.

- [ ] **Step 6: Verify build**

```bash
npm run build 2>&1 | tail -5
```

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/BankStatements.tsx
git commit -m "feat(frontend): manual bank statement entry editor + link file action

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: Frontend — CardStatements Manual Entry Editor

**Files:**
- Modify: `frontend/src/pages/CardStatements.tsx`

**Interfaces:**
- Consumes: `POST /card-statements/manual` endpoint.

- [ ] **Step 1: Add "+ Manual Entry" button and editor panel**

Same pattern as Task 9 but with card-specific fields: card issuer, card network, last-4, cardholder name, credit limit, minimum payment, payment due date. Transaction grid uses single `amount` column (positive) with `transaction_type` dropdown.

- [ ] **Step 2: Add "Link File" action on expanded rows**

Same as Task 9 Step 5 but calling `PUT /card-statements/:id/link-file`.

- [ ] **Step 3: Verify build**

```bash
npm run build 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/CardStatements.tsx
git commit -m "feat(frontend): manual card statement entry editor + link file action

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: Frontend — Invoice Create Modal File Attachment

**Files:**
- Modify: `frontend/src/pages/Invoices.tsx`

**Interfaces:**
- Consumes: `file_id` on `POST /invoices`.

- [ ] **Step 1: Add file attachment state and picker**

In the Create Invoice modal component, add:

```typescript
const [pickedFile, setPickedFile] = useState<PickedFile | null>(null);
const [showPicker, setShowPicker] = useState(false);
```

- [ ] **Step 2: Add file attachment section in the modal**

Before the submit button, add:

```tsx
<div className="border-t pt-3 mt-3">
  <label className="text-sm font-medium mb-1 block">
    {tr('Attach supporting file (optional)', '附加證明文件（可選）', '附加证明文件（可选）')}
  </label>
  {pickedFile ? (
    <div className="flex items-center gap-2">
      <span className="text-sm bg-muted px-2 py-1 rounded">{pickedFile.filename}</span>
      <button onClick={() => setPickedFile(null)} className="text-destructive text-xs">✕</button>
    </div>
  ) : (
    <button onClick={() => setShowPicker(true)} type="button" className="text-sm text-primary hover:underline">
      + {tr('Choose file', '選擇文件', '选择文件')}
    </button>
  )}
  {showPicker && (
    <DocumentPickerModal
      alreadyPicked={[]}
      onPick={(picked) => { setPickedFile(picked[0] || null); setShowPicker(false); }}
      onClose={() => setShowPicker(false)}
    />
  )}
</div>
```

- [ ] **Step 3: Pass `file_id` in submit**

In the form submit handler, add `file_id: pickedFile?.id || undefined` to the POST body.

- [ ] **Step 4: Verify build**

```bash
npm run build 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Invoices.tsx
git commit -m "feat(frontend): file attachment in Create Invoice modal

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 12: Playwright Non-Mutating Checks

**Files:**
- Create: `tests/manual-statements.spec.ts`

**Interfaces:**
- Consumes: All frontend changes from Tasks 7–11.

- [ ] **Step 1: Write Playwright spec**

```typescript
// tests/manual-statements.spec.ts
// Non-mutating Playwright checks for manual statement entry features
import { test, expect } from '@playwright/test';

test.describe('Manual Statement Entry', () => {
  test('FileUpload shows Save without AI Analysis button', async ({ page }) => {
    await page.goto('/file-upload');
    await expect(page.getByRole('button', { name: /Save without AI/i })).toBeVisible();
  });

  test('BankStatements shows Manual Entry button', async ({ page }) => {
    await page.goto('/bank-statements');
    await expect(page.getByRole('button', { name: /Manual Entry/i })).toBeVisible();
  });

  test('CardStatements shows Manual Entry button', async ({ page }) => {
    await page.goto('/card-statements');
    await expect(page.getByRole('button', { name: /Manual Entry/i })).toBeVisible();
  });

  test('FileStorage shows Stored (no AI) badge for skipped files', async ({ page }) => {
    // Route-intercept to return a file with ocr_status='skipped'
    await page.route('**/file-storage*', (route) => {
      route.fulfill({
        json: {
          data: [{
            id: 'fs-test1', filename: 'test.pdf', original_name: 'test.pdf',
            file_type: 'application/pdf', file_size: 1000, folder: 'Bank Statements',
            ocr_status: 'skipped', created_at: '2026-08-27',
          }],
        },
      });
    });
    await page.goto('/file-storage');
    await expect(page.getByText('Stored (no AI)')).toBeVisible();
  });

  test('Invoices Create modal shows file attachment option', async ({ page }) => {
    await page.goto('/invoices');
    await page.getByRole('button', { name: /Create Invoice/i }).first().click();
    await expect(page.getByText(/Attach supporting file/i)).toBeVisible();
  });
});
```

- [ ] **Step 2: Run Playwright (non-mutating)**

```bash
npx playwright test tests/manual-statements.spec.ts --project=chromium
```

Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add tests/manual-statements.spec.ts
git commit -m "test: Playwright non-mutating checks for manual statement entry

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 13: Deploy & Smoke Test

**Files:** None (operational)

- [ ] **Step 1: Run migration on production**

```bash
wrangler d1 execute opcc-crm-db --file=api/src/db/migration-manual-statements.sql --remote
wrangler d1 execute opcc-crm-db --command="PRAGMA table_info(bank_statements)" --remote | grep source
```

- [ ] **Step 2: Deploy API worker**

```bash
cd Tech_Connect_SME/Development_code/latest_code
wrangler deploy
```

- [ ] **Step 3: Smoke test backend**

```bash
# Test skip_ocr upload
curl -X POST .../file-storage/upload -d '{"skip_ocr": true, ...}' # expect ocr_status: 'skipped'

# Test manual bank statement
curl -X POST .../bank-statements/manual -d '{"bank_name":"HSBC","transactions":[...]}' # expect 201

# Test manual card statement
curl -X POST .../card-statements/manual -d '{"card_issuer":"Visa","transactions":[...]}' # expect 201

# Test linked-records with manual link
curl .../file-storage/:id/linked-records # expect provenance labels
```

- [ ] **Step 4: Deploy frontend**

```bash
cd Tech_Connect_SME/Development_code/latest_code/frontend
npm run build
# Deploy to Cloudflare Pages
```

- [ ] **Step 5: Live round-trip verification**

1. Upload a PDF with "Save without AI Analysis" → badge "Stored (no AI)"
2. Create manual bank statement linked to that file → badge changes to "Manually Linked"
3. File no longer appears in `?unlinked=1`
4. Review/confirm the statement → JEs generate
5. Clean up all test rows

- [ ] **Step 6: Record deployed URLs in memory**

---

## Self-Review Checklist

- [ ] All spec sections covered by tasks
- [ ] No TBD/TODO/placeholders in any step
- [ ] Type names consistent across tasks (FileLink, PickedFile, FileItem, etc.)
- [ ] Every commit uses explicit paths
- [ ] `tsc` and `npm run build` checkpoints in every relevant task
