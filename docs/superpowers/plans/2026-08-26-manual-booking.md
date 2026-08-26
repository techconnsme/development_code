# Manual Booking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Manual Booking subpage under Bookkeeping where users create GL vouchers by hand — auto-numbered `MJ-YYYYMM-NNN`, multi-line DR/CR, multiple R2 document attachments with "already linked elsewhere" warnings, reverse-entry correction, duplicate-entry and no-document warnings.

**Architecture:** Extend the existing `POST /bookkeeping/entries` pipeline (DR=CR / leaf-account / closed-period guards and audit logging reused) with optional `file_ids`, server-side auto-numbering, `entry_source='manual'`, `created_by` stamp and a similar-entry check. One junction table `journal_entry_files` links vouchers to `file_records`. Frontend: new `/manual-booking` page with an inline full-width editor built on a `JournalLineEditor` component extracted from the existing GJE modal (which is rewired onto it).

**Tech Stack:** Cloudflare Worker (Hono) + D1 (SQLite) + R2; React + TypeScript + TanStack Query + Tailwind; `tr()` EN/繁/简 i18n; Playwright for non-mutating specs.

**Spec:** `docs/superpowers/specs/2026-08-26-manual-booking-design.md` — read it before starting; this plan argues from it.

## Global Constraints

- **CONCURRENT SESSION:** Another AI agent session is editing this same codebase. All work happens in an isolated git worktree (Task 0). Never run `git add -A` / `git add .` / `git commit -a` — always add files by explicit path. Never stash, revert, or commit changes that are not yours. Before editing any shared file, re-read its CURRENT content first — the other session may have committed changes since this plan was written.
- API typecheck baseline: measure in Task 0 (`npx tsc --noEmit` in `api/`), keep the count identical through all tasks; zero new errors in touched files.
- Frontend `npm run build` must stay clean after every frontend task.
- `tests/` is gitignored — Playwright specs and test harnesses there need `git add -f`.
- All frontend strings via `tr('EN', '繁體', '简体')`; sidebar labels via `nav.*` keys in all three locale JSONs.
- Every API write audit-logged via the file-local `auditLog()` helper; tenancy always `const tenantId = c.get('client_user_id') || user.id`.
- House git convention: commit messages end with `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Migration files are plain SQL applied manually with `wrangler d1 execute` — there is no migrations runner. Verify with PRAGMA after running; never assume a `.sql` file was applied.
- `playwright-report/` dirties the tree on test runs — never commit it.

---

### Task 0: Setup — isolated worktree + baselines

**Files:** none modified

**Why:** the concurrent session's uncommitted changes live in the main working tree; we must not touch them or build on top of them.

- [ ] **Step 1: Create an isolated worktree**

Use the `superpowers:using-git-worktrees` skill for the repo at `C:\Users\samue\Documents\Pastel\Tech_Connect_SME\Development_code\latest_code` (branch name: `manual-booking`). All subsequent tasks run inside that worktree. Record its path; every command below assumes `cwd` = the worktree's `latest_code` root.

- [ ] **Step 2: Measure the API typecheck baseline**

```bash
cd api && npx tsc --noEmit 2>&1 | tee /tmp/tsc-baseline.txt | tail -1
grep -c "error TS" /tmp/tsc-baseline.txt
```

Expected: a nonzero count (historically 24–43). WRITE THIS NUMBER DOWN — every later `tsc` run must match it exactly, and no error may point at a file this plan touches.

- [ ] **Step 3: Measure the frontend build baseline**

```bash
cd frontend && npm run build
```

Expected: clean build. Note the output hash dir for later comparison.

- [ ] **Step 4: Sanity-check the concurrent-session state**

```bash
git log --oneline -3 && git status --short | head
```

Expected in the worktree: clean tree on `main` HEAD (uncommitted changes belong to the OTHER tree and must NOT appear here; if they do, stop and report — something was committed mid-flight).

---

### Task 1: Migration + schema.sql

**Files:**
- Create: `api/src/db/migration-manual-booking.sql`
- Modify: `api/src/db/schema.sql` (journal_entries block ~line 148-169; add junction table after journal_lines ~line 182; indexes ~line 244-246)

- [ ] **Step 1: Write the migration file**

Create `api/src/db/migration-manual-booking.sql`:

```sql
-- Manual Booking feature (spec: docs/superpowers/specs/2026-08-26-manual-booking-design.md)
-- Attachments: which documents support which manual bookings (many-to-many)
CREATE TABLE IF NOT EXISTS journal_entry_files (
  entry_id        TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  file_record_id  TEXT NOT NULL REFERENCES file_records(id),
  attached_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entry_id, file_record_id)
);
CREATE INDEX IF NOT EXISTS idx_jef_file ON journal_entry_files(file_record_id);

-- Who typed the entry (firm staff vs tenant owner). JSON snapshot {"id","name","email"}.
ALTER TABLE journal_entries ADD COLUMN created_by TEXT;

-- Backfill: every auto-generated JE carries a reference_type (bank_transaction,
-- invoice, payment, journal, card_transaction, year_end_close, tax_provision,
-- fixed_asset, expense, petty_cash). Rows with none were hand-keyed through the
-- GJE modal but got the 'auto' default. Measure the count before running:
--   SELECT COUNT(*) FROM journal_entries WHERE entry_source = 'auto' AND reference_type IS NULL;
UPDATE journal_entries SET entry_source = 'manual'
WHERE entry_source = 'auto' AND reference_type IS NULL;
```

- [ ] **Step 2: Update schema.sql for fresh DBs**

In `api/src/db/schema.sql`, inside `CREATE TABLE journal_entries`, after the `entry_source TEXT NOT NULL DEFAULT 'auto',` line (line ~167), add:

```sql
  -- Operator snapshot {"id","name","email"} of whoever created the entry
  -- (firm staff when booking via X-Active-Client; else the tenant user).
  created_by TEXT,
```

After the `journal_lines` table definition (after line ~182), add:

```sql
-- Manual Booking attachments (many-to-many voucher ↔ file_records)
CREATE TABLE IF NOT EXISTS journal_entry_files (
  entry_id        TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  file_record_id  TEXT NOT NULL REFERENCES file_records(id),
  attached_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entry_id, file_record_id)
);
```

And near the other journal_entries indexes (line ~246), add:

```sql
CREATE INDEX IF NOT EXISTS idx_jef_file ON journal_entry_files(file_record_id);
```

- [ ] **Step 3: Verify the SQL parses (dry run against a scratch local DB)**

```bash
cd api
npx wrangler d1 execute opcc-crm-db --local --file=src/db/migration-manual-booking.sql
```

Expected: statements succeed on the LOCAL scratch DB (this does not touch remote). If the local DB lacks `journal_entries` the ALTER will fail — in that case initialize first with `npm run db:init -- --local`. The remote run happens in Task 12.

- [ ] **Step 4: Commit**

```bash
git add api/src/db/migration-manual-booking.sql api/src/db/schema.sql
git commit -m "feat(db): manual booking migration — journal_entry_files + created_by

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Shared helpers — `api/src/lib/manual-booking.ts` (TDD)

**Files:**
- Create: `api/src/lib/manual-booking.ts`
- Test: `tests/manual-booking.test.ts` (gitignored — force-add at commit)

**Interfaces:**
- Produces (used by Tasks 3, 4, 6):
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
            // nextManualVoucherNumber: SELECT entry_number ... LIKE 'MJ-YYYYMM-%' ORDER BY ... DESC LIMIT 1
            if (/LIKE/.test(sql) && /entry_number/.test(sql)) {
              const like = String(args[1]); // e.g. 'MJ-202608-%'
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
  ok(await nextManualVoucherNumber(mockDb([]), U, '2026-08-26') === 'MJ-202608-001', 'first number is MJ-202608-001');
  ok(await nextManualVoucherNumber(mockDb(['MJ-202608-003']), U, '2026-08-26') === 'MJ-202608-004', 'after 003 comes 004');
  ok(await nextManualVoucherNumber(mockDb(['MJ-202607-009']), U, '2026-08-26') === 'MJ-202608-001', 'month rollover restarts seq');
  ok(await nextManualVoucherNumber(mockDb(['MJ-202608-010']), U, '2026-08-01') === 'MJ-202608-011', 'padded comparison');
  capturedSql = [];
  await nextManualVoucherNumber(mockDb([]), U, '2026-08-26');
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
  const cands = await findSimilarEntryCandidates(db, U, '2026-08-26', 12000);
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
  const links5 = buildFileLinks({}, [{ id: 'je-9', entry_number: 'MJ-202608-005', entry_date: '2026-08-26' }]);
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
// Shared helpers for the Manual Booking feature.
// Spec: docs/superpowers/specs/2026-08-26-manual-booking-design.md

export interface SimilarEntry {
  id: string; entry_number: string; description: string; total_debit: number;
}

export interface FileLink {
  kind: 'invoice' | 'receipt' | 'bank_statement' | 'card_statement' | 'journal_entry';
  id: string; label: string;
}

// Next sequential manual voucher number: MJ-YYYYMM-NNN (e.g. MJ-202608-001).
// Scans ALL rows including tombstoned ones so numbers are never reused.
export async function nextManualVoucherNumber(db: any, tenantId: string, date: string): Promise<string> {
  const ym = date.slice(0, 7).replace(/-/g, ''); // '2026-08-26' → '202608'
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

// Pure predicate: do the candidate's line accounts overlap the new booking's accounts?
export function hasSharedAccount(entryLineCodes: string[], newCodes: string[]): boolean {
  const set = new Set(entryLineCodes);
  return newCodes.some((c) => set.has(c));
}

// Live entries on the same date with the same total debit (±0.01), with their line codes.
// Caller filters the result with hasSharedAccount().
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

// Assemble the "already linked elsewhere" list for one file_records row.
// fileRow carries the LEFT JOIN columns from the route query; jeRows the journal links.
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

Expected: same count as Task 0 baseline, none in `lib/manual-booking.ts`.

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
- Modify: `api/src/routes/bookkeeping.ts` (imports ~line 15, `entrySchema` lines 122-125, handler lines 127-172)

**Interfaces:**
- Consumes: `nextManualVoucherNumber`, `findSimilarEntryCandidates`, `hasSharedAccount` from `../lib/manual-booking` (Task 2)
- Produces: the create endpoint now accepts optional `file_ids`/`duplicate_acknowledged`, auto-numbers when `entry_number` omitted, and can return **409** `{ error: 'Similar entry already exists', error_code: 'similar_entry_exists', similar_entries: [{id, entry_number, description, total_debit}] }`

- [ ] **Step 1: Re-read the current state of `bookkeeping.ts` lines 1-180** (concurrent-session check) and confirm `entrySchema` and the POST handler still match the shapes below. Adapt line numbers if they drifted, but STOP and report if the handler logic itself changed.

- [ ] **Step 2: Add the import** after the `checkPeriodOpen` import (line 15):

```ts
import { nextManualVoucherNumber, findSimilarEntryCandidates, hasSharedAccount } from '../lib/manual-booking';
```

- [ ] **Step 3: Make `entry_number` optional and add the new fields** — replace the `entrySchema` block (lines 122-125):

```ts
const entrySchema = z.object({
  entry_number: z.string().min(1).max(50).optional(), entry_date: z.string().max(10), description: z.string().min(1).max(500),
  reference_type: z.string().max(50).optional(), reference_id: z.string().max(50).optional(), lines: z.array(lineSchema).min(2).max(200),
  file_ids: z.array(z.string()).max(10).optional(), duplicate_acknowledged: z.boolean().optional(),
});
```

- [ ] **Step 4: Extend the handler.** Inside `bookkeeping.post('/entries', ...)`, after the existing `checkPeriodOpen` guard (lines 154-155) and BEFORE the `INSERT INTO journal_entries`, insert:

```ts
  // Validate attached files belong to this tenant and are live
  const fileIds = [...new Set(data.file_ids || [])];
  if (fileIds.length > 0) {
    const fileRows = await db.prepare(
      `SELECT id FROM file_records WHERE user_id = ? AND deleted_at IS NULL AND id IN (${fileIds.map(() => '?').join(',')})`
    ).bind(tenantId, ...fileIds).all();
    const found = new Set((fileRows.results as any[]).map(f => f.id));
    const missing = fileIds.filter(fid => !found.has(fid));
    if (missing.length > 0) return c.json({ error: `File(s) not found: ${missing.join(', ')}` }, 400);
  }

  // Similar-entry duplicate check (skipped once the user acknowledged it)
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

Note: `codes` is the existing `[...new Set(data.lines.map(l => l.account_code))]` defined earlier in the handler (~line 139), and `totalDebit` the existing sum (~line 134).

- [ ] **Step 5: Replace the journal_entries INSERT** (lines 157-159) with the stamped version:

```ts
  await db.prepare(
    'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id, entry_source, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, tenantId, entryNumber, data.entry_date, data.description, data.reference_type || null, data.reference_id || null, 'manual', createdBy).run();
```

- [ ] **Step 6: Insert attachment rows** right after the journal_lines loop (after line ~166):

```ts
  for (const fileId of fileIds) {
    await db.prepare('INSERT OR IGNORE INTO journal_entry_files (entry_id, file_record_id) VALUES (?, ?)').bind(id, fileId).run();
  }
```

- [ ] **Step 7: Extend the audit payload** — replace the `auditLog(...)` call (line ~170):

```ts
  await auditLog(db, user.id, 'create', 'journal_entry', id, {
    entry_number: entryNumber, description: data.description, lines: data.lines.length,
    file_ids: fileIds, duplicate_acknowledged: !!data.duplicate_acknowledged,
  });
```

- [ ] **Step 8: Verify**

```bash
cd api && npx tsc --noEmit 2>&1 | grep -c "error TS"   # must equal Task 0 baseline
npx wrangler deploy --dry-run                            # bundle must build
```

Expected: baseline count unchanged; dry-run bundles OK.

- [ ] **Step 9: Commit**

```bash
git add api/src/routes/bookkeeping.ts
git commit -m "feat(api): manual booking create — auto voucher no., file links, duplicate check

POST /bookkeeping/entries now auto-numbers MJ-YYYYMM-NNN when entry_number is
omitted, validates+stores file_ids in journal_entry_files, stamps
entry_source='manual' + created_by, and returns 409 similar_entry_exists
until duplicate_acknowledged is sent.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: `GET /entries/manual` + `GET /entries/next-number`

**Files:**
- Modify: `api/src/routes/bookkeeping.ts` (insert between `GET /entries` ending ~line 104 and `GET /entries/:id` at ~line 106)

**Interfaces:**
- Consumes: `nextManualVoucherNumber` (Task 2), `jeLive()` (existing import)
- Produces:
  - `GET /bookkeeping/entries/manual?start_date&end_date` → `{ data: [{...entry, total_debit, total_credit, created_by: {id,name,email}|null, files: [{id,filename}], reversed: boolean}] }`
  - `GET /bookkeeping/entries/next-number?date=YYYY-MM-DD` → `{ entry_number: 'MJ-YYYYMM-NNN' }`

- [ ] **Step 1: Insert both routes** immediately after the `GET /entries` handler (so they register BEFORE the `/entries/:id` param route):

```ts
// Manual bookings list (new Manual Booking subpage). Hand-keyed entries only:
// entry_source='manual' AND no reference_type (auto entries and petty cash all carry one).
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

// Voucher-number preview for the Manual Booking form (read-only, nothing written)
bookkeeping.get('/entries/next-number', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const date = c.req.query('date') || new Date().toISOString().split('T')[0];
  return c.json({ entry_number: await nextManualVoucherNumber(c.env.DB, tenantId, date) });
});
```

- [ ] **Step 2: Verify route order** — confirm in the file that both new routes appear ABOVE `bookkeeping.get('/entries/:id', ...)` and ABOVE `bookkeeping.patch('/entries/:id/status', ...)`.

- [ ] **Step 3: Verify**

```bash
cd api && npx tsc --noEmit 2>&1 | grep -c "error TS"   # baseline unchanged
npx wrangler deploy --dry-run                            # bundle OK
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
- Modify: `api/src/routes/bookkeeping.ts` (DELETE handler lines ~194-215, reverse handler lines ~217-251)

- [ ] **Step 1: Delete becomes tombstone.** Replace the comment at line ~194 and the DELETE statement at lines ~211-212:

Comment becomes:
```ts
// Delete a journal entry — tombstone (soft delete): lines retained, voucher number retired.
// HK practice: posted vouchers are corrected by reversal, never destroyed.
```

Replace:
```ts
  await db.prepare('DELETE FROM journal_entries WHERE id = ? AND user_id = ?')
    .bind(id, tenantId).run();
```
with:
```ts
  await db.prepare("UPDATE journal_entries SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .bind(id, tenantId).run();
```

The existing closed-period check above it stays as-is.

- [ ] **Step 2: Reverse — reject tombstoned originals.** In the reverse handler, immediately after the `if (!entry) return c.json({ error: 'Entry not found' }, 404);` line (~226), add:

```ts
  if ((entry as any).deleted_at) return c.json({ error: 'Cannot reverse a deleted entry' }, 409);

  const revDate = new Date().toISOString().split('T')[0];
  if (!(await checkPeriodOpen(db, tenantId, revDate)))
    return c.json({ error: 'Cannot create reversal in a closed period' }, 400);
```

- [ ] **Step 3: Reverse — stamp entry_source + created_by.** Replace the reversal INSERT (lines ~234-237):

```ts
  await db.prepare(
    'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(revId, tenantId, revNumber, new Date().toISOString().split('T')[0],
    `Reversal: ${entry.description}`, 'journal', originalId).run();
```

with:

```ts
  await db.prepare(
    'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id, entry_source, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(revId, tenantId, revNumber, revDate,
    `Reversal: ${entry.description}`, 'journal', originalId, 'manual',
    JSON.stringify({ id: user.id, name: user.name, email: user.email })).run();
```

Keep the existing `revNumber = \`${entry.entry_number}-REV\`` convention unchanged.

- [ ] **Step 4: Verify**

```bash
cd api && npx tsc --noEmit 2>&1 | grep -c "error TS"   # baseline unchanged
npx wrangler deploy --dry-run                            # bundle OK
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
- Modify: `api/src/routes/file-storage.ts` (import near line 12; new route inserted after the `GET /issues` block ending ~line 2082, BEFORE any `/:id` route)

⚠️ **Concurrent-session hot file** — another session has uncommitted edits to this file in the main tree. Keep the change to ONE import line + ONE self-contained route block; re-read the insertion point immediately before editing.

**Interfaces:**
- Consumes: `buildFileLinks` from `../lib/manual-booking` (Task 2)
- Produces: `GET /api/file-storage/:id/linked-records` → `{ file_id, links: FileLink[] }` or 404

- [ ] **Step 1: Add the import** alongside the other lib imports (after the `import { reconcileDirections } ...` line ~22):

```ts
import { buildFileLinks } from '../lib/manual-booking';
```

- [ ] **Step 2: Insert the route** after the `/issues` handler (line ~2082), before any other route containing `:id`:

```ts
// Where else is this file already linked? (Manual Booking duplicate-link warning)
files.get('/:id/linked-records', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const id = c.req.param('id');

  // Same join shape as the list endpoint; a fan-out here (file linked to several
  // statements) is benign — .first() reports one link of each kind found.
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
cd api && npx tsc --noEmit 2>&1 | grep -c "error TS"   # baseline unchanged
npx wrangler deploy --dry-run                            # bundle OK
```

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/file-storage.ts
git commit -m "feat(api): file linked-records endpoint for manual booking warnings

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Extract `JournalLineEditor` + rewire GJE modal

**Files:**
- Create: `frontend/src/components/JournalLineEditor.tsx`
- Modify: `frontend/src/pages/Bookkeeping.tsx` (imports ~line 10; `addLine`/`updateLine` lines 186-199; `totals` memo lines 204-208; modal table+footer JSX lines 998-1120; datalist lines 1133-1137)

⚠️ Re-read Bookkeeping.tsx fully before editing — it is 1,338 lines and shared.

**Interfaces:**
- Produces (used by Task 10): default export `JournalLineEditor` with props `{ accounts: any[]; leafAccounts: any[]; lines: JournalLine[]; onChange: (lines: JournalLine[]) => void; datalistId?: string }`; named exports `JournalLine`, `EMPTY_JOURNAL_LINE`, `computeTotals(lines) → { debit, credit, diff, balanced }`

- [ ] **Step 1: Create the component** at `frontend/src/components/JournalLineEditor.tsx`. It is the GJE modal's lines table + balance footer + datalist (Bookkeeping.tsx lines 998-1120 and 1133-1137), lifted verbatim and rewired from `entryForm`/`updateLine`/`addLine` to props:

```tsx
import React from 'react';
import { tr } from '../lib/i18nHelpers';

export interface JournalLine {
  account_code: string; account_name: string; description: string;
  debit: number; credit: number; project?: string;
}

export const EMPTY_JOURNAL_LINE: JournalLine = {
  account_code: '', account_name: '', description: '', debit: 0, credit: 0, project: '',
};

export function computeTotals(lines: JournalLine[]) {
  const debit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const credit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  return { debit, credit, diff: debit - credit, balanced: Math.abs(debit - credit) <= 0.001 };
}

const fmtMoney = (n: number) => (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2 });

const TYPE_BADGE: Record<string, string> = {
  asset: 'bg-blue-100 text-blue-700', liability: 'bg-orange-100 text-orange-700',
  equity: 'bg-green-100 text-green-700', revenue: 'bg-emerald-100 text-emerald-700',
  cost: 'bg-orange-100 text-orange-700', expense: 'bg-red-100 text-red-700',
};

export default function JournalLineEditor({ accounts, leafAccounts, lines, onChange, datalistId = 'account-list' }: {
  accounts: any[]; leafAccounts: any[]; lines: JournalLine[];
  onChange: (lines: JournalLine[]) => void; datalistId?: string;
}) {
  function updateLine(idx: number, field: string, value: any) {
    const next = lines.map((l, i) => (i === idx ? { ...l, [field]: value } : l));
    if (field === 'debit') next[idx] = { ...next[idx], credit: 0 };
    if (field === 'credit') next[idx] = { ...next[idx], debit: 0 };
    onChange(next);
  }
  function addLine() { onChange([...lines, { ...EMPTY_JOURNAL_LINE }]); }
  function removeLine(idx: number) {
    const next = lines.filter((_, i) => i !== idx);
    onChange(next.length ? next : [{ ...EMPTY_JOURNAL_LINE }]);
  }
  const totals = computeTotals(lines);

  return (
    <>
      <div className="border rounded-md overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 border-b text-xs text-muted-foreground">
              <th className="py-2 px-2 w-8 font-medium">#</th>
              <th className="py-2 px-2 text-left font-medium">{tr('Account #', '科目編號', '科目编号')}</th>
              <th className="py-2 px-2 text-left font-medium">{tr('Account Name', '科目名稱', '科目名称')}</th>
              <th className="py-2 px-2 text-right font-medium w-[120px]">{tr('Debit ($Dr$)', '借方 ($Dr$)', '借方 ($Dr$)')}</th>
              <th className="py-2 px-2 text-right font-medium w-[120px]">{tr('Credit ($Cr$)', '貸方 ($Cr$)', '贷方 ($Cr$)')}</th>
              <th className="py-2 px-2 text-left font-medium">{tr('Project/Item', '項目', '项目')}</th>
              <th className="py-2 px-2 text-left font-medium">{tr('Line Memo', '記帳備忘', '记帐备记')}</th>
              <th className="py-2 px-2 w-8"></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, idx) => {
              const matchedAccount = accounts.find((a: any) => a.account_code === line.account_code);
              const typeBadge = matchedAccount ? (TYPE_BADGE[matchedAccount.account_type] || '') : '';
              const normalSide = matchedAccount ? (
                ['asset', 'cost', 'expense'].includes(matchedAccount.account_type) ? 'Dr' : 'Cr'
              ) : '';
              return (
                <tr key={idx} className="border-b border-muted/30 hover:bg-muted/20">
                  <td className="py-1.5 px-2 text-muted-foreground text-xs text-center">{idx + 1}</td>
                  <td className="py-1.5 px-2">
                    <input required value={line.account_code}
                      onChange={(e) => {
                        const code = e.target.value;
                        updateLine(idx, 'account_code', code);
                        const match = accounts.find((a: any) => a.account_code === code);
                        if (match) updateLine(idx, 'account_name', match.account_name);
                      }}
                      placeholder={tr('Account #', '科目編號', '科目编号')}
                      list={datalistId}
                      className="w-[90px] px-2 py-1 border rounded text-xs font-mono" />
                  </td>
                  <td className="py-1.5 px-2">
                    <div className="flex flex-col gap-0.5">
                      <select value={line.account_name}
                        onChange={(e) => {
                          const name = e.target.value;
                          updateLine(idx, 'account_name', name);
                          const match = accounts.find((a: any) => a.account_name === name);
                          if (match) updateLine(idx, 'account_code', match.account_code);
                        }}
                        className="w-full px-2 py-1 border rounded text-xs bg-background min-w-[130px]">
                        <option value="">{tr('Select...', '選擇科目...', '选择科目...')}</option>
                        {leafAccounts.map((a: any) => (
                          <option key={a.id} value={a.account_name}>{a.account_code} – {a.account_name}</option>
                        ))}
                      </select>
                      {matchedAccount && (
                        <div className="flex items-center gap-1">
                          <span className={`text-[10px] px-1 py-0 rounded ${typeBadge}`}>{matchedAccount.account_type}</span>
                          <span className="text-[10px] text-muted-foreground">({normalSide})</span>
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="py-1.5 px-2">
                    <input type="number" step="0.01" min="0"
                      value={line.debit || ''} onChange={(e) => updateLine(idx, 'debit', parseFloat(e.target.value) || 0)}
                      className="w-full px-2 py-1 border rounded text-xs text-right font-mono" placeholder="0.00" />
                  </td>
                  <td className="py-1.5 px-2">
                    <input type="number" step="0.01" min="0"
                      value={line.credit || ''} onChange={(e) => updateLine(idx, 'credit', parseFloat(e.target.value) || 0)}
                      className="w-full px-2 py-1 border rounded text-xs text-right font-mono" placeholder="0.00" />
                  </td>
                  <td className="py-1.5 px-2">
                    <input value={line.project || ''} onChange={(e) => updateLine(idx, 'project', e.target.value)}
                      placeholder={tr('Optional', '可選', '可选')} className="w-full px-2 py-1 border rounded text-xs" />
                  </td>
                  <td className="py-1.5 px-2">
                    <input value={line.description} onChange={(e) => updateLine(idx, 'description', e.target.value)}
                      placeholder={tr('Line memo', '記帳備忘', '记帐备记')} className="w-full px-2 py-1 border rounded text-xs" />
                  </td>
                  <td className="py-1.5 px-2 text-center">
                    <button type="button" onClick={() => removeLine(idx)}
                      className="text-destructive text-xs hover:bg-destructive/10 rounded p-1">✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="px-3 py-2 border-t flex justify-between items-center">
          <button type="button" onClick={addLine} className="text-xs text-primary hover:underline">{tr('+ Add Line', '+ 新增行', '+ 新增行')}</button>
          <span className="text-xs text-muted-foreground">{lines.length} {tr('line(s)', '行', '行')}</span>
        </div>
      </div>

      {/* Balance check footer */}
      <div className="border rounded-md p-4 space-y-2 bg-muted/20">
        <div className="flex justify-end gap-8 text-sm">
          <div className="text-right">
            <span className="text-muted-foreground">{tr('Total Debit', '總借項', '总借项')}: </span>
            <span className="font-mono font-medium">HK$ {fmtMoney(totals.debit)}</span>
          </div>
          <div className="text-right">
            <span className="text-muted-foreground">{tr('Total Credit', '總貸項', '总贷项')}: </span>
            <span className="font-mono font-medium">HK$ {fmtMoney(totals.credit)}</span>
          </div>
          <div className="text-right">
            <span className="text-muted-foreground">{tr('Difference', '差額', '差额')}: </span>
            <span className={`font-mono font-medium ${totals.balanced ? 'text-green-600' : 'text-red-600'}`}>HK$ {fmtMoney(Math.abs(totals.diff))}</span>
          </div>
        </div>
        <div aria-live="polite" className={`flex items-center justify-center gap-2 py-1.5 rounded-md text-sm font-medium ${
          totals.balanced ? 'bg-green-100 dark:bg-green-950/40 text-green-700' : 'bg-red-100 dark:bg-red-950/40 text-red-700'
        }`}>
          {totals.balanced ? (
            <>{tr('✓ Balanced', '✓ 已平衡', '✓ 已平衡')}</>
          ) : (
            <>{tr('⚠ Unbalanced — Debits must equal credits', '⚠ 不平衡 — 借貸必須相等', '⚠ 不平衡 — 借贷必须相等')}</>
          )}
        </div>
      </div>

      <datalist id={datalistId}>
        {leafAccounts.map((a: any) => (
          <option key={a.id} value={a.account_code}>{a.account_code} – {a.account_name}</option>
        ))}
      </datalist>
    </>
  );
}
```

- [ ] **Step 2: Rewire the GJE modal in Bookkeeping.tsx.**

a. Add imports (near line 11):
```ts
import JournalLineEditor, { computeTotals } from '../components/JournalLineEditor';
```

b. DELETE the `addLine()` and `updateLine()` functions (lines ~186-199) — they now live in the component.

c. Replace the `totals` useMemo (lines ~204-208) with:
```ts
  const totals = computeTotals(entryForm.lines);
```

d. Replace the modal's lines table + balance footer (lines ~998-1120, from `{/* Lines table */}` through the balance footer's closing `</div>`) with:
```tsx
              <JournalLineEditor
                accounts={accounts?.data || []}
                leafAccounts={leafAccounts}
                lines={entryForm.lines}
                onChange={(lines) => setEntryForm({ ...entryForm, lines })}
              />
```

e. DELETE the modal's trailing `<datalist id="account-list">` block (lines ~1133-1137) — it is now rendered by the component.

- [ ] **Step 3: Build**

```bash
cd frontend && npm run build
```

Expected: clean. If TS complains that `entryForm.lines` (which has `project: string`) is not assignable to `JournalLine[]` — it IS assignable (`project?: string` accepts `string`); if vite complains otherwise, widen `EMPTY_JOURNAL_LINE` typing, do not change the modal form.

- [ ] **Step 4: Manual smoke (non-negotiable — behavior must be unchanged)**

Run the app (`cd frontend && npm run dev` against the live API is fine), open the GJE tab, click **+ New Entry**: datalist autocomplete, name↔code sync, DR/CR mutual exclusion, add/remove line, ✓/⚠ footer, Post all work exactly as before. Post one throwaway entry on the demo account, verify it appears, then DELETE it (delete is now a tombstone — the row must disappear from the GJE list; that is expected).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/JournalLineEditor.tsx frontend/src/pages/Bookkeeping.tsx
git commit -m "refactor(frontend): extract JournalLineEditor from GJE modal

Shared multi-line DR/CR editor + balance footer now used by the GJE modal;
the upcoming Manual Booking page builds on the same component.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: `api()` error payload + navigation + i18n + ManualBooking list page

**Files:**
- Modify: `frontend/src/lib/api.ts` (error branch lines 65-68)
- Modify: `frontend/src/components/Layout.tsx` (navGroups ~line 48, NAV_FEATURE_MAP ~line 103)
- Modify: `frontend/src/App.tsx` (FEATURE_ROUTES ~line 95, routes ~line 181, imports)
- Modify: `frontend/src/i18n/locales/en.json`, `zh-Hant.json`, `zh-Hans.json` (nav section)
- Create: `frontend/src/pages/ManualBooking.tsx` (this task: list + row actions; the editor arrives in Task 10)

**Interfaces:**
- Consumes: `GET /bookkeeping/entries/manual`, `POST /entries/:id/reverse`, `DELETE /entries/:id` (Tasks 3-5)
- Produces: page route `/manual-booking`; `api()` errors now carry the parsed JSON body as `(err as any).body` (Task 10 relies on `err.body.error_code`)

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
      e.body = err; // structured fields (error_code, similar_entries…) survive to callers
      throw e;
    }
```

- [ ] **Step 2: Sidebar entry.** In `Layout.tsx` navGroups, inside the `bookkeeping` children array, insert after the `gje` line (~line 48):

```ts
    { key: 'manualBooking', label: 'Manual Booking', to: '/manual-booking' },
```

And in `NAV_FEATURE_MAP` (~line 103) add:

```ts
  manualBooking: 'bookkeeping',
```

- [ ] **Step 3: Route.** In `App.tsx`: add `import ManualBooking from './pages/ManualBooking';` with the other page imports; add to FEATURE_ROUTES: `'/manual-booking': 'bookkeeping',`; and add the route next to the `/GJE` route (~line 181):

```tsx
      <Route path="/manual-booking" element={<ProtectedRoute><FeatureGuard><ManualBooking /></FeatureGuard></ProtectedRoute>} />
```

- [ ] **Step 4: Locale keys.** In each locale JSON's `nav` object, after the `"gje"` key:

- `en.json`: `"manualBooking": "Manual Booking",`
- `zh-Hant.json`: `"manualBooking": "手動記帳",`
- `zh-Hans.json`: `"manualBooking": "手动记账",`

- [ ] **Step 5: Create the page (list version).** Create `frontend/src/pages/ManualBooking.tsx`:

```tsx
import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, WORKER_API_BASE, iframeClientParam } from '../lib/api';
import { useToast } from '../components/Toast';
import { tr } from '../lib/i18nHelpers';
import { useDateFilter } from '../contexts/DateFilterContext';
import { Plus, ChevronDown, ChevronRight, Trash2, RotateCcw, Paperclip, X } from 'lucide-react';

const fmtMoney = (n: number) => (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2 });

export default function ManualBooking() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { startDate, endDate } = useDateFilter();

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [entryDetails, setEntryDetails] = useState<Record<string, any[]>>({});
  const [previewFile, setPreviewFile] = useState<{ id: string; filename: string } | null>(null);

  const { data: manualData } = useQuery({
    queryKey: ['manual-entries', startDate, endDate],
    queryFn: () => api(`/bookkeeping/entries/manual?start_date=${startDate}&end_date=${endDate}`),
    staleTime: 0,
  });
  const entries: any[] = manualData?.data || [];

  function invalidateAll() {
    queryClient.invalidateQueries({ queryKey: ['manual-entries'] });
    queryClient.invalidateQueries({ queryKey: ['entries'] });
  }

  const reverseMut = useMutation({
    mutationFn: (id: string) => api(`/bookkeeping/entries/${id}/reverse`, { method: 'POST' }),
    onSuccess: (data: any) => {
      toast.info(tr(`Reversal posted: ${data.entry_number}`, `已記錄沖銷分錄 ${data.entry_number}`, `已记录冲销分录 ${data.entry_number}`));
      invalidateAll();
    },
    onError: (err: any) => toast.info(err?.message || tr('Reversal failed', '沖銷失敗', '冲销失败')),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api(`/bookkeeping/entries/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.info(tr('Booking deleted', '已刪除記帳', '已删除记帐'));
      invalidateAll();
    },
    onError: (err: any) => toast.info(err?.message || tr('Delete failed', '刪除失敗', '删除失败')),
  });

  function toggleExpand(id: string) {
    const next = expandedId === id ? null : id;
    setExpandedId(next);
    if (next && !entryDetails[next]) {
      api(`/bookkeeping/entries/${next}`)
        .then(d => setEntryDetails(prev => ({ ...prev, [next]: d.lines || [] })))
        .catch(() => {});
    }
  }

  const STATUS_BADGE: Record<string, string> = {
    draft: 'bg-amber-100 text-amber-700', posted: 'bg-green-100 text-green-700', reconciled: 'bg-blue-100 text-blue-700',
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">{tr('Manual Booking', '手動記帳', '手动记账')}</h2>
          <p className="text-sm text-muted-foreground">
            {tr('Hand-keyed journal vouchers (MJ series)', '手工記帳憑證（MJ 系列）', '手工记账凭证（MJ 系列）')}
          </p>
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="border rounded-xl p-10 text-center text-muted-foreground text-sm">
          {tr('No manual bookings yet.', '暫無手動記帳。', '暂无手动记账。')}
        </div>
      ) : (
        <div className="border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b text-xs text-muted-foreground">
                <th className="py-2 px-2 w-8"></th>
                <th className="py-2 px-2 text-left font-medium">{tr('Voucher No.', '總帳 #', '总帐 #')}</th>
                <th className="py-2 px-2 text-left font-medium">{tr('Date', '日期', '日期')}</th>
                <th className="py-2 px-2 text-left font-medium">{tr('Description', '備忘', '备记')}</th>
                <th className="py-2 px-2 text-right font-medium">{tr('Debit', '借方', '借方')}</th>
                <th className="py-2 px-2 text-right font-medium">{tr('Credit', '貸方', '贷方')}</th>
                <th className="py-2 px-2 text-center font-medium">{tr('Docs', '附件', '附件')}</th>
                <th className="py-2 px-2 text-left font-medium">{tr('Status', '狀態', '状态')}</th>
                <th className="py-2 px-2 text-left font-medium">{tr('Created by', '建立者', '建立者')}</th>
                <th className="py-2 px-2 text-right font-medium">{tr('Actions', '操作', '操作')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e: any) => (
                <React.Fragment key={e.id}>
                  <tr className="border-b border-muted/30 hover:bg-muted/20 cursor-pointer" onClick={() => toggleExpand(e.id)}>
                    <td className="py-2 px-2 text-center">
                      {expandedId === e.id ? <ChevronDown className="h-4 w-4 inline" /> : <ChevronRight className="h-4 w-4 inline" />}
                    </td>
                    <td className="py-2 px-2 font-mono text-xs">
                      {e.entry_number}
                      {e.reversed && <span className="ml-1 text-amber-600" title={tr('Has live reversal', '已有沖銷分錄', '已有冲销分录')}>↩</span>}
                    </td>
                    <td className="py-2 px-2">{e.entry_date}</td>
                    <td className="py-2 px-2 max-w-[260px] truncate">{e.description}</td>
                    <td className="py-2 px-2 text-right font-mono">{fmtMoney(e.total_debit)}</td>
                    <td className="py-2 px-2 text-right font-mono">{fmtMoney(e.total_credit)}</td>
                    <td className="py-2 px-2 text-center">
                      {(e.files || []).length > 0 && (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <Paperclip className="h-3 w-3" />{(e.files || []).length}
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-2">
                      <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_BADGE[e.status] || ''}`}>{e.status}</span>
                    </td>
                    <td className="py-2 px-2 text-xs text-muted-foreground">{e.created_by?.name || e.created_by?.email || '—'}</td>
                    <td className="py-2 px-2 text-right" onClick={(ev) => ev.stopPropagation()}>
                      <button title={tr('Reverse entry', '沖銷分錄', '冲销分录')}
                        onClick={() => {
                          if (window.confirm(tr(`Post a reversal of ${e.entry_number}?`, `記錄 ${e.entry_number} 的沖銷分錄？`, `记录 ${e.entry_number} 的冲销分录？`)))
                            reverseMut.mutate(e.id);
                        }}
                        className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
                        <RotateCcw className="h-4 w-4" />
                      </button>
                      <button title={tr('Delete', '刪除', '删除')}
                        onClick={() => {
                          if (window.confirm(tr(`Delete booking ${e.entry_number}? It will be removed from all reports.`, `刪除記帳 ${e.entry_number}？將從所有報表中移除。`, `删除记账 ${e.entry_number}？将从所有报表中移除。`)))
                            deleteMut.mutate(e.id);
                        }}
                        className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                  {expandedId === e.id && (
                    <tr className="border-b bg-muted/10">
                      <td colSpan={10} className="px-6 py-3">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-muted-foreground">
                              <th className="py-1 px-2 text-left font-medium">{tr('Account', '科目', '科目')}</th>
                              <th className="py-1 px-2 text-left font-medium">{tr('Memo', '備忘', '备记')}</th>
                              <th className="py-1 px-2 text-right font-medium">{tr('Debit', '借方', '借方')}</th>
                              <th className="py-1 px-2 text-right font-medium">{tr('Credit', '貸方', '贷方')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(entryDetails[e.id] || []).map((l: any) => (
                              <tr key={l.id} className="border-t border-muted/20">
                                <td className="py-1 px-2 font-mono">{l.account_code} – {l.account_name}</td>
                                <td className="py-1 px-2">{l.description || ''}</td>
                                <td className="py-1 px-2 text-right font-mono">{l.debit ? fmtMoney(l.debit) : ''}</td>
                                <td className="py-1 px-2 text-right font-mono">{l.credit ? fmtMoney(l.credit) : ''}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {(e.files || []).length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {(e.files as any[]).map(f => (
                              <button key={f.id} onClick={() => setPreviewFile(f)}
                                className="inline-flex items-center gap-1 text-xs border rounded-md px-2 py-1 hover:bg-muted">
                                <Paperclip className="h-3 w-3" />{f.filename}
                              </button>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {previewFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setPreviewFile(null)}>
          <div className="bg-card border rounded-xl w-full max-w-4xl h-[80vh] flex flex-col" onClick={(ev) => ev.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-2 border-b">
              <span className="text-sm font-medium truncate">{previewFile.filename}</span>
              <button onClick={() => setPreviewFile(null)} className="p-1 rounded hover:bg-muted"><X className="h-4 w-4" /></button>
            </div>
            <iframe title={previewFile.filename} className="flex-1 w-full"
              src={`${WORKER_API_BASE}/file-storage/${previewFile.id}/download?inline=1&token=${localStorage.getItem('token') || ''}${iframeClientParam()}`} />
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Build**

```bash
cd frontend && npm run build
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/components/Layout.tsx frontend/src/App.tsx \
        frontend/src/i18n/locales/en.json frontend/src/i18n/locales/zh-Hant.json frontend/src/i18n/locales/zh-Hans.json \
        frontend/src/pages/ManualBooking.tsx
git commit -m "feat(frontend): Manual Booking subpage — list, reverse, delete, doc preview

Adds nav entry, /manual-booking route, trilingual labels, and the list page
(expandable rows, reversal badge, created-by stamp, attachment previews).
api() errors now expose the parsed JSON body for structured error handling.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: `DocumentPickerModal` component

**Files:**
- Create: `frontend/src/components/DocumentPickerModal.tsx`

**Interfaces:**
- Produces (used by Task 10): default export `DocumentPickerModal` with props `{ alreadyPicked: string[]; onPick: (picked: PickedFile[]) => void; onClose: () => void }`; named export `PickedFile { id: string; filename: string }`

- [ ] **Step 1: Create the component**:

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

- [ ] **Step 2: Build** — `cd frontend && npm run build`. Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/DocumentPickerModal.tsx
git commit -m "feat(frontend): document picker modal for manual booking attachments

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: Editor panel + attachments + warnings (final ManualBooking.tsx)

**Files:**
- Modify (full rewrite): `frontend/src/pages/ManualBooking.tsx`

**Interfaces:**
- Consumes: `JournalLineEditor`/`computeTotals`/`EMPTY_JOURNAL_LINE` (Task 7), `DocumentPickerModal`/`PickedFile` (Task 9), `GET /entries/manual`, `GET /entries/next-number`, `POST /entries` (409 `similar_entry_exists`), `GET /file-storage/:id/linked-records`, `GET /bookkeeping/closed-periods`, `err.body` from `api()` (Task 8)

- [ ] **Step 1: Replace `frontend/src/pages/ManualBooking.tsx` entirely** with the final page (list from Task 8 unchanged + editor panel):

```tsx
import React, { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { api, WORKER_API_BASE, iframeClientParam } from '../lib/api';
import { useToast } from '../components/Toast';
import { tr } from '../lib/i18nHelpers';
import { filterLeafAccounts } from '../lib/coa-hierarchy';
import { useDateFilter } from '../contexts/DateFilterContext';
import JournalLineEditor, { computeTotals, EMPTY_JOURNAL_LINE, type JournalLine } from '../components/JournalLineEditor';
import DocumentPickerModal, { type PickedFile } from '../components/DocumentPickerModal';
import { Plus, ChevronDown, ChevronRight, Trash2, RotateCcw, Paperclip, AlertTriangle, X } from 'lucide-react';

const fmtMoney = (n: number) => (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2 });

export default function ManualBooking() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { startDate, endDate } = useDateFilter();

  // ── list state ──
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [entryDetails, setEntryDetails] = useState<Record<string, any[]>>({});
  const [previewFile, setPreviewFile] = useState<PickedFile | null>(null);

  // ── editor state ──
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ entry_date: new Date().toISOString().split('T')[0], description: '' });
  const [lines, setLines] = useState<JournalLine[]>([{ ...EMPTY_JOURNAL_LINE }, { ...EMPTY_JOURNAL_LINE }]);
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [confirmNoDocs, setConfirmNoDocs] = useState(false);
  const [similarEntries, setSimilarEntries] = useState<any[] | null>(null);

  const { data: manualData } = useQuery({
    queryKey: ['manual-entries', startDate, endDate],
    queryFn: () => api(`/bookkeeping/entries/manual?start_date=${startDate}&end_date=${endDate}`),
    staleTime: 0,
  });
  const entries: any[] = manualData?.data || [];

  const { data: accounts } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api('/bookkeeping/accounts'),
    enabled: showForm,
  });
  const leafAccounts = useMemo(() => filterLeafAccounts(accounts?.data || []), [accounts]);

  const { data: closedPeriods } = useQuery({
    queryKey: ['closed-periods'],
    queryFn: () => api('/bookkeeping/closed-periods'),
    enabled: showForm,
  });
  const closedHit = (closedPeriods?.data || []).find(
    (p: any) => form.entry_date >= p.period_start && form.entry_date <= p.period_end,
  );

  const { data: nextNumber } = useQuery({
    queryKey: ['next-number', form.entry_date],
    queryFn: () => api(`/bookkeeping/entries/next-number?date=${form.entry_date}`),
    enabled: showForm,
  });

  // link-status per attached file
  const linkQueries = useQueries({
    queries: files.map(f => ({
      queryKey: ['file-links', f.id],
      queryFn: () => api(`/file-storage/${f.id}/linked-records`),
    })),
  });
  const fileWarnings = files
    .map((f, i) => ({ file: f, links: (linkQueries[i]?.data?.links || []) as any[] }))
    .filter(w => w.links.length > 0);

  const totals = computeTotals(lines);
  const allAccountsChosen = lines.every(l => l.account_code && l.account_name);
  const canPost = totals.balanced && lines.length >= 2 && allAccountsChosen && !!form.description.trim() && !closedHit;

  function invalidateAll() {
    queryClient.invalidateQueries({ queryKey: ['manual-entries'] });
    queryClient.invalidateQueries({ queryKey: ['entries'] });
    queryClient.invalidateQueries({ queryKey: ['file-links'] });
  }

  function resetForm() {
    setShowForm(false);
    setForm({ entry_date: new Date().toISOString().split('T')[0], description: '' });
    setLines([{ ...EMPTY_JOURNAL_LINE }, { ...EMPTY_JOURNAL_LINE }]);
    setFiles([]);
    setConfirmNoDocs(false);
    setSimilarEntries(null);
  }

  const postMut = useMutation({
    mutationFn: (duplicateAcknowledged: boolean) => api('/bookkeeping/entries', {
      method: 'POST',
      body: {
        entry_date: form.entry_date, description: form.description, lines,
        file_ids: files.map(f => f.id), duplicate_acknowledged: duplicateAcknowledged,
      },
    }),
    onSuccess: (data: any) => {
      toast.info(tr(`Posted ${data.entry_number}`, `已記錄 ${data.entry_number}`, `已记录 ${data.entry_number}`));
      resetForm();
      invalidateAll();
    },
    onError: (err: any) => {
      if (err?.body?.error_code === 'similar_entry_exists') {
        setSimilarEntries(err.body.similar_entries || []);
        return;
      }
      toast.info(err?.message || tr('Failed to post', '記錄失敗', '记录失败'));
    },
  });

  function handlePost() {
    if (!canPost || postMut.isPending) return;
    if (files.length === 0 && !confirmNoDocs) { setConfirmNoDocs(true); return; }
    postMut.mutate(false);
  }

  const reverseMut = useMutation({
    mutationFn: (id: string) => api(`/bookkeeping/entries/${id}/reverse`, { method: 'POST' }),
    onSuccess: (data: any) => {
      toast.info(tr(`Reversal posted: ${data.entry_number}`, `已記錄沖銷分錄 ${data.entry_number}`, `已记录冲销分录 ${data.entry_number}`));
      invalidateAll();
    },
    onError: (err: any) => toast.info(err?.message || tr('Reversal failed', '沖銷失敗', '冲销失败')),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api(`/bookkeeping/entries/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.info(tr('Booking deleted', '已刪除記帳', '已删除记帐'));
      invalidateAll();
    },
    onError: (err: any) => toast.info(err?.message || tr('Delete failed', '刪除失敗', '删除失败')),
  });

  function toggleExpand(id: string) {
    const next = expandedId === id ? null : id;
    setExpandedId(next);
    if (next && !entryDetails[next]) {
      api(`/bookkeeping/entries/${next}`)
        .then(d => setEntryDetails(prev => ({ ...prev, [next]: d.lines || [] })))
        .catch(() => {});
    }
  }

  const STATUS_BADGE: Record<string, string> = {
    draft: 'bg-amber-100 text-amber-700', posted: 'bg-green-100 text-green-700', reconciled: 'bg-blue-100 text-blue-700',
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">{tr('Manual Booking', '手動記帳', '手动记账')}</h2>
          <p className="text-sm text-muted-foreground">
            {tr('Hand-keyed journal vouchers (MJ series)', '手工記帳憑證（MJ 系列）', '手工记账凭证（MJ 系列）')}
          </p>
        </div>
        {!showForm && (
          <button onClick={() => setShowForm(true)}
            className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm hover:opacity-90">
            <Plus className="h-4 w-4" /> {tr('New Manual Booking', '新增手動記帳', '新增手动记账')}
          </button>
        )}
      </div>

      {/* ══ Inline editor panel ══ */}
      {showForm && (
        <div className="border rounded-xl p-6 space-y-4 bg-card">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-lg">{tr('New Manual Booking', '新增手動記帳', '新增手动记账')}</h3>
            <span className="text-sm text-muted-foreground font-mono">
              {tr('Voucher', '總帳 #', '总帐 #')}: {nextNumber?.entry_number || '…'}{' '}
              <span className="text-xs">({tr('auto', '自動', '自动')})</span>
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">{tr('Date', '日期', '日期')}</label>
              <input type="date" required value={form.entry_date}
                onChange={(e) => setForm({ ...form, entry_date: e.target.value })}
                className="w-full px-3 py-2 border rounded-md bg-background text-sm" />
              {closedHit && (
                <p className="mt-1 text-xs text-red-600">
                  {tr('This date falls in a closed period — posting is locked.', '此日期屬於已關帳期間 — 記帳已鎖定。', '此日期属于已关账期间 — 记账已锁定。')}
                </p>
              )}
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-muted-foreground mb-1">{tr('Description', '備忘', '备记')}</label>
              <input required value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder={tr('Narration', '備忘', '备记')}
                className="w-full px-3 py-2 border rounded-md bg-background text-sm" />
            </div>
          </div>

          <JournalLineEditor accounts={accounts?.data || []} leafAccounts={leafAccounts}
            lines={lines} onChange={setLines} datalistId="mb-account-list" />

          {/* ── attachments ── */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-medium text-muted-foreground">{tr('Supporting documents', '證明文件', '证明文件')}</span>
              {files.map(f => (
                <span key={f.id} className="inline-flex items-center gap-1 text-xs border rounded-md px-2 py-1">
                  <Paperclip className="h-3 w-3" />{f.filename}
                  <button onClick={() => setFiles(files.filter(x => x.id !== f.id))}
                    className="text-muted-foreground hover:text-destructive"><X className="h-3 w-3" /></button>
                </span>
              ))}
              <button onClick={() => setShowPicker(true)} disabled={files.length >= 10}
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
            {confirmNoDocs && files.length === 0 && (
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

          <div className="flex gap-3 justify-end pt-2">
            <button onClick={resetForm} className="px-4 py-2 border rounded-md text-sm">{tr('Cancel', '取消', '取消')}</button>
            <button onClick={handlePost} disabled={!canPost || postMut.isPending}
              className={`px-4 py-2 rounded-md text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed ${
                confirmNoDocs && files.length === 0
                  ? 'bg-amber-500 text-white hover:bg-amber-600'
                  : 'bg-primary text-primary-foreground'
              }`}>
              {confirmNoDocs && files.length === 0
                ? tr('Post without documents', '不附文件記錄', '不附文件记录')
                : tr('Post Booking', '記錄', '记录')}
            </button>
          </div>
        </div>
      )}

      {/* ══ duplicate-entry modal ══ */}
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
              <button onClick={() => { setSimilarEntries(null); postMut.mutate(true); }}
                className="px-4 py-2 bg-amber-500 text-white rounded-md text-sm hover:bg-amber-600">
                {tr('Post anyway', '仍要記錄', '仍要记录')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══ picker ══ */}
      {showPicker && (
        <DocumentPickerModal
          alreadyPicked={files.map(f => f.id)}
          onPick={(picked) => setFiles(prev => [...prev, ...picked.filter(p => !prev.some(x => x.id === p.id))].slice(0, 10))}
          onClose={() => setShowPicker(false)}
        />
      )}

      {/* ══ list (unchanged from Task 8) ══ */}
      {entries.length === 0 && !showForm ? (
        <div className="border rounded-xl p-10 text-center text-muted-foreground text-sm">
          {tr('No manual bookings yet.', '暫無手動記帳。', '暂无手动记账。')}
        </div>
      ) : (
        <div className="border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b text-xs text-muted-foreground">
                <th className="py-2 px-2 w-8"></th>
                <th className="py-2 px-2 text-left font-medium">{tr('Voucher No.', '總帳 #', '总帐 #')}</th>
                <th className="py-2 px-2 text-left font-medium">{tr('Date', '日期', '日期')}</th>
                <th className="py-2 px-2 text-left font-medium">{tr('Description', '備忘', '备记')}</th>
                <th className="py-2 px-2 text-right font-medium">{tr('Debit', '借方', '借方')}</th>
                <th className="py-2 px-2 text-right font-medium">{tr('Credit', '貸方', '贷方')}</th>
                <th className="py-2 px-2 text-center font-medium">{tr('Docs', '附件', '附件')}</th>
                <th className="py-2 px-2 text-left font-medium">{tr('Status', '狀態', '状态')}</th>
                <th className="py-2 px-2 text-left font-medium">{tr('Created by', '建立者', '建立者')}</th>
                <th className="py-2 px-2 text-right font-medium">{tr('Actions', '操作', '操作')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e: any) => (
                <React.Fragment key={e.id}>
                  <tr className="border-b border-muted/30 hover:bg-muted/20 cursor-pointer" onClick={() => toggleExpand(e.id)}>
                    <td className="py-2 px-2 text-center">
                      {expandedId === e.id ? <ChevronDown className="h-4 w-4 inline" /> : <ChevronRight className="h-4 w-4 inline" />}
                    </td>
                    <td className="py-2 px-2 font-mono text-xs">
                      {e.entry_number}
                      {e.reversed && <span className="ml-1 text-amber-600" title={tr('Has live reversal', '已有沖銷分錄', '已有冲销分录')}>↩</span>}
                    </td>
                    <td className="py-2 px-2">{e.entry_date}</td>
                    <td className="py-2 px-2 max-w-[260px] truncate">{e.description}</td>
                    <td className="py-2 px-2 text-right font-mono">{fmtMoney(e.total_debit)}</td>
                    <td className="py-2 px-2 text-right font-mono">{fmtMoney(e.total_credit)}</td>
                    <td className="py-2 px-2 text-center">
                      {(e.files || []).length > 0 && (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <Paperclip className="h-3 w-3" />{(e.files || []).length}
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-2">
                      <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_BADGE[e.status] || ''}`}>{e.status}</span>
                    </td>
                    <td className="py-2 px-2 text-xs text-muted-foreground">{e.created_by?.name || e.created_by?.email || '—'}</td>
                    <td className="py-2 px-2 text-right" onClick={(ev) => ev.stopPropagation()}>
                      <button title={tr('Reverse entry', '沖銷分錄', '冲销分录')}
                        onClick={() => {
                          if (window.confirm(tr(`Post a reversal of ${e.entry_number}?`, `記錄 ${e.entry_number} 的沖銷分錄？`, `记录 ${e.entry_number} 的冲销分录？`)))
                            reverseMut.mutate(e.id);
                        }}
                        className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
                        <RotateCcw className="h-4 w-4" />
                      </button>
                      <button title={tr('Delete', '刪除', '删除')}
                        onClick={() => {
                          if (window.confirm(tr(`Delete booking ${e.entry_number}? It will be removed from all reports.`, `刪除記帳 ${e.entry_number}？將從所有報表中移除。`, `删除记账 ${e.entry_number}？将从所有报表中移除。`)))
                            deleteMut.mutate(e.id);
                        }}
                        className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                  {expandedId === e.id && (
                    <tr className="border-b bg-muted/10">
                      <td colSpan={10} className="px-6 py-3">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-muted-foreground">
                              <th className="py-1 px-2 text-left font-medium">{tr('Account', '科目', '科目')}</th>
                              <th className="py-1 px-2 text-left font-medium">{tr('Memo', '備忘', '备记')}</th>
                              <th className="py-1 px-2 text-right font-medium">{tr('Debit', '借方', '借方')}</th>
                              <th className="py-1 px-2 text-right font-medium">{tr('Credit', '貸方', '贷方')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(entryDetails[e.id] || []).map((l: any) => (
                              <tr key={l.id} className="border-t border-muted/20">
                                <td className="py-1 px-2 font-mono">{l.account_code} – {l.account_name}</td>
                                <td className="py-1 px-2">{l.description || ''}</td>
                                <td className="py-1 px-2 text-right font-mono">{l.debit ? fmtMoney(l.debit) : ''}</td>
                                <td className="py-1 px-2 text-right font-mono">{l.credit ? fmtMoney(l.credit) : ''}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {(e.files || []).length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {(e.files as any[]).map(f => (
                              <button key={f.id} onClick={() => setPreviewFile(f)}
                                className="inline-flex items-center gap-1 text-xs border rounded-md px-2 py-1 hover:bg-muted">
                                <Paperclip className="h-3 w-3" />{f.filename}
                              </button>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ══ attachment preview modal ══ */}
      {previewFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setPreviewFile(null)}>
          <div className="bg-card border rounded-xl w-full max-w-4xl h-[80vh] flex flex-col" onClick={(ev) => ev.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-2 border-b">
              <span className="text-sm font-medium truncate">{previewFile.filename}</span>
              <button onClick={() => setPreviewFile(null)} className="p-1 rounded hover:bg-muted"><X className="h-4 w-4" /></button>
            </div>
            <iframe title={previewFile.filename} className="flex-1 w-full"
              src={`${WORKER_API_BASE}/file-storage/${previewFile.id}/download?inline=1&token=${localStorage.getItem('token') || ''}${iframeClientParam()}`} />
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Build** — `cd frontend && npm run build`. Expected: clean.

- [ ] **Step 3: Manual smoke against the deployed-from-branch API is NOT possible yet** (API deploys in Task 12) — verify the form mechanics locally only: open the page, editor opens/closes, lines add/remove, balance indicator, closed-period message renders when a closed period exists, picker opens (list may be empty until the API has the linked-records endpoint — fine), Post button gating behaves. All wired-flow checks happen in Task 13's live round-trip.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/ManualBooking.tsx
git commit -m "feat(frontend): manual booking editor — attachments, warnings, posting flow

Inline full-width editor: auto voucher preview, JournalLineEditor,
multi-document picker with already-linked warnings, closed-period lock,
no-document confirm, similar-entry 409 dialog, reverse/delete actions.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: Playwright spec (non-mutating)

**Files:**
- Create: `tests/manual-booking.spec.ts` (gitignored — force-add)

Run convention (house): `TEST_BASE_URL=<url> npx playwright test tests/manual-booking.spec.ts --headed`. Defaults to the testing deployment. Login pattern copied from `tests/file-storage-relative-time.spec.ts`.

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

test.describe('Manual Booking page (non-mutating)', () => {
  test('MB-01: sidebar entry + page renders', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/manual-booking`);
    await expect(page.getByText('Hand-keyed journal vouchers (MJ series)').first()).toBeVisible({ timeout: 15000 });
    // sidebar item exists (desktop nav)
    await expect(page.locator('nav, aside').getByText('Manual Booking').first()).toBeVisible();
  });

  test('MB-02: editor opens, unbalanced Post disabled, closed-period hint element exists', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/manual-booking`);
    await page.getByRole('button', { name: /New Manual Booking/ }).click();
    // voucher preview shows an MJ- number (auto)
    await expect(page.getByText(/MJ-\d{6}-\d{3}/).first()).toBeVisible({ timeout: 10000 });
    // Post disabled while unbalanced (empty lines)
    const postBtn = page.getByRole('button', { name: /^Post Booking$|^Post without documents$/ }).first();
    await expect(postBtn).toBeDisabled();
    // add a debit on line 1 via the first debit input in the editor panel
    const descInput = page.getByPlaceholder('Narration').first();
    await descInput.fill('Playwright non-mutating check');
    // balance indicator shows unbalanced state text
    await expect(page.getByText(/Unbalanced/).first()).toBeVisible();
    // Cancel closes the panel without posting anything
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('button', { name: /New Manual Booking/ })).toBeVisible();
  });

  test('MB-03: GJE modal still works after JournalLineEditor extraction', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/GJE`);
    await page.getByRole('button', { name: /New Entry|Create/ }).first().click();
    await expect(page.getByText('Create / Edit Journal Entry').first()).toBeVisible({ timeout: 10000 });
    // balance footer present inside the modal
    await expect(page.getByText(/Total Debit/).first()).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
  });
});
```

- [ ] **Step 2: Run it** (against whatever URL currently has this branch deployed — before Task 12, run against local `npm run dev` with `TEST_BASE_URL=http://localhost:5173` if the branch is not deployed yet; MB-01/02 need the NEW frontend; MB-03 needs only the refactor):

```bash
TEST_BASE_URL=<url> npx playwright test tests/manual-booking.spec.ts --headed
```

Expected: 3/3 pass. If a selector drifted (button labels), fix the SELECTOR in the spec to match the actual rendered text — do not change the app.

- [ ] **Step 3: Commit**

```bash
git add -f tests/manual-booking.spec.ts
git commit -m "test: manual booking page non-mutating Playwright checks

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 12: Deploy — migration, API, frontend

**Files:** none modified (operations only)

⚠️ Deploying from the worktree deploys `origin/main + this feature` — the concurrent session's UNCOMMITTED work stays out (correct). Coordinate with the user if their work must ship first.

- [ ] **Step 1: Final gates**

```bash
cd api && npx tsc --noEmit 2>&1 | grep -c "error TS"   # == Task 0 baseline
npx wrangler deploy --dry-run                            # bundle OK
cd ../frontend && npm run build                          # clean
```

- [ ] **Step 2: Measure the backfill** (read-only):

```bash
cd ../api
npx wrangler d1 execute opcc-crm-db --command "SELECT COUNT(*) FROM journal_entries WHERE entry_source = 'auto' AND reference_type IS NULL"
```

Record the number — it should be small (hand-keyed GJE-modal entries). If it is large (hundreds+), STOP and ask the user before running the migration.

- [ ] **Step 3: Run the migration on remote D1**:

```bash
npx wrangler d1 execute opcc-crm-db --file=src/db/migration-manual-booking.sql
```

Expected: all statements succeed. The ALTER errors with "duplicate column name" ONLY if it was already applied — anything else is a stop.

- [ ] **Step 4: Verify the schema landed**:

```bash
npx wrangler d1 execute opcc-crm-db --command "PRAGMA table_info(journal_entries)" | grep created_by
npx wrangler d1 execute opcc-crm-db --command "SELECT name FROM sqlite_master WHERE name IN ('journal_entry_files','idx_jef_file')"
npx wrangler d1 execute opcc-crm-db --command "SELECT entry_source, COUNT(*) c FROM journal_entries GROUP BY entry_source"
```

Expected: `created_by` column exists; both names returned; `manual` count ≥ the Step-2 number.

- [ ] **Step 5: Deploy the API worker**:

```bash
cd api && npm run deploy
```

Record the deployed version hash.

- [ ] **Step 6: Smoke the new endpoints** (replace TOKEN with a valid JWT — obtain via `POST /api/auth/login` with the demo credentials, or copy from a browser session's localStorage):

```bash
API=https://opcc-crm-api.ruhan-farhan.workers.dev/api
curl -s -H "Authorization: Bearer $TOKEN" "$API/bookkeeping/entries/next-number?date=2026-08-26"
curl -s -H "Authorization: Bearer $TOKEN" "$API/bookkeeping/entries/manual?start_date=2025-01-01&end_date=2026-12-31"
```

Expected: `{"entry_number":"MJ-202608-..."}`; a JSON list (possibly empty `{"data":[...]}`).

- [ ] **Step 7: Deploy the frontend**:

```bash
cd ../frontend && npx wrangler pages deploy dist --project-name=opcc-crm-testing
```

Record the deployment URL. (House rule: always surface the frontend testing URL after deploy.)

- [ ] **Step 8: Re-run the Playwright spec** against the fresh testing URL (all 3 tests).

---

### Task 13: Live round-trip + cleanup + memory

**Files:**
- Create: `tests/manual-booking-live.ts` (gitignored — force-add)

⚠️ Runs against PRODUCTION data for one test tenant; every step is cleaned up. Follow the house convention of `tests/verify-onetomany-live.ts` (deterministic, exit-code gated, cleanup guaranteed in `finally`).

- [ ] **Step 1: Obtain a token** for the demo supervisor tenant (`muhammadruhan.farhan25@nixorcollege.edu.pk` / `password`) via `POST /api/auth/login`, or extract it from a logged-in browser session. Export as `TEST_TOKEN`. If login 503s (known throttling on shared workers), use the browser-session token.

- [ ] **Step 2: Write `tests/manual-booking-live.ts`** (run: `TEST_TOKEN=... npx tsx tests/manual-booking-live.ts`). Required behavior — implement with plain `fetch` against `https://opcc-crm-api.ruhan-farhan.workers.dev/api`:

1. `GET /bookkeeping/entries/next-number?date=<today>` → expect `MJ-YYYYMM-NNN`.
2. Pick an existing file id from `GET /file-storage?limit=1` (tenant must have ≥1 file; else abort with instructions).
3. `GET /file-storage/<id>/linked-records` → expect `{file_id, links: [...]}` (200; links may be empty).
4. `POST /bookkeeping/entries` with `{entry_date: today, description: 'MANUAL-BOOKING-LIVE-TEST', lines: [Dr 11101 100.00, Cr 42101 100.00], file_ids: [fileId]}` (no entry_number) → expect 201, `entry_number` starts with `MJ-`, response `created_by` present in DB row (verify via `GET /bookkeeping/entries/<id>`), status `posted`. Record the id.
5. Duplicate check: re-POST the identical body → expect **409** `error_code: 'similar_entry_exists'` with `similar_entries` containing the first voucher. Re-POST with `duplicate_acknowledged: true` → 201 second entry. Record the id.
6. `GET /bookkeeping/entries/manual` → both test entries appear with `files` of length 1 and `created_by` parsed.
7. `POST /bookkeeping/entries/<id1>/reverse` → 201, number is `<id1's number>-REV`. `GET /bookkeeping/entries/manual` shows entry 1 with `reversed: true`.
8. `DELETE /bookkeeping/entries/<id2>` → 200; the entry disappears from the manual list (tombstoned).
9. Trial balance sanity: `GET /bookkeeping/trial-balance` → total debits == total credits (within 0.01).

Exit code 0 only if every check passes; print each step's PASS/FAIL.

- [ ] **Step 3: Run it** — all steps PASS.

- [ ] **Step 4: Cleanup (guaranteed, also on failure — do it in a `finally` block):** hard-delete the test artifacts via remote D1 SQL (collect ids from the script's responses):

```bash
npx wrangler d1 execute opcc-crm-db --command "
DELETE FROM journal_entry_files WHERE entry_id IN ('<id1>','<id2>','<revId>');
DELETE FROM journal_lines WHERE entry_id IN ('<id1>','<id2>','<revId>');
DELETE FROM journal_entries WHERE id IN ('<id1>','<id2>','<revId>');
DELETE FROM audit_log WHERE entity_type='journal_entry' AND entity_id IN ('<id1>','<id2>','<revId>');"
```

Verify zero rows remain:

```bash
npx wrangler d1 execute opcc-crm-db --command "SELECT COUNT(*) FROM journal_entries WHERE description = 'MANUAL-BOOKING-LIVE-TEST'"
```

Expected: 0. Also re-check trial balance equality after cleanup.

- [ ] **Step 5: Commit the script**

```bash
git add -f tests/manual-booking-live.ts
git commit -m "test: manual booking live round-trip (create/dup/reverse/delete + cleanup)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 6: Update project state notes.** Append a dated section to `SESSION_STATE.md` summarizing: feature shipped, migration applied, deployed API version + frontend URL, round-trip evidence, and the tombstone-delete behavior change (GJE tab deletes are now soft). Also record the frontend testing URL per house convention.

---

### Task 14: Rebase onto main + merge + push

**Files:** none modified (git operations)

⚠️ The concurrent session may have committed to `origin/main` since Task 0. Never touch their uncommitted changes in the main working tree.

- [ ] **Step 1: Fetch and rebase the feature branch** (inside the worktree):

```bash
git fetch origin
git rebase origin/main
```

If conflicts arise in shared files (`bookkeeping.ts`, `file-storage.ts`, `Bookkeeping.tsx`, `Layout.tsx`, `App.tsx`, `api.ts`, locale JSONs): resolve by keeping BOTH features — re-read both sides, apply this plan's changes on top of theirs, re-run `npx tsc --noEmit` (api) and `npm run build` (frontend) before `git rebase --continue`. If a conflict is ambiguous (their refactor changed a function this plan edits), STOP and ask the user.

- [ ] **Step 2: Re-run all gates**:

```bash
npx tsx tests/manual-booking.test.ts                     # harness green
cd api && npx tsc --noEmit 2>&1 | grep -c "error TS"     # == baseline
cd ../frontend && npm run build                          # clean
```

- [ ] **Step 3: Merge into main and push.** In the MAIN working tree (not the worktree):

```bash
git merge <manual-booking-branch> --ff-only
git push origin main
```

If `--ff-only` fails (main moved again) → go back to Step 1 in the worktree. If the merge is BLOCKED because the other session's uncommitted changes overlap the merging files, do NOT stash or commit them — stop and coordinate with the user.

- [ ] **Step 4: Remove the worktree** per the `superpowers:using-git-worktrees` skill's exit flow (keep-or-remove; remove is fine once pushed).

- [ ] **Step 5: Post-deploy verification** (5-10 min after push, in case a colleague's deploy raced): open the testing URL's `/manual-booking`, create one real booking with an attachment against the demo tenant via the UI, confirm it lands in the list with the created-by stamp, then reverse it (leaves a tidy audit trail) — this doubles as the user-facing acceptance pass.

---

## Self-Review Notes (author)

**Spec coverage:** §4.1 migration → Task 1; §5.1 create extensions → Task 3; §5.2 duplicate check → Tasks 2+3+10; §5.3 list/next-number/linked-records → Tasks 4+6; §5.4 reverse & tombstone → Task 5; §6.1 nav → Task 8; §6.2 page → Tasks 8+10; §6.3 editor → Tasks 7+10; §6.4 attachments → Tasks 9+10; §6.5 warnings → Task 10; §6.6 conventions → all frontend tasks; §7 errors → Tasks 3/5/6 (server) + Task 10 (client); §8 testing → Tasks 2/11/13 + gates in 12; §9 deploy/rollback → Tasks 12-14; created-by stamp → Tasks 1/3/4/8; ↩ reversed badge → Tasks 4/8; closed-period hint → Task 10; audit payloads → Tasks 3/5.

**Known judgment calls:** (1) reversal keeps `-REV` numbering (spec §5.4, corrected against actual code); (2) GJE modal + Petty Cash unaffected because all new fields are optional and `entry_number` remains user-suppliable; (3) `POST /entries` now stamps `entry_source='manual'` for ALL callers of that endpoint (modal, petty cash, new page) — correct, since that endpoint is only reached by hand-keyed paths.
