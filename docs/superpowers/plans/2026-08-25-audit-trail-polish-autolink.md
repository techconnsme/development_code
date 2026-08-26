# Audit Trail UX Polish + Auto-Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the Audit Trail trigger as a labeled button, make the popup taller, and add in-popup auto-linking with recommendations for unmatched invoices/transactions.

**Architecture:** Pure frontend over shipped endpoints. Invoice context: `POST /bank-statements/auto-match?direction=<invoice.direction>` persists `suggested` matches; the popup's refreshed `linked_transactions` then shows them with ✓ Confirm (`PATCH /bank-statements/transactions/:txId/match`). Tx context: compact unpaid-invoice candidate list (same query as LinkedDocModal) with a Link action per candidate. Bank-side audit button becomes unconditional so unmatched txs can reach the popup.

**Spec:** `docs/superpowers/specs/2026-08-25-invoice-posting-editor-and-lineage-design.md` §7 (this is revision 3 — controller appends a note).

## Global Constraints

- Frontend build clean; api typecheck untouched (no backend changes).
- tr() everywhere; testids: trigger `audit-trail-btn` (kept), popup auto-link `auto-link-btn`, candidate rows `link-candidate`, confirm-on-suggested `confirm-suggested-btn`.
- Playwright NON-MUTATING — auto-link tests assert UI states only (button presence, candidate list renders); NO confirm clicks on shared ground-truth data.
- Only frontend files + the spec note change.

---

### Task 1: Trigger restyle + popup height

**Files:**
- Modify: `frontend/src/pages/AP.tsx`, `frontend/src/pages/AR.tsx`, `frontend/src/components/AuditTrailModal.tsx`, `frontend/src/pages/BankStatements.tsx` (import only)

- [ ] **Step 1: Labeled trigger button (AP/AR)**

Replace the icon-only button in both action cells with a compact bordered button (keep `data-testid="audit-trail-btn"`, keep position after Eye). Add `History` to the lucide-react import in both files:

```tsx
<button data-testid="audit-trail-btn" onClick={() => setAuditId(inv.id)}
  className="inline-flex items-center gap-1 px-2 py-1 border rounded text-xs hover:bg-muted mr-1"
  title={tr('Audit Trail', '審計追蹤', '审计追踪')}>
  <History className="h-3.5 w-3.5" /> {tr('Audit', '追蹤', '追踪')}
</button>
```

Bank side: keep the existing text button as-is.

- [ ] **Step 2: Taller popup**

In `AuditTrailModal.tsx`, change the panel div classes: add `min-h-[60vh] flex flex-col` and make the content area scrollable rather than growing the overlay — wrap the sections after the header in `<div className="overflow-y-auto flex-1 space-y-4 pr-1">…</div>` (move the existing `space-y-4` there). Keep `max-w-3xl`.

- [ ] **Step 3: Build + commit**

`cd frontend && npm run build` → clean.

```bash
git add frontend/src/pages/AP.tsx frontend/src/pages/AR.tsx frontend/src/components/AuditTrailModal.tsx
git commit -m "feat(frontend): labeled audit trail trigger + taller popup"
```

---

### Task 2: Auto-link with recommendations inside the popup

**Files:**
- Modify: `frontend/src/components/AuditTrailModal.tsx`, `frontend/src/pages/BankStatements.tsx`

**Interfaces:**
- Consumes: `POST /bank-statements/auto-match?direction=<d>` (persists suggestions); `PATCH /bank-statements/transactions/:txId/match` bodies `{invoice_id, action:'confirm'}` / `{action:'unlink'}`; `GET /invoices?status=draft,sent,overdue&q=` (candidate list, LinkedDocModal's query); existing `linked_transactions` payload.
- Produces: invoice-context `auto-link-btn` (visible when the invoice has NO linked transactions); suggested tx rows get `confirm-suggested-btn` (✓) + ✕ unlink; tx-context candidate list rows `link-candidate` with a Link button (visible when txContext has no linked invoices — i.e., `rows` empty or all without legs).

- [ ] **Step 1: Extend txContext + ungate the bank button**

`AuditTrailModal.tsx`: add `txId?: string` to the txContext type. `BankStatements.tsx`: (a) remove the `linked_invoices` gate on the View-audit-trail button (render for every expanded transaction), (b) pass `txId: tx.id` in the auditTx object.

- [ ] **Step 2: Invoice-context auto-link**

In the modal, add state + mutation:

```ts
  const [autoLinking, setAutoLinking] = useState(false);
  const [autoLinkMsg, setAutoLinkMsg] = useState<string | null>(null);
  const invoiceCtx = rows[0] || null;
  const noTxs = !txContext && invoiceCtx && !(invoiceCtx.linked_transactions || []).length;

  const autoLinkMut = useMutation({
    mutationFn: () => api(`/bank-statements/auto-match?direction=${(invoiceCtx as any)?.direction || 'incoming'}`, { method: 'POST' }),
    onSuccess: () => { refresh(); setAutoLinkMsg(tr('Recommendations refreshed — confirm a suggested match below', '建議已更新——請在下方確認配對', '建议已更新——请在下方确认配对')); },
    onError: (e: any) => setAutoLinkMsg(e?.message || tr('Auto-link failed', '自動連結失敗', '自动连结失败')),
    onSettled: () => setAutoLinking(false),
  });
```

In the chain section, when `noTxs`, render:

```tsx
{noTxs && (
  <div className="flex items-center gap-2">
    <button data-testid="auto-link-btn" onClick={() => { setAutoLinking(true); setAutoLinkMsg(null); autoLinkMut.mutate(); }}
      disabled={autoLinking} className="px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:opacity-90 disabled:opacity-40">
      {autoLinking ? '…' : tr('Auto-link', '自動連結', '自动连结')}
    </button>
    <span className="text-[11px] text-muted-foreground">{tr('Find matching bank transactions', '尋找配對的銀行交易', '寻找配对的银行交易')}</span>
  </div>
)}
{autoLinkMsg && <p className="text-[11px] text-muted-foreground">{autoLinkMsg}</p>}
```

- [ ] **Step 3: Confirm/unlink on suggested rows (invoice context)**

Add mutations (parameterized by txId — same lesson as the posting mutations):

```ts
  const confirmTxMut = useMutation({
    mutationFn: (txId: string) => api(`/bank-statements/transactions/${txId}/match`, { method: 'PATCH', body: { invoice_id: invoiceId || rows.find(r => (r.linked_transactions || []).some(t => t.id === txId))?.id, action: 'confirm' } }),
    onSuccess: () => refresh(),
    onError: (e: any) => toast.error(e?.message || tr('Confirm failed', '確認失敗', '确认失败')),
  });
  const unlinkTxMut = useMutation({
    mutationFn: (txId: string) => api(`/bank-statements/transactions/${txId}/match`, { method: 'PATCH', body: { action: 'unlink' } }),
    onSuccess: () => refresh(),
    onError: (e: any) => toast.error(e?.message || tr('Unlink failed', '解除連結失敗', '解除链接失败')),
  });
```

In the per-invoice tx hop rows (chain), when `tx.match_status === 'suggested'` and NOT txContext, append:

```tsx
{tx.match_status === 'suggested' && !txContext && (
  <>
    <button data-testid="confirm-suggested-btn" onClick={() => confirmTxMut.mutate(tx.id)} disabled={confirmTxMut.isPending}
      className="p-0.5 hover:bg-green-50 rounded text-green-600 disabled:opacity-40" title={tr('Confirm', '確認', '确认')}>
      ✓
    </button>
    <button onClick={() => unlinkTxMut.mutate(tx.id)} disabled={unlinkTxMut.isPending}
      className="p-0.5 hover:bg-red-50 rounded text-red-500 disabled:opacity-40" title={tr('Reject', '拒絕', '拒绝')}>
      ✕
    </button>
  </>
)}
```

- [ ] **Step 4: Tx-context candidate list**

When `txContext?.txId` and the fetched invoices collectively show NO linked legs for this tx (all `rows` have empty `linked_transactions` for that tx — simplest check: `rows.every(r => !(r.linked_transactions || []).some(t => t.id === txContext.txId))`), render a candidate picker:

```ts
  const candidates = useQuery({
    queryKey: ['link-candidates', txContext?.txId],
    queryFn: () => api('/invoices?status=draft,sent,overdue&q='),
    enabled: open && !!txContext?.txId && !!txContext && rows.length === 0,
  });
```

Render (inside the chain section, after the notice area):

```tsx
{txContext?.txId && rows.length === 0 && (
  <div className="space-y-1" data-testid="link-candidates">
    <p className="text-[11px] text-muted-foreground">{tr('Candidate invoices to link', '可連結的發票候選', '可连结的发票候选')}:</p>
    {((candidates.data as any)?.data || []).slice(0, 8).map((c: any) => (
      <div key={c.id} className="flex items-center gap-2 text-xs">
        <span className="font-medium">{c.invoice_number}</span>
        <span className="text-muted-foreground truncate flex-1">{c.vendor_name || c.customer_name || c.supplier_name || '-'}</span>
        <span className="font-mono">{c.currency} {c.total?.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
        <button onClick={() => confirmTxMut.mutate(c.id)} disabled={confirmTxMut.isPending}
          className="px-2 py-0.5 border rounded text-[11px] hover:bg-muted disabled:opacity-40">
          {tr('Link', '連結', '链接')}
        </button>
      </div>
    ))}
  </div>
)}
```

NOTE for implementer: `confirmTxMut` builds `invoice_id` from invoice context — for the tx-context candidate path it must send the CANDIDATE id. Parameterize as `mutationFn: ({txId, invoiceId}: {txId: string; invoiceId?: string}) => api(..., { body: { invoice_id: invoiceId, action: 'confirm' } })` and pass `{txId: tx.id}` / `{txId: txContext.txId, invoiceId: c.id}` at call sites. Adapt the Step-3 snippet accordingly (body omits invoice_id only if undefined — the endpoint accepts `{invoice_id, action:'confirm'}`; always send invoice_id).

- [ ] **Step 5: Build + commit**

`cd frontend && npm run build` → clean.

```bash
git add frontend/src/components/AuditTrailModal.tsx frontend/src/pages/BankStatements.tsx
git commit -m "feat(frontend): in-popup auto-link with recommendations for unmatched invoices/transactions"
```

---

### Task 3: Spec note + Playwright + deploy

**Files:**
- Modify: `docs/superpowers/specs/2026-08-25-invoice-posting-editor-and-lineage-design.md`, `tests/invoice-posting-lineage.spec.ts`

- [ ] **Step 1: Spec note**

Append to §7: "Revision 3 (2026-08-25): trigger restyled as labeled button; popup min-height 60vh with scrollable body; in-popup auto-link — invoice context runs auto-match then offers ✓ confirm on suggested transactions; tx context lists unpaid-invoice candidates with Link action; bank-side popup button now unconditional."

- [ ] **Step 2: Playwright additions (non-mutating)**

- TC-LIN-02 stays (editor via new labeled trigger — selector `audit-trail-btn` unchanged).
- Add TC-LIN-04: open popup on the UNPAID fixture invoice (pick an unpaid PnR AP bill at runtime: first row with status text `Sent` or `active`) → `auto-link-btn` visible → click → button enters pending (`…`) or message appears → assert NO confirm click happens (waiver). 
- Add TC-LIN-05: bank side, expand an UNMATCHED tx row (no green badge; walk rows as TC-LIN-03 does, inverting the filter; if none found, skip gracefully with a logged note) → `audit-trail-btn` visible (now unconditional) → popup opens → `link-candidates` list renders ≥1 row (do NOT click Link).

- [ ] **Step 3: Deploy + run + commit**

```bash
npm run deploy:api   # no api changes, but keeps versions aligned
cd frontend; npm run build; npx wrangler pages deploy dist --project-name opcc-crm-testing
npx playwright test invoice-posting-lineage     # 5/5
npx playwright test ap-ar-invoice-detail-panel  # 4/4
git add -f tests/invoice-posting-lineage.spec.ts docs/superpowers/specs/2026-08-25-invoice-posting-editor-and-lineage-design.md
git commit -m "test+docs: auto-link popup coverage and revision-3 note"
```

- [ ] **Step 4: Pending-manual**

Document (do not execute): confirm-flow via popup on a scratch tenant, and the director/group-slice scenarios from prior rounds.
