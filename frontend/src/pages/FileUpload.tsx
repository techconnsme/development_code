import React, { useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, WORKER_API_BASE } from '../lib/api';
import { useToast } from '../components/Toast';
import { Upload, FileText, Image, File, Loader2, AlertCircle, CheckCircle2, AlertTriangle, ArrowRight } from 'lucide-react';
import { tr } from '../lib/i18nHelpers';
import { writeTokenUsage, clearTokenUsage } from '../components/TokenPopup';

// ── Channel types ─────────────────────────────────────────────────────────

type UploadChannel = 'bank_statement' | 'card_statement' | 'bank_invoice' | 'cash_invoice' | 'petty_cash' | 'others';

interface ChannelDef {
  key: UploadChannel;
  label: string;
  labelZh: string;
  labelCn: string;
  folder: string;
  category: string;
}

const CHANNELS: ChannelDef[] = [
  { key: 'bank_statement', label: 'Bank Statement', labelZh: '銀行月結單', labelCn: '银行月结单', folder: 'Bank Statements', category: 'bank_statement' },
  { key: 'card_statement', label: 'Card Statement', labelZh: '信用卡月結單', labelCn: '信用卡月结单', folder: 'Card Statements', category: 'card_statement' },
  { key: 'bank_invoice', label: 'Bank-TXN Invoice', labelZh: '銀行交易發票', labelCn: '银行交易发票', folder: 'Invoices', category: 'bank_invoice' },
  { key: 'cash_invoice', label: 'Cash Invoice', labelZh: '現金發票', labelCn: '现金发票', folder: 'Invoices', category: 'cash_invoice' },
  { key: 'petty_cash', label: 'Petty Cash', labelZh: '零用金', labelCn: '零用金', folder: 'Petty Cash', category: 'petty_cash' },
  { key: 'others', label: 'Others', labelZh: '其他', labelCn: '其他', folder: 'Others', category: 'general' },
];

function channelLabel(ch: ChannelDef): string {
  return tr(ch.label, ch.labelZh, ch.labelCn);
}

function reviewPageFlags(result: any): string {
  const params = new URLSearchParams();
  if (result?.needs_direction_review) params.set('review_direction', '1');
  if (result?.company_not_detected) params.set('company_not_detected', '1');
  if (result?.is_duplicate) params.set('is_duplicate', '1');
  if (result?.direction) params.set('direction', result.direction);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

// ── Mismatch dialog ────────────────────────────────────────────────────────

interface MismatchInfo {
  channel: ChannelDef;
  detectedType: string;
  inferredValues: Record<string, string>;
  fileId: string;
  result: any;
  fileName: string;
}

function MismatchDialog({ info, onForce, onSwitch, onClose }: {
  info: MismatchInfo;
  onForce: () => void;
  onSwitch: () => void;
  onClose: () => void;
}) {
  const detectedChannel = CHANNELS.find(c => c.key === info.detectedType);
  const detectedLabel = detectedChannel ? channelLabel(detectedChannel) : info.detectedType;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-card border rounded-xl shadow-xl max-w-lg w-full mx-4 p-6 space-y-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-6 w-6 text-amber-500 shrink-0 mt-0.5" />
          <div>
            <h3 className="text-lg font-bold">
              {tr('Document Type Mismatch', '文件類型不符', '文件类型不符')}
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              {tr(
                `This file was uploaded as "${channelLabel(info.channel)}" but OCR detected it as "${detectedLabel}".`,
                `此文件上傳為「${channelLabel(info.channel)}」，但 OCR 檢測為「${detectedLabel}」。`,
                `此文件上传为「${channelLabel(info.channel)}」，但 OCR 检测为「${detectedLabel}」。`,
              )}
            </p>
          </div>
        </div>

        {/* Inferred values table */}
        {Object.keys(info.inferredValues).length > 0 && (
          <div className="bg-muted/30 rounded-lg p-3 space-y-1">
            <p className="text-xs font-semibold text-muted-foreground mb-2">
              {tr('OCR Inferred Values:', 'OCR 推斷值：', 'OCR 推断值：')}
            </p>
            <table className="w-full text-xs">
              <tbody>
                {Object.entries(info.inferredValues).map(([key, value]) => (
                  <tr key={key} className="border-b border-border/30 last:border-b-0">
                    <td className="py-1 pr-3 font-medium text-muted-foreground capitalize">{key}</td>
                    <td className="py-1">{value || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex gap-2 justify-end pt-2">
          <button onClick={onClose} className="px-3 py-2 border rounded-lg text-sm hover:bg-muted">
            {tr('Cancel', '取消', '取消')}
          </button>
          <button onClick={onForce} className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700 flex items-center gap-1.5">
            {tr(`Force as ${channelLabel(info.channel)}`, `強制作為${channelLabel(info.channel)}`, `强制作为${channelLabel(info.channel)}`)}
          </button>
          <button onClick={onSwitch} className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 flex items-center gap-1.5">
            {detectedChannel
              ? tr(`Switch to ${channelLabel(detectedChannel)}`, `切換至${channelLabel(detectedChannel)}`, `切换至${channelLabel(detectedChannel)}`)
              : tr('Switch channel', '切換頻道', '切换频道')}
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────────────────

export default function FileUpload() {
  useTranslation(); // subscribe to language changes so tr() updates
  const nav = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [dragOver, setDragOver] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [description, setDescription] = useState('');
  const [uploading, setUploading] = useState(false);
  const [processingMsg, setProcessingMsg] = useState<string | null>(null);
  const batchRef = useRef({ total: 0, done: 0, bank: 0, invoice: 0, card: 0 });
  const [batchProgress, setBatchProgress] = useState({ done: 0, total: 0, currentFile: '' });
  const [tokenCardDismissed, setTokenCardDismissed] = useState(false);
  const [fileErrors, setFileErrors] = useState<Record<number, string>>({});
  const [fileStatuses, setFileStatuses] = useState<Record<number, 'pending' | 'processing' | 'success' | 'error'>>({});

  // Channel selection
  const [channel, setChannel] = useState<UploadChannel>('bank_statement');
  const channelDef = CHANNELS.find(c => c.key === channel)!;

  // Mismatch dialog state
  const [mismatch, setMismatch] = useState<MismatchInfo | null>(null);
  const mismatchResolveRef = useRef<((action: 'force' | 'switch' | 'cancel') => void) | null>(null);

  function pushToQueue(docType: string, reviewId: string, filename: string, flags: string) {
    const stored = sessionStorage.getItem('reviewQueue');
    let queue: { docType: string; reviewId: string; filename: string; flags: string }[] = [];
    try { if (stored) queue = JSON.parse(stored); } catch {}
    queue.push({ docType, reviewId, filename, flags });
    sessionStorage.setItem('reviewQueue', JSON.stringify(queue));
    sessionStorage.setItem('reviewQueueTotal', String(batchRef.current.total));
    batchRef.current.done++;
    if (docType === 'bank_statement') batchRef.current.bank++;
    else if (docType === 'invoice') batchRef.current.invoice++;
    else if (docType === 'card_statement') batchRef.current.card++;
    setBatchProgress({ done: batchRef.current.done, total: batchRef.current.total, currentFile: filename });
  }

  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); setDragOver(true); }, []);
  const handleDragLeave = useCallback(() => setDragOver(false), []);
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    if (e.dataTransfer.files.length > 0) { setFiles(Array.from(e.dataTransfer.files)); setFileErrors({}); setFileStatuses({}); }
  }, []);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) { setFiles(Array.from(e.target.files)); setFileErrors({}); setFileStatuses({}); }
  }, []);

  // Extract inferred values from OCR result for display
  function extractInferredValues(result: any): Record<string, string> {
    const vals: Record<string, string> = {};
    if (result?.amount != null) vals['Amount'] = typeof result.amount === 'number' ? result.amount.toLocaleString('en-HK', { minimumFractionDigits: 2 }) : String(result.amount);
    if (result?.statement_date || result?.invoice_date) vals['Date'] = result.statement_date || result.invoice_date || '';
    if (result?.bank_name || result?.counterparty_name || result?.supplier_name) vals['Counterparty'] = result.bank_name || result.counterparty_name || result.supplier_name || '';
    if (result?.account_number || result?.invoice_number) vals['Reference'] = result.account_number || result.invoice_number || '';
    if (result?.currency) vals['Currency'] = result.currency;
    return vals;
  }

  // Show mismatch dialog and wait for user decision
  function showMismatchDialog(info: MismatchInfo): Promise<'force' | 'switch' | 'cancel'> {
    return new Promise((resolve) => {
      mismatchResolveRef.current = resolve;
      setMismatch(info);
    });
  }

  const uploadFile = async (file: File, skipNavigation = false, fileIndex = 0, totalFiles = 0): Promise<string> => {
    const token = localStorage.getItem('token');
    const activeClient = localStorage.getItem('activeClient');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    };
    if (activeClient) {
      try { const c = JSON.parse(activeClient); if (c?.id) headers['X-Active-Client'] = c.id; } catch {}
    }

    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });

    // Step 1: Upload to file-storage with channel's folder
    const uploadBody = {
      filename: file.name,
      original_name: file.name,
      file_type: file.type,
      file_size: file.size,
      file_data: base64,
      folder: channelDef.folder,
      description: description,
    };

    const uploadData = await api('/file-storage/upload', {
      method: 'POST', body: uploadBody, baseUrl: WORKER_API_BASE,
    }) as any;
    const fileId = uploadData?.id;
    if (!fileId) throw new Error('Upload succeeded but no file ID');

    // Step 2: Run OCR + document type detection
    const batchLabel = totalFiles > 1
      ? tr(`Processing file ${fileIndex} of ${totalFiles}…`, `正在處理第 ${fileIndex}/${totalFiles} 個文件…`, `正在处理第 ${fileIndex}/${totalFiles} 个文件…`)
      : tr('Running OCR and AI analysis… (20-40 sec)', 'OCR 及 AI 分析中… (20-40秒)', 'OCR 及 AI 分析中… (20-40秒)');
    setProcessingMsg(batchLabel);
    const importResp = await fetch(
      `${WORKER_API_BASE}/file-storage/${fileId}/import-document`,
      { method: 'POST', headers }
    );
    const result = await importResp.json().catch(() => ({}));
    if (result?.ocr_text) console.log('[OCR-RAW-TEXT]', result.ocr_text);
    if (result?.deepseek_raw) console.log('[DEEPSEEK-OUTPUT]', JSON.parse(result.deepseek_raw));
    if (result?.usage?.total_tokens || result?.glm_usage?.total_tokens) {
      const dsTotal = result.usage?.total_tokens || 0;
      const glmTotal = result.glm_usage?.total_tokens || 0;
      writeTokenUsage({
        prompt: (result.usage?.prompt_tokens || 0) + (result.glm_usage?.prompt_tokens || 0),
        completion: (result.usage?.completion_tokens || 0) + (result.glm_usage?.completion_tokens || 0),
        total: dsTotal + glmTotal,
      });
    }
    setProcessingMsg(null);

    // Duplicate handling
    if (importResp.status === 409) {
      if (result?.type === 'card_statement' && result?.statement_id) {
        toast.warning(tr('Duplicate card statement. Opening existing.', '重複的信用卡月結單。開啟現有。', '重复的信用卡月结单。开启现有。'));
        if (skipNavigation) { pushToQueue('card_statement', result.statement_id, file.name, ''); return 'duplicate'; }
        nav(`/card-statements/review/${result.statement_id}`);
        return 'duplicate';
      }
      if (result?.type === 'bank_statement' && result?.statement_id) {
        toast.warning(tr('Duplicate bank statement. Opening existing.', '重複的銀行月結單。開啟現有。', '重复的银行月结单。开启现有。'));
        if (skipNavigation) { pushToQueue('bank_statement', result.statement_id, file.name, ''); return 'duplicate'; }
        nav(`/bank-statements/review/${result.statement_id}`);
        return 'duplicate';
      }
      toast.warning(result?.error || tr('Duplicate file.', '重複文件。', '重复文件。'));
      return 'duplicate';
    }

    // Encrypted PDF — show password prompt
    if (result?.status === 'password_required' || result?.type === 'encrypted_pdf') {
      toast.info(tr(
        'This PDF is encrypted. Go to File Storage and click "🔒 Encrypted" to unlock with your password.',
        '此 PDF 已加密。請前往 File Storage 並點擊「🔒 已加密」以輸入密碼解鎖。',
        '此 PDF 已加密。请前往 File Storage 并点击「🔒 已加密」以输入密码解锁。'
      ));
      return 'encrypted';
    }

    // Hard errors
    if (result?.error) throw new Error(result.error);
    if (result?.ocr_failed) {
      throw new Error(tr(
        'Could not read this document. The file may be blurry, scanned at low resolution, or in an unsupported format.',
        '無法讀取此文件。文件可能模糊、掃描分辨率低或格式不支援。',
        '无法读取此文件。文件可能模糊、扫描分辨率低或格式不支援。',
      ));
    }

    const detectedType = result?.type;

    // Check for OCR mismatch with user-selected channel
    if (detectedType && detectedType !== channel) {
      // Compatible: invoice channels accept invoice detection without warning
      const isInvoiceChannel = channel === 'bank_invoice' || channel === 'cash_invoice';
      const isInvoiceDetected = detectedType === 'invoice';
      if (!(isInvoiceChannel && isInvoiceDetected)) {
        const action = await showMismatchDialog({
          channel: channelDef,
          detectedType,
          inferredValues: extractInferredValues(result),
          fileId,
          result,
          fileName: file.name,
        });
        if (action === 'switch') {
          // Accept detected type: redirect to the correct review page
          if (detectedType === 'bank_statement' && result?.statement_id) {
            if (skipNavigation) { pushToQueue('bank_statement', result.statement_id, file.name, ''); return 'review'; }
            nav(`/bank-statements/review/${result.statement_id}`);
            return 'review';
          }
          if (detectedType === 'card_statement' && result?.statement_id) {
            if (skipNavigation) { pushToQueue('card_statement', result.statement_id, file.name, ''); return 'review'; }
            nav(`/card-statements/review/${result.statement_id}`);
            return 'review';
          }
          if (detectedType === 'invoice' && result?.invoice_id) {
            const flags = reviewPageFlags(result);
            if (skipNavigation) { pushToQueue('invoice', result.invoice_id, file.name, flags); return 'review'; }
            nav(`/invoices/review/${result.invoice_id}${flags}`);
            return 'review';
          }
          throw new Error(tr('Switched channel but could not find review link.', '已切換頻道但無法找到審核連結。', '已切换频道但无法找到审核连结。'));
        }
        if (action === 'cancel') {
          throw new Error(tr('Upload cancelled.', '已取消上傳。', '已取消上传。'));
        }
        // 'force' — re-import with user's chosen type, overriding OCR detection
        if (action === 'force') {
          setProcessingMsg(tr(`Re-importing as ${channelLabel(channelDef)}…`, `重新匯入為${channelLabel(channelDef)}…`, `重新汇入为${channelLabel(channelDef)}…`));
          const forceResp = await fetch(
            `${WORKER_API_BASE}/file-storage/${fileId}/import-document?force=true&type=${encodeURIComponent(channel)}`,
            { method: 'POST', headers }
          );
          const forceResult = await forceResp.json().catch(() => ({}));
          if (forceResult?.error && forceResp.status !== 201) {
            throw new Error(forceResult.error || tr('Re-import failed.', '重新匯入失敗。', '重新汇入失败。'));
          }
          // Use the forced result going forward
          Object.assign(result, forceResult);
          setProcessingMsg(null);
        }
      }
    }

    const needsReview = !!(result?.needs_direction_review || result?.company_not_detected || result?.needs_review);

    // Route based on user-selected CHANNEL (not OCR type)
    if (channel === 'card_statement' && result?.statement_id) {
      if (needsReview) {
        if (skipNavigation) { pushToQueue('card_statement', result.statement_id, file.name, ''); return 'review'; }
        nav(`/card-statements/review/${result.statement_id}`);
        return 'review';  // prevent handleUpload from doing a default redirect over us
      }
      return 'ok';
    } else if (channel === 'bank_statement' && result?.statement_id) {
      if (needsReview) {
        if (skipNavigation) { pushToQueue('bank_statement', result.statement_id, file.name, ''); return 'review'; }
        nav(`/bank-statements/review/${result.statement_id}`);
        return 'review';  // prevent handleUpload from doing a default redirect over us
      }
      return 'ok';
    } else if ((channel === 'bank_invoice' || channel === 'cash_invoice') && result?.invoice_id) {
      const flags = reviewPageFlags(result);
      if (needsReview) {
        if (skipNavigation) { pushToQueue('invoice', result.invoice_id, file.name, flags); return 'review'; }
        nav(`/invoices/review/${result.invoice_id}${flags}`);
        return 'review';  // prevent handleUpload from doing a default redirect over us
      }
      return 'ok';
    } else if (channel === 'petty_cash') {
      // Auto-create journal entry: debit Petty Cash Expenses (67001), credit Cash on Hand (11101)
      const pettyAmount = result?.amount || result?.total_amount || result?.total || 0;
      if (pettyAmount > 0) {
        try {
          const today = new Date().toISOString().split('T')[0];
          const entryDate = result?.statement_date || result?.invoice_date || result?.date || today;
          const desc = result?.description || result?.supplier_name || result?.counterparty_name || file.name;
          await api('/bookkeeping/entries', {
            method: 'POST',
            body: {
              entry_number: `PC-${Date.now().toString(36).toUpperCase()}`,
              entry_date: entryDate,
              description: `Petty Cash: ${desc}`,
              reference_type: 'petty_cash',
              reference_id: fileId,
              lines: [
                { account_code: '67001', account_name: 'Petty Cash Expenses', debit: pettyAmount, credit: 0, description: desc },
                { account_code: '11101', account_name: 'Cash on Hand', debit: 0, credit: pettyAmount, description: desc },
              ],
            },
          });
          toast.success(tr(
            `Petty Cash expense created: ${pettyAmount.toLocaleString('en-HK', { minimumFractionDigits: 2 })}`,
            `零用金支出已建立：${pettyAmount.toLocaleString('en-HK', { minimumFractionDigits: 2 })}`,
            `零用金支出已建立：${pettyAmount.toLocaleString('en-HK', { minimumFractionDigits: 2 })}`,
          ));
        } catch (e: any) {
          console.error('Failed to create petty cash entry:', e);
          toast.warning(tr(
            'File saved but could not auto-create expense entry. Please create manually.',
            '文件已儲存但無法自動建立支出分錄。請手動建立。',
            '文件已储存但无法自动建立支出分录。请手动建立。',
          ));
        }
      }
      return 'ok';
    } else if (channel === 'others') {
      // Just save to file storage, no special routing
      return 'ok';
    } else if (!detectedType) {
      throw new Error(tr(
        'Could not determine document type. Please check the file and try again.',
        '無法識別文件類型。請檢查文件後重試。',
        '无法识别文件类型。请检查文件后重试。',
      ));
    }
    return 'ok';
  };

  const handleUpload = async () => {
    if (files.length === 0) return;
    setUploading(true);
    setFileErrors({});
    setFileStatuses({});
    const isBatch = files.length > 1;

    if (isBatch) {
      batchRef.current = { total: files.length, done: 0, bank: 0, invoice: 0, card: 0 };
      setBatchProgress({ done: 0, total: files.length, currentFile: '' });
      clearTokenUsage();
      setTokenCardDismissed(false);
      sessionStorage.removeItem('reviewQueue');
      sessionStorage.removeItem('reviewQueueTotal');
    }

    let ok = 0;
    let reviewCount = 0;
    let hasError = false;
    let idx = 0;
    for (const file of files) {
      idx++;
      const fileIdx = idx - 1;
      setFileStatuses(prev => ({ ...prev, [fileIdx]: 'processing' }));
      try {
        setBatchProgress(prev => ({ ...prev, currentFile: file.name }));
        const status = await uploadFile(file, isBatch, idx, files.length);
        if (status === 'review') reviewCount++;
        ok++;
        setFileStatuses(prev => ({ ...prev, [fileIdx]: 'success' }));
      } catch (e: any) {
        hasError = true;
        setFileStatuses(prev => ({ ...prev, [fileIdx]: 'error' }));
        setFileErrors(prev => ({ ...prev, [fileIdx]: e.message || 'Unknown error' }));
        if (isBatch) { batchRef.current.done++; setBatchProgress(prev => ({ ...prev, done: batchRef.current.done })); }
        break;
      }
    }

    setUploading(false);

    if (hasError) return;

    setFiles([]);
    setDescription('');

    const storedTokens = (() => { try { const r = sessionStorage.getItem('aiTokenUsage'); return r ? JSON.parse(r) : null; } catch { return null; } })();

    if (ok > 0) {
      queryClient.invalidateQueries({ queryKey: ['file-storage'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['bookkeeping'] });

      if (batchRef.current.bank > 0 || batchRef.current.card > 0) {
        try { await api('/bookkeeping/auto-generate-entries', { method: 'POST' }); } catch {}
      }

      // Route based on channel after upload
      if (reviewCount > 0) {
        const raw = sessionStorage.getItem('reviewQueue');
        try {
          const queue = raw ? JSON.parse(raw) : [];
          if (queue.length > 0) {
            const first = queue[0];
            const reviewUrl = first.docType === 'bank_statement' ? `/bank-statements/review/${first.reviewId}`
              : first.docType === 'card_statement' ? `/card-statements/review/${first.reviewId}`
              : `/invoices/review/${first.reviewId}${first.flags || ''}`;
            toast.success(tr(
              `${reviewCount} file(s) need review. ${ok - reviewCount} auto-saved.`,
              `${reviewCount} 個文件需要審核。${ok - reviewCount} 個已自動儲存。`,
              `${reviewCount} 个文件需要审核。${ok - reviewCount} 个已自动储存。`,
            ));
            setTimeout(() => nav(reviewUrl), 800);
            return;
          }
        } catch {}
        sessionStorage.removeItem('reviewQueue');
        sessionStorage.removeItem('reviewQueueTotal');
        // Single-file review: navigation already happened inside uploadFile
        return;
      } else {
        sessionStorage.removeItem('reviewQueue');
        sessionStorage.removeItem('reviewQueueTotal');
      }

      // Default redirect based on channel
      const defaultRoute = channel === 'bank_statement' ? '/bank-statements'
        : channel === 'card_statement' ? '/card-statements'
        : channel === 'petty_cash' ? '/expense-receipts'
        : channel === 'others' ? '/file-storage'
        : '/invoices';

      toast.success(tr(
        `Successfully processed and saved ${ok} file(s)${storedTokens?.total > 0 ? ` · Tokens: ~${storedTokens.total.toLocaleString()}` : ''}.`,
        `已成功處理並儲存 ${ok} 個文件${storedTokens?.total > 0 ? ` · Tokens: ~${storedTokens.total.toLocaleString()}` : ''}。`,
        `已成功处理并储存 ${ok} 个文件${storedTokens?.total > 0 ? ` · Tokens: ~${storedTokens.total.toLocaleString()}` : ''}。`,
      ));
      setTimeout(() => nav(defaultRoute), 800);
    }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <h2 className="text-2xl font-bold flex items-center gap-2">
        <Upload className="h-6 w-6" /> {tr('File Upload', '上傳文件', '上传文件')}
      </h2>

      {/* ── Channel tabs ── */}
      <div className="flex gap-1 border-b overflow-x-auto">
        {CHANNELS.map(ch => (
          <button
            key={ch.key}
            onClick={() => { setChannel(ch.key); setFiles([]); setFileErrors({}); setFileStatuses({}); }}
            className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
              channel === ch.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
            }`}
          >
            {channelLabel(ch)}
          </button>
        ))}
      </div>

      {/* ── Current channel indicator ── */}
      <div className="text-xs text-muted-foreground flex items-center gap-1">
        <span>{tr('Uploading to', '上傳至', '上传至')}</span>
        <span className="font-medium text-foreground">{channelDef.folder}</span>
        {channel === 'petty_cash' && (
          <span className="ml-2 text-amber-600 dark:text-amber-400">
            {tr('(will auto-create expense under Petty Cash)', '（將自動建立零用金支出）', '（将自动建立零用金支出）')}
          </span>
        )}
      </div>

      <div onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}
        className={`bg-card border-2 border-dashed rounded-xl p-8 transition-colors ${dragOver ? 'border-primary bg-primary/5' : 'border-border'}`}>
        <div className="flex flex-col items-center gap-4">
          <div className={`rounded-full p-4 transition-colors ${dragOver ? 'bg-primary/10' : 'bg-muted'}`}>
            <Upload className={`h-8 w-8 ${dragOver ? 'text-primary' : 'text-muted-foreground'}`} />
          </div>
          <div className="text-center">
            <p className="font-medium">{dragOver ? tr('Drop files here', '放開以上傳', '放開以上传') : tr('Drag & drop files here, or click to browse', '拖放文件至此，或點擊瀏覽', '拖放文件至此，或点击浏览')}</p>
            <p className="text-sm text-muted-foreground mt-1">{tr('Supports PDF, PNG, JPG. OCR auto-detects bank statements, card statements & invoices.', '支援 PDF、PNG、JPG。OCR 自動檢測銀行月結單、信用卡月結單及發票。', '支援 PDF、PNG、JPG。OCR 自动检测银行月结单、信用卡月结单及发票。')}</p>
          </div>
          <label className="cursor-pointer bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:opacity-90">
            {uploading ? tr('Uploading...', '上傳中...', '上传中...') : tr('Select Files', '選擇文件', '选择文件')}
            <input type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={handleFileInput} className="hidden" multiple />
          </label>
        </div>
        {files.length > 0 && (
          <>
            <div className="mt-4 pt-4 border-t">
              <p className="text-sm font-medium mb-2">{files.length} {tr('file(s) selected', '個文件已選擇', '个文件已选择')}</p>
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {files.map((f, i) => {
                  const status = fileStatuses[i];
                  const errorMsg = fileErrors[i];
                  const isError = status === 'error';
                  const isSuccess = status === 'success';
                  const isProcessing = status === 'processing';

                  return (
                    <div key={i} className="flex flex-col gap-1">
                      <div className={`flex items-center gap-2 text-sm ${isError ? 'text-red-600 dark:text-red-400 font-medium' : isSuccess ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'}`}>
                        {isError ? (
                          <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />
                        ) : isSuccess ? (
                          <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                        ) : isProcessing ? (
                          <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
                        ) : f.type.includes('pdf') ? (
                          <FileText className="h-4 w-4 text-red-500 shrink-0" />
                        ) : f.type.includes('image') ? (
                          <Image className="h-4 w-4 text-blue-500 shrink-0" />
                        ) : (
                          <File className="h-4 w-4 text-gray-500 shrink-0" />
                        )}
                        <span className="truncate">{f.name}</span>
                        <span className="text-xs shrink-0">({(f.size / 1024).toFixed(1)} KB)</span>
                        {isError && (
                          <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 text-xs font-bold shrink-0">!</span>
                        )}
                      </div>
                      {isError && errorMsg && (
                        <div className="ml-6 px-3 py-2 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-md text-xs text-red-700 dark:text-red-300">
                          {errorMsg}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3 mt-4 pt-4 border-t">
              <div className="flex-1 min-w-[200px]">
                <label className="text-xs text-muted-foreground">{tr('Description', '描述', '描述')}</label>
                <input value={description} onChange={e => setDescription(e.target.value)} placeholder={tr('Optional description', '可選描述', '可选描述')}
                  className="px-3 py-2 border rounded-md bg-background text-sm w-full focus:outline-none focus:ring-2 focus:ring-ring" />
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => { setFiles([]); setDescription(''); setFileErrors({}); setFileStatuses({}); }}
                className="px-4 py-2 border rounded-md text-sm hover:bg-muted">{tr('Clear', '清除', '清除')}</button>
              <button onClick={handleUpload} disabled={uploading}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2">
                {uploading && <Loader2 className="h-4 w-4 animate-spin" />}
                {tr('Upload & Analyze', '上傳並分析', '上传并分析')}
              </button>
            </div>
          </>
        )}
      </div>

      {processingMsg && (
        <div className="bg-primary/10 border border-primary/30 rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-primary shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium">{processingMsg}</p>
              {batchProgress.total > 1 && batchProgress.currentFile && (
                <p className="text-xs text-muted-foreground truncate">{batchProgress.currentFile}</p>
              )}
              <p className="text-xs text-muted-foreground">{tr('DeepSeek AI is extracting transactions…', 'DeepSeek AI 正在提取交易記錄…', 'DeepSeek AI 正在提取交易记录…')}</p>
            </div>
          </div>
          {batchProgress.total > 1 && (
            <div className="space-y-1">
              <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                <div
                  className="bg-primary h-2 rounded-full transition-all duration-500"
                  style={{ width: `${batchProgress.total > 0 ? (batchProgress.done / batchProgress.total) * 100 : 0}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground text-right">
                {batchProgress.done} / {batchProgress.total}
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── OCR mismatch dialog ── */}
      {mismatch && (
        <MismatchDialog
          info={mismatch}
          onForce={() => { const resolve = mismatchResolveRef.current; setMismatch(null); resolve?.('force'); }}
          onSwitch={() => { const resolve = mismatchResolveRef.current; setMismatch(null); resolve?.('switch'); }}
          onClose={() => { const resolve = mismatchResolveRef.current; setMismatch(null); resolve?.('cancel'); }}
        />
      )}
    </div>
  );
}
