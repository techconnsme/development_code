import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { tr } from '../lib/i18nHelpers';
import { useToast } from './Toast';
import { RefreshCw, Check, X, CheckCircle, FileText } from 'lucide-react';
import { WORKER_API_BASE, iframeClientParam } from '../lib/api';

interface Suggestion {
  transaction_id: string;
  description: string;
  amount: number;
  direction: 'deposit' | 'withdrawal';
  transaction_date: string;
  bank_account_code: string;
  bank_account_name: string;
  contra_account_code: string;
  contra_account_name: string;
  confidence: 'confirmed' | 'needs_review';
  reason: string;
  file_id: string | null;
}

interface Props {
  onDone: () => void;
}

export default function AutoGenerateSuggestionPanel({ onDone }: Props) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTxId, setSelectedTxId] = useState<string | null>(null);

  const fetchSuggestions = useMutation({
    mutationFn: () => api('/bookkeeping/auto-generate-entries?dry_run=true', { method: 'POST' }),
    onSuccess: (data: any) => {
      setSuggestions(data.suggestions || []);
      setLoading(false);
      if ((data.suggestions || []).length === 0) {
        toast.info(tr(
          'All transactions already have journal entries.',
          '所有交易已有日誌分錄。',
          '所有交易已有日志分录。',
        ));
        onDone();
      }
    },
    onError: (err: any) => {
      setError(err?.message || err?.error || 'Failed to fetch suggestions');
      setLoading(false);
    },
  });

  const confirmMut = useMutation({
    mutationFn: (params: { transaction_id: string; contra_account_code?: string }) =>
      api('/bookkeeping/confirm-suggestion', { method: 'POST', body: JSON.stringify(params) }),
    onSuccess: (_data: any, params) => {
      setSuggestions(prev => prev.filter(s => s.transaction_id !== params.transaction_id));
      queryClient.invalidateQueries({ queryKey: ['entries'] });
      if (selectedTxId === params.transaction_id) setSelectedTxId(null);
    },
    onError: (err: any) => {
      toast.error(tr('Confirm failed: ', '確認失敗：', '确认失败：') + (err?.message || err?.error));
    },
  });

  const confirmAllMut = useMutation({
    mutationFn: async () => {
      const confirmed = suggestions.filter(s => s.confidence === 'confirmed');
      for (const s of confirmed) {
        await api('/bookkeeping/confirm-suggestion', {
          method: 'POST',
          body: JSON.stringify({ transaction_id: s.transaction_id, contra_account_code: s.contra_account_code }),
        });
      }
      return { count: confirmed.length };
    },
    onSuccess: (data) => {
      setSuggestions(prev => prev.filter(s => s.confidence !== 'confirmed'));
      queryClient.invalidateQueries({ queryKey: ['entries'] });
      setSelectedTxId(null);
      toast.info(tr(
        `${data.count} journal entries created.`,
        `已建立 ${data.count} 筆日誌分錄。`,
        `已建立 ${data.count} 笔日志分录。`,
      ));
    },
    onError: (err: any) => {
      toast.error(tr('Confirm all failed: ', '全部確認失敗：', '全部确认失败：') + (err?.message || err?.error));
    },
  });

  const handleReject = (txId: string) => {
    setSuggestions(prev => prev.filter(s => s.transaction_id !== txId));
    if (selectedTxId === txId) setSelectedTxId(null);
  };

  const handleRejectAll = () => {
    setSuggestions([]);
    setSelectedTxId(null);
  };

  const handleContraChange = (txId: string, newCode: string) => {
    setSuggestions(prev => prev.map(s =>
      s.transaction_id === txId ? { ...s, contra_account_code: newCode } : s
    ));
  };

  const selectedSuggestion = suggestions.find(s => s.transaction_id === selectedTxId);

  useEffect(() => { fetchSuggestions.mutate(); }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onDone}>
      <div
        className="bg-card border rounded-xl p-6 w-full max-w-6xl mx-4 space-y-4 h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
        data-testid="auto-generate-suggestions"
      >
        {/* Header */}
        <div className="flex items-center justify-between shrink-0">
          <h3 className="text-base font-semibold">
            {tr('Auto-Generate Journal Entries', '自動產生日誌分錄', '自动产生日志分录')}
          </h3>
          <button onClick={onDone} className="p-1 hover:bg-muted rounded-md">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Loading */}
        {loading && (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" />
            {tr('Analyzing transactions...', '分析交易中...', '分析交易中...')}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="p-4 text-sm text-red-600">
            {error}
            <button onClick={onDone} className="ml-2 underline">{tr('Close', '關閉', '关闭')}</button>
          </div>
        )}

        {/* Content: split view when selected, list when not */}
        {!loading && !error && (
          <div className="flex-1 overflow-hidden flex gap-4 min-h-0">
            {/* Left: suggestion list */}
            <div className={`${selectedSuggestion ? 'w-1/2' : 'w-full'} flex flex-col min-h-0 overflow-hidden transition-all`}>
              <div className="flex items-center justify-between mb-2 shrink-0">
                <span className="text-sm text-muted-foreground">
                  {tr(
                    `${suggestions.length} transaction(s) ready for review`,
                    `${suggestions.length} 筆交易待審核`,
                    `${suggestions.length} 笔交易待审核`,
                  )}
                </span>
                <div className="flex gap-2">
                  {suggestions.some(s => s.confidence === 'confirmed') && (
                    <button
                      onClick={() => confirmAllMut.mutate()}
                      disabled={confirmAllMut.isPending}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
                      data-testid="confirm-all-btn"
                    >
                      <CheckCircle className="h-3.5 w-3.5" />
                      {tr('Confirm All Confirmed', '確認全部已確認', '确认全部已确认')}
                    </button>
                  )}
                  {suggestions.length > 0 && (
                    <button
                      onClick={handleRejectAll}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300"
                      data-testid="reject-all-btn"
                    >
                      <X className="h-3.5 w-3.5" />
                      {tr('Reject All', '拒絕全部', '拒绝全部')}
                    </button>
                  )}
                </div>
              </div>

              <div className="space-y-1.5 overflow-y-auto flex-1 pr-1">
                {suggestions.map(s => (
                  <div
                    key={s.transaction_id}
                    onClick={() => setSelectedTxId(s.file_id ? s.transaction_id : null)}
                    className={`flex flex-wrap items-center gap-2 p-2 rounded-lg border text-xs cursor-pointer transition-colors ${
                      selectedTxId === s.transaction_id
                        ? 'ring-2 ring-blue-500 bg-blue-50 border-blue-300'
                        : s.confidence === 'confirmed'
                          ? 'bg-green-50 border-green-200 hover:bg-green-100'
                          : 'bg-yellow-50 border-yellow-200 hover:bg-yellow-100'
                    }`}
                    data-testid="suggestion-row"
                  >
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                      s.confidence === 'confirmed'
                        ? 'bg-green-100 text-green-700'
                        : 'bg-yellow-100 text-yellow-700'
                    }`}>
                      {s.confidence === 'confirmed' ? 'CONFIRMED' : 'NEEDS REVIEW'}
                    </span>

                    <span className="font-mono truncate max-w-[180px]" title={s.description}>{s.description}</span>
                    <span className="text-muted-foreground">{s.transaction_date}</span>
                    <span className="font-mono font-medium">
                      {s.direction === 'deposit' ? '+' : '-'}${s.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </span>

                    <span className="text-muted-foreground">
                      {s.direction === 'deposit' ? 'Dr' : 'Cr'} {s.bank_account_name}
                      {' → '}
                      {s.direction === 'deposit' ? 'Cr' : 'Dr'} {s.contra_account_name}
                    </span>

                    {s.file_id && (
                      <span title={tr('Has attached document', '有附件文件', '有附件文件')}>
                        <FileText className="h-3.5 w-3.5 text-blue-500 shrink-0" />
                      </span>
                    )}

                    <input
                      type="text"
                      value={s.contra_account_code}
                      onChange={(e) => { e.stopPropagation(); handleContraChange(s.transaction_id, e.target.value); }}
                      onClick={(e) => e.stopPropagation()}
                      className="w-20 px-1.5 py-0.5 border rounded text-xs font-mono"
                      title={tr('Contra account code', '對方科目代碼', '对方科目代码')}
                      data-testid="contra-input"
                    />

                    <button
                      onClick={(e) => { e.stopPropagation(); confirmMut.mutate({ transaction_id: s.transaction_id, contra_account_code: s.contra_account_code }); }}
                      disabled={confirmMut.isPending}
                      className="p-0.5 hover:bg-green-100 rounded text-green-600 disabled:opacity-40"
                      title={tr('Confirm', '確認', '确认')}
                      data-testid="confirm-btn"
                    >
                      <Check className="h-4 w-4" />
                    </button>

                    <button
                      onClick={(e) => { e.stopPropagation(); handleReject(s.transaction_id); }}
                      disabled={confirmMut.isPending}
                      className="p-0.5 hover:bg-red-50 rounded text-red-500 disabled:opacity-40"
                      title={tr('Reject', '拒絕', '拒绝')}
                      data-testid="reject-btn"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>

              {suggestions.length === 0 && (
                <div className="text-center text-sm text-muted-foreground py-4">
                  {tr('All done! Closing.', '全部完成！關閉中。', '全部完成！关闭中。')}
                </div>
              )}
            </div>

            {/* Right: PDF preview panel */}
            {selectedSuggestion && selectedSuggestion.file_id && (
              <div className="w-1/2 flex flex-col min-h-0 border-l pl-4">
                <div className="flex items-center justify-between mb-2 shrink-0">
                  <span className="text-sm font-medium">
                    {tr('Document Preview', '文件預覽', '文件预览')}
                  </span>
                  <button
                    onClick={() => setSelectedTxId(null)}
                    className="p-1 hover:bg-muted rounded-md"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex-1 border rounded-lg overflow-hidden bg-gray-100">
                  <iframe
                    src={`${WORKER_API_BASE}/file-storage/${selectedSuggestion.file_id}/download?inline=1&token=${localStorage.getItem('token') || ''}${iframeClientParam()}`}
                    className="w-full h-full border-0"
                    title={tr('Document Preview', '文件預覽', '文件预览')}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
