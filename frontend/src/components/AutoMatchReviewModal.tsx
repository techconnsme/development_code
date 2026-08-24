import { useState } from 'react';
import { X, Sparkles, CheckCircle2 } from 'lucide-react';
import { WORKER_API_BASE, iframeClientParam } from '../lib/api';
import { tr } from '../lib/i18nHelpers';

// Unified match-review modal (2026-08-17) — the ONE review surface for the
// bank-transaction ↔ invoice matching engine, shared by Bank Statements,
// File Storage, AP, AR, and the dashboard.
//
// Suggestion rows are accordions: clicking a row slides down a side-by-side
// dual-PDF preview (bank statement left, invoice right) right below it.
// The iframes stay mounted while collapsed, so PDFs aren't re-downloaded
// on every toggle. Only one row can be expanded at a time.
export default function AutoMatchReviewModal({ matches, onConfirm, onReject, onClose }: {
  matches: any[];
  onConfirm: (txId: string, invoiceId: string | null, invoiceIds?: string[]) => void | Promise<void>;
  onReject: (txId: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [processing, setProcessing] = useState<string | null>(null);
  const [previewMatch, setPreviewMatch] = useState<any | null>(null);
  const token = localStorage.getItem('token') || '';

  const pending = matches.filter(m => !confirmed.has(m.transaction_id) && !rejected.has(m.transaction_id));

  const handleConfirm = async (m: any) => {
    setProcessing(m.transaction_id);
    try {
      await onConfirm(m.transaction_id, m.invoice_id ?? null, m.invoice_ids);
      setConfirmed(prev => new Set(prev).add(m.transaction_id));
    } catch { /* parent surfaces the error; keep the row pending */ }
    setProcessing(null);
  };

  const handleReject = async (txId: string) => {
    setProcessing(txId);
    try {
      await onReject(txId);
      setRejected(prev => new Set(prev).add(txId));
    } catch { /* keep the row pending */ }
    setProcessing(null);
  };

  const acceptAll = async () => {
    for (const m of pending) await handleConfirm(m);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-card border rounded-xl p-6 w-full max-w-[95vw] mx-4 space-y-4 max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-blue-600" />
            {tr('Auto-Match Suggestions', '自動配對建議', '自动配对建议')} ({confirmed.size + rejected.size}/{matches.length})
          </h3>
          <button onClick={onClose} className="p-1 hover:bg-muted rounded"><X className="h-4 w-4" /></button>
        </div>

        {pending.length === 0 ? (
          <div className="text-center py-8 space-y-2">
            <CheckCircle2 className="h-8 w-8 text-green-500 mx-auto" />
            <p className="text-sm font-medium">{tr('All suggestions reviewed!', '所有建議已審核！', '所有建议已审核！')}</p>
            <button onClick={onClose} className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm">
              {tr('Close', '關閉', '关闭')}
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {tr('Review each suggestion below. Click a row to preview both documents. Confirm to link, or reject to skip.', '請逐一審核以下建議。點擊行可預覽兩份文件。確認以連結，或拒絕以跳過。', '请逐一审核以下建议。点击行可预览两份文件。确认以连结，或拒绝以跳过。')}
              </span>
              <button
                onClick={acceptAll}
                disabled={processing !== null}
                className="px-3 py-1.5 bg-green-600 text-white rounded text-xs font-medium hover:bg-green-700 disabled:opacity-50"
              >
                {tr('Accept All', '全部接受', '全部接受')} ({pending.length})
              </button>
            </div>
            <div className="space-y-2 overflow-y-auto flex-1">
              {pending.map(m => {
                const open = previewMatch?.transaction_id === m.transaction_id;
                return (
                  <div
                    key={m.transaction_id}
                    className={`border rounded-lg transition-colors ${processing === m.transaction_id ? 'opacity-50' : ''} ${open ? 'ring-2 ring-blue-400 bg-blue-50/30' : 'hover:bg-muted/50'}`}
                  >
                    {/* Row — click toggles the PDF preview below */}
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
                          {(m.invoice_ids?.length ?? 0) >= 2 ? (
                            <>
                              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">COMBINED</span>
                              <span className="text-sm font-medium truncate">{m.invoices.map((i: any) => i.invoice_number).join(' + ')}</span>
                            </>
                          ) : (
                            <span className="text-sm font-medium truncate">{m.invoice_number}</span>
                          )}
                          <span className="font-mono text-xs text-muted-foreground">HKD {m.amount?.toLocaleString()}</span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">{m.reason}</p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                        <button onClick={() => setPreviewMatch(open ? null : m)}
                          className="px-2 py-1 text-xs text-primary hover:bg-blue-50 rounded">
                          {tr('Preview', '預覽', '预览')}
                        </button>
                        <button onClick={() => handleConfirm(m)}
                          disabled={processing === m.transaction_id}
                          className="px-3 py-1.5 bg-green-600 text-white rounded text-xs font-medium hover:bg-green-700 disabled:opacity-50">
                          ✓ {tr('Confirm', '確認', '确认')}
                        </button>
                        <button onClick={() => handleReject(m.transaction_id)}
                          disabled={processing === m.transaction_id}
                          className="px-3 py-1.5 border border-red-300 text-red-600 rounded text-xs hover:bg-red-50 disabled:opacity-50">
                          ✗ {tr('Reject', '拒絕', '拒绝')}
                        </button>
                      </div>
                    </div>

                    {/* Animated accordion preview — slides down under the row.
                        Always mounted (grid-rows clip) so iframes keep their PDFs loaded.
                        Bank statement PDF and invoice PDF side by side; a labeled
                        placeholder fills in when one side has no file. */}
                    <div className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                      <div className="overflow-hidden min-h-0">
                        <div className="border-t px-3 pt-3 pb-1">
                          <div className="flex gap-3 h-80">
                            <div className="flex-1 min-w-[220px] flex flex-col">
                              <span className="text-[10px] text-muted-foreground mb-1">{tr('Bank Statement', '銀行月結單', '银行月结单')}</span>
                              {m.stmt_file_id ? (
                                <iframe src={`${WORKER_API_BASE}/file-storage/${m.stmt_file_id}/download?inline=1&token=${token}${iframeClientParam()}`}
                                  className="w-full flex-1 border rounded" title="Bank Statement" />
                              ) : (
                                <div className="w-full flex-1 border rounded bg-muted/30 flex items-center justify-center text-xs text-muted-foreground">
                                  {tr('No statement file', '沒有月結單文件', '没有月结单文件')}
                                </div>
                              )}
                            </div>
                            {(m.invoice_ids?.length ?? 0) >= 2 ? (
                              <div className="flex-[2] flex gap-3 overflow-x-auto">
                                {m.invoices.map((inv: any) => (
                                  <div key={inv.invoice_number} className="flex-1 min-w-[240px] flex flex-col">
                                    <span className="text-[10px] text-muted-foreground mb-1 truncate">{tr('Invoice', '發票', '发票')} · {inv.invoice_number}</span>
                                    {inv.file_id ? (
                                      <iframe src={`${WORKER_API_BASE}/file-storage/${inv.file_id}/download?inline=1&token=${token}${iframeClientParam()}`}
                                        className="w-full flex-1 border rounded" title={inv.invoice_number} />
                                    ) : (
                                      <div className="w-full flex-1 border rounded bg-muted/30 flex items-center justify-center text-xs text-muted-foreground">
                                        {tr('No invoice file', '沒有發票文件', '没有发票文件')}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="flex-1 flex flex-col">
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
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
