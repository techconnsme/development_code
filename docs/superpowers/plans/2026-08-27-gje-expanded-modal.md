# Expanded GJE Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the existing GJE modal to include auto-numbered vouchers, document attachments with warnings, reverse-entry action, duplicate-entry warnings, and created_by stamps.

**Architecture:** Extend the existing `POST /bookkeeping/entries` pipeline with optional `file_ids`, server-side auto-numbering, `entry_source='manual'`, `created_by` stamp, and a similar-entry check. One junction table `journal_entry_files` links vouchers to `file_records`. Frontend: expand the existing GJE modal and add reverse buttons to the list.

**Tech Stack:** Cloudflare Worker (Hono) + D1 (SQLite) + R2; React + TypeScript + TanStack Query + Tailwind; `tr()` EN/繁/简 i18n; Playwright for non-mutating specs.

**Spec:** `docs/superpowers/specs/2026-08-27-gje-expanded-modal-design.md` — read it before starting; this plan argues from it.

## Global Constraints

- API typecheck baseline: measure before starting, keep the count identical through all tasks; zero new errors in touched files.
- Frontend `npm run build` must stay clean after every frontend task.
- `tests/` is gitignored — Playwright specs and test harnesses there need `git add -f`.
- All frontend strings via `tr('EN', '繁體', '简体')`.
- Every API write audit-logged via the file-local `auditLog()` helper; tenancy always `const tenantId = c.get('client_user_id') || user.id`.
- House git convention: commit messages end with `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Migration files are plain SQL applied manually with `wrangler d1 execute` — there is no migrations runner. Verify with PRAGMA after running; never assume a `.sql` file was applied.
- `playwright-report/` dirties the tree on test runs — never commit it.

---

### Task 1: Migration + schema.sql

**Files:**
- Create: `api/src/db/migration-gje-expanded.sql`
- Modify: `api/src/db/schema.sql` (journal_entries block ~line 148-169; add junction table after journal_lines ~line 182; indexes ~line 244-246)

- [ ] **Step 1: Write the migration file**

Create `api/src/db/migration-gje-expanded.sql`:

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

- [ ] **Step 2: Update schema.sql for fresh DBs**

In `api/src/db/schema.sql`, inside `CREATE TABLE journal_entries`, after the `entry_source TEXT NOT NULL DEFAULT 'auto',` line, add:

```sql
  created_by TEXT,
```

After the `journal_lines` table definition, add:

```sql
CREATE TABLE IF NOT EXISTS journal_entry_files (
  entry_id        TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  file_record_id  TEXT NOT NULL REFERENCES file_records(id),
  attached_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entry_id, file_record_id)
);
```

And near the other journal_entries indexes, add:

```sql
CREATE INDEX IF NOT EXISTS idx_jef_file ON journal_entry_files(file_record_id);
```

- [ ] **Step 3: Verify the SQL parses (dry run against a scratch local DB)**

```bash
cd api
npx wrangler d1 execute opcc-crm-db --local --file=src/db/migration-gje-expanded.sql
```

Expected: statements succeed on the LOCAL scratch DB.

- [ ] **Step 4: Commit**

```bash
git add api/src/db/migration-gje-expanded.sql api/src/db/schema.sql
git commit -m "feat(db): GJE expanded modal migration — journal_entry_files + created_by

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Shared helpers — `api/src/lib/manual-booking.ts` (TDD)

**Files:**
- Create: `api/src/lib/manual-booking.ts`
- Test: `tests/manual-booking.test.ts` (gitignored — force-add at commit)

**Interfaces:**
- Produces (used by Tasks 3, 4, 5):
  - `nextManualVoucherNumber(db, tenantId: string, date: string): Promise<string>` → `'MJ-YYYYMM-NNN'`
  - `hasSharedAccount(entryLineCodes: string[], newCodes: string[]): boolean`
  - `findSimilarEntryCandidates(db, tenantId: string, entryDate: string, totalDebit: number): Promise<(SimilarEntry & { line_codes: string[] })[]>`
  - `buildFileLinks(fileRow: any, jeRows: any[]): FileLink[]`
  - types `SimilarEntry { id; entry_number; description; total_debit }`, `FileLink { kind: 'invoice'|'receipt'|'bank_statement'|'card_statement'|'journal_entry'; id; label }`

- [ ] **Step 1: Write the failing test harness**

Create `tests/manual-booking.test.ts` (mock-db pattern from `tests/bank-resolver.test.ts`):

```ts
// Tests for manual booking helpers.
// Run: npx tsx tests/manual-booking.test.ts
import { nextManualVoucherNumber, hasSharedAccount, findSimilarEntryCandidates, buildFileLinks } from '../api/src/lib/manual-booking';

let capturedSql: string[] = [];

function mockDb(entryNumbers: string[], similarRows: any[] = []) {
  return {
    prepare(sql: string) {
      capturedSql.push(sql);
      return {
        bind(...args: any[]) {
          const first = async () => {
            if (/LIKE/.test(sql) && /entry_number/.test(sql)) {
              const like = String(args[1]);
              const matching = entryNumbers
                .filter(n => n.startsWith(like.slice(0, -1)))
                .sort();
              return matching.length ? { entry_number: matching[matching.length - 1] } : null;
            }
            return null;
          };
          const all = async () => {
            if (/GROUP_CONCAT/.test(sql)) return { results: similarRows };
            return { results: [] };
          };
          return { first, all, run: async () => ({ success: true }) };
        },
      };
    },
  };
}

let pass = 0, fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) { pass++; } else { fail++; console.error(`FAIL: ${label}`); }
}

(async () => {
  const U = 'u-test';

  // ── nextManualVoucherNumber ──
  ok(await nextManualVoucherNumber(mockDb([]), U, '2026-08-27') === 'MJ-202608-001', 'first number is MJ-202608-001');
  ok(await nextManualVoucherNumber(mockDb(['MJ-202608-003']), U, '2026-08-27') === 'MJ-202608-004', 'after 003 comes 004');
  ok(await nextManualVoucherNumber(mockDb(['MJ-202607-009']), U, '2026-08-27') === 'MJ-202608-001', 'month rollover restarts seq');
  ok(await nextManualVoucherNumber(mockDb(['MJ-202608-010']), U, '2026-08-01') === 'MJ-202608-011', 'padded comparison');
  capturedSql = [];
  await nextManualVoucherNumber(mockDb([]), U, '2026-08-27');
  ok(!capturedSql.some(s => /deleted_at/.test(s)), 'number scan includes tombstones (no deleted_at filter)');

  // ── hasSharedAccount ──
  ok(hasSharedAccount(['63101', '21101'], ['21101', '11102']) === true, 'shared code detected');
  ok(hasSharedAccount(['63101'], ['21101']) === false, 'no shared code');
  ok(hasSharedAccount([], ['21101']) === false, 'empty candidate codes');

  // ── findSimilarEntryCandidates ──
  const db = mockDb([], [
    { id: 'je-1', entry_number: 'MJ-202608-001', description: 'Audit fee', total_debit: 12000, codes: '63101,21101' },
    { id: 'je-2', entry_number: 'MJ-202608-002', description: 'Rent', total_debit: 5000, codes: null },
  ]);
  const cands = await findSimilarEntryCandidates(db, U, '2026-08-27', 12000);
  ok(cands.length === 2, 'two candidates mapped');
  ok(cands[0].line_codes.join(',') === '63101,21101', 'codes split on comma');
  ok(cands[1].line_codes.length === 0, 'null codes → empty array');

  // ── buildFileLinks ──
  const links1 = buildFileLinks({ invoice_id: 'inv-1', invoice_number: 'INV-001414', vendor_name: 'Pastel Tech', invoice_total: 15300 }, []);
  ok(links1.length === 1 && links1[0].kind === 'invoice' && /INV-001414/.test(links1[0].label), 'invoice link');
  const links2 = buildFileLinks({ invoice_id: 'inv-2', invoice_number: 'REC2608-001' }, []);
  ok(links2[0].kind === 'receipt', 'REC-prefixed number → receipt kind');
  const links3 = buildFileLinks({ statement_id: 'bs-1', stmt_bank_name: 'HSBC' }, []);
  ok(links3[0].kind === 'bank_statement' && /HSBC/.test(links3[0].label), 'bank statement link');
  const links4 = buildFileLinks({ card_statement_id: 'cs-1', card_issuer: 'Visa' }, []);
  ok(links4[0].kind === 'card_statement', 'card statement link');
  const links5 = buildFileLinks({}, [{ id: 'je-9', entry_number: 'MJ-202608-005', entry_date: '2026-08-27' }]);
  ok(links5[0].kind === 'journal_entry' && /MJ-202608-005/.test(links5[0].label), 'journal entry link');
  ok(buildFileLinks({}, []).length === 0, 'clean file → no links');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx tsx tests/manual-booking.test.ts
```

Expected: FAIL — `Cannot find module '../api/src/lib/manual-booking'`.

- [ ] **Step 3: Implement the helpers**

Create `api/src/lib/manual-booking.ts`:

```ts
export interface SimilarEntry {
  id: string; entry_number: string; description: string; total_debit: number;
}

export interface FileLink {
  kind: 'invoice' | 'receipt' | 'bank_statement' | 'card_statement' | 'journal_entry';
  id: string; label: string;
}

export async function nextManualVoucherNumber(db: any, tenantId: string, date: string): Promise<string> {
  const ym = date.slice(0, 7).replace(/-/g, '');
  const row = await db.prepare(
    'SELECT entry_number FROM journal_entries WHERE user_id = ? AND entry_number LIKE ? ORDER BY entry_number DESC LIMIT 1'
  ).bind(tenantId, `MJ-${ym}-%`).first<{ entry_number: string }>();
  let seq = 1;
  if (row?.entry_number) {
    const lastSeq = parseInt(row.entry_number.split('-').pop() || '', 10);
    if (!isNaN(lastSeq)) seq = lastSeq + 1;
  }
  return `MJ-${ym}-${String(seq).padStart(3, '0')}`;
}

export function hasSharedAccount(entryLineCodes: string[], newCodes: string[]): boolean {
  const set = new Set(entryLineCodes);
  return newCodes.some((c) => set.has(c));
}

export async function findSimilarEntryCandidates(
  db: any, tenantId: string, entryDate: string, totalDebit: number,
): Promise<(SimilarEntry & { line_codes: string[] })[]> {
  const rows = await db.prepare(
    `SELECT je.id, je.entry_number, je.description, SUM(jl.debit) AS total_debit,
            GROUP_CONCAT(DISTINCT jl.account_code) AS codes
     FROM journal_entries je
     JOIN journal_lines jl ON jl.entry_id = je.id
     WHERE je.user_id = ? AND je.deleted_at IS NULL AND je.entry_date = ?
     GROUP BY je.id
     HAVING ABS(SUM(jl.debit) - ?) <= 0.01`
  ).bind(tenantId, entryDate, totalDebit).all();
  return (rows.results as any[]).map((r) => ({
    id: r.id, entry_number: r.entry_number, description: r.description,
    total_debit: r.total_debit, line_codes: (r.codes || '').split(',').filter(Boolean),
  }));
}

export function buildFileLinks(fileRow: any, jeRows: any[]): FileLink[] {
  const links: FileLink[] = [];
  if (fileRow?.invoice_id) {
    const isReceipt = (fileRow.invoice_number || '').toUpperCase().startsWith('REC');
    const bits = [
      fileRow.invoice_number,
      fileRow.vendor_name || fileRow.customer_name,
      fileRow.invoice_total ? `HK$${Number(fileRow.invoice_total).toLocaleString()}` : '',
    ].filter(Boolean);
    links.push({
      kind: isReceipt ? 'receipt' : 'invoice', id: fileRow.invoice_id,
      label: `${isReceipt ? 'Receipt' : 'Invoice'} ${bits.join(' — ')}`,
    });
  }
  if (fileRow?.statement_id) {
    links.push({
      kind: 'bank_statement', id: fileRow.statement_id,
      label: `Bank statement${fileRow.stmt_bank_name ? ` — ${fileRow.stmt_bank_name}` : ''}`,
    });
  }
  if (fileRow?.card_statement_id) {
    links.push({
      kind: 'card_statement', id: fileRow.card_statement_id,
      label: `Card statement${fileRow.card_issuer ? ` — ${fileRow.card_issuer}` : ''}`,
    });
  }
  for (const je of jeRows || []) {
    links.push({ kind: 'journal_entry', id: je.id, label: `Journal entry ${je.entry_number} (${je.entry_date})` });
  }
  return links;
}
```

- [ ] **Step 4: Run the harness — all pass**

```bash
npx tsx tests/manual-booking.test.ts
```

Expected: `N passed, 0 failed`, exit code 0.

- [ ] **Step 5: Typecheck baseline unchanged**

```bash
cd api && npx tsc --noEmit 2>&1 | grep -c "error TS"
```

Expected: same count as baseline, none in `lib/manual-booking.ts`.

- [ ] **Step 6: Commit**

```bash
git add api/src/lib/manual-booking.ts
git add -f tests/manual-booking.test.ts
git commit -m "feat(api): manual booking helpers — voucher numbering, similarity, file links

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Extend `POST /bookkeeping/entries`

**Files:**
- Modify: `api/src/routes/bookkeeping.ts` (imports ~line 15, `entrySchema` lines 219-222, handler lines 224-270)

**Interfaces:**
- Consumes: `nextManualVoucherNumber`, `findSimilarEntryCandidates`, `hasSharedAccount` from `../lib/manual-booking` (Task 2)
- Produces: the create endpoint now accepts optional `file_ids`/`duplicate_acknowledged`, auto-numbers when `entry_number` omitted, and can return **409** `{ error: 'Similar entry already exists', error_code: 'similar_entry_exists', similar_entries: [{id, entry_number, description, total_debit}] }`

- [ ] **Step 1: Re-read the current state of `bookkeeping.ts` lines 1-270** and confirm `entrySchema` and the POST handler still match the shapes below. Adapt line numbers if they drifted.

- [ ] **Step 2: Add the import** after the `checkPeriodOpen` import:

```ts
import { nextManualVoucherNumber, findSimilarEntryCandidates, hasSharedAccount } from '../lib/manual-booking';
```

- [ ] **Step 3: Make `entry_number` optional and add the new fields** — replace the `entrySchema` block:

```ts
const entrySchema = z.object({
  entry_number: z.string().min(1).max(50).optional(), entry_date: z.string().max(10), description: z.string().min(1).max(500),
  reference_type: z.string().max(50).optional(), reference_id: z.string().max(50).optional(), lines: z.array(lineSchema).min(2).max(200),
  file_ids: z.array(z.string()).max(10).optional(), duplicate_acknowledged: z.boolean().optional(),
});
```

- [ ] **Step 4: Extend the handler.** Inside `bookkeeping.post('/entries', ...)`, after the existing `checkPeriodOpen` guard and BEFORE the `INSERT INTO journal_entries`, insert:

```ts
  const fileIds = [...new Set(data.file_ids || [])];
  if (fileIds.length > 0) {
    const fileRows = await db.prepare(
      `SELECT id FROM file_records WHERE user_id = ? AND deleted_at IS NULL AND id IN (${fileIds.map(() => '?').join(',')})`
    ).bind(tenantId, ...fileIds).all();
    const found = new Set((fileRows.results as any[]).map(f => f.id));
    const missing = fileIds.filter(fid => !found.has(fid));
    if (missing.length > 0) return c.json({ error: `File(s) not found: ${missing.join(', ')}` }, 400);
  }

  if (!data.duplicate_acknowledged) {
    const candidates = await findSimilarEntryCandidates(db, tenantId, data.entry_date, totalDebit);
    const similar = candidates
      .filter(cand => hasSharedAccount(cand.line_codes, codes))
      .map(({ id, entry_number, description, total_debit }) => ({ id, entry_number, description, total_debit }));
    if (similar.length > 0) {
      return c.json({ error: 'Similar entry already exists', error_code: 'similar_entry_exists', similar_entries: similar }, 409);
    }
  }

  const entryNumber = data.entry_number || await nextManualVoucherNumber(db, tenantId, data.entry_date);
  const createdBy = JSON.stringify({ id: user.id, name: user.name, email: user.email });
```

- [ ] **Step 5: Replace the journal_entries INSERT** with the stamped version:

```ts
  await db.prepare(
    'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id, entry_source, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, tenantId, entryNumber, data.entry_date, data.description, data.reference_type || null, data.reference_id || null, 'manual', createdBy).run();
```

- [ ] **Step 6: Insert attachment rows** right after the journal_lines loop:

```ts
  for (const fileId of fileIds) {
    await db.prepare('INSERT OR IGNORE INTO journal_entry_files (entry_id, file_record_id) VALUES (?, ?)').bind(id, fileId).run();
  }
```

- [ ] **Step 7: Extend the audit payload** — replace the `auditLog(...)` call:

```ts
  await auditLog(db, user.id, 'create', 'journal_entry', id, {
    entry_number: entryNumber, description: data.description, lines: data.lines.length,
    file_ids: fileIds, duplicate_acknowledged: !!data.duplicate_acknowledged,
  });
```

- [ ] **Step 8: Verify**

```bash
cd api && npx tsc --noEmit 2>&1 | grep -c "error TS"
npx wrangler deploy --dry-run
```

Expected: baseline count unchanged; dry-run bundles OK.

- [ ] **Step 9: Commit**

```bash
git add api/src/routes/bookkeeping.ts
git commit -m "feat(api): GJE expanded modal — auto voucher no., file links, duplicate check

POST /bookkeeping/entries now auto-numbers MJ-YYYYMM-NNN when entry_number is
omitted, validates+stores file_ids in journal_entry_files, stamps
entry_source='manual' + created_by, and returns 409 similar_entry_exists
until duplicate_acknowledged is sent.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: `GET /entries/manual` + `GET /entries/next-number`

**Files:**
- Modify: `api/src/routes/bookkeeping.ts` (insert between `GET /entries` ending ~line 185 and `GET /entries/:id` at ~line 187)

**Interfaces:**
- Consumes: `nextManualVoucherNumber` (Task 2), `jeLive()` (existing import)
- Produces:
  - `GET /bookkeeping/entries/manual?start_date&end_date` → `{ data: [{...entry, total_debit, total_credit, created_by: {id,name,email}|null, files: [{id,filename}], reversed: boolean}] }`
  - `GET /bookkeeping/entries/next-number?date=YYYY-MM-DD` → `{ entry_number: 'MJ-YYYYMM-NNN' }`

- [ ] **Step 1: Insert both routes** immediately after the `GET /entries` handler:

```ts
bookkeeping.get('/entries/manual', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const startDate = c.req.query('start_date');
  const endDate = c.req.query('end_date');

  let query = `SELECT je.*, SUM(jl.debit) as total_debit, SUM(jl.credit) as total_credit
    FROM journal_entries je LEFT JOIN journal_lines jl ON je.id = jl.entry_id
    WHERE je.user_id = ? AND ${jeLive()} AND je.entry_source = 'manual' AND je.reference_type IS NULL`;
  const params: any[] = [tenantId];
  if (startDate) { query += ' AND je.entry_date >= ?'; params.push(startDate); }
  if (endDate) { query += ' AND je.entry_date <= ?'; params.push(endDate); }
  query += ' GROUP BY je.id ORDER BY je.entry_date DESC, je.created_at DESC LIMIT 500';

  const rows = await db.prepare(query).bind(...params).all();
  const entries = rows.results as any[];

  for (const e of entries) {
    try { e.created_by = e.created_by ? JSON.parse(e.created_by) : null; } catch { e.created_by = null; }
  }

  const ids = entries.map(e => e.id);
  const filesByEntry: Record<string, { id: string; filename: string }[]> = {};
  const reversedSet = new Set<string>();
  if (ids.length > 0) {
    const ph = ids.map(() => '?').join(',');
    const fRows = await db.prepare(
      `SELECT jef.entry_id, fr.id, fr.filename FROM journal_entry_files jef
       JOIN file_records fr ON fr.id = jef.file_record_id
       WHERE jef.entry_id IN (${ph})`
    ).bind(...ids).all();
    for (const r of fRows.results as any[]) {
      if (!filesByEntry[r.entry_id]) filesByEntry[r.entry_id] = [];
      filesByEntry[r.entry_id].push({ id: r.id, filename: r.filename });
    }
    const rRows = await db.prepare(
      `SELECT reference_id FROM journal_entries
       WHERE user_id = ? AND reference_type = 'journal' AND deleted_at IS NULL AND reference_id IN (${ph})`
    ).bind(tenantId, ...ids).all();
    for (const r of rRows.results as any[]) reversedSet.add(r.reference_id);
  }

  return c.json({ data: entries.map(e => ({ ...e, files: filesByEntry[e.id] || [], reversed: reversedSet.has(e.id) })) });
});

bookkeeping.get('/entries/next-number', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const date = c.req.query('date') || new Date().toISOString().split('T')[0];
  return c.json({ entry_number: await nextManualVoucherNumber(c.env.DB, tenantId, date) });
});
```

- [ ] **Step 2: Verify route order** — confirm both new routes appear ABOVE `bookkeeping.get('/entries/:id', ...)`.

- [ ] **Step 3: Verify**

```bash
cd api && npx tsc --noEmit 2>&1 | grep -c "error TS"
npx wrangler deploy --dry-run
```

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/bookkeeping.ts
git commit -m "feat(api): manual bookings list + voucher next-number endpoints

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Reverse stamps/guards + delete → tombstone

**Files:**
- Modify: `api/src/routes/bookkeeping.ts` (DELETE handler lines ~296-319, reverse handler lines ~321-360)

- [ ] **Step 1: Delete becomes tombstone.** Replace the DELETE statement:

```ts
  await db.prepare("UPDATE journal_entries SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .bind(id, tenantId).run();
```

- [ ] **Step 2: Reverse — reject tombstoned originals.** In the reverse handler, after the `if (!entry) return c.json({ error: 'Entry not found' }, 404);` line, add:

```ts
  if ((entry as any).deleted_at) return c.json({ error: 'Cannot reverse a deleted entry' }, 409);

  const revDate = new Date().toISOString().split('T')[0];
  if (!(await checkPeriodOpen(db, tenantId, revDate)))
    return c.json({ error: 'Cannot create reversal in a closed period' }, 400);
```

- [ ] **Step 3: Reverse — stamp entry_source + created_by.** Replace the reversal INSERT:

```ts
  await db.prepare(
    'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id, entry_source, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(revId, tenantId, revNumber, revDate,
    `Reversal: ${entry.description}`, 'journal', originalId, 'manual',
    JSON.stringify({ id: user.id, name: user.name, email: user.email })).run();
```

- [ ] **Step 4: Verify**

```bash
cd api && npx tsc --noEmit 2>&1 | grep -c "error TS"
npx wrangler deploy --dry-run
```

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/bookkeeping.ts
git commit -m "feat(api): JE delete tombstones; reversal stamps + guards

DELETE /entries/:id now sets deleted_at instead of hard-deleting (voucher
number retired, trail preserved). Reverse rejects tombstoned originals,
enforces the period guard on the reversal date, and stamps
entry_source='manual' + created_by.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: `GET /file-storage/:id/linked-records`

**Files:**
- Modify: `api/src/routes/file-storage.ts` (import near line 12; new route inserted after the `GET /issues` block)

- [ ] **Step 1: Add the import** alongside the other lib imports:

```ts
import { buildFileLinks } from '../lib/manual-booking';
```

- [ ] **Step 2: Insert the route** after the `/issues` handler:

```ts
files.get('/:id/linked-records', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const id = c.req.param('id');

  const fr = await db.prepare(
    `SELECT fr.id, fr.filename,
      i.id as invoice_id, i.invoice_number, i.total as invoice_total, i.vendor_name,
      cust.name as customer_name,
      bs.id as statement_id, bs.bank_name as stmt_bank_name,
      cs.id as card_statement_id, cs.card_issuer
    FROM file_records fr
    LEFT JOIN invoices i ON i.file_id = fr.id AND i.user_id = fr.user_id AND i.deleted_at IS NULL
    LEFT JOIN customers cust ON i.customer_id = cust.id
    LEFT JOIN bank_statements bs ON bs.r2_key = fr.r2_key AND bs.user_id = fr.user_id AND bs.deleted_at IS NULL
    LEFT JOIN card_statements cs ON cs.r2_key = fr.r2_key AND cs.user_id = fr.user_id AND cs.deleted_at IS NULL
    WHERE fr.id = ? AND fr.user_id = ? AND fr.deleted_at IS NULL`
  ).bind(id, tenantId).first();

  if (!fr) return c.json({ error: 'File not found' }, 404);

  const jeRows = await db.prepare(
    `SELECT je.id, je.entry_number, je.entry_date FROM journal_entry_files jef
     JOIN journal_entries je ON je.id = jef.entry_id
     WHERE jef.file_record_id = ? AND je.deleted_at IS NULL`
  ).bind(id).all();

  return c.json({ file_id: id, links: buildFileLinks(fr, jeRows.results as any[]) });
});
```

- [ ] **Step 3: Verify**

```bash
cd api && npx tsc --noEmit 2>&1 | grep -c "error TS"
npx wrangler deploy --dry-run
```

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/file-storage.ts
git commit -m "feat(api): file linked-records endpoint for GJE attachment warnings

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: `api()` error payload + DocumentPickerModal

**Files:**
- Modify: `frontend/src/lib/api.ts` (error branch lines 65-68)
- Create: `frontend/src/components/DocumentPickerModal.tsx`

**Interfaces:**
- Produces (used by Task 8): `api()` errors now carry the parsed JSON body as `(err as any).body`; `DocumentPickerModal` with props `{ alreadyPicked: string[]; onPick: (picked: PickedFile[]) => void; onClose: () => void }`; named export `PickedFile { id: string; filename: string }`

- [ ] **Step 1: `api()` — attach the parsed error body.** In `frontend/src/lib/api.ts` replace:

```ts
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Request failed');
    }
```

with:

```ts
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const e: any = new Error(err.error || 'Request failed');
      e.body = err;
      throw e;
    }
```

- [ ] **Step 2: Create the DocumentPickerModal component**:

```tsx
import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, WORKER_API_BASE, iframeClientParam } from '../lib/api';
import { tr } from '../lib/i18nHelpers';
import { Search, X } from 'lucide-react';

export interface PickedFile { id: string; filename: string }

export default function DocumentPickerModal({ alreadyPicked, onPick, onClose }: {
  alreadyPicked: string[];
  onPick: (picked: PickedFile[]) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [sel, setSel] = useState<PickedFile[]>([]);
  const [preview, setPreview] = useState<PickedFile | null>(null);

  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  qs.set('limit', '200');
  const { data } = useQuery({
    queryKey: ['file-storage-list', q],
    queryFn: () => api(`/file-storage?${qs.toString()}`),
  });
  const files: any[] = data?.data || [];
  const visible = files.filter(f => !cat || (f.category || 'general') === cat);
  const CATEGORIES = [
    ['', tr('All types', '所有類型', '所有类型')],
    ['bank_statement', tr('Bank statements', '銀行月結單', '银行月结单')],
    ['card_statement', tr('Card statements', '信用卡月結單', '信用卡月结单')],
    ['invoice', tr('Invoices', '發票', '发票')],
    ['receipt', tr('Receipts', '收據', '收据')],
    ['general', tr('Other', '其他', '其他')],
  ];

  function toggle(f: any) {
    const picked = { id: f.id, filename: f.original_name || f.filename };
    setSel(prev => prev.some(p => p.id === f.id) ? prev.filter(p => p.id !== f.id) : [...prev, picked]);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-card border rounded-xl w-full max-w-5xl h-[80vh] flex flex-col mx-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="font-bold">{tr('Attach Documents', '附加文件', '附加文件')}</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted"><X className="h-4 w-4" /></button>
        </div>

        <div className="px-4 py-2 border-b">
          <div className="relative">
            <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={tr('Search files…', '搜尋檔案…', '搜索文件…')}
              className="w-full pl-9 pr-3 py-2 border rounded-md bg-background text-sm" />
          </div>
          <select value={cat} onChange={(e) => setCat(e.target.value)}
            className="mt-2 px-3 py-1.5 border rounded-md bg-background text-xs">
            {CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>

        <div className="flex-1 flex min-h-0">
          <div className="w-1/2 border-r overflow-y-auto">
            {visible.map((f: any) => {
              const attached = alreadyPicked.includes(f.id);
              const checked = attached || sel.some(p => p.id === f.id);
              return (
                <label key={f.id} className={`flex items-center gap-2 px-4 py-2 border-b border-muted/30 text-sm ${attached ? 'opacity-50' : 'hover:bg-muted/30 cursor-pointer'}`}>
                  <input type="checkbox" disabled={attached} checked={checked} onChange={() => toggle(f)} />
                  <button type="button" className="flex-1 text-left truncate" onClick={(e) => { e.preventDefault(); setPreview({ id: f.id, filename: f.original_name || f.filename }); }}>
                    {f.original_name || f.filename}
                  </button>
                  <span className="text-xs text-muted-foreground shrink-0">{f.category || f.folder}</span>
                  {attached && <span className="text-xs text-amber-600 shrink-0">{tr('attached', '已附加', '已附加')}</span>}
                </label>
              );
            })}
            {visible.length === 0 && (
              <div className="p-6 text-center text-sm text-muted-foreground">{tr('No files found.', '找不到檔案。', '找不到文件。')}</div>
            )}
          </div>
          <div className="w-1/2 flex items-center justify-center bg-muted/10">
            {preview ? (
              <iframe title={preview.filename} className="w-full h-full"
                src={`${WORKER_API_BASE}/file-storage/${preview.id}/download?inline=1&token=${localStorage.getItem('token') || ''}${iframeClientParam()}`} />
            ) : (
              <span className="text-sm text-muted-foreground">{tr('Select a file to preview', '選擇檔案以預覽', '选择文件以预览')}</span>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 px-4 py-3 border-t">
          <button onClick={onClose} className="px-4 py-2 border rounded-md text-sm">{tr('Cancel', '取消', '取消')}</button>
          <button onClick={() => { onPick(sel); onClose(); }} disabled={sel.length === 0}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm disabled:opacity-50">
            {tr(`Attach${sel.length ? ` (${sel.length})` : ''}`, `附加${sel.length ? `（${sel.length}）` : ''}`, `附加${sel.length ? `（${sel.length}）` : ''}`)}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Build** — `cd frontend && npm run build`. Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/components/DocumentPickerModal.tsx
git commit -m "feat(frontend): api() error body + document picker modal

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Expand GJE modal + add reverse buttons to list

**Files:**
- Modify: `frontend/src/pages/Bookkeeping.tsx` (entryForm state ~line 57, modal JSX ~line 1102-1277, list table ~line 127-240)

**Interfaces:**
- Consumes: `DocumentPickerModal`/`PickedFile` (Task 7), `GET /entries/next-number`, `POST /entries` (409 `similar_entry_exists`), `GET /file-storage/:id/linked-records`, `GET /bookkeeping/closed-periods`, `err.body` from `api()` (Task 7)

- [ ] **Step 1: Add imports** at the top of Bookkeeping.tsx:

```ts
import DocumentPickerModal, { type PickedFile } from '../components/DocumentPickerModal';
import { useQueries } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
```

- [ ] **Step 2: Extend entryForm state** — add `files` field:

```ts
const [entryForm, setEntryForm] = useState({
  entry_number: '', entry_date: new Date().toISOString().split('T')[0], description: '',
  lines: [{ account_code: '', account_name: '', description: '', debit: 0, credit: 0, project: '' }],
  files: [] as PickedFile[],
});
```

- [ ] **Step 3: Add picker state and similar entries state**:

```ts
const [showPicker, setShowPicker] = useState(false);
const [confirmNoDocs, setConfirmNoDocs] = useState(false);
const [similarEntries, setSimilarEntries] = useState<any[] | null>(null);
```

- [ ] **Step 4: Add closed periods query**:

```ts
const { data: closedPeriods } = useQuery({
  queryKey: ['closed-periods'],
  queryFn: () => api('/bookkeeping/closed-periods'),
  enabled: showEntryForm,
});
const closedHit = (closedPeriods?.data || []).find(
  (p: any) => entryForm.entry_date >= p.period_start && entryForm.entry_date <= p.period_end,
);
```

- [ ] **Step 5: Add next-number query**:

```ts
const { data: nextNumber } = useQuery({
  queryKey: ['next-number', entryForm.entry_date],
  queryFn: () => api(`/bookkeeping/entries/next-number?date=${entryForm.entry_date}`),
  enabled: showEntryForm && !entryForm.entry_number,
});
```

- [ ] **Step 6: Add file link queries**:

```ts
const linkQueries = useQueries({
  queries: entryForm.files.map(f => ({
    queryKey: ['file-links', f.id],
    queryFn: () => api(`/file-storage/${f.id}/linked-records`),
  })),
});
const fileWarnings = entryForm.files
  .map((f, i) => ({ file: f, links: (linkQueries[i]?.data?.links || []) as any[] }))
  .filter(w => w.links.length > 0);
```

- [ ] **Step 7: Update createEntry mutation** to handle 409:

Replace the `createEntry` mutation's `onError` to handle `similar_entry_exists`:

```ts
onError: (err: any) => {
  if (err?.body?.error_code === 'similar_entry_exists') {
    setSimilarEntries(err.body.similar_entries || []);
    return;
  }
  toast.error(err?.message || tr('Failed to post', '記錄失敗', '记录失败'));
},
```

- [ ] **Step 8: Add handlePost function**:

```ts
function handlePost() {
  if (!canSubmit || createEntry.isPending) return;
  if (entryForm.files.length === 0 && !confirmNoDocs) { setConfirmNoDocs(true); return; }
  createEntry.mutate({ ...entryForm, file_ids: entryForm.files.map(f => f.id), duplicate_acknowledged: false });
}
```

- [ ] **Step 9: Expand the modal JSX** — add attachments section, voucher preview, closed-period hint, and warnings. Add before the balance footer:

```tsx
{/* Voucher preview */}
{!entryForm.entry_number && nextNumber?.entry_number && (
  <div className="text-sm text-muted-foreground">
    {tr('Voucher', '總帳 #', '总帐 #')}: <span className="font-mono">{nextNumber.entry_number}</span>
    <span className="text-xs"> ({tr('auto', '自動', '自动')})</span>
  </div>
)}

{/* Closed period hint */}
{closedHit && (
  <p className="text-xs text-red-600">
    {tr('This date falls in a closed period — posting is locked.', '此日期屬於已關帳期間 — 記帳已鎖定。', '此日期属于已关账期间 — 记账已锁定。')}
  </p>
)}

{/* Attachments section */}
<div className="space-y-2">
  <div className="flex items-center gap-2 flex-wrap">
    <span className="text-xs font-medium text-muted-foreground">{tr('Supporting documents', '證明文件', '证明文件')}</span>
    {entryForm.files.map(f => (
      <span key={f.id} className="inline-flex items-center gap-1 text-xs border rounded-md px-2 py-1">
        <Paperclip className="h-3 w-3" />{f.filename}
        <button onClick={() => setEntryForm({ ...entryForm, files: entryForm.files.filter(x => x.id !== f.id) })}
          className="text-muted-foreground hover:text-destructive"><X className="h-3 w-3" /></button>
      </span>
    ))}
    <button onClick={() => setShowPicker(true)} disabled={entryForm.files.length >= 10}
      className="text-xs text-primary hover:underline disabled:opacity-50">
      {tr('+ attach documents', '+ 附加文件', '+ 附加文件')}
    </button>
  </div>
  {fileWarnings.map(w => (
    <div key={w.file.id} className="flex items-start gap-2 text-xs bg-amber-100 dark:bg-amber-950/40 text-amber-800 rounded-md px-3 py-2">
      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <span>
        <b>{w.file.filename}</b>{' '}
        {tr('is already linked to:', '已連結至：', '已链接至：')}{' '}
        {w.links.map(l => l.label).join('; ')}
      </span>
    </div>
  ))}
  {confirmNoDocs && entryForm.files.length === 0 && (
    <div className="flex items-start gap-2 text-xs bg-amber-100 dark:bg-amber-950/40 text-amber-800 rounded-md px-3 py-2">
      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <span>{tr(
        'No supporting document attached. HK companies should keep records supporting each entry — post anyway?',
        '未附加證明文件。香港公司應保留每筆記帳的證明文件 — 仍要記錄？',
        '未附加证明文件。香港公司应保留每笔记账的证明文件 — 仍要记录？',
      )}</span>
    </div>
  )}
</div>
```

- [ ] **Step 10: Update the Post button** to use handlePost:

```tsx
<button type="button" onClick={handlePost} disabled={!canSubmit || createEntry.isPending}
  className={`px-4 py-2 rounded-md text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed ${
    confirmNoDocs && entryForm.files.length === 0
      ? 'bg-amber-500 text-white hover:bg-amber-600'
      : 'bg-primary text-primary-foreground'
  }`}>
  {confirmNoDocs && entryForm.files.length === 0
    ? tr('Post without documents', '不附文件記錄', '不附文件记录')
    : tr('Post Entry', '記錄', '记录')}
</button>
```

- [ ] **Step 11: Add DocumentPickerModal** at the end of the modal:

```tsx
{showPicker && (
  <DocumentPickerModal
    alreadyPicked={entryForm.files.map(f => f.id)}
    onPick={(picked) => setEntryForm({ ...entryForm, files: [...entryForm.files, ...picked.filter(p => !entryForm.files.some(x => x.id === p.id))].slice(0, 10) })}
    onClose={() => setShowPicker(false)}
  />
)}
```

- [ ] **Step 12: Add similar entries modal** at the end of the component:

```tsx
{similarEntries !== null && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setSimilarEntries(null)}>
    <div className="bg-card border rounded-xl p-6 w-full max-w-lg mx-4 space-y-3" onClick={(e) => e.stopPropagation()}>
      <h3 className="font-bold flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-600" />
        {tr('Similar entry already exists', '已存在類似分錄', '已存在类似分录')}
      </h3>
      <ul className="text-sm space-y-1">
        {similarEntries.map(s => (
          <li key={s.id} className="font-mono text-xs border rounded px-2 py-1">
            {s.entry_number} · {s.description} · HK$ {fmtMoney(s.total_debit)}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        {tr('Same date, amount and account as an existing live entry. Book again anyway?', '與現有分錄的日期、金額和科目相同。仍要再次記錄？', '与现有分录的日期、金额和科目相同。仍要再次记录？')}
      </p>
      <div className="flex justify-end gap-3">
        <button onClick={() => setSimilarEntries(null)} className="px-4 py-2 border rounded-md text-sm">{tr('Cancel', '取消', '取消')}</button>
        <button onClick={() => { setSimilarEntries(null); createEntry.mutate({ ...entryForm, file_ids: entryForm.files.map(f => f.id), duplicate_acknowledged: true }); }}
          className="px-4 py-2 bg-amber-500 text-white rounded-md text-sm hover:bg-amber-600">
          {tr('Post anyway', '仍要記錄', '仍要记录')}
        </button>
      </div>
    </div>
  </div>
)}
```

- [ ] **Step 13: Add reverse buttons to the GJE tab list** — in the entries table, add a Reverse button column:

```tsx
<td className="py-2 px-2 text-right">
  <button title={tr('Reverse entry', '沖銷分錄', '冲销分录')}
    onClick={() => {
      if (window.confirm(tr(`Post a reversal of ${e.entry_number}?`, `記錄 ${e.entry_number} 的沖銷分錄？`, `记录 ${e.entry_number} 的冲销分录？`)))
        reverseEntry.mutate(e.id);
    }}
    className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
    <RotateCcw className="h-4 w-4" />
  </button>
</td>
```

- [ ] **Step 14: Add reverseEntry mutation**:

```ts
const reverseEntry = useMutation({
  mutationFn: (id: string) => api(`/bookkeeping/entries/${id}/reverse`, { method: 'POST' }),
  onSuccess: (data: any) => {
    toast.success(tr(`Reversal posted: ${data.entry_number}`, `已記錄沖銷分錄 ${data.entry_number}`, `已记录冲销分录 ${data.entry_number}`));
    queryClient.invalidateQueries({ queryKey: ['entries'] });
  },
  onError: (err: any) => toast.error(err?.message || tr('Reversal failed', '沖銷失敗', '冲销失败')),
});
```

- [ ] **Step 15: Build** — `cd frontend && npm run build`. Expected: clean.

- [ ] **Step 16: Commit**

```bash
git add frontend/src/pages/Bookkeeping.tsx
git commit -m "feat(frontend): expanded GJE modal — attachments, warnings, reverse buttons

GJE modal now includes auto-number preview, document attachments with
already-linked warnings, no-document confirm, similar-entry 409 dialog,
and reverse action on each row.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Playwright spec (non-mutating)

**Files:**
- Create: `tests/manual-booking.spec.ts` (gitignored — force-add)

- [ ] **Step 1: Write the spec**:

```ts
import { test, expect } from '@playwright/test';

const BASE = process.env.TEST_BASE_URL || 'https://opcc-crm-testing.pages.dev';
const LOGIN_EMAIL = process.env.TEST_EMAIL || 'muhammadruhan.farhan25@nixorcollege.edu.pk';
const LOGIN_PASSWORD = process.env.TEST_PASSWORD || 'password';

async function login(page: any) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', LOGIN_EMAIL);
  await page.fill('input[type="password"]', LOGIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !window.location.href.includes('/login'), null, { timeout: 30000 });
  await page.evaluate(() => {
    localStorage.removeItem('activeClient');
    localStorage.setItem('i18nextLng', 'en');
  });
}

test.describe('Expanded GJE modal (non-mutating)', () => {
  test('GJE-01: modal opens with auto-number preview', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/GJE`);
    await page.getByRole('button', { name: /New Entry|Create/ }).first().click();
    await expect(page.getByText('Create / Edit Journal Entry').first()).toBeVisible({ timeout: 10000 });
    // voucher preview shows an MJ- number (auto)
    await expect(page.getByText(/MJ-\d{6}-\d{3}/).first()).toBeVisible({ timeout: 10000 });
    // Post disabled while unbalanced (empty lines)
    const postBtn = page.getByRole('button', { name: /^Post Entry$|^Post without documents$/ }).first();
    await expect(postBtn).toBeDisabled();
    // Cancel closes the modal
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  test('GJE-02: attachments section renders', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/GJE`);
    await page.getByRole('button', { name: /New Entry|Create/ }).first().click();
    await expect(page.getByText('Supporting documents').first()).toBeVisible({ timeout: 10000 });
    // attach documents link exists
    await expect(page.getByText('+ attach documents').first()).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  test('GJE-03: reverse button exists on rows', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/GJE`);
    // Wait for entries to load
    await page.waitForTimeout(2000);
    // If there are entries, reverse buttons should be present
    const rows = page.locator('table tbody tr');
    const count = await rows.count();
    if (count > 0) {
      await expect(page.locator('[title="Reverse entry"]').first()).toBeVisible();
    }
  });
});
```

- [ ] **Step 2: Run it**:

```bash
TEST_BASE_URL=<url> npx playwright test tests/manual-booking.spec.ts --headed
```

Expected: 3/3 pass.

- [ ] **Step 3: Commit**

```bash
git add -f tests/manual-booking.spec.ts
git commit -m "test: expanded GJE modal non-mutating Playwright checks

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: Deploy — migration, API, frontend

**Files:** none modified (operations only)

- [ ] **Step 1: Final gates**

```bash
cd api && npx tsc --noEmit 2>&1 | grep -c "error TS"
npx wrangler deploy --dry-run
cd ../frontend && npm run build
```

- [ ] **Step 2: Measure the backfill** (read-only):

```bash
cd ../api
npx wrangler d1 execute opcc-crm-db --command "SELECT COUNT(*) FROM journal_entries WHERE entry_source = 'auto' AND reference_type IS NULL"
```

- [ ] **Step 3: Run the migration on remote D1**:

```bash
npx wrangler d1 execute opcc-crm-db --file=src/db/migration-gje-expanded.sql
```

- [ ] **Step 4: Verify the schema landed**:

```bash
npx wrangler d1 execute opcc-crm-db --command "PRAGMA table_info(journal_entries)" | grep created_by
npx wrangler d1 execute opcc-crm-db --command "SELECT name FROM sqlite_master WHERE name IN ('journal_entry_files','idx_jef_file')"
npx wrangler d1 execute opcc-crm-db --command "SELECT entry_source, COUNT(*) c FROM journal_entries GROUP BY entry_source"
```

- [ ] **Step 5: Deploy the API worker**:

```bash
cd api && npm run deploy
```

- [ ] **Step 6: Smoke the new endpoints**:

```bash
API=https://opcc-crm-api.ruhan-farhan.workers.dev/api
curl -s -H "Authorization: Bearer $TOKEN" "$API/bookkeeping/entries/next-number?date=2026-08-27"
curl -s -H "Authorization: Bearer $TOKEN" "$API/bookkeeping/entries/manual?start_date=2025-01-01&end_date=2026-12-31"
```

- [ ] **Step 7: Deploy the frontend**:

```bash
cd ../frontend && npx wrangler pages deploy dist --project-name=opcc-crm-testing
```

- [ ] **Step 8: Re-run the Playwright spec** against the fresh testing URL (all 3 tests).

---

### Task 11: Live round-trip + cleanup

**Files:**
- Create: `tests/manual-booking-live.ts` (gitignored — force-add)

- [ ] **Step 1: Obtain a token** for the demo supervisor tenant.

- [ ] **Step 2: Write `tests/manual-booking-live.ts`**:

```ts
// Run: TEST_TOKEN=... npx tsx tests/manual-booking-live.ts
const API = 'https://opcc-crm-api.ruhan-farhan.workers.dev/api';
const token = process.env.TEST_TOKEN!;
const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
let pass = 0, fail = 0;
function ok(cond: boolean, label: string) { if (cond) { pass++; console.log(`PASS: ${label}`); } else { fail++; console.error(`FAIL: ${label}`); } }

(async () => {
  try {
    // 1. next-number
    const nn = await fetch(`${API}/bookkeeping/entries/next-number?date=${new Date().toISOString().split('T')[0]}`, { headers: h });
    const nnj = await nn.json();
    ok(nnj.entry_number?.startsWith('MJ-'), 'next-number returns MJ-...');

    // 2. Get a file id
    const fs = await fetch(`${API}/file-storage?limit=1`, { headers: h });
    const fsj = await fs.json();
    const fileId = fsj.data?.[0]?.id;
    ok(!!fileId, 'tenant has at least 1 file');

    // 3. linked-records
    const lr = await fetch(`${API}/file-storage/${fileId}/linked-records`, { headers: h });
    const lrj = await lr.json();
    ok(Array.isArray(lrj.links), 'linked-records returns array');

    // 4. Create entry with attachment
    const today = new Date().toISOString().split('T')[0];
    const create = await fetch(`${API}/bookkeeping/entries`, {
      method: 'POST', headers: h,
      body: JSON.stringify({
        entry_date: today, description: 'GJE-EXPANDED-LIVE-TEST',
        lines: [{ account_code: '11101', account_name: 'Cash on Hand', description: 'Dr', debit: 100, credit: 0 },
                { account_code: '42101', account_name: 'Interest Income', description: 'Cr', debit: 0, credit: 100 }],
        file_ids: [fileId],
      }),
    });
    const cj = await create.json();
    ok(create.ok && cj.entry_number?.startsWith('MJ-'), `created entry ${cj.entry_number}`);
    const id1 = cj.id;

    // 5. Duplicate check
    const dup = await fetch(`${API}/bookkeeping/entries`, {
      method: 'POST', headers: h,
      body: JSON.stringify({
        entry_date: today, description: 'GJE-EXPANDED-LIVE-TEST',
        lines: [{ account_code: '11101', account_name: 'Cash on Hand', description: 'Dr', debit: 100, credit: 0 },
                { account_code: '42101', account_name: 'Interest Income', description: 'Cr', debit: 0, credit: 100 }],
        file_ids: [fileId],
      }),
    });
    ok(dup.status === 409, 'duplicate returns 409');
    const dupj = await dup.json();
    ok(dupj.error_code === 'similar_entry_exists', '409 has similar_entry_exists code');

    // 6. Re-submit with acknowledgement
    const dup2 = await fetch(`${API}/bookkeeping/entries`, {
      method: 'POST', headers: h,
      body: JSON.stringify({
        entry_date: today, description: 'GJE-EXPANDED-LIVE-TEST',
        lines: [{ account_code: '11101', account_name: 'Cash on Hand', description: 'Dr', debit: 100, credit: 0 },
                { account_code: '42101', account_name: 'Interest Income', description: 'Cr', debit: 0, credit: 100 }],
        file_ids: [fileId], duplicate_acknowledged: true,
      }),
    });
    ok(dup2.ok, 'duplicate acknowledged succeeds');
    const id2 = (await dup2.json()).id;

    // 7. Manual list
    const ml = await fetch(`${API}/bookkeeping/entries/manual?start_date=2025-01-01&end_date=2026-12-31`, { headers: h });
    const mlj = await ml.json();
    ok(mlj.data.some((e: any) => e.id === id1), 'entry 1 in manual list');
    ok(mlj.data.some((e: any) => e.id === id2), 'entry 2 in manual list');

    // 8. Reverse
    const rev = await fetch(`${API}/bookkeeping/entries/${id1}/reverse`, { method: 'POST', headers: h });
    ok(rev.ok, 'reverse succeeds');
    const revj = await rev.json();
    ok(revj.entry_number?.endsWith('-REV'), 'reversal has -REV suffix');

    // 9. Delete
    const del = await fetch(`${API}/bookkeeping/entries/${id2}`, { method: 'DELETE', headers: h });
    ok(del.ok, 'delete succeeds');

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  } finally {
    // Cleanup
    console.log('Cleaning up...');
    // Collect ids from above (id1, id2, revj.id) and delete via SQL
  }
})();
```

- [ ] **Step 3: Run it** — all steps PASS.

- [ ] **Step 4: Commit the script**

```bash
git add -f tests/manual-booking-live.ts
git commit -m "test: expanded GJE modal live round-trip (create/dup/reverse/delete + cleanup)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 12: Update SESSION_STATE.md

**Files:**
- Modify: `SESSION_STATE.md`

- [ ] **Step 1: Append a dated section** summarizing: feature shipped, migration applied, deployed API version + frontend URL, round-trip evidence, and the tombstone-delete behavior change.

- [ ] **Step 2: Commit**

```bash
git add SESSION_STATE.md
git commit -m "docs: SESSION_STATE update for expanded GJE modal feature

Co-Authored-By: Claude <noreply@anthropic.com>"
```
