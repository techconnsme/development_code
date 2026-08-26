import { useEffect, useMemo, useState } from 'react';
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
      const results = await Promise.allSettled(ids.map(id => api(`/invoices/${id}`)));
      return {
        invoices: results.filter(r => r.status === 'fulfilled').map(r => (r as PromiseFulfilledResult<any>).value as InvoiceDetail),
        missing: results.filter(r => r.status === 'rejected').length,
      };
    },
    enabled: open && ids.length > 0,
  });

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ label: string; holding: string }>({ label: '', holding: '' });
  useEffect(() => { if (!open) { setEditingId(null); setDraft({ label: '', holding: '' }); } }, [open]);
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
    mutationFn: (id: string) => api(`/invoices/${id}/posting`, {
      method: 'PUT',
      body: { label_account_code: draft.label, holding_account_code: draft.holding },
    }),
    onSuccess: () => { setEditingId(null); refresh(); toast.success(tr('Posting updated', '分錄已更新', '分录已更新')); },
    onError: (err: any) => toast.error(err?.message || tr('Update failed', '更新失敗', '更新失败')),
  });
  const resetPostingMut = useMutation({
    mutationFn: (id: string) => api(`/invoices/${id}/posting`, { method: 'PUT', body: { reset_to_auto: true } }),
    onSuccess: () => { setEditingId(null); refresh(); toast.info(tr('Reset to auto classification', '已重設為自動分類', '已重设为自动分类')); },
    onError: (err: any) => toast.error(err?.message || tr('Reset failed', '重設失敗', '重设失败')),
  });

  if (!open) return null;
  const rows = details.data?.invoices || [];

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
          {details.data && details.data.missing > 0 && (
            <p className="text-xs text-amber-600">
              {tr(`${details.data.missing} document(s) no longer available`, `${details.data.missing} 份文件已不存在`, `${details.data.missing} 份文件已不存在`)}
            </p>
          )}
          {rows.map(inv => {
            const txs = inv.linked_transactions || [];
            return (
              <div key={inv.id} className="space-y-1">
                {txs.map(tx => (
                  <div key={`${inv.id}-${tx.id}-${tx.link_type}`} className="flex flex-wrap items-center gap-2 text-xs">
                    {!txContext && (
                      <>
                        <span className="px-1.5 py-0.5 rounded bg-white border">{tx.bank_name || tr('Bank statement', '銀行月結單', '银行月结单')}</span>
                        <span className="text-muted-foreground">→</span>
                      </>
                    )}
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
                    <button data-testid="reset-posting" onClick={() => resetPostingMut.mutate(inv.id)} disabled={resetPostingMut.isPending}
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
                    <button onClick={() => savePostingMut.mutate(inv.id)} disabled={savePostingMut.isPending || !draft.label || !draft.holding || draft.label === draft.holding}
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
