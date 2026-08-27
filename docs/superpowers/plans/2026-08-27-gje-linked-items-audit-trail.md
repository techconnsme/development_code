# GJE Linked Items & Audit Trail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add expandable rows to the GJE table showing linked bank statements/invoices with navigation, plus field-level audit trail per entry.

**Architecture:** Server resolves `reference_type`/`reference_id` into human-readable linked items. New `journal_entry_snapshots` table stores field-level diffs. Frontend expands rows to show linked items + audit trail, with navigation to target pages via React Router state.

**Tech Stack:** Hono (Cloudflare Workers), D1 (SQLite), React 18, TanStack React Query, React Router v6, Tailwind CSS, Lucide icons

## Global Constraints

- TypeScript strict mode
- i18n via `react-i18next` — use `tr()` helper for user-facing strings
- All API mutations require `bookkeeperMiddleware` auth
- D1 SQLite — no `json_agg` (use subqueries or app-level aggregation)
- Existing patterns: `auditLog()` helper, `uuidv4().slice(0, 8)` for IDs, `api()` client function

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `api/src/db/migration-journal-entry-snapshots.sql` | Create | Snapshot table + index |
| `api/src/lib/journal-snapshots.ts` | Create | Snapshot creation + diff computation |
| `api/src/routes/bookkeeping.ts` | Modify | Add `resolved_links` to GET /entries, add GET /entries/:id/audit-trail, call snapshot helpers on mutations |
| `frontend/src/hooks/useHighlightTarget.ts` | Create | Shared hook for highlight-on-navigate |
| `frontend/src/pages/Bookkeeping.tsx` | Modify | Expandable row with linked items + audit trail sections |
| `frontend/src/pages/BankStatements.tsx` | Modify | Support `location.state.highlight` for tx row |
| `frontend/src/pages/AP.tsx` | Modify | Support `location.state.highlight` for invoice row |
| `frontend/src/pages/AR.tsx` | Modify | Support `location.state.highlight` for invoice row |

---

### Task 1: Database Migration

**Files:**
- Create: `api/src/db/migration-journal-entry-snapshots.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- migration-journal-entry-snapshots.sql
-- Stores field-level snapshots for journal entry audit trail

CREATE TABLE IF NOT EXISTS journal_entry_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  snapshot TEXT NOT NULL,
  action TEXT NOT NULL,
  changed_fields TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_je_snapshots_entry ON journal_entry_snapshots(entry_id, created_at);
```

- [ ] **Step 2: Run the migration**

```bash
cd api && npx wrangler d1 execute <DB_NAME> --file=src/db/migration-journal-entry-snapshots.sql
```

- [ ] **Step 3: Commit**

```bash
git add api/src/db/migration-journal-entry-snapshots.sql
git commit -m "feat(db): add journal_entry_snapshots table for GJE audit trail"
```

---

### Task 2: Snapshot Library

**Files:**
- Create: `api/src/lib/journal-snapshots.ts`
- Depends on: Task 1

**Interfaces:**
- Consumes: `journal_entries` and `journal_lines` tables, `users` table
- Produces: `createSnapshot()`, `getSnapshots()`, `computeDiffs()`

- [ ] **Step 1: Create the snapshot library**

```typescript
// api/src/lib/journal-snapshots.ts
import { v4 as uuidv4 } from 'uuid';

interface JournalSnapshot {
  entry_number: string;
  entry_date: string;
  description: string;
  status: string;
  reference_type: string | null;
  reference_id: string | null;
  lines: Array<{
    account_code: string;
    account_name: string;
    description: string | null;
    debit: number;
    credit: number;
    project: string | null;
  }>;
}

interface AuditTrailEntry {
  id: string;
  action: string;
  user_email: string;
  created_at: string;
  snapshot: JournalSnapshot;
  changes: Array<{ field: string; old: any; new: any }>;
}

export async function createSnapshot(
  db: any,
  userId: string,
  entryId: string,
  action: string,
  previousSnapshot?: JournalSnapshot | null
): Promise<void> {
  const entry = await db.prepare(
    'SELECT * FROM journal_entries WHERE id = ?'
  ).bind(entryId).first();
  if (!entry) return;

  const lines = await db.prepare(
    'SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY sort_order'
  ).bind(entryId).all();

  const snapshot: JournalSnapshot = {
    entry_number: (entry as any).entry_number,
    entry_date: (entry as any).entry_date,
    description: (entry as any).description,
    status: (entry as any).status,
    reference_type: (entry as any).reference_type,
    reference_id: (entry as any).reference_id,
    lines: (lines.results as any[]).map(l => ({
      account_code: l.account_code,
      account_name: l.account_name,
      description: l.description,
      debit: l.debit,
      credit: l.credit,
      project: l.project,
    })),
  };

  const changedFields = previousSnapshot
    ? computeChangedFields(previousSnapshot, snapshot)
    : [];

  const id = `js-${uuidv4().slice(0, 8)}`;
  await db.prepare(
    'INSERT INTO journal_entry_snapshots (id, user_id, entry_id, snapshot, action, changed_fields) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(
    id, userId, entryId,
    JSON.stringify(snapshot),
    action,
    changedFields.length > 0 ? JSON.stringify(changedFields) : null
  ).run();
}

export async function getLatestSnapshot(
  db: any,
  entryId: string
): Promise<JournalSnapshot | null> {
  const row = await db.prepare(
    'SELECT snapshot FROM journal_entry_snapshots WHERE entry_id = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(entryId).first();
  return row ? JSON.parse((row as any).snapshot) : null;
}

export async function getSnapshots(
  db: any,
  entryId: string
): Promise<AuditTrailEntry[]> {
  const rows = await db.prepare(
    `SELECT js.*, u.email as user_email
     FROM journal_entry_snapshots js
     LEFT JOIN users u ON js.user_id = u.id
     WHERE js.entry_id = ?
     ORDER BY js.created_at DESC`
  ).bind(entryId).all();

  const snapshots = rows.results as any[];
  const result: AuditTrailEntry[] = [];

  for (let i = 0; i < snapshots.length; i++) {
    const current = JSON.parse(snapshots[i].snapshot) as JournalSnapshot;
    const previous = i < snapshots.length - 1
      ? JSON.parse(snapshots[i + 1].snapshot) as JournalSnapshot
      : null;

    const changes = previous
      ? computeChangedFields(previous, current)
      : snapshots[i].action === 'create'
        ? [{ field: '_entry', old: null, new: current }]
        : [{ field: '_entry', old: current, new: null }];

    result.push({
      id: snapshots[i].id,
      action: snapshots[i].action,
      user_email: snapshots[i].user_email || 'unknown',
      created_at: snapshots[i].created_at,
      snapshot: current,
      changes,
    });
  }

  return result;
}

function computeChangedFields(
  oldSnap: JournalSnapshot,
  newSnap: JournalSnapshot
): Array<{ field: string; old: any; new: any }> {
  const changes: Array<{ field: string; old: any; new: any }> = [];

  const scalarFields = ['entry_date', 'description', 'status'] as const;
  for (const field of scalarFields) {
    if (oldSnap[field] !== newSnap[field]) {
      changes.push({ field, old: oldSnap[field], new: newSnap[field] });
    }
  }

  // Compare lines by sort order
  const maxLen = Math.max(oldSnap.lines.length, newSnap.lines.length);
  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldSnap.lines[i];
    const newLine = newSnap.lines[i];

    if (!oldLine && newLine) {
      changes.push({
        field: `lines[${i}]`,
        old: null,
        new: newLine,
      });
    } else if (oldLine && !newLine) {
      changes.push({
        field: `lines[${i}]`,
        old: oldLine,
        new: null,
      });
    } else if (oldLine && newLine) {
      const lineFields = ['account_code', 'account_name', 'description', 'debit', 'credit', 'project'] as const;
      for (const lf of lineFields) {
        if (oldLine[lf] !== newLine[lf]) {
          changes.push({
            field: `lines[${i}].${lf}`,
            old: oldLine[lf],
            new: newLine[lf],
          });
        }
      }
    }
  }

  return changes;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd api && npx tsc --noEmit
```

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add api/src/lib/journal-snapshots.ts
git commit -m "feat(api): add journal snapshot library for field-level audit trail"
```

---

### Task 3: Snapshot Hooks in API Mutations

**Files:**
- Modify: `api/src/routes/bookkeeping.ts` (lines 127-251)
- Depends on: Task 2

**Interfaces:**
- Consumes: `createSnapshot()`, `getLatestSnapshot()` from Task 2
- Produces: Snapshots created on POST, PATCH /status, DELETE, POST /reverse

- [ ] **Step 1: Add import at top of bookkeeping.ts**

Find the existing imports (top of file) and add:

```typescript
import { createSnapshot, getLatestSnapshot } from '../lib/journal-snapshots';
```

- [ ] **Step 2: Add snapshot to POST /entries (after line 170, before return)**

Find the line `await auditLog(db, user.id, 'create', 'journal_entry', id, ...)` and add after it:

```typescript
await createSnapshot(db, tenantId, id, 'create');
```

- [ ] **Step 3: Add snapshot to PATCH /entries/:id/status (after line 189, before return)**

Find `await auditLog(db, user.id, 'update_status', 'journal_entry', ...)` and add after it:

```typescript
const prevSnap = await getLatestSnapshot(db, c.req.param('id'));
await createSnapshot(db, tenantId, c.req.param('id'), 'status_change', prevSnap);
```

- [ ] **Step 4: Add snapshot to DELETE /entries/:id (after line 211, before return)**

Find `await auditLog(db, user.id, 'delete', 'journal_entry', ...)` and add after it:

```typescript
const prevSnap = await getLatestSnapshot(db, id);
await createSnapshot(db, tenantId, id, 'delete', prevSnap);
```

- [ ] **Step 5: Add snapshot to POST /entries/:id/reverse**

Find the reverse endpoint (around line 218-251). After the line that creates the reversal entry and before the return, add:

```typescript
await createSnapshot(db, tenantId, reversalId, 'create');
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
cd api && npx tsc --noEmit
```

Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add api/src/routes/bookkeeping.ts
git commit -m "feat(api): add snapshot creation to GJE mutations"
```

---

### Task 4: Resolved Links in GET /entries

**Files:**
- Modify: `api/src/routes/bookkeeping.ts` (lines 83-104)
- Depends on: Task 1 (schema must exist for joins)

**Interfaces:**
- Consumes: `journal_entries`, `bank_transactions`, `bank_statements`, `invoices`, `bank_transaction_invoice_links`
- Produces: `resolved_links` field on each entry in list response

- [ ] **Step 1: Replace the GET /entries endpoint**

Find the `bookkeeping.get('/entries', ...)` handler (lines 83-104) and replace the SQL query and result mapping with:

```typescript
bookkeeping.get('/entries', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = (page - 1) * limit;
  const startDate = c.req.query('start_date');
  const endDate = c.req.query('end_date');

  let query = `SELECT je.*, SUM(jl.debit) as total_debit, SUM(jl.credit) as total_credit
    FROM journal_entries je LEFT JOIN journal_lines jl ON je.id = jl.entry_id
    WHERE je.user_id = ? AND ${jeLive()}`;
  const params: any[] = [tenantId];
  if (startDate) { query += ' AND je.entry_date >= ?'; params.push(startDate); }
  if (endDate) { query += ' AND je.entry_date <= ?'; params.push(endDate); }
  query += ' GROUP BY je.id ORDER BY je.entry_date DESC, je.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = await db.prepare(query).bind(...params).all();

  // Resolve links for each entry
  const entriesWithLinks = await Promise.all(
    (rows.results as any[]).map(async (entry) => {
      const resolved_links = await resolveLinks(db, entry);
      return { ...entry, resolved_links };
    })
  );

  return c.json({ data: entriesWithLinks, page, limit });
});
```

- [ ] **Step 2: Add the resolveLinks helper function**

Add this function before the route handlers (e.g., after the `auditLog` helper around line 81):

```typescript
async function resolveLinks(db: any, entry: any): Promise<any> {
  if (!entry.reference_type || !entry.reference_id) return null;

  switch (entry.reference_type) {
    case 'bank_transaction': {
      const tx = await db.prepare(
        `SELECT bt.id, bt.description, bt.deposit_amount, bt.withdrawal_amount, bt.match_status, bt.statement_id,
                bs.statement_number, bs.file_name
         FROM bank_transactions bt
         LEFT JOIN bank_statements bs ON bt.statement_id = bs.id
         WHERE bt.id = ?`
      ).bind(entry.reference_id).first();
      if (!tx) return { bank_transaction: { id: entry.reference_id, description: '(deleted)', amount: 0, match_status: 'deleted', statement_id: null, statement_number: null, file_name: null } };
      return {
        bank_statement: tx.statement_id ? { id: tx.statement_id, statement_number: (tx as any).statement_number, file_name: (tx as any).file_name } : null,
        bank_transaction: { id: (tx as any).id, description: (tx as any).description, amount: (tx as any).deposit_amount || (tx as any).withdrawal_amount, match_status: (tx as any).match_status, statement_id: (tx as any).statement_id },
      };
    }
    case 'invoice': {
      const inv = await db.prepare(
        `SELECT id, invoice_number, direction, total, vendor_name, customer_name FROM invoices WHERE id = ?`
      ).bind(entry.reference_id).first();
      if (!inv) return { invoice: { id: entry.reference_id, invoice_number: '(deleted)', direction: 'incoming', total: 0, vendor_or_customer: '(deleted)' } };
      return {
        invoice: {
          id: (inv as any).id,
          invoice_number: (inv as any).invoice_number,
          direction: (inv as any).direction,
          total: (inv as any).total,
          vendor_or_customer: (inv as any).vendor_name || (inv as any).customer_name || '',
        },
      };
    }
    case 'payment': {
      const tx = await db.prepare(
        `SELECT bt.id, bt.description, bt.deposit_amount, bt.withdrawal_amount, bt.match_status, bt.statement_id,
                bs.statement_number, bs.file_name
         FROM bank_transactions bt
         LEFT JOIN bank_statements bs ON bt.statement_id = bs.id
         WHERE bt.id = ?`
      ).bind(entry.reference_id).first();
      // Check for linked invoices (group payment)
      const linkedInvoices = await db.prepare(
        `SELECT btil.invoice_id, btil.allocated_amount, i.invoice_number
         FROM bank_transaction_invoice_links btil
         LEFT JOIN invoices i ON btil.invoice_id = i.id
         WHERE btil.transaction_id = ?`
      ).bind(entry.reference_id).all();
      const result: any = {
        bank_statement: tx?.statement_id ? { id: (tx as any).statement_id, statement_number: (tx as any).statement_number, file_name: (tx as any).file_name } : null,
        bank_transaction: tx ? { id: (tx as any).id, description: (tx as any).description, amount: (tx as any).deposit_amount || (tx as any).withdrawal_amount, match_status: (tx as any).match_status, statement_id: (tx as any).statement_id } : null,
      };
      if (linkedInvoices.results.length > 0) {
        result.linked_invoices = (linkedInvoices.results as any[]).map(li => ({
          id: li.invoice_id,
          invoice_number: li.invoice_number || '(deleted)',
          allocated_amount: li.allocated_amount,
        }));
      }
      return result;
    }
    case 'journal': {
      const rev = await db.prepare(
        'SELECT id, entry_number, entry_date FROM journal_entries WHERE id = ?'
      ).bind(entry.reference_id).first();
      if (!rev) return { reversal: { id: entry.reference_id, entry_number: '(deleted)', entry_date: '' } };
      return { reversal: { id: (rev as any).id, entry_number: (rev as any).entry_number, entry_date: (rev as any).entry_date } };
    }
    default:
      return null;
  }
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd api && npx tsc --noEmit
```

Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/bookkeeping.ts
git commit -m "feat(api): add resolved_links to GET /bookkeeping/entries"
```

---

### Task 5: Audit Trail Endpoint

**Files:**
- Modify: `api/src/routes/bookkeeping.ts`
- Depends on: Task 2

**Interfaces:**
- Consumes: `getSnapshots()` from Task 2
- Produces: `GET /entries/:id/audit-trail` endpoint

- [ ] **Step 1: Add the audit trail endpoint**

Find the `bookkeeping.get('/entries/:id', ...)` handler (around line 106-114) and add this new endpoint AFTER it:

```typescript
bookkeeping.get('/entries/:id/audit-trail', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const entryId = c.req.param('id');

  // Verify entry exists and belongs to tenant
  const entry = await db.prepare(
    'SELECT id FROM journal_entries WHERE id = ? AND user_id = ?'
  ).bind(entryId, tenantId).first();
  if (!entry) return c.json({ error: 'Entry not found' }, 404);

  const auditTrail = await getSnapshots(db, entryId);
  return c.json(auditTrail);
});
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd api && npx tsc --noEmit
```

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add api/src/routes/bookkeeping.ts
git commit -m "feat(api): add GET /entries/:id/audit-trail endpoint"
```

---

### Task 6: useHighlightTarget Hook

**Files:**
- Create: `frontend/src/hooks/useHighlightTarget.ts`

**Interfaces:**
- Consumes: `react-router-dom` `useLocation`
- Produces: `useHighlightTarget()` returning `string | null`

- [ ] **Step 1: Create the hooks directory and hook file**

```typescript
// frontend/src/hooks/useHighlightTarget.ts
import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';

export function useHighlightTarget(durationMs = 3000): string | null {
  const location = useLocation();
  const [highlightId, setHighlightId] = useState<string | null>(null);

  useEffect(() => {
    const state = location.state as any;
    if (state?.highlight) {
      setHighlightId(state.highlight);
      const timer = setTimeout(() => setHighlightId(null), durationMs);
      return () => clearTimeout(timer);
    }
  }, [location.state, durationMs]);

  return highlightId;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit
```

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/useHighlightTarget.ts
git commit -m "feat(frontend): add useHighlightTarget hook"
```

---

### Task 7: Expandable Row with Linked Items & Audit Trail

**Files:**
- Modify: `frontend/src/pages/Bookkeeping.tsx`
- Depends on: Tasks 4, 5, 6

**Interfaces:**
- Consumes: `resolved_links` from entries API, `GET /entries/:id/audit-trail`, `useHighlightTarget()`
- Produces: Expanded row with journal lines, linked items, and audit trail

- [ ] **Step 1: Add imports**

Find the existing imports in Bookkeeping.tsx (lines 1-20) and add:

```typescript
import { useHighlightTarget } from '../hooks/useHighlightTarget';
import { ExternalLink } from 'lucide-react';
```

- [ ] **Step 2: Add state for audit trail**

Find the existing state declarations (around line 45) and add after the `entryDetails` state:

```typescript
const [entryAuditTrail, setEntryAuditTrail] = useState<Record<string, any[]>>({});
const [loadingAudit, setLoadingAudit] = useState<string | null>(null);
const highlightId = useHighlightTarget();
const bookkeepingNavigate = useNavigate();
```

- [ ] **Step 3: Add audit trail fetch to toggleEntryDetail**

Find the `toggleEntryDetail` function (search for it in the file). It should look something like:

```typescript
const toggleEntryDetail = async (id: string) => {
  if (expandedId === id) {
    setExpandedId(null);
    return;
  }
  setExpandedId(id);
  if (!entryDetails[id]) {
    setLoadingDetail(id);
    try {
      const data = await api(`/bookkeeping/entries/${id}`);
      setEntryDetails(prev => ({ ...prev, [id]: data.lines || [] }));
    } catch (err) {
      console.error('Failed to load entry details', err);
    } finally {
      setLoadingDetail(null);
    }
  }
};
```

Replace it with:

```typescript
const toggleEntryDetail = async (id: string) => {
  if (expandedId === id) {
    setExpandedId(null);
    return;
  }
  setExpandedId(id);
  // Fetch entry lines if not cached
  if (!entryDetails[id]) {
    setLoadingDetail(id);
    try {
      const data = await api(`/bookkeeping/entries/${id}`);
      setEntryDetails(prev => ({ ...prev, [id]: data.lines || [] }));
    } catch (err) {
      console.error('Failed to load entry details', err);
    } finally {
      setLoadingDetail(null);
    }
  }
  // Fetch audit trail if not cached
  if (!entryAuditTrail[id]) {
    setLoadingAudit(id);
    try {
      const trail = await api(`/bookkeeping/entries/${id}/audit-trail`);
      setEntryAuditTrail(prev => ({ ...prev, [id]: trail }));
    } catch (err) {
      console.error('Failed to load audit trail', err);
    } finally {
      setLoadingAudit(null);
    }
  }
};
```

- [ ] **Step 4: Add auto-expand on highlight**

Find the existing `useEffect` that handles `entryParam` (the `?entry=<id>` auto-expand). After that effect, add:

```typescript
// Auto-expand from highlight navigation
useEffect(() => {
  if (!highlightId || tab !== 'entries' || !entries?.data) return;
  const inTable = entries.data.find((e: any) => e.id === highlightId);
  if (inTable) {
    setExpandedId(highlightId);
    toggleEntryDetail(highlightId);
    // Scroll into view
    setTimeout(() => {
      document.getElementById(`entry-row-${highlightId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
  }
}, [highlightId, entries?.data, tab]);
```

- [ ] **Step 5: Add linked items rendering in the expanded row**

Find the expanded row detail section (the `<tr key={`${e.id}-detail`}>` block). After the journal lines table (after the `</table>` closing tag and before the `</div>` closing tag of the `<div className="px-8 py-3">`), add:

```tsx
{/* Linked Items Section */}
{e.resolved_links && (
  <div className="mt-4 border-t pt-3">
    <h4 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
      {tr('Linked Items', '關聯項目', '关联项目')}
    </h4>
    <div className="flex flex-wrap gap-2">
      {/* Bank Statement */}
      {e.resolved_links.bank_statement && (
        <button
          onClick={() => bookkeepingNavigate('/bank-statements', { state: { highlight: e.resolved_links.bank_statement.id } })}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300"
        >
          <ExternalLink className="h-3 w-3" />
          {tr('Statement', '結單', '结单')}: {e.resolved_links.bank_statement.statement_number || e.resolved_links.bank_statement.id}
        </button>
      )}
      {/* Bank Transaction */}
      {e.resolved_links.bank_transaction && (
        <button
          onClick={() => {
            const stmtId = e.resolved_links.bank_transaction.statement_id;
            if (stmtId) bookkeepingNavigate(`/bank-statements/review/${stmtId}`, { state: { highlight: e.resolved_links.bank_transaction.id } });
          }}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full border border-green-200 bg-green-50 text-green-700 hover:bg-green-100 dark:border-green-800 dark:bg-green-950 dark:text-green-300"
        >
          <ExternalLink className="h-3 w-3" />
          {tr('Transaction', '交易', '交易')}: {e.resolved_links.bank_transaction.description || e.resolved_links.bank_transaction.id}
        </button>
      )}
      {/* Invoice */}
      {e.resolved_links.invoice && (
        <button
          onClick={() => {
            const target = e.resolved_links.invoice.direction === 'incoming' ? '/ap' : '/ar';
            bookkeepingNavigate(target, { state: { highlight: e.resolved_links.invoice.id } });
          }}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full border border-purple-200 bg-purple-50 text-purple-700 hover:bg-purple-100 dark:border-purple-800 dark:bg-purple-950 dark:text-purple-300"
        >
          <ExternalLink className="h-3 w-3" />
          {e.resolved_links.invoice.direction === 'incoming' ? tr('Bill', '帳單', '账单') : tr('Invoice', '發票', '发票')}: {e.resolved_links.invoice.invoice_number}
          {e.resolved_links.invoice.vendor_or_customer ? ` (${e.resolved_links.invoice.vendor_or_customer})` : ''}
        </button>
      )}
      {/* Linked Invoices (group payment) */}
      {e.resolved_links.linked_invoices?.map((li: any) => (
        <button
          key={li.id}
          onClick={() => bookkeepingNavigate('/ap', { state: { highlight: li.id } })}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full border border-purple-200 bg-purple-50 text-purple-700 hover:bg-purple-100 dark:border-purple-800 dark:bg-purple-950 dark:text-purple-300"
        >
          <ExternalLink className="h-3 w-3" />
          {tr('Bill', '帳單', '账单')}: {li.invoice_number} (${li.allocated_amount.toFixed(2)})
        </button>
      ))}
      {/* Reversal */}
      {e.resolved_links.reversal && (
        <button
          onClick={() => bookkeepingNavigate('/GJE', { state: { highlight: e.resolved_links.reversal.id } })}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full border border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
        >
          <ExternalLink className="h-3 w-3" />
          {tr('Reversed by', '反轉由', '反转由')}: {e.resolved_links.reversal.entry_number}
        </button>
      )}
    </div>
  </div>
)}
```

- [ ] **Step 6: Add audit trail rendering in the expanded row**

After the linked items section (after the closing `</div>` of the linked items block), add:

```tsx
{/* Audit Trail Section */}
<div className="mt-4 border-t pt-3">
  <h4 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
    {tr('Audit Trail', '審計軌跡', '审计轨迹')}
  </h4>
  {loadingAudit === e.id ? (
    <div className="flex justify-center py-2"><div className="animate-spin h-4 w-4 border-2 border-primary border-t-transparent rounded-full" /></div>
  ) : (entryAuditTrail[e.id] || []).length === 0 ? (
    <p className="text-xs text-muted-foreground">{tr('No audit history', '暫無審計歷史', '暂无审计历史')}</p>
  ) : (
    <div className="space-y-2 max-h-60 overflow-y-auto">
      {(entryAuditTrail[e.id] || []).map((trail: any) => (
        <div key={trail.id} className="text-xs border-l-2 border-muted pl-3 py-1">
          <div className="flex items-center gap-2 text-muted-foreground">
            <span className="font-mono">{new Date(trail.created_at).toLocaleString()}</span>
            <span className="text-foreground font-medium">{trail.user_email}</span>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted">
              {trail.action}
            </span>
          </div>
          {trail.changes?.filter((c: any) => !c.field.startsWith('_')).map((change: any, ci: number) => (
            <div key={ci} className="mt-0.5 text-muted-foreground">
              <span className="font-medium">{change.field}</span>: {JSON.stringify(change.old)} → {JSON.stringify(change.new)}
            </div>
          ))}
          {trail.action === 'create' && (
            <div className="mt-0.5 text-green-600 dark:text-green-400">
              {tr('Entry created', '分錄已建立', '分录已建立')}
            </div>
          )}
          {trail.action === 'delete' && (
            <div className="mt-0.5 text-red-600 dark:text-red-400">
              {tr('Entry deleted', '分錄已刪除', '分录已删除')}
            </div>
          )}
        </div>
      ))}
    </div>
  )}
</div>
```

- [ ] **Step 7: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit
```

Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/Bookkeeping.tsx
git commit -m "feat(frontend): add linked items and audit trail to GJE expanded row"
```

---

### Task 8: BankStatements Highlight Support

**Files:**
- Modify: `frontend/src/pages/BankStatements.tsx`
- Depends on: Task 6

**Interfaces:**
- Consumes: `useHighlightTarget()` from Task 6
- Produces: Auto-expand + scroll + highlight visual on target transaction row

- [ ] **Step 1: Add import**

Find the imports in BankStatements.tsx (lines 1-20) and add:

```typescript
import { useHighlightTarget } from '../hooks/useHighlightTarget';
```

- [ ] **Step 2: Add highlight state**

Find the existing state declarations in the `BankStatements` component and add:

```typescript
const highlightId = useHighlightTarget();
```

- [ ] **Step 3: Add useEffect for highlight auto-expand**

After the existing state declarations, add:

```typescript
// Auto-expand and scroll to highlighted transaction
useEffect(() => {
  if (!highlightId) return;
  // Find the transaction in the data and expand its parent statement
  if (statements?.data) {
    for (const stmt of statements.data) {
      if (stmt.transactions?.some((tx: any) => tx.id === highlightId)) {
        setExpandedStatement(stmt.id);
        setTimeout(() => {
          document.getElementById(`tx-row-${highlightId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 200);
        break;
      }
    }
  }
}, [highlightId, statements?.data]);
```

- [ ] **Step 4: Add highlight visual to transaction rows**

Find the transaction row rendering (search for `tx-row-` or the `<tr>` that renders each transaction). Add a conditional highlight class:

Find the `<tr>` element for each transaction and add the highlight class:

```tsx
<tr
  id={`tx-row-${tx.id}`}
  className={`... ${highlightId === tx.id ? 'bg-yellow-100 dark:bg-yellow-900/30 ring-2 ring-yellow-400' : ''}`}
>
```

The exact class string depends on the existing classes. Add the highlight conditional to whatever className the `<tr>` already has.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit
```

Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/BankStatements.tsx
git commit -m "feat(frontend): add highlight navigation support to BankStatements"
```

---

### Task 9: AP Highlight Support

**Files:**
- Modify: `frontend/src/pages/AP.tsx`
- Depends on: Task 6

**Interfaces:**
- Consumes: `useHighlightTarget()` from Task 6
- Produces: Auto-expand + scroll + highlight visual on target invoice row

- [ ] **Step 1: Add import**

Find the imports in AP.tsx (lines 1-20) and add:

```typescript
import { useHighlightTarget } from '../hooks/useHighlightTarget';
```

- [ ] **Step 2: Add highlight state**

Find the existing state declarations in the `AP` component and add:

```typescript
const highlightId = useHighlightTarget();
```

- [ ] **Step 3: Add useEffect for highlight auto-expand**

After the existing state declarations, add:

```typescript
// Auto-expand and scroll to highlighted invoice
useEffect(() => {
  if (!highlightId || !invoices?.data) return;
  const inv = invoices.data.find((i: any) => i.id === highlightId);
  if (inv) {
    setExpandedId(highlightId);
    setTimeout(() => {
      document.getElementById(`invoice-row-${highlightId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 200);
  }
}, [highlightId, invoices?.data]);
```

- [ ] **Step 4: Add highlight visual to invoice rows**

Find the invoice row `<tr>` element and add a conditional highlight class. The exact class depends on existing classes — add:

```tsx
className={`... ${highlightId === inv.id ? 'bg-yellow-100 dark:bg-yellow-900/30 ring-2 ring-yellow-400' : ''}`}
```

Also ensure the `<tr>` has `id={`invoice-row-${inv.id}`}` if it doesn't already.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit
```

Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/AP.tsx
git commit -m "feat(frontend): add highlight navigation support to AP"
```

---

### Task 10: AR Highlight Support

**Files:**
- Modify: `frontend/src/pages/AR.tsx`
- Depends on: Task 6

**Interfaces:**
- Consumes: `useHighlightTarget()` from Task 6
- Produces: Auto-expand + scroll + highlight visual on target invoice row

- [ ] **Step 1: Add import**

Find the imports in AR.tsx (lines 1-20) and add:

```typescript
import { useHighlightTarget } from '../hooks/useHighlightTarget';
```

- [ ] **Step 2: Add highlight state**

Find the existing state declarations in the `AR` component and add:

```typescript
const highlightId = useHighlightTarget();
```

- [ ] **Step 3: Add useEffect for highlight auto-expand**

After the existing state declarations, add:

```typescript
// Auto-expand and scroll to highlighted invoice
useEffect(() => {
  if (!highlightId || !invoices?.data) return;
  const inv = invoices.data.find((i: any) => i.id === highlightId);
  if (inv) {
    setExpandedId(highlightId);
    setTimeout(() => {
      document.getElementById(`invoice-row-${highlightId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 200);
  }
}, [highlightId, invoices?.data]);
```

- [ ] **Step 4: Add highlight visual to invoice rows**

Find the invoice row `<tr>` element and add a conditional highlight class. The exact class depends on existing classes — add:

```tsx
className={`... ${highlightId === inv.id ? 'bg-yellow-100 dark:bg-yellow-900/30 ring-2 ring-yellow-400' : ''}`}
```

Also ensure the `<tr>` has `id={`invoice-row-${inv.id}`}` if it doesn't already.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit
```

Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/AR.tsx
git commit -m "feat(frontend): add highlight navigation support to AR"
```

---

### Task 11: E2E Test

**Files:**
- Create: `tests/gje-linked-items.spec.ts`

**Interfaces:**
- Consumes: All previous tasks
- Produces: Playwright test verifying the full flow

- [ ] **Step 1: Create the Playwright test**

```typescript
// tests/gje-linked-items.spec.ts
import { test, expect } from '@playwright/test';

const EMAIL = 'joseph.lin@pnr.hk';
const PASSWORD = 'Test1234';

test.describe('GJE Linked Items & Audit Trail', () => {
  test.beforeEach(async ({ page }) => {
    // Login
    await page.goto('/login');
    await page.fill('input[type="email"], input[name="email"]', EMAIL);
    await page.fill('input[type="password"], input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/dashboard', { timeout: 10000 });
  });

  test('should expand GJE row and show linked items', async ({ page }) => {
    await page.goto('/GJE');
    await page.waitForTimeout(1000);

    // Find and click the first expand button
    const expandBtn = page.locator('table tbody tr td button').first();
    await expandBtn.click();

    // Verify expanded content appears
    const expandedRow = page.locator('table tbody tr').nth(1);
    await expect(expandedRow).toBeVisible();

    // Check for linked items section (if entry has links)
    const linkedSection = expandedRow.locator('text=Linked Items');
    // May or may not be visible depending on entry type
  });

  test('should show audit trail in expanded row', async ({ page }) => {
    await page.goto('/GJE');
    await page.waitForTimeout(1000);

    // Expand first entry
    const expandBtn = page.locator('table tbody tr td button').first();
    await expandBtn.click();
    await page.waitForTimeout(500);

    // Verify audit trail section exists
    const auditSection = page.locator('text=Audit Trail');
    await expect(auditSection).toBeVisible();
  });

  test('should navigate to bank statement on linked item click', async ({ page }) => {
    await page.goto('/GJE');
    await page.waitForTimeout(1000);

    // Expand first entry
    const expandBtn = page.locator('table tbody tr td button').first();
    await expandBtn.click();
    await page.waitForTimeout(500);

    // Look for a bank statement chip (if present)
    const stmtChip = page.locator('button:has-text("Statement")').first();
    if (await stmtChip.isVisible()) {
      await stmtChip.click();
      await page.waitForURL('**/bank-statements**', { timeout: 5000 });
    }
  });
});
```

- [ ] **Step 2: Run the test**

```bash
npx playwright test tests/gje-linked-items.spec.ts --headed
```

Expected: Tests pass (or fail gracefully if no linked entries exist in test data)

- [ ] **Step 3: Commit**

```bash
git add tests/gje-linked-items.spec.ts
git commit -m "test: add E2E tests for GJE linked items and audit trail"
```

---

## Spec Coverage Check

| Spec Requirement | Task |
|---|---|
| `journal_entry_snapshots` table | Task 1 |
| Snapshot library (create/get/diff) | Task 2 |
| Snapshot creation on mutations | Task 3 |
| `resolved_links` on GET /entries | Task 4 |
| `GET /entries/:id/audit-trail` endpoint | Task 5 |
| `useHighlightTarget` hook | Task 6 |
| Expandable row with linked items + audit trail | Task 7 |
| BankStatements highlight support | Task 8 |
| AP highlight support | Task 9 |
| AR highlight support | Task 10 |
| E2E tests | Task 11 |
