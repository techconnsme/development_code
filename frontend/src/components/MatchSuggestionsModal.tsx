import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X, Link2, CreditCard, Receipt, Loader2, Check, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../lib/api';
import { useToast } from './Toast';
import { tr } from '../lib/i18nHelpers';

// ── Types ──

interface BankMatch {
  transaction_id: string;
  invoice_id: string;
  invoice_number: string;
  amount: number;
  confidence: string;
  reason: string;
  direction: string;
  invoice_total?: number;
}

interface CardMatch {
  transaction_id: string;
  card_statement_id: string;
  card_issuer: string;
  withdrawal_amount: number;
  confidence: string;
  reason: string;
}

interface ReceiptMatch {
  receipt_id: string;
  receipt_number: string;
  receipt_total: number;
  receipt_vendor: string;
  invoice_id: string;
  invoice_number: string;
  invoice_total: number;
  invoice_vendor: string;
  direction: string;
}

type TabKey = 'bank-invoice' | 'bank-card' | 'receipt';

// ── Helpers ──

const confidenceBadge = (c: string) => {
  const colors: Record<string, string> = {
    high: 'bg-green-100 text-green-700 border-green-300',
    medium: 'bg-yellow-100 text-yellow-700 border-yellow-300',
    low: 'bg-gray-100 text-gray-600 border-gray-300',
    auto: 'bg-blue-100 text-blue-700 border-blue-300',
    manual: 'bg-purple-100 text-purple-700 border-purple-300',
  };
  return `px-1.5 py-0.5 rounded text-[10px] font-medium border ${colors[c] || colors.low}`;
};

// ── Component ──

export default function MatchSuggestionsModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabKey>('bank-invoice');
  const [loading, setLoading] = useState(true);
  const [tabData, setTabData] = useState<Record<TabKey, any[]>>({
    'bank-invoice': [],
    'bank-card': [],
    receipt: [],
  });
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [rejected, setRejected] = useState<Set<string>>(new Set());

  // ── Auto-match calls on mount ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [biRes, bcRes, rInRes, rOutRes] = await Promise.allSettled([
          api('/bank-statements/auto-match', { method: 'POST' }),
          api('/bank-statements/auto-match-cards', { method: 'POST' }),
          api('/invoices/auto-match-receipts?direction=incoming', { method: 'POST' }),
          api('/invoices/auto-match-receipts?direction=outgoing', { method: 'POST' }),
        ]);
        if (cancelled) return;
        const bi = biRes.status === 'fulfilled' ? (biRes.value as any)?.matched || [] : [];
        const bc = bcRes.status === 'fulfilled' ? (bcRes.value as any)?.matched || [] : [];
        const rIn = rInRes.status === 'fulfilled' ? (rInRes.value as any)?.matched || [] : [];
        const rOut = rOutRes.status === 'fulfilled' ? (rOutRes.value as any)?.matched || [] : [];
        setTabData({
          'bank-invoice': bi,
          'bank-card': bc,
          receipt: [...rIn, ...rOut],
        });
        // Default to first non-empty tab
        if (bi.length > 0) setActiveTab('bank-invoice');
        else if (bc.length > 0) setActiveTab('bank-card');
        else if (rIn.length + rOut.length > 0) setActiveTab('receipt');
      } catch {}
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Mutations ──

  const confirmBankInvMut = useMutation({
    mutationFn: ({ txId, invoiceId }: { txId: string; invoiceId: string }) =>
      api(`/bank-statements/transactions/${txId}/match`, { method: 'PATCH', body: { action: 'confirm', invoice_id: invoiceId } }),
    onSuccess: (_: any, vars: any) => {
      setConfirmed(prev => new Set(prev).add(vars.txId));
      toast.success(tr('Match confirmed', '配對已確認', '配对已确认'));
    },
    onError: (e: any) => toast.error(e?.message || 'Failed'),
  });

  const rejectBankInvMut = useMutation({
    mutationFn: (txId: string) =>
      api(`/bank-statements/transactions/${txId}/match`, { method: 'PATCH', body: { action: 'unlink' } }),
    onSuccess: (_: any, txId: string) => {
      setRejected(prev => new Set(prev).add(txId));
    },
    onError: (e: any) => toast.error(e?.message || 'Failed'),
  });

  const confirmBankCardMut = useMutation({
    mutationFn: ({ txId, csId }: { txId: string; csId: string }) =>
      api(`/bank-statements/transactions/${txId}/card-link`, { method: 'PATCH', body: { card_statement_id: csId, action: 'link' } }),
    onSuccess: (_: any, vars: any) => {
      setConfirmed(prev => new Set(prev).add('card-' + vars.txId));
      toast.success(tr('Card link confirmed', '信用卡連結已確認', '信用卡连结已确认'));
    },
    onError: (e: any) => toast.error(e?.message || 'Failed'),
  });

  const rejectBankCardMut = useMutation({
    mutationFn: (txId: string) =>
      api(`/bank-statements/transactions/${txId}/skip-link`, { method: 'PATCH' }),
    onSuccess: (_: any, txId: string) => {
      setRejected(prev => new Set(prev).add('card-' + txId));
    },
    onError: (e: any) => toast.error(e?.message || 'Failed'),
  });

  const confirmReceiptMut = useMutation({
    mutationFn: ({ receiptId, invoiceId }: { receiptId: string; invoiceId: string }) =>
      api('/invoices/confirm-receipt-match', { method: 'POST', body: { receipt_id: receiptId, invoice_id: invoiceId } }),
    onSuccess: (_: any, vars: any) => {
      setConfirmed(prev => new Set(prev).add('rcpt-' + vars.receiptId));
      toast.success(tr('Receipt matched', '收據已配對', '收据已配对'));
    },
    onError: (e: any) => toast.error(e?.message || 'Failed'),
  });

  // ── Pending items per tab (exclude confirmed/rejected) ──
  const activeTabData = tabData[activeTab];
  const pending = activeTab === 'bank-invoice'
    ? activeTabData.filter((m: BankMatch) => !confirmed.has(m.transaction_id) && !rejected.has(m.transaction_id))
    : activeTab === 'bank-card'
    ? activeTabData.filter((m: CardMatch) => !confirmed.has('card-' + m.transaction_id) && !rejected.has('card-' + m.transaction_id))
    : activeTabData.filter((m: ReceiptMatch) => !confirmed.has('rcpt-' + m.receipt_id) && !rejected.has('rcpt-' + m.receipt_id));

  const reviewedCount = activeTabData.length - pending.length;

  // Tab config
  const tabs: { key: TabKey; label: string; icon: React.ElementType }[] = [
    { key: 'bank-invoice', label: tr('Bank → Invoice', '銀行 → 發票', '银行 → 发票'), icon: Link2 },
    { key: 'bank-card', label: tr('Bank → Card', '銀行 → 信用卡', '银行 → 信用卡'), icon: CreditCard },
    { key: 'receipt', label: tr('Receipt → Invoice', '收據 → 發票', '收据 → 发票'), icon: Receipt },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-card border rounded-xl shadow-xl w-full max-w-4xl mx-4 max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b shrink-0">
          <div>
            <h2 className="text-lg font-bold">{tr('Link Suggestions', '連結建議', '连结建议')}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {tr('Review and confirm suggested matches across all document types.', '審核並確認所有文件類型的建議配對。', '审核并确认所有文件类型的建议配对。')}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-muted rounded-lg">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b shrink-0 px-2">
          {tabs.map(t => {
            const Icon = t.icon;
            const count = tabData[t.key].length;
            const isActive = activeTab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                  isActive
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon className="h-4 w-4" />
                {t.label}
                {count > 0 && (
                  <span className={`ml-1 text-xs px-1.5 py-0.5 rounded-full ${
                    isActive ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                  }`}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="h-8 w-8 animate-spin mb-3" />
              <p className="text-sm font-medium">{tr('Scanning for suggestions…', '正在掃描建議…', '正在扫描建议…')}</p>
              <p className="text-xs mt-1">{tr('This may take a few seconds', '可能需要幾秒鐘', '可能需要几秒钟')}</p>
            </div>
          ) : activeTabData.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <div className="text-4xl mb-3">🎉</div>
              <p className="text-sm font-medium">
                {tr('No suggestions for this category', '此類別沒有建議', '此类别没有建议')}
              </p>
              <p className="text-xs mt-1">
                {tr('All transactions are either matched or need manual review.', '所有交易已配對或需要手動審核。', '所有交易已配对或需要手动审核。')}
              </p>
            </div>
          ) : pending.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Check className="h-10 w-10 text-green-500 mb-2" />
              <p className="text-sm font-medium">{tr('All suggestions reviewed!', '所有建議已審核！', '所有建议已审核！')}</p>
              <p className="text-xs mt-1">{reviewedCount}/{activeTabData.length} {tr('reviewed', '已審核', '已审核')}</p>
            </div>
          ) : (
            <>
              {/* Accept All + progress */}
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs text-muted-foreground">
                  {reviewedCount}/{activeTabData.length} {tr('reviewed', '已審核', '已审核')}
                  {pending.length > 0 && <> · {pending.length} {tr('remaining', '剩餘', '剩余')}</>}
                </span>
                {pending.length > 0 && (
                  <button
                    onClick={() => {
                      pending.forEach((m: any) => {
                        if (activeTab === 'bank-invoice') {
                          confirmBankInvMut.mutate({ txId: m.transaction_id, invoiceId: m.invoice_id });
                        } else if (activeTab === 'bank-card') {
                          confirmBankCardMut.mutate({ txId: m.transaction_id, csId: m.card_statement_id });
                        } else {
                          confirmReceiptMut.mutate({ receiptId: m.receipt_id, invoiceId: m.invoice_id });
                        }
                      });
                    }}
                    disabled={
                      (activeTab === 'bank-invoice' && confirmBankInvMut.isPending) ||
                      (activeTab === 'bank-card' && confirmBankCardMut.isPending) ||
                      (activeTab === 'receipt' && confirmReceiptMut.isPending)
                    }
                    className="px-3 py-1.5 bg-green-600 text-white rounded text-xs font-medium hover:bg-green-700 disabled:opacity-50"
                  >
                    {tr('Accept All', '全部接受', '全部接受')} ({pending.length})
                  </button>
                )}
              </div>

              {/* List */}
              <div className="space-y-2">
                {pending.map((m: any) => (
                  <MatchRow
                    key={activeTab === 'bank-invoice' ? m.transaction_id : activeTab === 'bank-card' ? 'card-' + m.transaction_id : 'rcpt-' + m.receipt_id}
                    type={activeTab}
                    match={m}
                    onConfirm={() => {
                      if (activeTab === 'bank-invoice') confirmBankInvMut.mutate({ txId: m.transaction_id, invoiceId: m.invoice_id });
                      else if (activeTab === 'bank-card') confirmBankCardMut.mutate({ txId: m.transaction_id, csId: m.card_statement_id });
                      else confirmReceiptMut.mutate({ receiptId: m.receipt_id, invoiceId: m.invoice_id });
                    }}
                    onReject={() => {
                      if (activeTab === 'bank-invoice') rejectBankInvMut.mutate(m.transaction_id);
                      else if (activeTab === 'bank-card') rejectBankCardMut.mutate(m.transaction_id);
                      else setRejected(prev => new Set(prev).add('rcpt-' + m.receipt_id));
                    }}
                    isProcessing={
                      (activeTab === 'bank-invoice' && confirmBankInvMut.isPending) ||
                      (activeTab === 'bank-card' && (confirmBankCardMut.isPending || rejectBankCardMut.isPending)) ||
                      (activeTab === 'receipt' && confirmReceiptMut.isPending)
                    }
                  />
                ))}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="border-t px-5 py-3 shrink-0 flex justify-end">
          <button
            onClick={() => {
              queryClient.invalidateQueries({ queryKey: ['dashboard'] });
              queryClient.invalidateQueries({ queryKey: ['link-stats'] });
              queryClient.invalidateQueries({ queryKey: ['bank-statements'] });
              queryClient.invalidateQueries({ queryKey: ['invoices-ap'] });
              queryClient.invalidateQueries({ queryKey: ['invoices-ar'] });
              queryClient.invalidateQueries({ queryKey: ['invoices'] });
              onClose();
            }}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium"
          >
            {tr('Done', '完成', '完成')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Single match row ──

function MatchRow({ type, match, onConfirm, onReject, isProcessing }: {
  type: TabKey;
  match: any;
  onConfirm: () => void;
  onReject: () => void;
  isProcessing: boolean;
}) {
  return (
    <div className="border rounded-lg p-3 flex items-center gap-3 hover:bg-muted/30 transition-colors">
      <div className="flex-1 min-w-0">
        {type === 'bank-invoice' && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
              match.direction?.includes('AR') ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'
            }`}>
              {match.direction || '—'}
            </span>
            <span className="text-sm font-medium">#{match.invoice_number}</span>
            <span className={confidenceBadge(match.confidence)}>{match.confidence}</span>
            <span className="text-xs text-muted-foreground">
              {tr('HKD', '港幣', '港币')} {(match.amount || match.invoice_total || 0).toLocaleString()}
            </span>
          </div>
        )}
        {type === 'bank-card' && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 font-medium">
              {match.card_issuer || tr('Card', '信用卡', '信用卡')}
            </span>
            <span className={confidenceBadge(match.confidence)}>{match.confidence}</span>
            <span className="text-xs text-muted-foreground">
              {tr('HKD', '港幣', '港币')} {(match.withdrawal_amount || 0).toLocaleString()}
            </span>
          </div>
        )}
        {type === 'receipt' && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
              match.direction === 'outgoing' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'
            }`}>
              {match.direction === 'outgoing' ? 'AR' : 'AP'}
            </span>
            <span className="text-sm font-medium">Receipt #{match.receipt_number}</span>
            <span className="text-xs text-muted-foreground">→</span>
            <span className="text-sm font-medium">Invoice #{match.invoice_number}</span>
            <span className="text-xs text-muted-foreground">
              {tr('HKD', '港幣', '港币')} {match.receipt_total?.toLocaleString()} → {match.invoice_total?.toLocaleString()}
            </span>
          </div>
        )}
        <p className="text-xs text-muted-foreground mt-0.5 truncate">{match.reason}</p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={onConfirm}
          disabled={isProcessing}
          className="px-3 py-1.5 bg-green-600 text-white rounded text-xs font-medium hover:bg-green-700 disabled:opacity-50"
        >
          ✓ {tr('Confirm', '確認', '确认')}
        </button>
        <button
          onClick={onReject}
          disabled={isProcessing}
          className="px-3 py-1.5 border border-red-300 text-red-600 rounded text-xs hover:bg-red-50 disabled:opacity-50"
        >
          ✗ {tr('Reject', '拒絕', '拒绝')}
        </button>
      </div>
    </div>
  );
}
