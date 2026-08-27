import { useState, useEffect, useRef } from 'react';
import { X, Sparkles, CheckCircle2, Loader2, AlertCircle } from 'lucide-react';
import { WORKER_API_BASE, iframeClientParam } from '../lib/api';
import { tr } from '../lib/i18nHelpers';
import { writeTokenUsage } from './TokenPopup';

interface MatchSuggestion {
  transaction_id?: string;
  receipt_id?: string;
  invoice_id?: string;
  invoice_ids?: string[];
  invoice_number?: string;
  invoice_numbers?: string[];
  amount?: number;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  type: 'exact' | 'combined' | 'partial' | 'overpayment';
  direction?: string;
  invoice_file_id?: string | null;
  stmt_file_id?: string | null;
}

interface ProgressEvent {
  phase: 'rules' | 'llm' | 'done';
  current: number;
  total: number;
  message: string;
  sessionId?: string;
}

export default function LLMMatchModal({ type, direction, onConfirm, onReject, onClose }: {
  type: 'bank-invoice' | 'receipt-invoice';
  direction?: 'incoming' | 'outgoing';
  onConfirm: (txId: string | null, invoiceId: string | null, invoiceIds?: string[]) => void | Promise<void>;
  onReject: (txId: string | null) => void | Promise<void>;
  onClose: () => void;
}) {
  const [suggestions, setSuggestions] = useState<MatchSuggestion[]>([]);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [processing, setProcessing] = useState<string | null>(null);
  const [previewMatch, setPreviewMatch] = useState<MatchSuggestion | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const token = localStorage.getItem('token') || '';

  useEffect(() => {
    startMatching();
    return () => {
      abortControllerRef.current?.abort();
      if (sessionId) {
        fetch(`${WORKER_API_BASE}/match/cancel/${sessionId}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
      }
    };
  }, []);

  const startMatching = async () => {
    setIsStreaming(true);
    setError(null);
    abortControllerRef.current = new AbortController();

    try {
      const resp = await fetch(`${WORKER_API_BASE}/match/llm-analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ type, direction }),
        signal: abortControllerRef.current.signal,
      });

      if (!resp.ok) {
        throw new Error(`Server error: ${resp.status}`);
      }

      const reader = resp.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error('No response stream');

      let buffer = '';
      let currentEvent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            const data = JSON.parse(line.slice(6));

            if (data.sessionId && !sessionId) {
              setSessionId(data.sessionId);
            }

            switch (currentEvent) {
              case 'progress':
                setProgress(data);
                break;
              case 'suggestions':
                setSuggestions(data);
                break;
              case 'tokens':
                writeTokenUsage({
                  prompt: data.prompt || 0,
                  completion: data.completion || 0,
                  total: data.total || 0,
                });
                break;
              case 'error':
                setError(data.message);
                break;
              case 'cancelled':
                onClose();
                return;
            }
          }
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setError(err.message || 'Failed to start matching');
      }
    } finally {
      setIsStreaming(false);
    }
  };

  const handleCancel = async () => {
    abortControllerRef.current?.abort();
    if (sessionId) {
      await fetch(`${WORKER_API_BASE}/match/cancel/${sessionId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
    onClose();
  };

  const getKey = (m: MatchSuggestion) => m.transaction_id || m.receipt_id || '';

  const pending = suggestions.filter(m => !confirmed.has(getKey(m)) && !rejected.has(getKey(m)));

  const handleConfirm = async (m: MatchSuggestion) => {
    const key = getKey(m);
    setProcessing(key);
    try {
      await onConfirm(key, m.invoice_id ?? null, m.invoice_ids);
      setConfirmed(prev => new Set(prev).add(key));
    } catch { /* parent surfaces error */ }
    setProcessing(null);
  };

  const handleReject = async (m: MatchSuggestion) => {
    const key = getKey(m);
    setProcessing(key);
    try {
      await onReject(key);
      setRejected(prev => new Set(prev).add(key));
    } catch { /* keep pending */ }
    setProcessing(null);
  };

  const acceptAll = async () => {
    for (const m of pending) await handleConfirm(m);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-card border rounded-xl p-6 w-full max-w-[95vw] mx-4 space-y-4 h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-blue-600" />
            {tr('AI Match Suggestions', 'AI 配對建議', 'AI 配对建议')}
            {isStreaming && <Loader2 className="h-4 w-4 animate-spin text-blue-500" />}
          </h3>
          <button onClick={handleCancel} className="p-1 hover:bg-muted rounded"><X className="h-4 w-4" /></button>
        </div>

        {progress && progress.phase !== 'done' && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {progress.message}
            </div>
            <div className="w-full bg-muted rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }}
              />
            </div>
            <div className="text-xs text-muted-foreground text-right">
              {progress.current}/{progress.total}
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 p-3 rounded-lg">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}

        {suggestions.length === 0 && !isStreaming && !error ? (
          <div className="text-center py-8 space-y-2">
            <CheckCircle2 className="h-8 w-8 text-green-500 mx-auto" />
            <p className="text-sm font-medium">{tr('No additional matches found by AI', 'AI 未找到額外匹配', 'AI 未找到额外匹配')}</p>
            <button onClick={onClose} className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm">
              {tr('Close', '關閉', '关闭')}
            </button>
          </div>
        ) : pending.length === 0 && suggestions.length > 0 ? (
          <div className="text-center py-8 space-y-2">
            <CheckCircle2 className="h-8 w-8 text-green-500 mx-auto" />
            <p className="text-sm font-medium">{tr('All suggestions reviewed!', '所有建議已審核！', '所有建议已审核！')}</p>
            <button onClick={onClose} className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm">
              {tr('Close', '關閉', '关闭')}
            </button>
          </div>
        ) : suggestions.length > 0 ? (
          <>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {tr('AI found these matches. Review each suggestion. Click a row to preview both documents.', 'AI 找到了這些匹配。請逐一審核建議。點擊行可預覽兩份文件。', 'AI 找到了这些匹配。请逐一审核建议。点击行可预览两份文件。')}
              </span>
              <button
                onClick={acceptAll}
                disabled={processing !== null || isStreaming}
                className="px-3 py-1.5 bg-green-600 text-white rounded text-xs font-medium hover:bg-green-700 disabled:opacity-50"
              >
                {tr('Accept All', '全部接受', '全部接受')} ({pending.length})
              </button>
            </div>
            <div className="space-y-2 overflow-y-auto flex-1">
              {pending.map(m => {
                const key = getKey(m);
                const open = previewMatch && getKey(previewMatch) === key;
                return (
                  <div
                    key={key}
                    className={`border rounded-lg transition-colors ${processing === key ? 'opacity-50' : ''} ${open ? 'ring-2 ring-blue-400 bg-blue-50/30' : 'hover:bg-muted/50'}`}
                  >
                    <div
                      onClick={() => setPreviewMatch(open ? null : m)}
                      className="p-3 flex items-center gap-4 cursor-pointer"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                            m.confidence === 'high' ? 'bg-green-100 text-green-700' :
                            m.confidence === 'medium' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
                          }`}>{m.confidence?.toUpperCase() || 'LOW'}</span>
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">AI</span>
                          {(m.invoice_ids?.length ?? 0) >= 2 ? (
                            <>
                              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">COMBINED</span>
                              <span className="text-sm font-medium truncate">{m.invoice_ids?.join(' + ')}</span>
                            </>
                          ) : (
                            <span className="text-sm font-medium truncate">{m.invoice_number || m.invoice_id}</span>
                          )}
                          {m.amount && <span className="font-mono text-xs text-muted-foreground">HKD {m.amount.toLocaleString()}</span>}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">{m.reason}</p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                        <button onClick={() => setPreviewMatch(open ? null : m)}
                          className="px-2 py-1 text-xs text-primary hover:bg-blue-50 rounded">
                          {tr('Preview', '預覽', '预览')}
                        </button>
                        <button onClick={() => handleConfirm(m)}
                          disabled={processing === key}
                          className="px-3 py-1.5 bg-green-600 text-white rounded text-xs font-medium hover:bg-green-700 disabled:opacity-50">
                          ✓ {tr('Confirm', '確認', '确认')}
                        </button>
                        <button onClick={() => handleReject(m)}
                          disabled={processing === key}
                          className="px-3 py-1.5 border border-red-300 text-red-600 rounded text-xs hover:bg-red-50 disabled:opacity-50">
                          ✗ {tr('Reject', '拒絕', '拒绝')}
                        </button>
                      </div>
                    </div>

                    <div className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                      <div className="overflow-hidden min-h-0">
                        <div className="border-t px-3 pt-3 pb-1">
                          <div className="flex gap-3 h-80">
                            {m.stmt_file_id && (
                              <div className="flex-1 min-w-[220px] flex flex-col">
                                <span className="text-[10px] text-muted-foreground mb-1">{tr('Bank Statement', '銀行月結單', '银行月结单')}</span>
                                <iframe src={`${WORKER_API_BASE}/file-storage/${m.stmt_file_id}/download?inline=1&token=${token}${iframeClientParam()}`}
                                  className="w-full flex-1 border rounded" title="Bank Statement" />
                              </div>
                            )}
                            <div className="flex-1 min-w-[220px] flex flex-col">
                              <span className="text-[10px] text-muted-foreground mb-1">{tr('Invoice', '發票', '发票')}</span>
                              {m.invoice_file_id ? (
                                <iframe src={`${WORKER_API_BASE}/file-storage/${m.invoice_file_id}/download?inline=1&token=${token}${iframeClientParam()}`}
                                  className="w-full flex-1 border rounded" title="Invoice" />
                              ) : (
                                <div className="w-full flex-1 border rounded bg-muted/30 flex items-center justify-center text-xs text-muted-foreground">
                                  {tr('No invoice file', '沒有發票文件', '没有发票文件')}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
