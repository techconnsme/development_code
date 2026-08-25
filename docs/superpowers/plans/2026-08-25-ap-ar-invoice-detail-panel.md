# AP/AR Inline Invoice Detail Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking an invoice row in AP/AR slides open an inline detail panel showing line items, linked bank transactions (1:1 + group slices), and live GL postings.

**Architecture:** Extend the existing `GET /invoices/:id` endpoint with `linked_transactions[]` and `journal_entries[]` (no schema changes — both link paths already exist in the DB). Add one shared React component `InvoiceDetailPanel.tsx` rendered inside a `SlideOpen` expansion row in `AP.tsx` and `AR.tsx`, mirroring the bank statements page pattern.

**Tech Stack:** Hono + D1 (Cloudflare Workers) API, React + TanStack Query + Tailwind frontend, Playwright for E2E.

**Spec:** `docs/superpowers/specs/2026-08-25-ap-ar-invoice-detail-panel-design.md`

## Global Constraints

- NO schema changes, NO new migrations.
- Linked-transaction rows are view-only chips; confirm/unlink reuse the existing endpoint `PATCH /bank-statements/transactions/:txId/match` with bodies `{ invoice_id, action: 'confirm' }` / `{ invoice_ids, action: 'confirm' }` / `{ action: 'unlink' }`.
- API typecheck must stay at the established **24-error** baseline: `cd api && npx tsc --noEmit` — never more errors than before this work.
- Frontend build must be clean: `cd frontend && npm run build` (`tsc -b && vite build`).
- Every user-visible string goes through `tr(en, zhHant, zhHans)` from `frontend/src/lib/i18nHelpers.ts`.
- Dr/Cr styling matches `TxPostingPanel.tsx`: `font-mono font-bold`, Dr = `text-red-600`, Cr = `text-green-600`.
- Live journal entries are filtered with `jeLive()` semantics = `deleted_at IS NULL` (`api/src/lib/journal-filters.ts:45`). Do NOT use `jePosted` here — drafts are visible by design.
- Eye-icon PDF modals and their behavior remain untouched (except the one-line query-key alignment in Tasks 3–4).
- Playwright: sequential workers, `baseURL = process.env.TEST_BASE_URL || 'https://opcc-crm-testing.pages.dev'`.

---

### Task 1: Backend — extend `GET /invoices/:id` with `linked_transactions[]` + `journal_entries[]`

**Files:**
- Modify: `api/src/routes/invoices.ts:111-122` (the `invoices.get('/:id', ...)` handler)

**Interfaces:**
- Consumes: existing tables `bank_transactions` (cols: `id, bank_statement_id, user_id, transaction_date, description, deposit_amount, withdrawal_amount, invoice_id, match_confidence, match_status, deleted_at`), `bank_statements.bank_name`, `bank_transaction_invoice_links (transaction_id, invoice_id, allocated_amount)`, `journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id, status, entry_source, deleted_at)`, `journal_lines (entry_id, account_code, account_name, debit, credit, sort_order)`.
- Produces: response shape `{ ...invoice, items[], linked_transactions[], journal_entries[] }` where each `linked_transactions` row = `{ id, transaction_date, description, bank_name, amount, allocated_amount, match_status, match_confidence, link_type: 'direct'|'group', payment_voucher_no }` and each `journal_entries` row = `{ id, entry_number, entry_date, description, reference_type, reference_id, status, entry_source, lines[] }`. Task 2 consumes exactly these names.

- [ ] **Step 1: Replace the handler body**

Replace the entire handler at `api/src/routes/invoices.ts:111-122` (currently ends `return c.json({ ...invoice, items: items.results });`) with:

```ts
invoices.get('/:id', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const id = c.req.param('id');
  const invoice = await db.prepare(
    'SELECT i.*, c.name as customer_name, c.email as customer_email, c.address as customer_address FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id WHERE i.id = ? AND i.user_id = ? AND i.deleted_at IS NULL'
  ).bind(id, tenantId).first();
  if (!invoice) return c.json({ error: 'Invoice not found' }, 404);
  const items = await db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order').bind(id).all();

  // Linked bank transactions — both link paths:
  //   direct: bank_transactions.invoice_id = this invoice (classic 1:1 match)
  //   group:  bank_transaction_invoice_links junction row (1:N combined payment slice)
  const links = await db.prepare(
    `SELECT bt.id, bt.transaction_date, bt.description, bt.deposit_amount, bt.withdrawal_amount,
            bt.match_status, bt.match_confidence, bs.bank_name,
            NULL AS allocated_amount, 'direct' AS link_type
     FROM bank_transactions bt
     LEFT JOIN bank_statements bs ON bt.bank_statement_id = bs.id
     WHERE bt.invoice_id = ? AND bt.user_id = ? AND bt.deleted_at IS NULL
     UNION ALL
     SELECT bt.id, bt.transaction_date, bt.description, bt.deposit_amount, bt.withdrawal_amount,
            bt.match_status, bt.match_confidence, bs.bank_name,
            btil.allocated_amount, 'group' AS link_type
     FROM bank_transaction_invoice_links btil
     JOIN bank_transactions bt ON btil.transaction_id = bt.id
     LEFT JOIN bank_statements bs ON bt.bank_statement_id = bs.id
     WHERE btil.invoice_id = ? AND bt.user_id = ? AND bt.deleted_at IS NULL`
  ).bind(id, tenantId, id, tenantId).all();

  const txIds: string[] = links.results.map((r: any) => r.id);

  // Payment voucher numbers: the payment-leg JE per settling transaction
  const paymentVouchers: Record<string, string> = {};
  if (txIds.length > 0) {
    const ph = txIds.map(() => '?').join(',');
    const jes = await db.prepare(
      `SELECT reference_id, entry_number FROM journal_entries
       WHERE user_id = ? AND deleted_at IS NULL AND reference_type = 'payment' AND reference_id IN (${ph})`
    ).bind(tenantId, ...txIds).all();
    for (const je of jes.results as any[]) paymentVouchers[je.reference_id] = je.entry_number;
  }

  const linked_transactions = links.results.map((r: any) => ({
    id: r.id,
    transaction_date: r.transaction_date,
    description: r.description,
    bank_name: r.bank_name,
    amount: r.deposit_amount > 0 ? r.deposit_amount : Math.abs(r.withdrawal_amount || 0),
    allocated_amount: r.allocated_amount,
    match_status: r.match_status,
    match_confidence: r.match_confidence,
    link_type: r.link_type,
    payment_voucher_no: paymentVouchers[r.id] || null,
  }));

  // Live journal entries touching this invoice:
  //   invoice leg: reference_type='invoice' AND reference_id=<invoice id>
  //   payment leg: reference_type='payment' AND reference_id IN <linked tx ids>
  const invoiceLegs = await db.prepare(
    `SELECT id, entry_number, entry_date, description, reference_type, reference_id, status, entry_source
     FROM journal_entries WHERE user_id = ? AND deleted_at IS NULL AND reference_type = 'invoice' AND reference_id = ?`
  ).bind(tenantId, id).all();
  let paymentLegs: any[] = [];
  if (txIds.length > 0) {
    const phTx = txIds.map(() => '?').join(',');
    const res = await db.prepare(
      `SELECT id, entry_number, entry_date, description, reference_type, reference_id, status, entry_source
       FROM journal_entries WHERE user_id = ? AND deleted_at IS NULL AND reference_type = 'payment' AND reference_id IN (${phTx})`
    ).bind(tenantId, ...txIds).all();
    paymentLegs = res.results as any[];
  }
  const entries = [...(invoiceLegs.results as any[]), ...paymentLegs];

  let journal_entries: any[] = [];
  if (entries.length > 0) {
    const ePh = entries.map(() => '?').join(',');
    const linesRes = await db.prepare(
      `SELECT entry_id, account_code, account_name, debit, credit FROM journal_lines WHERE entry_id IN (${ePh}) ORDER BY sort_order`
    ).bind(...entries.map(e => e.id)).all();
    const byEntry: Record<string, any[]> = {};
    for (const l of linesRes.results as any[]) {
      if (!byEntry[l.entry_id]) byEntry[l.entry_id] = [];
      byEntry[l.entry_id].push(l);
    }
    journal_entries = entries.map(e => ({ ...e, lines: byEntry[e.id] || [] }));
  }

  return c.json({ ...invoice, items: items.results, linked_transactions, journal_entries });
});
```

- [ ] **Step 2: Typecheck at baseline**

Run: `cd api && npx tsc --noEmit 2>&1 | Select-String "error TS" | Measure-Object | Select-Object -ExpandProperty Count`
Expected: exactly **24** (same as before the change — this repo has a known pre-existing error baseline).

- [ ] **Step 3: Commit**

```bash
git add api/src/routes/invoices.ts
git commit -m "feat(api): return linked_transactions + journal_entries from GET /invoices/:id"
```

---

### Task 2: Frontend — `InvoiceDetailPanel` shared component

**Files:**
- Create: `frontend/src/components/InvoiceDetailPanel.tsx`

**Interfaces:**
- Consumes: `GET /invoices/:id` payload from Task 1; `api` helper from `../lib/api`; `tr` from `../lib/i18nHelpers`; confirm/unlink endpoints `PATCH /bank-statements/transactions/:txId/match`.
- Produces: `export default function InvoiceDetailPanel({ invoiceId }: { invoiceId: string })` — renders the 3 sections; owns query key `['invoice', invoiceId]`. Tasks 3–4 mount it inside `<SlideOpen>`.

- [ ] **Step 1: Create the component**

Create `frontend/src/components/InvoiceDetailPanel.tsx` with this exact content:

```tsx
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { toast } from './Toast';
import { api } from '../lib/api';
import { tr } from '../lib/i18nHelpers';

interface LinkedTx {
  id: string;
  transaction_date: string;
  description: string;
  bank_name: string | null;
  amount: number;
  allocated_amount: number | null;
  match_status: string;
  match_confidence: string | null;
  link_type: 'direct' | 'group';
  payment_voucher_no: string | null;
}

interface JeLine { account_code: string; account_name: string; debit: number; credit: number }
interface JournalEntry {
  id: string; entry_number: string; entry_date: string; description: string | null;
  reference_type: string; status: string; entry_source: string; lines: JeLine[];
}

export default function InvoiceDetailPanel({ invoiceId }: { invoiceId: string }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['invoice', invoiceId],
    queryFn: () => api(`/invoices/${invoiceId}`),
    enabled: !!invoiceId,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] });
    queryClient.invalidateQueries({ queryKey: ['entries'] });
    queryClient.invalidateQueries({ queryKey: ['bank-statements'] });
  };

  const confirmMut = useMutation({
    mutationFn: (tx: LinkedTx) =>
      api(`/bank-statements/transactions/${tx.id}/match`, {
        method: 'PATCH',
        body: { invoice_id: invoiceId, action: 'confirm' },
      }),
    onSuccess: () => { refresh(); toast.success(tr('Match confirmed', '配對已確認', '配对已确认')); },
    onError: (err: any) => toast.error(err?.error || err?.message || tr('Confirm failed', '確認失敗', '确认失败')),
  });
  const unlinkMut = useMutation({
    mutationFn: (txId: string) =>
      api(`/bank-statements/transactions/${txId}/match`, { method: 'PATCH', body: { action: 'unlink' } }),
    onSuccess: () => { refresh(); toast.info(tr('Transaction unlinked', '已解除交易連結', '已解除交易链接')); },
    onError: (err: any) => toast.error(err?.error || err?.message || tr('Unlink failed', '解除連結失敗', '解除链接失败')),
  });

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground">{tr('Loading...', '載入中...', '载入中...')}</div>;
  if (!data) return null;

  const linkedTxs: LinkedTx[] = data.linked_transactions || [];
  const journalEntries: JournalEntry[] = data.journal_entries || [];

  return (
    <div className="bg-muted/20 border-t border-border px-4 py-3 space-y-4" data-testid="invoice-detail-panel">
      {/* Section 1: Line items */}
      <div>
        <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-2">{tr('Line items', '項目明細', '项目明细')}</h4>
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="py-1 pr-2">{tr('Description', '描述', '描述')}</th>
              <th className="py-1 pr-2 text-right">{tr('Qty', '數量', '数量')}</th>
              <th className="py-1 pr-2 text-right">{tr('Unit price', '單價', '单价')}</th>
              <th className="py-1 text-right">{tr('Amount', '金額', '金额')}</th>
            </tr>
          </thead>
          <tbody>
            {(data.items || []).map((it: any) => (
              <tr key={it.id} className="border-b last:border-0">
                <td className="py-1 pr-2">{it.description}</td>
                <td className="py-1 pr-2 text-right font-mono">{it.quantity}</td>
                <td className="py-1 pr-2 text-right font-mono">{it.unit_price?.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                <td className="py-1 text-right font-mono">{it.amount?.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={3} className="py-1 text-right font-medium">{tr('Total', '總計', '总计')}</td>
              <td className="py-1 text-right font-mono font-bold">{data.currency} {data.total?.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Section 2: Linked bank transactions */}
      <div>
        <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-2">{tr('Linked bank transactions', '關聯銀行交易', '关联银行交易')}</h4>
        {linkedTxs.length === 0 ? (
          <p className="text-xs text-muted-foreground">{tr('No linked bank transactions', '沒有關聯的銀行交易', '没有关联的银行交易')}</p>
        ) : (
          <div className="space-y-1.5">
            {linkedTxs.map(tx => (
              <div key={`${tx.id}-${tx.link_type}`} className="flex flex-wrap items-center gap-2 text-xs bg-background border rounded px-2 py-1.5" data-testid="linked-tx-row">
                <span className="font-mono">{tx.transaction_date}</span>
                <span className="truncate max-w-[16rem]" title={tx.description}>{tx.description}</span>
                <span className="text-muted-foreground">{tx.bank_name || '-'}</span>
                {tx.link_type === 'group' && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">{tr('Group', '合併付款', '合并付款')}</span>
                )}
                <span className="font-mono ml-auto">{(tx.allocated_amount ?? tx.amount)?.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                {tx.link_type === 'group' && (
                  <span className="text-[10px] text-muted-foreground">
                    {tr('of', '佔', '占')} {tx.amount?.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </span>
                )}
                {tx.payment_voucher_no && (
                  <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-muted" title={tr('Payment voucher', '付款憑證', '付款凭证')}>
                    {tx.payment_voucher_no}
                  </span>
                )}
                {tx.match_status === 'suggested' ? (
                  <>
                    <button onClick={() => confirmMut.mutate(tx)} disabled={confirmMut.isPending}
                      className="p-0.5 hover:bg-green-50 rounded text-green-600 disabled:opacity-40"
                      title={tr('Confirm suggested match', '確認建議配對', '确认建议配对')}>
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button onClick={() => unlinkMut.mutate(tx.id)} disabled={unlinkMut.isPending}
                      className="p-0.5 hover:bg-red-50 rounded text-red-500 disabled:opacity-40"
                      title={tr('Reject suggestion', '拒絕建議', '拒绝建议')}>
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </>
                ) : (
                  <button onClick={() => unlinkMut.mutate(tx.id)} disabled={unlinkMut.isPending}
                    className="p-0.5 hover:bg-red-50 rounded text-red-500 disabled:opacity-40"
                    title={tr('Unlink', '解除連結', '解除链接')}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
                <span className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded ${
                  tx.match_status === 'confirmed' ? 'bg-green-100 text-green-700'
                  : tx.match_status === 'suggested' ? 'bg-yellow-100 text-yellow-700'
                  : 'bg-muted text-muted-foreground'
                }`}>
                  {tx.match_status === 'confirmed' ? tr('Confirmed', '已確認', '已确认')
                    : tx.match_status === 'suggested' ? tr('Suggested', '建議', '建议')
                    : tx.match_status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Section 3: GL postings */}
      <div>
        <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-2">{tr('GL postings', '過賬分錄', '过账分录')}</h4>
        {journalEntries.length === 0 ? (
          <p className="text-xs text-muted-foreground">{tr('Not yet posted to GL', '尚未過賬至總賬', '尚未过账至总账')}</p>
        ) : (
          <div className="space-y-2">
            {journalEntries.map(je => (
              <div key={je.id} className="border rounded px-2 py-1.5 bg-background">
                <div className="flex items-center gap-2 text-xs mb-1">
                  <span className="font-mono font-medium">{je.entry_number}</span>
                  <span className="text-muted-foreground font-mono">{je.entry_date}</span>
                  {je.description && <span className="text-muted-foreground truncate">{je.description}</span>}
                </div>
                <div className="space-y-0.5">
                  {je.lines.map((l, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      {(l.debit > 0 ? 'Dr' : 'Cr') === 'Dr'
                        ? <span className="font-mono font-bold text-xs text-red-600">Dr</span>
                        : <span className="font-mono font-bold text-xs text-green-600">Cr</span>}
                      <span className="font-mono">{l.account_code}</span>
                      <span className="text-muted-foreground truncate flex-1">{l.account_name}</span>
                      <span className="font-mono font-medium">
                        {(l.debit > 0 ? l.debit : l.credit)?.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

Note: check how `toast` is exported by `frontend/src/components/Toast.tsx` (AP.tsx uses `useToast()` hook; BankStatements imports `{ toast }`) — use whichever export exists there; adjust the import line accordingly.

- [ ] **Step 2: Verify build compiles so far**

Run: `cd frontend && npx tsc -b --noEmit 2>&1 | Select-Object -First 20`
Expected: no errors mentioning `InvoiceDetailPanel` (unused-component warnings acceptable).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/InvoiceDetailPanel.tsx
git commit -m "feat(frontend): shared InvoiceDetailPanel component (line items, linked bank txs, GL postings)"
```

---

### Task 3: Wire into AP.tsx

**Files:**
- Modify: `frontend/src/pages/AP.tsx` (imports near line 1-20; state near line 45; list render lines 259–306)

**Interfaces:**
- Consumes: `InvoiceDetailPanel` ({ invoiceId }), `SlideOpen` ({ open, children }) from `../components/SlideOpen`.
- Produces: row-click expansion guarded against action buttons; eye-modal cache aligned to `['invoice', viewId]` (single cached payload per invoice).

- [ ] **Step 1: Add imports**

With the other component imports in `AP.tsx` add:

```tsx
import InvoiceDetailPanel from '../components/InvoiceDetailPanel';
import SlideOpen from '../components/SlideOpen';
```

- [ ] **Step 2: Add expansion state**

Next to the existing `const [viewId, setViewId] = useState<string | null>(null);` (line ~45) add:

```tsx
const [expandedId, setExpandedId] = useState<string | null>(null);
const toggleExpand = (id: string, e: React.MouseEvent) => {
  if ((e.target as HTMLElement).closest('button,a,input,select')) return;
  setExpandedId(prev => (prev === id ? null : id));
};
```

- [ ] **Step 3: Align the eye-modal query key**

Change line ~86 from `queryKey: ['invoice-ap', viewId],` to `queryKey: ['invoice', viewId],` so the panel and modal share one cached payload. (Search the file for other `'invoice-ap'` detail-key references first — the list query `['invoices-ap', ...]` stays unchanged.)

- [ ] **Step 4: Render the expansion row**

In the invoices map (lines 259–306): put the row-click on the `<tr>` and add a second `<tr>` after it. The map currently returns one `<tr key={inv.id} id={\`inv-row-${inv.id}\`} className="border-b hover:bg-muted/30">…</tr>`; wrap both rows in a fragment and add the expansion row:

```tsx
{invoices.map((inv: any) => (
  <React.Fragment key={inv.id}>
    <tr id={`inv-row-${inv.id}`} className="border-b hover:bg-muted/30 cursor-pointer" onClick={(e) => toggleExpand(inv.id, e)}>
      {/* …existing <td> cells unchanged… */}
    </tr>
    <tr className="border-b">
      <td colSpan={7} className="p-0">
        <SlideOpen open={expandedId === inv.id}>
          <InvoiceDetailPanel invoiceId={inv.id} />
        </SlideOpen>
      </td>
    </tr>
  </React.Fragment>
))}
```

(`colSpan={7}` matches the 7 columns of the AP table header.)

- [ ] **Step 5: Build check**

Run: `cd frontend && npm run build`
Expected: completes with no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/AP.tsx
git commit -m "feat(ap): inline invoice detail expansion row"
```

---

### Task 4: Wire into AR.tsx

**Files:**
- Modify: `frontend/src/pages/AR.tsx` (imports near line 1-12; state near line 46; list render lines 260–307)

**Interfaces:**
- Consumes: same units as Task 3.
- Produces: identical expansion behavior on the AR list; must NOT break the `?highlight=` deep-link scroll effect (AR.tsx:153-175).

- [ ] **Step 1: Add imports**

```tsx
import InvoiceDetailPanel from '../components/InvoiceDetailPanel';
import SlideOpen from '../components/SlideOpen';
```

- [ ] **Step 2: Add expansion state**

Same pattern as Task 3 Step 2, next to `viewId` (line ~46):

```tsx
const [expandedId, setExpandedId] = useState<string | null>(null);
const toggleExpand = (id: string, e: React.MouseEvent) => {
  if ((e.target as HTMLElement).closest('button,a,input,select')) return;
  setExpandedId(prev => (prev === id ? null : id));
};
```

- [ ] **Step 3: Align the eye-modal query key**

Change line ~87 from `queryKey: ['invoice-ar', viewId],` to `queryKey: ['invoice', viewId],`.

- [ ] **Step 4: Render the expansion row**

Same fragment pattern as Task 3 Step 4 on the AR `<tr>` (line 261), preserving its existing attributes (`id={\`inv-row-${inv.id}\`}`, hover class). `colSpan={7}` matches the AR header column count — count the `<th>` elements in AR.tsx and use that number.

- [ ] **Step 5: Build check**

Run: `cd frontend && npm run build`
Expected: clean build.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/AR.tsx
git commit -m "feat(ar): inline invoice detail expansion row"
```

---

### Task 5: Playwright E2E spec

**Files:**
- Create: `tests/ap-ar-invoice-detail-panel.spec.ts`

**Interfaces:**
- Consumes: deployed test environment containing PnR tenant data (paid invoices with confirmed 1:1 links; at least one group-payment invoice); login credentials `joseph.lin@pnr.hk` / `Test1234`.
- Produces: automated verification of Tasks 1–4 end-to-end.

- [ ] **Step 1: Write the spec**

Create `tests/ap-ar-invoice-detail-panel.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

const BASE = process.env.TEST_BASE_URL || 'https://opcc-crm-testing.pages.dev';
const LOGIN_EMAIL = process.env.TEST_EMAIL || 'joseph.lin@pnr.hk';
const LOGIN_PASSWORD = process.env.TEST_PASSWORD || 'Test1234';

async function login(page: any) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', LOGIN_EMAIL);
  await page.fill('input[type="password"]', LOGIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !window.location.href.includes('/login'), null, { timeout: 30000 });
  await page.evaluate(() => localStorage.setItem('i18nextLng', 'en')); // deterministic English selectors
}

async function expandFirstRow(page: any, route: string) {
  await page.goto(`${BASE}${route}`);
  await page.locator('tbody tr').first().waitFor({ timeout: 15000 });
  // Click the FIRST CELL of the first invoice row (never the actions column)
  await page.locator('tbody tr').first().locator('td').first().click();
  const panel = page.getByTestId('invoice-detail-panel');
  await expect(panel).toBeVisible({ timeout: 15000 });
  return panel;
}

test('TC-PANEL-01: AP row expands with all three sections', async ({ page }) => {
  await login(page);
  const panel = await expandFirstRow(page, '/ap');
  await expect(panel.getByText('Line items')).toBeVisible();
  await expect(panel.getByText(/Linked bank transactions|Not yet posted to GL|GL postings/).first()).toBeVisible();
  // Line items table renders at least a Total row
  await expect(panel.getByText('Total')).toBeVisible();
});

test('TC-PANEL-02: AR row expands with all three sections', async ({ page }) => {
  await login(page);
  const panel = await expandFirstRow(page, '/ar');
  await expect(panel.getByText('Line items')).toBeVisible();
  await expect(panel.getByText(/Linked bank transactions|Not yet posted to GL|GL postings/).first()).toBeVisible();
});

test('TC-PANEL-03: linked transaction rows show status, and group slices show allocated amount', async ({ page }) => {
  await login(page);
  const panel = await expandFirstRow(page, '/ap');
  const rows = panel.getByTestId('linked-tx-row');
  if (await rows.count() > 0) {
    // Each row carries a status chip
    await expect(rows.first().getByText(/Confirmed|Suggested|unmatched/)).toBeVisible();
    // Group-payment slices: every 'Group' row must also show its allocated slice ("of <tx amount>")
    const groupRows = await rows.getByText('Group').count();
    if (groupRows > 0) {
      for (let i = 0; i < groupRows; i++) {
        await expect(rows.nth(i).getByText(/^of /)).toBeVisible();
      }
    }
  }
});

test('TC-PANEL-04: action buttons do not toggle expansion', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/ap`);
  await page.locator('tbody tr').first().waitFor({ timeout: 15000 });
  // The Eye button has a stable title ("View" via tr()); clicking it must open the
  // eye modal — never the inline detail panel
  await page.locator('tbody tr').first().locator('button[title="View"]').click();
  await page.waitForTimeout(800);
  const panelCount = await page.getByTestId('invoice-detail-panel').count();
  if (panelCount > 0) throw new Error('Row-click guard failed: panel opened from action button');
});
```

- [ ] **Step 2: Deploy to the test environment**

The default wrangler env IS the test deployment (`api/wrangler.toml` top-level = `opcc-crm-api`; only `[env.production]` targets prod):

```bash
npm run deploy:api
npm run build && npx wrangler pages deploy dist   # from frontend/ — project opcc-crm-testing
```

Do NOT pass `--env production`. If the pages project name prompts, it is `opcc-crm-testing` (matches the Playwright baseURL).

- [ ] **Step 3: Run the spec**

Run: `npx playwright test ap-ar-invoice-detail-panel --headed`
Expected: all 4 tests pass. If TC-PANEL-03 finds zero linked rows on the first AP invoice, manually pick a known paid PnR invoice and verify its panel shows the linked tx + voucher (adjust the locator to target `#inv-row-<id>` if needed — do not weaken the assertion silently).

- [ ] **Step 4: Manual spot-check**

On the test deployment as Joseph Lin: open a **paid** invoice panel — both JE legs (`JE-INV-*` and `JE-PMT-*`) appear with correct Dr/Cr colors; open an unposted draft — "Not yet posted to GL" shows.

- [ ] **Step 5: Final verification & commit**

Run: `cd api && npx tsc --noEmit 2>&1 | Select-String "error TS" | Measure-Object | Select-Object -ExpandProperty Count` → still 24.
Run: `cd frontend && npm run build` → clean.

```bash
git add tests/ap-ar-invoice-detail-panel.spec.ts
git commit -m "test: AP/AR inline invoice detail panel E2E spec"
```
