# Audit Trail Popup + Minimal Inline GL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AP/AR inline panels show only the invoice's own Dr/Cr pair; a new Audit Trail popup (from AP/AR rows AND bank statement transaction rows) shows the document chain with statuses, the Entry 1 → pivot → Entry 2 legs, and the posting editor with cascade.

**Architecture:** Frontend restructure over the shipped backend. `LineageMap` and the editor move from `InvoiceDetailPanel` into a new `AuditTrailModal`; the panel keeps a static pair. One small read-only backend addition (`linked_receipt`).

**Tech Stack:** React + TanStack Query + Tailwind; Hono/D1 for the one backend tweak. Playwright E2E.

**Spec:** `docs/superpowers/specs/2026-08-25-invoice-posting-editor-and-lineage-design.md` §7 (Revision 2)

## Global Constraints

- API typecheck: exactly **43** pre-existing errors, none in touched files (`cd api && npx tsc --noEmit`).
- Frontend build clean (`cd frontend && npm run build`).
- tr(en, zhHant, zhHans) on every visible string; Dr red-600 / Cr green-600 conventions.
- Testids consumed by Playwright: modal `audit-trail-modal`; row buttons `audit-trail-btn` (AP/AR + bank side); chain `audit-chain`; per-invoice legs reuse LineageMap's `lineage-map`/`lineage-pivot`; editor buttons keep `edit-posting`/`reset-posting`.
- Playwright stays NON-MUTATING (shared ground-truth DB); PNR login `joseph.lin@pnr.hk` / `Test1234`; fixture invoice `i-872c3a1e`.

---

### Task 1: Backend — `linked_receipt` on `GET /invoices/:id`

**Files:**
- Modify: `api/src/routes/invoices.ts` (inside `invoiceDetailPayload`)

**Interfaces:**
- Produces: payload field `linked_receipt: { id, invoice_number, total, issue_date } | null` — consumed by Task 3's modal.

- [ ] **Step 1: Resolve the receipt**

Inside `invoiceDetailPayload`, after the `invoice` fetch succeeds and before the final return, add:

```ts
  // Receipt link: linked_invoice_id points at a receipt row (binary link, no status)
  let linked_receipt: { id: string; invoice_number: string; total: number; issue_date: string } | null = null;
  if (invoice.linked_invoice_id) {
    const rid = String(invoice.linked_invoice_id).split(',')[0].trim();
    const r = await db.prepare(
      `SELECT id, invoice_number, total, issue_date FROM invoices
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL
         AND (receipt_number IS NOT NULL OR invoice_number LIKE 'REC-%')`
    ).bind(rid, tenantId).first<{ id: string; invoice_number: string; total: number; issue_date: string }>();
    if (r) linked_receipt = r;
  }
```

Change the final return to include `linked_receipt` (keep all existing fields):

```ts
  return { ...invoice, items: items.results, linked_transactions, journal_entries, linked_receipt };
```

- [ ] **Step 2: Typecheck + commit**

Run: `cd api && npx tsc --noEmit 2>&1 | Select-String "error TS" | Measure-Object | Select-Object -ExpandProperty Count` → **43**, none in invoices.ts.

```bash
git add api/src/routes/invoices.ts
git commit -m "feat(api): expose linked_receipt on invoice detail payload"
```

---

### Task 2: Frontend — strip the panel to the minimal GL pair

**Files:**
- Modify: `frontend/src/components/InvoiceDetailPanel.tsx`

**Interfaces:**
- Produces: GL section = header + static pair only. Removes LineageMap mount, editor state/mutations/CoaRoleSelect, and the now-unused `edit-posting`/`reset-posting` buttons (they move to the modal in Task 3). Sections 1–2 untouched.

- [ ] **Step 1: Remove editor + lineage machinery**

Delete from the component: `editing`/`draft` state, `savePostingMut`/`resetPostingMut`, `refreshLists()` usage tied to them (keep the helper only if still referenced — if not, remove it), the `CoaRoleSelect` component, the `LineageMap` import + `paymentEntries` computation + `<LineageMap/>` mount, and the ✏️/Reset buttons.

- [ ] **Step 2: Simplify the GL section**

The GL postings section becomes:

```tsx
      {/* Section 3: GL postings — this invoice's own entry (Entry 1) */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase">{tr('GL postings', '過賬分錄', '过账分录')}</h4>
          {invoiceJe && <span className="font-mono text-[10px] text-muted-foreground">{invoiceJe.entry_number}</span>}
        </div>
        {!invoiceJe ? (
          <p className="text-xs text-muted-foreground">{tr('Not yet posted to GL', '尚未過賬至總賬', '尚未过账至总账')}</p>
        ) : (
          <div className="space-y-0.5">
            {invoiceJe.lines.map((l, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <span className={`font-mono font-bold ${l.debit > 0 ? 'text-red-600' : 'text-green-600'}`}>{l.debit > 0 ? 'Dr' : 'Cr'}</span>
                <span className="font-mono">{l.account_code}</span>
                <span className="text-muted-foreground truncate flex-1">{l.account_name}</span>
                <span className="font-mono font-medium">
                  {(l.debit > 0 ? l.debit : l.credit)?.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
```

Keep `invoiceJe`/`holdingLine`/`labelLine` derivations ONLY if still referenced after removals — delete unused ones (`holdingLine`/`labelLine` move to the modal; delete here if orphaned). Run an unused-import/variable pass so the build stays clean.

- [ ] **Step 3: Build + commit**

Run: `cd frontend && npm run build` → clean.

```bash
git add frontend/src/components/InvoiceDetailPanel.tsx
git commit -m "refactor(frontend): inline GL section shows only the invoice's own pair"
```

---

### Task 3: Frontend — `AuditTrailModal` component

**Files:**
- Create: `frontend/src/components/AuditTrailModal.tsx`

**Interfaces:**
- Consumes: `GET /invoices/:id` (query key `['invoice', id]` — cache shared with the panel); `PUT /invoices/:id/posting`; `LineageMap`; payload fields `linked_transactions[]`, `journal_entries[]` (with `account_type`, `reference_id`, `entry_source`), `linked_receipt`.
- Props: `{ open: boolean; onClose: () => void; invoiceId?: string | null; txContext?: { statementName: string | null; transactionDate: string; description: string; amount: number; matchStatus: string; invoiceIds: string[] } | null }` — exactly one of `invoiceId` / `txContext` per open.
- Produces: modal with testids `audit-trail-modal`, `audit-chain`, `edit-posting`, `reset-posting`; renders LineageMap (testids `lineage-map`/`lineage-pivot`) per invoice.

- [ ] **Step 1: Create the component**

```tsx
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, RotateCcw, X } from 'lucide-react';
import { useToast } from './Toast';
import { api } from '../lib/api';
import { tr } from '../lib/i18nHelpers';
import { buildCoaTree, CoaNode } from '../lib/coa-hierarchy';
import LineageMap from './LineageMap';

interface JeLine { account_code: string; account_name: string; debit: number; credit: number; account_type?: string | null }
interface JournalEntry {
  id: string; entry_number: string; entry_date: string; description: string | null;
  reference_type: string; reference_id?: string | null; status: string; entry_source: string; lines: JeLine[];
}
interface LinkedTx {
  id: string; transaction_date: string; description: string; bank_name: string | null;
  amount: number; allocated_amount: number | null; match_status: string; link_type: 'direct' | 'group';
  payment_voucher_no: string | null;
}
interface InvoiceDetail {
  id: string; invoice_number: string; total: number; currency: string;
  linked_transactions?: LinkedTx[]; journal_entries?: JournalEntry[];
  linked_receipt?: { id: string; invoice_number: string; total: number; issue_date: string } | null;
}

export default function AuditTrailModal({ open, onClose, invoiceId, txContext }: {
  open: boolean; onClose: () => void;
  invoiceId?: string | null;
  txContext?: { statementName: string | null; transactionDate: string; description: string; amount: number; matchStatus: string; invoiceIds: string[] } | null;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const ids = useMemo(() => {
    if (invoiceId) return [invoiceId];
    return txContext?.invoiceIds ?? [];
  }, [invoiceId, txContext]);

  const details = useQuery({
    queryKey: ['audit-trail', ids],
    queryFn: async () => {
      const rows = await Promise.all(ids.map(id => api(`/invoices/${id}`)));
      return rows as InvoiceDetail[];
    },
    enabled: open && ids.length > 0,
  });

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ label: string; holding: string }>({ label: '', holding: '' });
  const { data: accountsData } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api('/bookkeeping/accounts'),
    enabled: open && editingId !== null,
  });
  const accounts: any[] = accountsData?.data || [];
  const coaTree: CoaNode[] = useMemo(() => buildCoaTree(accounts), [accounts]);

  const refresh = () => {
    ids.forEach(id => queryClient.invalidateQueries({ queryKey: ['invoice', id] }));
    queryClient.invalidateQueries({ queryKey: ['audit-trail', ids] });
    queryClient.invalidateQueries({ queryKey: ['entries'] });
    queryClient.invalidateQueries({ queryKey: ['bank-statements'] });
    queryClient.invalidateQueries({ queryKey: ['invoices-ap'] });
    queryClient.invalidateQueries({ queryKey: ['invoices-ar'] });
    queryClient.invalidateQueries({ queryKey: ['invoices'] });
  };

  const savePostingMut = useMutation({
    mutationFn: () => api(`/invoices/${editingId}/posting`, {
      method: 'PUT',
      body: { label_account_code: draft.label, holding_account_code: draft.holding },
    }),
    onSuccess: () => { setEditingId(null); refresh(); toast.success(tr('Posting updated', '分錄已更新', '分录已更新')); },
    onError: (err: any) => toast.error(err?.message || tr('Update failed', '更新失敗', '更新失败')),
  });
  const resetPostingMut = useMutation({
    mutationFn: () => api(`/invoices/${editingId}/posting`, { method: 'PUT', body: { reset_to_auto: true } }),
    onSuccess: () => { setEditingId(null); refresh(); toast.info(tr('Reset to auto classification', '已重設為自動分類', '已重设为自动分类')); },
    onError: (err: any) => toast.error(err?.message || tr('Reset failed', '重設失敗', '重设失败')),
  });

  if (!open) return null;
  const rows = details.data || [];

  const statusChip = (s: string) => (
    <span className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded ${
      s === 'confirmed' ? 'bg-green-100 text-green-700'
      : s === 'suggested' ? 'bg-yellow-100 text-yellow-700'
      : 'bg-muted text-muted-foreground'}`}>{s}</span>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 overflow-y-auto" onClick={onClose} data-testid="audit-trail-modal">
      <div className="bg-card border rounded-xl p-5 w-full max-w-3xl mx-4 my-8 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-lg">{tr('Audit Trail', '審計追蹤', '审计追踪')}</h3>
          <button onClick={onClose} className="p-1 hover:bg-muted rounded"><X className="h-4 w-4" /></button>
        </div>

        {/* Chain */}
        <div className="border rounded p-3 space-y-2 bg-muted/10" data-testid="audit-chain">
          {txContext && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="px-1.5 py-0.5 rounded bg-white border font-medium">{txContext.statementName || tr('Bank statement', '銀行月結單', '银行月结单')}</span>
              <span className="text-muted-foreground">→</span>
              <span className="px-1.5 py-0.5 rounded bg-white border">
                <span className="font-mono">{txContext.transactionDate}</span> · {txContext.description} · <span className="font-mono">{txContext.amount?.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
              </span>
              {statusChip(txContext.matchStatus)}
            </div>
          )}
          {rows.map(inv => {
            const txs = inv.linked_transactions || [];
            return (
              <div key={inv.id} className="space-y-1">
                {!txContext && txs.map(tx => (
                  <div key={`${inv.id}-${tx.id}-${tx.link_type}`} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="px-1.5 py-0.5 rounded bg-white border">{tx.bank_name || tr('Bank statement', '銀行月結單', '银行月结单')}</span>
                    <span className="text-muted-foreground">→</span>
                    <span className="px-1.5 py-0.5 rounded bg-white border">
                      <span className="font-mono">{tx.transaction_date}</span> · {tx.description} · <span className="font-mono">{(tx.allocated_amount ?? tx.amount)?.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                    </span>
                    {statusChip(tx.match_status)}
                    {tx.link_type === 'group' && <span className="text-[10px] px-1 rounded bg-blue-100 text-blue-700">{tr('Group', '合併付款', '合并付款')}</span>}
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {!txContext && !txs.length && <span className="text-muted-foreground">{tr('No settling bank transaction yet', '尚未有結算銀行交易', '尚未有结算银行交易')}</span>}
                  <span className="text-muted-foreground">{txs.length || txContext ? '→' : ''}</span>
                  <span className="px-1.5 py-0.5 rounded bg-white border font-medium">{inv.invoice_number}</span>
                  <span className="font-mono text-muted-foreground">{inv.currency} {inv.total?.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                  {inv.linked_receipt ? (
                    <span className="px-1.5 py-0.5 rounded bg-green-100 text-green-700">
                      {tr('Receipt', '收據', '收据')} {inv.linked_receipt.invoice_number} · {tr('linked', '已連結', '已链接')}
                    </span>
                  ) : (
                    <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{tr('Receipt not linked', '收據未連結', '收据未链接')}</span>
                  )}
                </div>
              </div>
            );
          })}
          {details.isLoading && <p className="text-xs text-muted-foreground">{tr('Loading...', '載入中...', '载入中...')}</p>}
        </div>

        {/* GL legs + editor per invoice */}
        {rows.map(inv => {
          const entries = inv.journal_entries || [];
          const invoiceJe = entries.find(e => e.reference_type === 'invoice') || null;
          const paymentEntries = entries.filter(e => e.reference_type === 'payment')
            .map(je => ({ je, tx: (inv.linked_transactions || []).find(t => t.id === (je as any).reference_id) }));
          const holdingLine = invoiceJe?.lines.find(l => l.account_type === 'asset' || l.account_type === 'liability') || null;
          const labelLine = invoiceJe?.lines.find(l => l.account_type === 'revenue' || l.account_type === 'expense') || null;
          const editing = editingId === inv.id;
          return (
            <div key={inv.id} className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold">{inv.invoice_number}</span>
                <div className="flex items-center gap-1">
                  {invoiceJe && !editing && (
                    <button data-testid="edit-posting" onClick={() => { setEditingId(inv.id); setDraft({ label: labelLine?.account_code || '', holding: holdingLine?.account_code || '' }); }}
                      className="p-1 hover:bg-muted rounded" title={tr('Edit posting', '編輯分錄', '编辑分录')}>
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {invoiceJe?.entry_source === 'manual' && !editing && (
                    <button data-testid="reset-posting" onClick={() => resetPostingMut.mutate()} disabled={resetPostingMut.isPending}
                      className="p-1 hover:bg-muted rounded text-amber-600" title={tr('Reset to auto', '重設為自動', '重设为自动')}>
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
              <LineageMap invoiceNumber={inv.invoice_number} total={inv.total} currency={inv.currency}
                invoiceJe={invoiceJe} paymentEntries={paymentEntries} />
              {editing && (
                <div className="border rounded p-2 space-y-2 bg-muted/10">
                  <CoaRoleSelect label={tr('What kind of income / expense', '收入／支出類別', '收入／支出类别')}
                    value={draft.label} onChange={v => setDraft(d => ({ ...d, label: v }))} tree={coaTree} allowedTypes={['revenue', 'expense']} />
                  <CoaRoleSelect label={tr('Where the debt / claim is tracked', '債務／權益追蹤科目', '债务／权益追踪科目')}
                    value={draft.holding} onChange={v => setDraft(d => ({ ...d, holding: v }))} tree={coaTree} allowedTypes={['asset', 'liability']} />
                  {draft.label && draft.holding && draft.label === draft.holding && (
                    <p className="text-xs text-red-600">{tr('Accounts must differ', '兩個科目不能相同', '两个科目不能相同')}</p>
                  )}
                  <div className="flex items-center justify-end gap-2">
                    <button onClick={() => setEditingId(null)} className="px-3 py-1 text-xs border rounded hover:bg-muted">{tr('Cancel', '取消', '取消')}</button>
                    <button onClick={() => savePostingMut.mutate()} disabled={savePostingMut.isPending || !draft.label || !draft.holding || draft.label === draft.holding}
                      className="px-3 py-1 text-xs bg-primary text-primary-foreground rounded hover:opacity-90 disabled:opacity-30">
                      {savePostingMut.isPending ? '…' : tr('Save posting', '儲存分錄', '储存分录')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CoaRoleSelect({ label, value, onChange, tree, allowedTypes }: {
  label: string; value: string; onChange: (v: string) => void; tree: CoaNode[]; allowedTypes: string[];
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <select value={value} onChange={e => onChange(e.target.value)} className="w-full mt-0.5 border rounded px-2 py-1 text-xs bg-background">
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

- [ ] **Step 2: Build + commit**

Run: `cd frontend && npm run build` → clean.

```bash
git add frontend/src/components/AuditTrailModal.tsx
git commit -m "feat(frontend): AuditTrailModal — chain, GL legs, posting editor"
```

---

### Task 4: Wire entry points (AP, AR, Bank Statements)

**Files:**
- Modify: `frontend/src/pages/AP.tsx`, `frontend/src/pages/AR.tsx`, `frontend/src/pages/BankStatements.tsx`

**Interfaces:**
- Consumes: `AuditTrailModal` props per Task 3; `linked_invoices[]` per tx on the bank page (existing).
- Produces: `audit-trail-btn` buttons opening the modal in invoice context (AP/AR) and transaction context (bank page).

- [ ] **Step 1: AP.tsx + AR.tsx (identical pattern)**

Add state + import:

```tsx
const [auditId, setAuditId] = useState<string | null>(null);
import AuditTrailModal from '../components/AuditTrailModal';
```

In the actions cell (after the Eye button), add:

```tsx
<button data-testid="audit-trail-btn" onClick={() => setAuditId(inv.id)} className="p-1 hover:bg-muted rounded mr-1" title={tr('Audit Trail', '審計追蹤', '审计追踪')}>
  <Link2 className="h-4 w-4" />
</button>
```

(`Link2` is already imported in both files.) Render the modal near the other modals:

```tsx
<AuditTrailModal open={!!auditId} onClose={() => setAuditId(null)} invoiceId={auditId} />
```

- [ ] **Step 2: BankStatements.tsx**

Add state + import:

```tsx
const [auditTx, setAuditTx] = useState<{ statementName: string | null; transactionDate: string; description: string; amount: number; matchStatus: string; invoiceIds: string[] } | null>(null);
import AuditTrailModal from '../components/AuditTrailModal';
```

Inside the expanded row's SlideOpen, directly AFTER the settles strip, add:

```tsx
{!!(tx as any).linked_invoices?.length && (
  <div className="px-4 py-1.5">
    <button data-testid="audit-trail-btn" onClick={() => setAuditTx({
      statementName: (stmt as any)?.file_name || null,
      transactionDate: tx.transaction_date,
      description: tx.description,
      amount: dep > 0 ? dep : wd,
      matchStatus: tx.match_status || 'unmatched',
      invoiceIds: (tx as any).linked_invoices.map((li: any) => li.invoice_id),
    })} className="text-xs flex items-center gap-1 text-primary hover:underline">
      <Link2 className="h-3.5 w-3.5" /> {tr('View audit trail', '查看審計追蹤', '查看审计追踪')}
    </button>
  </div>
)}
```

(Use whatever variables hold deposit/withdrawal in that scope for `dep`/`wd` — they exist near `movementAmount` computation; `stmt` is the statement detail object in scope.) Render the modal once near the page's other modals:

```tsx
<AuditTrailModal open={!!auditTx} onClose={() => setAuditTx(null)} txContext={auditTx} />
```

- [ ] **Step 3: Build + commit**

Run: `cd frontend && npm run build` → clean.

```bash
git add frontend/src/pages/AP.tsx frontend/src/pages/AR.tsx frontend/src/pages/BankStatements.tsx
git commit -m "feat(frontend): audit trail entry points on AP/AR rows and bank transactions"
```

---

### Task 5: Playwright update + deploy + run

**Files:**
- Modify: `tests/invoice-posting-lineage.spec.ts`

**Interfaces:**
- Consumes: testids `audit-trail-btn` (AP/AR rows + bank side), `audit-trail-modal`, `audit-chain`, `lineage-map`, `lineage-pivot`, `edit-posting`.

- [ ] **Step 1: Update the spec**

Rewrite the three tests to route through the modal:

- **TC-LIN-01**: login → `/ap` → click `#inv-row-i-872c3a1e` `audit-trail-btn` (in the row's LAST cell, not the expansion) → expect `audit-trail-modal` visible → `lineage-map` + `lineage-pivot` visible inside it → `audit-chain` contains the invoice number.
- **TC-LIN-02**: same open → click `edit-posting` in the modal → two selects appear → Save disabled until both chosen → Cancel closes editor (selects gone).
- **TC-LIN-03**: login → `/bank-statements` → expand a statement → click a green-badge (matched) row → `settles-strip` visible → click that row's `audit-trail-btn` → modal shows `audit-chain` containing `→` hops and at least one `lineage-map`.

Keep the session-cache login helper and non-mutation waiver comment intact.

- [ ] **Step 2: Deploy test env**

```bash
npm run deploy:api
cd frontend; npm run build; npx wrangler pages deploy dist --project-name opcc-crm-testing
```

- [ ] **Step 3: Run suites**

`npx playwright test invoice-posting-lineage` → 3/3; `npx playwright test ap-ar-invoice-detail-panel` → 4/4 (timeout 600000).

- [ ] **Step 4: Final verification + commit**

Typecheck 43/none-in-touched; build clean. Commit:

```bash
git add -f tests/invoice-posting-lineage.spec.ts
git commit -m "test: audit trail popup E2E (chain, legs, editor gating)"
```

- [ ] **Step 5: Pending-manual (document, do not execute)**

Re-document the director-scenario + group-slice checks, now executed via the popup, in the task report for the human to run.
