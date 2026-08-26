# Invoice Posting Editor + Entry-Flow Lineage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users edit an invoice's label + holding GL accounts (with automatic payment-leg propagation), and see the Entry 1 → Entry 2 money flow as a lineage map on both the invoice panel and the bank statements page.

**Architecture:** No schema changes. The invoice's live journal entry stays the single source of truth: editing tombstones it and inserts a fresh `entry_source='manual'` pair (mirroring `replaceTransactionPosting`). Payment posting stops hardcoding trade accounts and resolves each invoice's holding account from its live JE — propagation becomes structural. Lineage views are pure display over payloads already shipped (plus one read-only enrichment each).

**Tech Stack:** Hono + D1 (Cloudflare Workers) API, React + TanStack Query + Tailwind, Playwright E2E.

**Spec:** `docs/superpowers/specs/2026-08-25-invoice-posting-editor-and-lineage-design.md`

## Global Constraints

- NO schema changes, NO migrations.
- API typecheck: **43 pre-existing errors** is the baseline (the spec doc's older sibling plans mention 24 — stale). After every task: count unchanged, zero errors in touched files. Command: `cd api && npx tsc --noEmit`.
- Frontend must build clean: `cd frontend && npm run build`.
- Every user-visible string through `tr(en, zhHant, zhHans)` from `frontend/src/lib/i18nHelpers`.
- Dr styling `font-mono font-bold text-red-600`, Cr `text-green-600` (house convention).
- Live-entry filter is always `deleted_at IS NULL` (`jeLive()` semantics) — never status-based.
- Holding-account role detection is by `accounts.account_type`: holding ∈ (`asset`,`liability`), label ∈ (`revenue`,`expense`).
- Payment-leg propagation must pre-validate ALL affected parent statements (`status='active'`) BEFORE any tombstone; any reconciled statement ⇒ 409 and zero writes.
- Audit-log every posting edit: house-style inline `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, changes)` with `` al-${uuidv4().slice(0,8)} `` keys.
- Playwright specs are NON-MUTATING (shared ground-truth DB); baseURL default `https://opcc-crm-testing.pages.dev`; PNR login `joseph.lin@pnr.hk` / `Test1234`.

---

### Task 1: Backend — holding-account resolution in payment posting

**Files:**
- Modify: `api/src/lib/post-payment.ts`

**Interfaces:**
- Produces: `export async function resolveInvoiceHoldingAccount(db: D1Database, tenantId: string, invoiceId: string): Promise<{ code: string; name: string }>` — Task 2's route does NOT call this directly (regeneration reuses `postPaymentToGl`), but it defines the resolution contract: live invoice-JE line whose joined `accounts.account_type ∈ ('asset','liability')`; fallback `{code:'11201',name:'Trade Debtors 應收賬款'}` for outgoing / `{code:'21101',name:'Trade Creditors 應付賬款'}` for incoming invoices, or when no live JE / no typed line exists.
- Behavior change: `postPaymentToGl` 1:1 and group contra lines use the resolved per-invoice holding account instead of hardcoded `11201`/`21101`.

- [ ] **Step 1: Add the resolver**

Append to `api/src/lib/post-payment.ts`:

```ts
/**
 * The holding ("who owes whom") account for an invoice = the asset/liability
 * line of its LIVE invoice JE. Falls back to the classic trade accounts when
 * the invoice is unposted or shaped unusually. Direction decides the fallback.
 */
export async function resolveInvoiceHoldingAccount(
  db: D1Database,
  tenantId: string,
  invoiceId: string,
): Promise<{ code: string; name: string }> {
  const inv = await db.prepare(
    'SELECT direction FROM invoices WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(invoiceId, tenantId).first<{ direction: string }>();
  const fallback = inv?.direction === 'incoming'
    ? { code: '21101', name: 'Trade Creditors 應付賬款' }
    : { code: '11201', name: 'Trade Debtors 應收賬款' };

  const row = await db.prepare(
    `SELECT jl.account_code, jl.account_name
     FROM journal_entries je
     JOIN journal_lines jl ON jl.entry_id = je.id
     JOIN accounts a ON a.account_code = jl.account_code AND a.user_id = je.user_id
     WHERE je.reference_type = 'invoice' AND je.reference_id = ? AND je.user_id = ?
       AND ${jeLive('je')} AND a.account_type IN ('asset','liability')
     ORDER BY (CASE WHEN jl.debit > 0 THEN jl.debit ELSE jl.credit END) DESC
     LIMIT 1`
  ).bind(invoiceId, tenantId).first<{ account_code: string; account_name: string }>();
  return row ? { code: row.account_code, name: row.account_name } : fallback;
}
```

- [ ] **Step 2: Use it in the group path**

In `postPaymentToGl`, group branch — currently:

```ts
    if (isDeposit) {
      await line(bankAccount, 'Bank', nums.slice(0, 120), amount, 0);
      for (const l of links) await line('11201', 'Trade Debtors', l.invoice_number, 0, l.allocated_amount);
    } else {
      for (const l of links) await line('21101', 'Trade Creditors', l.invoice_number, l.allocated_amount, 0);
      await line(bankAccount, 'Bank', nums.slice(0, 120), 0, amount);
    }
```

Replace with per-member resolution:

```ts
    const memberAccounts: { code: string; name: string }[] = [];
    for (const l of links) {
      memberAccounts.push(await resolveInvoiceHoldingAccount(db, tenantId, l.invoice_id));
    }
    if (isDeposit) {
      await line(bankAccount, 'Bank', nums.slice(0, 120), amount, 0);
      for (let i = 0; i < links.length; i++) {
        await line(memberAccounts[i].code, memberAccounts[i].name, links[i].invoice_number, 0, links[i].allocated_amount);
      }
    } else {
      for (let i = 0; i < links.length; i++) {
        await line(memberAccounts[i].code, memberAccounts[i].name, links[i].invoice_number, links[i].allocated_amount, 0);
      }
      await line(bankAccount, 'Bank', nums.slice(0, 120), 0, amount);
    }
```

- [ ] **Step 3: Use it in the 1:1 path**

The 1:1 branch fetches the invoice then hardcodes `'11201'`/`'21101'` in its two Cr/Dr line INSERTs (and mirrors in the AP withdrawal branch). Resolve once after the invoice fetch:

```ts
  const holding = await resolveInvoiceHoldingAccount(db, tenantId, base.invoice_id!);
```

then substitute `holding.code` / `holding.name` for the hardcoded trade-account literals in BOTH the deposit and withdrawal line INSERTs (bank-side lines stay untouched).

- [ ] **Step 4: Typecheck at baseline**

Run: `cd api && npx tsc --noEmit 2>&1 | Select-String "error TS" | Measure-Object | Select-Object -ExpandProperty Count`
Expected: **43**, none in post-payment.ts.

- [ ] **Step 5: Commit**

```bash
git add api/src/lib/post-payment.ts
git commit -m "feat(api): payment legs resolve holding account from the invoice's live JE"
```

---

### Task 2: Backend — `PUT /invoices/:id/posting` with propagation

**Files:**
- Create: `api/src/lib/period-guard.ts`
- Modify: `api/src/routes/bookkeeping.ts` (replace local `checkPeriodOpen` with import)
- Modify: `api/src/routes/invoices.ts` (new route, placed directly AFTER the existing `invoices.get('/:id', ...)` handler)

**Interfaces:**
- Consumes: `postInvoiceToGl` + `postPaymentToGl` + `resolveInvoiceHoldingAccount` (lib), `findParentAccountError` from `../lib/account-guard`, `jeLive` from `../lib/journal-filters`.
- Produces: `PUT /invoices/:id/posting` accepting `{ label_account_code: string, holding_account_code: string }` or `{ reset_to_auto: true }`; responds with the SAME shape as `GET /invoices/:id` (re-runs the detail queries via the same code — simplest: after mutation, re-fetch using the identical query block; factor nothing, just call the internal logic by reading back like the GET handler does).
- `api/src/lib/period-guard.ts` exports `checkPeriodOpen(db, tenantId, entryDate): Promise<boolean>` (moved verbatim from bookkeeping.ts:836-841).

- [ ] **Step 1: Extract the period guard**

Create `api/src/lib/period-guard.ts`:

```ts
/** Prevent mutations on closed accounting periods (shared by bookkeeping + invoice posting). */
export async function checkPeriodOpen(db: any, tenantId: string, entryDate: string): Promise<boolean> {
  const closed = await db.prepare(
    'SELECT id FROM closed_periods WHERE user_id = ? AND ? >= period_start AND ? <= period_end LIMIT 1'
  ).bind(tenantId, entryDate, entryDate).first();
  return !closed;
}
```

In `bookkeeping.ts`: delete the local `checkPeriodOpen` (lines ~836-841) and add `import { checkPeriodOpen } from '../lib/period-guard';`. All existing call sites keep working unchanged.

- [ ] **Step 2: Extract the shared detail payload + add the route**

First, refactor the existing `GET /invoices/:id` handler (`invoices.ts`, starts at the `invoices.get('/:id', async (c) => {` added by commit `7a236cd`) so its body lives in an exported-for-file helper:

```ts
async function invoiceDetailPayload(db: any, tenantId: string, id: string) {
  // …move EVERYTHING from the `const invoice = await db.prepare('SELECT i.*…')`
  // through `return { ...invoice, items: items.results, linked_transactions, journal_entries };`
  // unchanged, replacing the final `c.json(...)` wrapper with this plain return…
}

invoices.get('/:id', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const payload = await invoiceDetailPayload(c.env.DB, tenantId, c.req.param('id'));
  if (!payload || (payload as any).error === 'Invoice not found') return c.json({ error: 'Invoice not found' }, 404);
  return c.json(payload);
});
```

(Adjust the not-found path: make `invoiceDetailPayload` return `null` instead of the 409-style json when the invoice row is missing.)

In `invoices.ts`, add to the top imports: `findParentAccountError` from `../lib/account-guard`, `checkPeriodOpen` from `../lib/period-guard`, `postPaymentToGl`, `resolveInvoiceHoldingAccount` from `../lib/post-payment`, `postInvoiceToGl` from `../lib/post-invoice`, and `jeLive` from `../lib/journal-filters`. Then place the new route directly AFTER the GET handler:

```ts
// PUT /invoices/:id/posting — rewrite the live invoice JE's label+holding pair
// (entry_source='manual'), propagating holding changes to confirmed payment legs.
invoices.put('/:id/posting', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({})) as any;

  const inv = await db.prepare(
    'SELECT * FROM invoices WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(id, tenantId).first<any>();
  if (!inv) return c.json({ error: 'Invoice not found' }, 404);

  // Current live invoice JE (must exist — editing implies posted)
  const live = await db.prepare(
    `SELECT id, entry_number, entry_date, description FROM journal_entries
     WHERE reference_type = 'invoice' AND reference_id = ? AND user_id = ? AND ${jeLive('journal_entries')}`
  ).bind(id, tenantId).first<{ id: string; entry_number: string; entry_date: string; description: string }>();
  if (!live) return c.json({ error: 'Invoice is not posted to GL yet' }, 409);

  if (body.reset_to_auto === true) {
    // Same reconciled-statement guard as the manual path — reset must never
    // rebuild payment legs under locked statements (plan amendment 2026-08-25).
    const resetTxIds = await payingTransactionIds(db, tenantId, id);
    for (const txId of resetTxIds) {
      const st = await db.prepare(
        `SELECT bs.status FROM bank_transactions bt JOIN bank_statements bs ON bt.bank_statement_id = bs.id WHERE bt.id = ?`
      ).bind(txId).first<{ status: string }>();
      if (st && st.status !== 'active') {
        return c.json({ error: 'A settling statement is reconciled — reopen reconciliation before resetting this posting' }, 409);
      }
    }
    await db.prepare(
      `UPDATE journal_entries SET deleted_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`
    ).bind(live.id, tenantId).run();
    const repost = await postInvoiceToGl(db, tenantId, id);
    if (repost.error || repost.not_postable || repost.already_posted) {
      return c.json({ error: repost.error || `Cannot re-post (status ${repost.not_postable})` }, 409);
    }
    await propagateHoldingChange(db, tenantId, id, /*oldHolding*/ null); // null = re-resolve per member
    await db.prepare('INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, changes) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(`al-${uuidv4().slice(0, 8)}`, user.id, 'reset_posting', 'invoice', id, JSON.stringify({ previous_entry: live.entry_number })).run();
    return c.json({ ok: true });
  }

  const labelCode = String(body.label_account_code ?? '');
  const holdingCode = String(body.holding_account_code ?? '');
  if (!labelCode || !holdingCode) return c.json({ error: 'Both label and holding accounts are required' }, 400);
  if (labelCode === holdingCode) return c.json({ error: 'Label and holding accounts must differ' }, 400);

  const acctRows = await db.prepare(
    `SELECT account_code, account_name, account_type FROM accounts
     WHERE user_id = ? AND account_code IN (?, ?) AND is_active = 1`
  ).bind(tenantId, labelCode, holdingCode).all();
  const byCode = new Map((acctRows.results as any[]).map(r => [r.account_code, r]));
  const label = byCode.get(labelCode);
  const holding = byCode.get(holdingCode);
  if (!label) return c.json({ error: `Label account ${labelCode} not found` }, 400);
  if (!holding) return c.json({ error: `Holding account ${holdingCode} not found` }, 400);
  if (!(label.account_type === 'revenue' || label.account_type === 'expense')) {
    return c.json({ error: 'Label account must be a revenue or expense account' }, 400);
  }
  if (!(holding.account_type === 'asset' || holding.account_type === 'liability')) {
    return c.json({ error: 'Holding account must be an asset or liability account' }, 400);
  }
  const leafErr = (await findParentAccountError(db, tenantId, labelCode))
    || (await findParentAccountError(db, tenantId, holdingCode));
  if (leafErr) return c.json({ error: leafErr }, 400);

  if (!(await checkPeriodOpen(db, tenantId, live.entry_date))) {
    return c.json({ error: 'Cannot change posting in a closed period' }, 409);
  }

  const prevHolding = await resolveInvoiceHoldingAccount(db, tenantId, id);
  const holdingChanged = prevHolding.code !== holdingCode;

  // Pre-validate EVERY confirmed paying transaction's parent statement BEFORE writing anything.
  const payTxIds = await payingTransactionIds(db, tenantId, id);
  if (holdingChanged && payTxIds.length > 0) {
    for (const txId of payTxIds) {
      const st = await db.prepare(
        `SELECT bs.status FROM bank_transactions bt JOIN bank_statements bs ON bt.bank_statement_id = bs.id WHERE bt.id = ?`
      ).bind(txId).first<{ status: string }>();
      if (st && st.status !== 'active') {
        return c.json({ error: 'A settling statement is reconciled — reopen reconciliation before changing the holding account' }, 409);
      }
    }
  }

  // Tombstone + fresh manual JE (new -R suffix: UNIQUE(user_id, entry_number) holds for tombstoned rows)
  await db.prepare(
    `UPDATE journal_entries SET deleted_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ? AND user_id = ?`
  ).bind(live.id, tenantId).run();

  const baseNum = `JE-INV-${inv.invoice_number}`;
  const numRows = await db.prepare(
    `SELECT entry_number FROM journal_entries WHERE user_id = ? AND entry_number LIKE ?`
  ).bind(tenantId, `${baseNum}-R%`).all();
  let maxR = 1;
  for (const r of numRows.results as any[]) {
    const m = /-R(\d+)$/.exec(r.entry_number);
    if (m) maxR = Math.max(maxR, parseInt(m[1], 10));
  }
  const jeId = `je-${uuidv4().slice(0, 8)}`;
  const jeNum = `${baseNum}-R${maxR + 1}`;
  const lineIns = 'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?,?,?,?,?,?,?,?)';
  const isIncoming = inv.direction === 'incoming';
  // One D1 batch = entry + both lines land atomically
  await db.batch([
    db.prepare(
      'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id, entry_source) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(jeId, tenantId, jeNum, live.entry_date, live.description || '', 'invoice', id, 'manual'),
    isIncoming
      ? db.prepare(lineIns).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, labelCode, label.account_name, inv.invoice_number, inv.total, 0, 0)
      : db.prepare(lineIns).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, holdingCode, holding.account_name, inv.invoice_number, inv.total, 0, 0),
    isIncoming
      ? db.prepare(lineIns).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, holdingCode, holding.account_name, inv.invoice_number, 0, inv.total, 1)
      : db.prepare(lineIns).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, labelCode, label.account_name, inv.invoice_number, 0, inv.total, 1),
  ]);

  if (holdingChanged) await propagateHoldingChange(db, tenantId, id, prevHolding.code);

  await db.prepare('INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, changes) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(`al-${uuidv4().slice(0, 8)}`, user.id, 'update_posting', 'invoice', id, JSON.stringify({
      previous_entry: live.entry_number, new_entry: jeNum,
      label: { from: prevLabelCodeValue, to: labelCode },
      holding: { from: prevHolding.code, to: holdingCode },
    })).run();

  return c.json(await invoiceDetailPayload(db, tenantId, id));
});
```

Capture the previous label BEFORE the tombstone — insert right after resolving `prevHolding`:

```ts
  const prevLabelRow = await db.prepare(
    `SELECT jl.account_code FROM journal_lines jl
     JOIN accounts a ON a.user_id = ? AND a.account_code = jl.account_code
     WHERE jl.entry_id = ? AND a.account_type IN ('revenue','expense')
     ORDER BY (CASE WHEN jl.debit > 0 THEN jl.debit ELSE jl.credit END) DESC LIMIT 1`
  ).bind(tenantId, live.id).first<{ account_code: string }>();
  const prevLabelCodeValue = prevLabelRow?.account_code || null;
```
```

Plus these two helpers placed just ABOVE the route (same file, module scope):

```ts
async function payingTransactionIds(db: any, tenantId: string, invoiceId: string): Promise<string[]> {
  const res = await db.prepare(
    `SELECT DISTINCT bt.id FROM bank_transactions bt
     LEFT JOIN bank_transaction_invoice_links l ON l.transaction_id = bt.id
     WHERE bt.user_id = ? AND bt.match_status = 'confirmed' AND bt.deleted_at IS NULL
       AND (bt.invoice_id = ? OR l.invoice_id = ?)`
  ).bind(tenantId, invoiceId, invoiceId).all();
  return (res.results as any[]).map(r => r.id);
}

/**
 * Regenerate confirmed payment legs after a holding-account change. With
 * fromCode set, only transactions whose current payment JE references that
 * code are rebuilt; with null (reset path) all payers are rebuilt. Reuses the
 * idempotent posters: tombstone the live payment JE, then re-run postPaymentToGl.
 */
async function propagateHoldingChange(db: any, tenantId: string, invoiceId: string, fromCode: string | null): Promise<void> {
  const txIds = await payingTransactionIds(db, tenantId, invoiceId);
  for (const txId of txIds) {
    const je = await db.prepare(
      `SELECT je.id, jl.account_code FROM journal_entries je
       LEFT JOIN journal_lines jl ON jl.entry_id = je.id
       WHERE je.reference_type = 'payment' AND je.reference_id = ? AND je.user_id = ? AND ${jeLive('je')}
       ORDER BY CASE WHEN jl.debit > 0 THEN jl.debit ELSE jl.credit END DESC LIMIT 1`
    ).bind(txId, tenantId).first<{ id: string; account_code: string | null }>();
    if (fromCode && je?.account_code && je.account_code !== fromCode) continue;
    if (je) {
      await db.prepare(
        `UPDATE journal_entries SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND user_id = ?`
      ).bind(je.id, tenantId).run();
    }
    await postPaymentToGl(db, tenantId, txId);
  }
}
```

- [ ] **Step 3: Typecheck at baseline**

Run: `cd api && npx tsc --noEmit 2>&1 | Select-String "error TS" | Measure-Object | Select-Object -ExpandProperty Count`
Expected: **43**, none in touched files.

- [ ] **Step 4: Commit**

```bash
git add api/src/lib/period-guard.ts api/src/routes/bookkeeping.ts api/src/routes/invoices.ts
git commit -m "feat(api): PUT /invoices/:id/posting — manual label+holding rewrite with payment propagation"
```

---

### Task 3: Backend — read-only payload enrichments

**Files:**
- Modify: `api/src/routes/invoices.ts` (GET /:id lines SELECT)
- Modify: `api/src/routes/bank-statements.ts` (GET /:id transactions assembly)

**Interfaces:**
- Produces: (a) each `journal_entries[].lines[]` element gains `account_type: string | null`; (b) each statement-detail transaction gains `linked_invoices?: { invoice_id: string; invoice_number: string; allocated_amount: number | null }[]` and `payment_entry_number?: string | null`. Tasks 4–6 consume exactly these names.

- [ ] **Step 1: account_type on JE lines**

In `invoices.ts` GET /:id, change the lines SELECT (currently `SELECT entry_id, account_code, account_name, debit, credit FROM journal_lines WHERE entry_id IN ...`) to:

```ts
      `SELECT jl.entry_id, jl.account_code, jl.account_name, jl.debit, jl.credit,
              a.account_type AS account_type
       FROM journal_lines jl
       LEFT JOIN accounts a ON a.account_code = jl.account_code AND a.user_id = (SELECT user_id FROM journal_entries WHERE id = jl.entry_id)
       WHERE jl.entry_id IN (${ePh})
       ORDER BY jl.sort_order`
```

(Simpler correct variant: since all entries share the request tenant, join `a ON a.account_code = jl.account_code AND a.user_id = ?` binding tenantId — prefer this.)

- [ ] **Step 2: linked_invoices + payment_entry_number on statement detail**

In `bank-statements.ts` GET /:id, after the `txs` query and before building `transactions`, add:

```ts
  // Lineage: settled invoices (both link paths) + live payment JE number per tx
  const txIds = (txs.results as any[]).map(t => t.id);
  const membersByTx = new Map<string, { invoice_id: string; invoice_number: string; allocated_amount: number | null }[]>();
  const pmtByTx = new Map<string, string>();
  if (txIds.length > 0) {
    const ph = txIds.map(() => '?').join(',');
    const grp = await c.env.DB.prepare(
      `SELECT l.transaction_id, l.invoice_id, l.allocated_amount, i.invoice_number
       FROM bank_transaction_invoice_links l JOIN invoices i ON l.invoice_id = i.id
       WHERE l.transaction_id IN (${ph})`
    ).bind(...txIds).all();
    for (const r of grp.results as any[]) {
      if (!membersByTx.has(r.transaction_id)) membersByTx.set(r.transaction_id, []);
      membersByTx.get(r.transaction_id)!.push({ invoice_id: r.invoice_id, invoice_number: r.invoice_number, allocated_amount: r.allocated_amount });
    }
    const pmts = await c.env.DB.prepare(
      `SELECT je.reference_id, je.entry_number FROM journal_entries je
       WHERE je.reference_type = 'payment' AND je.reference_id IN (${ph}) AND ${jeLive('je')}`
    ).bind(...txIds).all();
    for (const r of pmts.results as any[]) pmtByTx.set(r.reference_id, r.entry_number);
  }
```

Then in the `transactions` mapping spread, add:

```ts
    linked_invoices: (() => {
      const list = membersByTx.get(tx.id) ? [...membersByTx.get(tx.id)!] : [];
      if (tx.invoice_id && !list.some(m => m.invoice_id === tx.invoice_id)) {
        list.unshift({ invoice_id: tx.invoice_id, invoice_number: tx.invoice_number, allocated_amount: null });
      }
      return list;
    })(),
    payment_entry_number: pmtByTx.get(tx.id) || null,
```

Add `import { jeLive } from '../lib/journal-filters';` if absent.

- [ ] **Step 3: Typecheck at baseline**

Expected: **43**, none in touched files.

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/invoices.ts api/src/routes/bank-statements.ts
git commit -m "feat(api): expose account_type on JE lines + linked_invoices/payment JE no. on statement detail"
```

---

### Task 4: Frontend — posting editor in the detail panel

**Files:**
- Modify: `frontend/src/components/InvoiceDetailPanel.tsx`

**Interfaces:**
- Consumes: `PUT /invoices/:id/posting`; `GET /bookkeeping/accounts` (`{data:[{account_code,account_name,account_type,...}]}`); payload fields from Tasks 3 (`lines[].account_type`, entries' `entry_source`).
- Produces: editable GL postings section with Save / Cancel / Reset-to-auto. Task 5 mounts beside it.

- [ ] **Step 1: Add imports + state**

Extend imports: `useState, useMemo` from react (the file currently imports NO react hooks), `Pencil, RotateCcw` from lucide-react, `buildCoaTree, CoaNode` from `../lib/coa-hierarchy`, and `LineageMap` from `./LineageMap`. Extend `JeLine` with `account_type?: string | null` and `JournalEntry` with `reference_id?: string | null` (the backend already returns it). Inside the component add:

```tsx
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<{ label: string; holding: string }>({ label: '', holding: '' });
  const { data: accountsData } = useQuery({ queryKey: ['accounts'], queryFn: () => api('/bookkeeping/accounts'), enabled: editing });
  const accounts: any[] = accountsData?.data || [];
  const coaTree: CoaNode[] = useMemo(() => buildCoaTree(accounts), [accounts]);
```

Derive current roles from the invoice JE (first entry with `reference_type === 'invoice'`):

```tsx
  const invoiceJe = journalEntries.find(e => e.reference_type === 'invoice') || null;
  const holdingLine = invoiceJe?.lines.find(l => l.account_type === 'asset' || l.account_type === 'liability') || null;
  const labelLine = invoiceJe?.lines.find(l => l.account_type === 'revenue' || l.account_type === 'expense') || null;
```

- [ ] **Step 2: Mutations**

```tsx
  const savePostingMut = useMutation({
    mutationFn: () => api(`/invoices/${invoiceId}/posting`, {
      method: 'PUT',
      body: { label_account_code: draft.label, holding_account_code: draft.holding },
    }),
    onSuccess: () => { setEditing(false); refresh(); toast.success(tr('Posting updated', '分錄已更新', '分录已更新')); refreshLists(); },
    onError: (err: any) => toast.error(err?.message || tr('Update failed', '更新失敗', '更新失败')),
  });
  const resetPostingMut = useMutation({
    mutationFn: () => api(`/invoices/${invoiceId}/posting`, { method: 'PUT', body: { reset_to_auto: true } }),
    onSuccess: () => { setEditing(false); refresh(); toast.info(tr('Reset to auto classification', '已重設為自動分類', '已重设为自动分类')); refreshLists(); },
    onError: (err: any) => toast.error(err?.message || tr('Reset failed', '重設失敗', '重设失败')),
  });
```

Extend the existing `refresh()` usage by adding a `refreshLists()` helper that invalidates `['invoices-ap']`, `['invoices-ar']`, `['invoices']` (list badges can shift when postings change status semantics — cheap insurance), keeping existing invalidations intact.

- [ ] **Step 3: Section header + editor JSX**

Replace the `<h4>` GL header line with a flex header: title + (when `invoiceJe`) an ✏️ button toggling `editing` + (when `invoiceJe?.entry_source === 'manual'`) a Reset-to-auto button calling `resetPostingMut.mutate()`. When `editing`, render instead of the static lines:

```tsx
          <div className="space-y-2">
            <CoaRoleSelect
              label={tr('What kind of income / expense', '收入／支出類別', '收入／支出类别')}
              value={draft.label} onChange={v => setDraft(d => ({ ...d, label: v }))} tree={coaTree}
              allowedTypes={['revenue', 'expense']} />
            <CoaRoleSelect
              label={tr('Where the debt / claim is tracked', '債務／權益追蹤科目', '债务／权益追踪科目')}
              value={draft.holding} onChange={v => setDraft(d => ({ ...d, holding: v }))} tree={coaTree}
              allowedTypes={['asset', 'liability']} />
            {draft.label && draft.holding && draft.label === draft.holding && (
              <p className="text-xs text-red-600">{tr('Accounts must differ', '兩個科目不能相同', '两个科目不能相同')}</p>
            )}
            <div className="flex items-center justify-end gap-2 pt-1">
              <button onClick={() => setEditing(false)} className="px-3 py-1 text-xs border rounded hover:bg-muted">
                {tr('Cancel', '取消', '取消')}
              </button>
              <button onClick={() => savePostingMut.mutate()} disabled={savePostingMut.isPending || !draft.label || !draft.holding || draft.label === draft.holding}
                className="px-3 py-1 text-xs bg-primary text-primary-foreground rounded hover:opacity-90 disabled:opacity-30">
                {savePostingMut.isPending ? '…' : tr('Save posting', '儲存分錄', '储存分录')}
              </button>
            </div>
          </div>
```

Entering edit mode seeds `setDraft({ label: labelLine?.account_code || '', holding: holdingLine?.account_code || '' })`.

Add a small local component at file bottom:

```tsx
function CoaRoleSelect({ label, value, onChange, tree, allowedTypes }: {
  label: string; value: string; onChange: (v: string) => void; tree: CoaNode[]; allowedTypes: string[];
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <select value={value} onChange={e => onChange(e.target.value)}
        className="w-full mt-0.5 border rounded px-2 py-1 text-xs bg-background">
        <option value="">{tr('-- Select account --', '-- 選科目 --', '-- 選科目 --')}</option>
        {tree.map(n => n.isParent ? (
          <option key={`p-${n.account.account_code}`} value="" disabled>
            {`${'\u00A0'.repeat(n.depth * 2)}${n.account.account_code} ${n.account.account_name}`}
          </option>
        ) : (
          allowedTypes.includes(String((n.account as any).account_type)) ? (
            <option key={n.account.account_code} value={n.account.account_code}>
              {`${'\u00A0'.repeat(n.depth * 3)}${n.account.account_code} ${n.account.account_name}`}
            </option>
          ) : null
        ))}
      </select>
    </label>
  );
}
```

(Note: parents render as disabled headers regardless of type; leaves filter by `allowedTypes`.)

- [ ] **Step 4: Build + commit**

Run: `cd frontend && npm run build` → clean.

```bash
git add frontend/src/components/InvoiceDetailPanel.tsx
git commit -m "feat(frontend): invoice posting editor in detail panel"
```

---

### Task 5: Frontend — Entry-flow lineage map (invoice side)

**Files:**
- Create: `frontend/src/components/LineageMap.tsx`
- Modify: `frontend/src/components/InvoiceDetailPanel.tsx` (mount above GL section content)

**Interfaces:**
- Consumes: props `{ invoiceNumber, total, currency, invoiceJe, paymentEntries, linkedTxs }` where `invoiceJe: JournalEntry | null`, `paymentEntries: { je: JournalEntry; tx: LinkedTx | undefined }[]`, `linkedTxs` being the panel's existing `LinkedTx[]`. All derived inside the panel from existing payload — NO new fetching.
- Renders: Entry 1 card (invoice · label line · JE-INV no.) → pivot badge (shared holding account, from `invoiceJe`'s asset/liability line) ← Entry 2 cards (one per payment JE/tx, showing Dr/Cr lines, allocated slice for group links). Holding-role lines get a subtle ring (`ring-1 ring-blue-300`) tying them visually to the pivot.

- [ ] **Step 1: Create LineageMap.tsx**

Create `frontend/src/components/LineageMap.tsx`:

```tsx
import { tr } from '../lib/i18nHelpers';

interface JeLine { account_code: string; account_name: string; debit: number; credit: number; account_type?: string | null }
interface JournalEntry {
  id: string; entry_number: string; entry_date: string; description: string | null;
  reference_type: string; status: string; entry_source: string; lines: JeLine[];
}
interface LinkedTx {
  id: string; transaction_date: string; description: string;
  amount: number; allocated_amount: number | null; link_type: 'direct' | 'group';
  payment_voucher_no: string | null;
}
interface Props {
  invoiceNumber: string; total: number; currency: string;
  invoiceJe: JournalEntry | null;
  paymentEntries: { je: JournalEntry; tx?: LinkedTx }[];
}

const isHolding = (l: JeLine) => l.account_type === 'asset' || l.account_type === 'liability';

function JeCard({ title, je, tx }: { title: string; je: JournalEntry; tx?: LinkedTx }) {
  return (
    <div className="border rounded px-2 py-1.5 bg-background" data-testid="lineage-je-card">
      <div className="flex items-center gap-2 text-xs mb-1">
        <span className="text-[10px] uppercase text-muted-foreground">{title}</span>
        <span className="font-mono font-medium ml-auto">{je.entry_number}</span>
      </div>
      {tx && (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground mb-0.5">
          <span className="font-mono">{tx.transaction_date}</span>
          <span className="truncate max-w-[14rem]">{tx.description}</span>
          <span className="font-mono ml-auto">{(tx.allocated_amount ?? tx.amount)?.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
        </div>
      )}
      <div className="space-y-0.5">
        {je.lines.map((l, i) => (
          <div key={i} className={`flex items-center gap-2 text-xs rounded px-1 ${isHolding(l) ? 'ring-1 ring-blue-300' : ''}`}>
            <span className={`font-mono font-bold ${l.debit > 0 ? 'text-red-600' : 'text-green-600'}`}>{l.debit > 0 ? 'Dr' : 'Cr'}</span>
            <span className="font-mono">{l.account_code}</span>
            <span className="text-muted-foreground truncate flex-1">{l.account_name}</span>
            <span className="font-mono font-medium">
              {(l.debit > 0 ? l.debit : l.credit)?.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Entry 1 → pivot → Entry 2 flow for one invoice (pure display). */
export default function LineageMap({ invoiceNumber, total, currency, invoiceJe, paymentEntries }: Props) {
  const holdingLine = invoiceJe?.lines.find(isHolding) || null;
  return (
    <div className="rounded border border-dashed p-2 space-y-2 bg-muted/10" data-testid="lineage-map">
      {/* Entry 1 */}
      <JeCard
        title={tr('Entry 1 · recorded', '分錄一 · 入賬', '分录一 · 入账')}
        je={invoiceJe || {
          id: 'none', entry_number: '', entry_date: '', description: null,
          reference_type: 'invoice', status: '', entry_source: '', lines: [],
        }}
      />
      {!invoiceJe && (
        <p className="text-xs text-muted-foreground -mt-1">
          {tr('Not yet posted to GL', '尚未過賬至總賬', '尚未过账至总账')}
        </p>
      )}
      {/* Pivot */}
      {holdingLine && (
        <div className="flex justify-center" data-testid="lineage-pivot">
          <span className="inline-flex items-center gap-2 font-mono font-bold text-blue-700 bg-blue-50 border border-blue-200 rounded px-2 py-1 text-xs">
            {tr('Holding', '過渡', '过渡')}: {holdingLine.account_code} · {holdingLine.account_name}
            <span className="font-normal text-muted-foreground">{currency} {total?.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
          </span>
        </div>
      )}
      {/* Entry 2 cards */}
      {paymentEntries.map(({ je, tx }) => (
        <div key={je.id} className={tx?.link_type === 'group' ? 'border-l-2 border-blue-200 pl-2' : ''}>
          <div className="text-[10px] uppercase text-muted-foreground mb-0.5">
            {tr('Settled by', '結算自', '结算自')} {tx?.link_type === 'group' ? `(${tr('group slice', '合併付款份額', '合并付款份额')})` : ''}
          </div>
          <JeCard title={tr('Entry 2 · bank payment', '分錄二 · 銀行收付', '分录二 · 银行收付')} je={je} tx={tx} />
        </div>
      ))}
    </div>
  );
}
```

Invoice number appears inside the Entry 1 card via the JE's line descriptions (`inv.invoice_number`) already stored on lines — no extra prop plumbing needed beyond what's listed.

- [ ] **Step 2: Mount in panel**

Above the GL postings `<h4>` block (or as the first child of the section when `journalEntries.length > 0`), compute:

```tsx
  const paymentEntries = journalEntries
    .filter(e => e.reference_type === 'payment')
    .map(je => ({ je, tx: linkedTxs.find(t => t.id === (je as any).reference_id) }));
```

and render `<LineageMap invoiceNumber={data.invoice_number} total={data.total} currency={data.currency} invoiceJe={invoiceJe} paymentEntries={paymentEntries} />`.

- [ ] **Step 3: Build + commit**

Run: `cd frontend && npm run build` → clean.

```bash
git add frontend/src/components/LineageMap.tsx frontend/src/components/InvoiceDetailPanel.tsx
git commit -m "feat(frontend): entry-flow lineage map in invoice detail panel"
```

---

### Task 6: Frontend — "Settles" strip on Bank Statements

**Files:**
- Modify: `frontend/src/pages/BankStatements.tsx`

**Interfaces:**
- Consumes: per-tx `linked_invoices?: { invoice_id, invoice_number, allocated_amount }[]` and `payment_entry_number?: string | null` from Task 3.
- Produces: slim strip rendered INSIDE the expanded row's `SlideOpen`, ABOVE `<TxPostingPanel>`; hidden when `!(tx as any).linked_invoices?.length`.

- [ ] **Step 1: Extend the Transaction interface**

Add to the interface (lines 19–41): `linked_invoices?: { invoice_id: string; invoice_number: string; allocated_amount: number | null }[] | null;` and `payment_entry_number?: string | null;`.

- [ ] **Step 2: Render the strip**

Inside the expansion `<SlideOpen>` (before `<TxPostingPanel ...>` at ~line 876):

```tsx
                                        {!!(tx as any).linked_invoices?.length && (
                                          <div className="bg-blue-50/60 border-b border-blue-100 px-4 py-2 flex flex-wrap items-center gap-2 text-xs" data-testid="settles-strip">
                                            <span className="text-muted-foreground">{tr('Settles', '結算', '结算')}:</span>
                                            {(tx as any).linked_invoices.map((li: any) => (
                                              <span key={li.invoice_id} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-white border">
                                                <span className="font-medium">{li.invoice_number}</span>
                                                {li.allocated_amount != null && (
                                                  <span className="text-muted-foreground font-mono">{li.allocated_amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                                                )}
                                              </span>
                                            ))}
                                            {(tx as any).payment_entry_number && (
                                              <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-muted">{(tx as any).payment_entry_number}</span>
                                            )}
                                          </div>
                                        )}
```

- [ ] **Step 3: Build + commit**

Run: `cd frontend && npm run build` → clean.

```bash
git add frontend/src/pages/BankStatements.tsx
git commit -m "feat(frontend): settles strip linking matched transactions to their invoices"
```

---

### Task 7: Playwright verification + deploy

**Files:**
- Create: `tests/invoice-posting-lineage.spec.ts`

**Interfaces:**
- Non-mutating E2E only (shared DB waiver applies to the posting SAVE path — saves are verified manually per spec §6.4).

- [ ] **Step 1: Write the spec**

Login helper identical to `tests/ap-ar-invoice-detail-panel.spec.ts` (PNR defaults). Tests:

```ts
test('TC-LIN-01: lineage map renders on a paid invoice', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/ap`);
  await page.locator('#inv-row-i-872c3a1e td').first().click();
  const panel = page.getByTestId('invoice-detail-panel');
  await expect(panel.getByTestId('lineage-map')).toBeVisible({ timeout: 15000 });
  await expect(panel.getByTestId('lineage-pivot')).toBeVisible(); // holding account badge
});

test('TC-LIN-02: editor opens with role dropdowns, Save gated, Cancel restores', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/ap`);
  await page.locator('#inv-row-i-872c3a1e td').first().click();
  const panel = page.getByTestId('invoice-detail-panel');
  await panel.getByTestId('edit-posting').click();
  const selects = panel.locator('select');
  await expect(selects).toHaveCount(2);
  // Both dropdowns start empty → Save must stay disabled (nothing selected)
  const saveBtn = panel.getByRole('button', { name: /Save posting/i });
  await expect(saveBtn).toBeDisabled();
  // Pick a valid label account; holding still empty → still disabled
  const firstLabel = selects.nth(0).locator('option[value]:not([value=""])').first();
  await selects.nth(0).selectOption((await firstLabel.getAttribute('value'))!);
  await expect(saveBtn).toBeDisabled();
  await panel.getByRole('button', { name: /Cancel/i }).click();
  await expect(panel.locator('select')).toHaveCount(0);
});

test('TC-LIN-03: settles strip on a matched bank transaction', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/bank-statements`);
  await page.locator('main button, div[role="row"], tr').filter({ hasText: /HSBC|Statement/i }).first().click();
  // expand a transaction whose row shows the green confirmed badge
  const matchedRow = page.locator('tr').filter({ has: page.locator('.text-green-700') }).first();
  await matchedRow.click();
  await expect(page.getByTestId('settles-strip')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('settles-strip')).toContainText(/JE-PMT|#\d{4,}|INV|0014|44\d/i);
});
```

Add `data-testid="edit-posting"` on the ✏️ button (Task 4) and `data-testid="lineage-map"` / `"lineage-pivot"` (Task 5) — fold these attributes into those tasks' code.

If TC-LIN-03's generic matched-row locator proves brittle against live DOM, target the statement containing the known PnR fixture transaction instead (adjust locator, document it — never weaken assertions silently).

- [ ] **Step 2: Deploy test environment**

```bash
npm run deploy:api
# frontend:
cd frontend; npm run build; npx wrangler pages deploy dist   # project opcc-crm-testing; NEVER --env production
```

- [ ] **Step 3: Run suite**

Run: `npx playwright test invoice-posting-lineage` (timeout 600000)
Expected: 3/3 passing. Then `npx playwright test ap-ar-invoice-detail-panel` → 4/4 (no regression).

- [ ] **Step 4: Final verification**

`cd api && npx tsc --noEmit` errors == 43, none in touched files; frontend build clean.

- [ ] **Step 5: Manual checks (document results in report)**

1. Director scenario: pick a low-stakes AP bill → Edit posting → holding = `21201 Director Loan / Current Account` → Save → confirm a matching withdrawal in Bank Statements → its payment JE must show Dr `21201` (NOT 21101) → verify lineage pivot shows 21201 on both cards → Reset to auto restores `21101`.
2. Group slice: on a combined-payment tx, confirm one member's lineage slice shows its own allocated amount + pivot.

- [ ] **Step 6: Commit**

```bash
git add tests/invoice-posting-lineage.spec.ts
git commit -m "test: posting editor + lineage non-mutating E2E spec"
```
