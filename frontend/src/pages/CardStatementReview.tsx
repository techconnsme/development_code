import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, WORKER_API_BASE } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { tr } from '../lib/i18nHelpers';
import { CreditCard, Save, Trash2, Plus, AlertTriangle, CheckCircle } from 'lucide-react';
import { useToast } from '../components/Toast';

interface CardTransaction {
  id: string; transaction_date: string; posting_date: string | null;
  description: string; amount: number; transaction_type: string | null;
  foreign_currency: string | null; foreign_amount: number | null;
  category: string | null; reference: string | null; sort_order: number;
  expense_account_code: string | null; match_status: string;
}

interface CardStatement {
  id: string; file_name: string | null; card_issuer: string | null;
  card_network: string | null; card_number_last4: string | null;
  cardholder_name: string | null; currency: string;
  statement_year: number | null; statement_month: number | null;
  period_start: string | null; period_end: string | null;
  credit_limit: number | null; opening_balance: number | null;
  closing_balance: number | null; minimum_payment: number | null;
  payment_due_date: string | null; ocr_text: string | null;
  status: string; created_at: string; transactions: CardTransaction[];
}

export default function CardStatementReview() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [headerEdits, setHeaderEdits] = useState<Record<string, any>>({});
  const [txEdits, setTxEdits] = useState<Record<string, Record<string, any>>>({});
  const [deletedTxIds, setDeletedTxIds] = useState<Set<string>>(new Set());
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Reset saving state when navigating to a different review (React Router reuses component)
  useEffect(() => { setSaving(false); }, [id]);

  const { data: stmt, isLoading, isError } = useQuery({
    queryKey: ['card-statement', id],
    queryFn: () => api(`/card-statements/${id}`),
    enabled: !!id,
  }) as { data: CardStatement | undefined; isLoading: boolean; isError: boolean };

  // Fetch COA accounts for expense code dropdown
  const { data: acctData } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api('/bookkeeping/accounts?include_inactive=false&limit=500') as Promise<{ data?: any[]; results?: any[] }>,
    enabled: !!id,
  });
  const accounts = (acctData as any)?.data || (acctData as any)?.results || [];

  // Post card transactions to GL
  const postToGlMut = useMutation({
    mutationFn: () => api(`/card-statements/${id}/post-to-gl`, { method: 'POST' }),
    onSuccess: (res: any) => {
      toast.success
        ? toast.success(tr(`${res.posted} entries posted to GL`, `已過賬 ${res.posted} 筆分錄`, `已过账 ${res.posted} 笔分录`))
        : alert(tr(`${res.posted} entries posted to GL`, `已過賬 ${res.posted} 筆分錄`, `已过账 ${res.posted} 笔分录`));
      queryClient.invalidateQueries({ queryKey: ['card-statement', id] });
    },
    onError: (err: any) => {
      alert(tr('Failed to post: ', '過賬失敗：', '过账失败：') + (err?.message || 'Unknown error'));
    },
  });

  // ── Review queue: after save/discard, load next queued item ──
  // Shift current item (position 0), then navigate to the NEXT one.
  function goNextInQueue() {
    const raw = sessionStorage.getItem('reviewQueue');
    if (!raw) return null;
    try {
      const queue: {docType:string, reviewId:string, filename:string, flags:string}[] = JSON.parse(raw);
      // Remove current item
      if (queue.length > 0) queue.shift();
      // Navigate to next item if any
      if (queue.length > 0) {
        const next = queue[0];
        sessionStorage.setItem('reviewQueue', JSON.stringify(queue));
        if (next.docType === 'bank_statement') nav(`/bank-statements/review/${next.reviewId}`);
        else if (next.docType === 'card_statement') nav(`/card-statements/review/${next.reviewId}`);
        else nav(`/invoices/review/${next.reviewId}${next.flags || ''}`);
        return true;
      }
      sessionStorage.removeItem('reviewQueue');
      sessionStorage.removeItem('reviewQueueTotal');
    } catch {}
    sessionStorage.removeItem('reviewQueue');
    sessionStorage.removeItem('reviewQueueTotal');
    return null;
  }

  // Load PDF
  useEffect(() => {
    if (!id) return;
    let revokeUrl: string | null = null;
    let cancelled = false;
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const ac = localStorage.getItem('activeClient');
    if (ac) { try { const c = JSON.parse(ac); if (c?.id) headers['X-Active-Client'] = c.id; } catch {} }
    fetch(`${WORKER_API_BASE}/card-statements/${id}/file`, { headers })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob(); })
      .then(blob => { const url = URL.createObjectURL(blob); revokeUrl = url; if (!cancelled) setPdfUrl(url); })
      .catch(() => { if (!cancelled) setPdfError('Could not load PDF'); });
    return () => { cancelled = true; if (revokeUrl) URL.revokeObjectURL(revokeUrl); };
  }, [id]);

  const saveHeaderMut = useMutation({ mutationFn: (body: any) => api(`/card-statements/${id}`, { method: 'PATCH', body }) });
  const saveTxMut = useMutation({ mutationFn: ({ txId, body }: { txId: string; body: any }) => api(`/card-statements/transactions/${txId}`, { method: 'PATCH', body }) });
  const deleteTxMut = useMutation({ mutationFn: (txId: string) => api(`/card-statements/transactions/${txId}`, { method: 'DELETE' }) });

  const confirmMut = useMutation({
    mutationFn: (body?: any) => api(`/card-statements/${id}/confirm`, { method: 'POST', body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['card-statements'] });
      queryClient.invalidateQueries({ queryKey: ['card-statements-drafts'] });
      queryClient.invalidateQueries({ queryKey: ['card-continuity'] });
      setTimeout(() => { if (!goNextInQueue()) nav('/card-statements'); }, 0);
    },
    onError: (err: any) => {
      alert(`Failed to save: ${err?.message || err?.error || 'Unknown error'}`);
      setSaving(false);
    },
  });
  const discardMut = useMutation({
    mutationFn: () => api(`/card-statements/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['card-statements'] });
      queryClient.invalidateQueries({ queryKey: ['card-statements-drafts'] });
      queryClient.invalidateQueries({ queryKey: ['card-continuity'] });
      setTimeout(() => { if (!goNextInQueue()) nav('/card-statements'); }, 0);
    },
    onError: (err: any) => {
      alert(`Failed to discard: ${err?.message || err?.error || 'Unknown error'}`);
    },
  });

  if (isLoading) return <div className="p-6 text-muted-foreground">Loading…</div>;
  if (isError || !stmt) return (
    <div className="p-6 text-center">
      <p className="text-red-600">Statement not found.</p>
      <button onClick={() => { sessionStorage.removeItem('reviewQueue'); sessionStorage.removeItem('reviewQueueTotal'); nav('/card-statements'); }}
        className="text-primary underline mt-2">← Back to Card Statements</button>
    </div>
  );

  const txs = (stmt.transactions || []).filter((tx: CardTransaction) => !deletedTxIds.has(tx.id));
  const netChange = txs.reduce((sum: number, tx: CardTransaction) => {
    const amt = Number(txEdits[tx.id]?.amount ?? tx.amount) || 0;
    const type = txEdits[tx.id]?.transaction_type ?? tx.transaction_type;
    return (type === 'payment' || type === 'refund') ? sum - amt : sum + amt;
  }, 0);
  const expectedClosing = (stmt.opening_balance || 0) + netChange;
  const mismatch = stmt.opening_balance != null && stmt.closing_balance != null && Math.abs(expectedClosing - stmt.closing_balance) >= 0.01;

  const hasTxEdits = Object.keys(txEdits).length > 0 || deletedTxIds.size > 0;

  const handleSave = async () => {
    setSaving(true);
    try {
      // Auto-update closing balance to match edited transactions
      const finalHeader = { ...headerEdits };
      if (hasTxEdits && stmt?.opening_balance != null) {
        finalHeader.closing_balance = expectedClosing;
      }
      if (Object.keys(finalHeader).length > 0) {
        await saveHeaderMut.mutateAsync(finalHeader);
      }
      for (const tid of deletedTxIds) await deleteTxMut.mutateAsync(tid);
      for (const [tid, edits] of Object.entries(txEdits)) {
        if (Object.keys(edits).length > 0) await saveTxMut.mutateAsync({ txId: tid, body: edits });
      }
      // Invalidate queries before navigating to avoid stale cache flash
      queryClient.invalidateQueries({ queryKey: ['card-statements'] });
      queryClient.invalidateQueries({ queryKey: ['card-statement', id] });
      queryClient.invalidateQueries({ queryKey: ['card-continuity'] });
      await confirmMut.mutateAsync({
        balance_status: mismatch ? 'mismatch' : hasTxEdits ? 'corrected' : 'ok',
        balance_check: mismatch ? { expected: expectedClosing, actual: stmt.closing_balance, diff: (stmt.closing_balance ?? 0) - expectedClosing } : null,
      });
    } catch (e: any) {
      alert(e.message);
      setSaving(false); // only re-enable button on error — success navigates away
    }
  };

  const fmt = (v: number | null | undefined) => v != null ? v.toLocaleString(undefined, { minimumFractionDigits: 2 }) : '—';

  return (
    <div className="flex h-[calc(100vh-4rem)]" key={id}>
      <div className="w-3/5 border-r bg-muted/10">
        {pdfUrl ? <iframe src={pdfUrl} className="w-full h-full" title="PDF" /> : <div className="flex items-center justify-center h-full text-muted-foreground">Loading PDF…</div>}
      </div>
      <div className="w-2/5 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <CreditCard className="h-5 w-5" /> Review Card Statement
            {(stmt as any)?.ocr_source && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                (stmt as any).ocr_source === 'glm-ocr'
                  ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                  : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
              }`}>
                OCR: {(stmt as any).ocr_source === 'glm-ocr' ? 'GLM-OCR' : 'toMarkdown'}
              </span>
            )}
          </h2>

          <div className="grid grid-cols-2 gap-2">
            {(['card_issuer','card_network','card_number_last4','cardholder_name','statement_year','statement_month','currency','period_start','period_end','credit_limit','opening_balance','closing_balance','minimum_payment','payment_due_date'] as const).map(key => {
              // Show computed closing balance when transactions have been edited
              const displayVal = key === 'closing_balance' && hasTxEdits && stmt?.opening_balance != null
                ? expectedClosing
                : (headerEdits[key] ?? (stmt as any)[key] ?? '');
              return (
                <div key={key}>
                  <label className="text-[10px] text-muted-foreground uppercase">{key.replace(/_/g, ' ')}</label>
                  <input value={displayVal}
                    onChange={e => setHeaderEdits(h => ({ ...h, [key]: e.target.value }))}
                    className={`mt-0.5 block w-full px-2 py-1 border rounded text-xs ${key === 'closing_balance' && hasTxEdits ? 'bg-blue-50 border-blue-300' : ''}`}
                    title={key === 'closing_balance' && hasTxEdits ? 'Auto-computed from edited transactions' : ''} />
                </div>
              );
            })}
          </div>

          {stmt.opening_balance != null && stmt.closing_balance != null && (
            <div className={`rounded p-2 text-xs flex items-center gap-2 ${!mismatch ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
              {!mismatch ? <><CheckCircle className="h-3.5 w-3.5" /> Balance verified</> : <><AlertTriangle className="h-3.5 w-3.5" /> Balance mismatch: expected ${fmt(expectedClosing)} vs actual ${fmt(stmt.closing_balance)} (net change: ${fmt(netChange)})</>}
            </div>
          )}

          <div>
            <h3 className="font-medium text-sm mb-2">Transactions ({txs.length})</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead><tr className="text-left text-muted-foreground border-b"><th className="py-1 w-[80px]">Date</th><th className="py-1">Description</th><th className="py-1 w-[70px] text-right">Amount</th><th className="py-1 w-[70px]">Type</th><th className="py-1 w-[90px]">{tr('Account', '科目', '科目')}</th><th className="py-1 w-[50px]"></th></tr></thead>
                <tbody>
                  {txs.map((tx: CardTransaction) => (
                    <tr key={tx.id} className={`border-b border-muted/20 ${txEdits[tx.id] ? 'bg-blue-50 dark:bg-blue-950/30' : ''}`} title={txEdits[tx.id] ? 'Manually edited' : ''}>
                      <td className="py-1"><input value={txEdits[tx.id]?.transaction_date ?? tx.transaction_date ?? ''} onChange={e => setTxEdits(ed => ({ ...ed, [tx.id]: { ...ed[tx.id], transaction_date: e.target.value } }))} className="w-full px-1 py-0.5 border rounded text-[11px]" type="date" /></td>
                      <td className="py-1"><input value={txEdits[tx.id]?.description ?? tx.description ?? ''} onChange={e => setTxEdits(ed => ({ ...ed, [tx.id]: { ...ed[tx.id], description: e.target.value } }))} className="w-full px-1 py-0.5 border rounded text-[11px]" /></td>
                      <td className="py-1 relative"><input value={txEdits[tx.id]?.amount ?? tx.amount ?? ''} onChange={e => setTxEdits(ed => ({ ...ed, [tx.id]: { ...ed[tx.id], amount: parseFloat(e.target.value) || 0 } }))} className="w-full px-1 py-0.5 border rounded text-[11px] text-right" type="number" step="0.01" />{txEdits[tx.id] && <span className="absolute -left-1 top-1/2 -translate-y-1/2 text-blue-500 text-[8px]" title="Edited">✏</span>}</td>
                      <td className="py-1">
                        <select value={txEdits[tx.id]?.transaction_type ?? tx.transaction_type ?? ''} onChange={e => setTxEdits(ed => ({ ...ed, [tx.id]: { ...ed[tx.id], transaction_type: e.target.value } }))} className="w-full px-1 py-0.5 border rounded text-[11px] bg-background">
                          <option value="">—</option><option value="purchase">Purchase</option><option value="payment">Payment</option><option value="refund">Refund</option><option value="fee">Fee</option><option value="interest">Interest</option><option value="cash_advance">Cash Advance</option>
                        </select>
                      </td>
                      <td className="py-1">
                        <select
                          value={txEdits[tx.id]?.expense_account_code ?? tx.expense_account_code ?? ''}
                          onChange={e => setTxEdits(ed => ({ ...ed, [tx.id]: { ...ed[tx.id], expense_account_code: e.target.value || null } }))}
                          className="w-full px-1 py-0.5 border rounded text-[11px] bg-background"
                        >
                          <option value="">—</option>
                          {accounts.filter((a: any) => a.account_type === 'expense' || a.account_type === 'cost').map((a: any) => (
                            <option key={a.account_code} value={a.account_code}>{a.account_code}</option>
                          ))}
                        </select>
                      </td>
                      <td className="py-1"><button onClick={() => setDeletedTxIds(s => new Set([...s, tx.id]))} className="p-0.5 text-muted-foreground hover:text-red-500"><Trash2 className="h-3 w-3" /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="border-t bg-card p-3 flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            {txs.length} transactions
            {txs.filter((t: CardTransaction) => t.expense_account_code).length > 0 && (
              <span className="ml-2 text-green-600 font-medium">{txs.filter((t: CardTransaction) => t.expense_account_code).length} categorized</span>
            )}
            {stmt.status === 'draft' && <span className="ml-2 text-amber-600 font-medium">Draft</span>}
          </div>
          <div className="flex gap-2">
            {stmt.status === 'draft' && <button onClick={() => { if (confirm('Discard?')) discardMut.mutate(); }} className="px-3 py-1.5 border rounded text-sm text-red-600">Discard</button>}
            {stmt.status === 'active' && txs.filter((t: CardTransaction) => t.expense_account_code).length > 0 && (
              <button onClick={() => postToGlMut.mutate()} disabled={postToGlMut.isPending}
                className="px-3 py-1.5 border rounded text-sm font-medium text-green-700 border-green-400 hover:bg-green-50 disabled:opacity-50">
                {postToGlMut.isPending ? tr('Posting…', '過賬中…', '过账中…') : tr('Post to GL', '過賬', '过账')}
              </button>
            )}
            <button onClick={handleSave} disabled={saving} className="px-4 py-1.5 bg-primary text-primary-foreground rounded text-sm font-medium disabled:opacity-50 flex items-center gap-1"><Save className="h-3.5 w-3.5" /> Save & Confirm</button>
          </div>
        </div>
      </div>
    </div>
  );
}
