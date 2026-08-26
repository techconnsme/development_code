import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { useToast } from './Toast';
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

interface JeLine { account_code: string; account_name: string; debit: number; credit: number; account_type?: string | null }
interface JournalEntry {
  id: string; entry_number: string; entry_date: string; description: string | null;
  reference_type: string; status: string; entry_source: string; reference_id?: string | null; lines: JeLine[];
}

export default function InvoiceDetailPanel({ invoiceId }: { invoiceId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({
    queryKey: ['invoice', invoiceId],
    queryFn: () => api(`/invoices/${invoiceId}`),
    enabled: !!invoiceId,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] });
    queryClient.invalidateQueries({ queryKey: ['entries'] });
    queryClient.invalidateQueries({ queryKey: ['bank-statements'] });
    queryClient.invalidateQueries({ queryKey: ['invoices-ap'] });
    queryClient.invalidateQueries({ queryKey: ['invoices-ar'] });
    queryClient.invalidateQueries({ queryKey: ['invoices'] });
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
  const invoiceJe = journalEntries.find(e => e.reference_type === 'invoice') || null;

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
    </div>
  );
}
