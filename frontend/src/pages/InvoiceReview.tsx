import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, WORKER_API_BASE } from '../lib/api';
import { useToast } from '../components/Toast';
import { Save, Trash2, Plus, X, ChevronLeft } from 'lucide-react';
import { tr } from '../lib/i18nHelpers';

// ─── Money Input (same pattern as BankStatementReview) ───────────────────────
function MoneyInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [raw, setRaw] = useState(value === 0 ? '' : String(value));
  useEffect(() => { if (document.activeElement?.tagName !== 'INPUT') setRaw(value === 0 ? '' : String(value)); }, [value]);
  return (
    <input
      type="text" inputMode="decimal" value={raw}
      onChange={(e) => { setRaw(e.target.value); const n = parseFloat(e.target.value.replace(/,/g, '')); if (!isNaN(n)) onChange(n); }}
      onBlur={() => setRaw(value === 0 ? '' : value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}
      onFocus={() => setRaw(value === 0 ? '' : String(value))}
      className="w-full px-2 py-1 border rounded text-sm text-right font-mono bg-background"
      placeholder="0.00"
    />
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function InvoiceReview() {
  const { i18n } = useTranslation();
  const toast = useToast();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();

  // Check for flags from import-invoice
  const searchParams = new URLSearchParams(location.search);
  const needsDirectionReview = searchParams.get('review_direction') === '1';
  const companyNotDetected = searchParams.get('company_not_detected') === '1';
  const isDuplicate = searchParams.get('is_duplicate') === '1';
  const dupStatus = searchParams.get('dup_status') || '';
  const autoLinkedId = searchParams.get('auto_linked') || '';
  const suggestedDirection = searchParams.get('direction') || '';

  // ── Review queue indicator ──
  let queueRemaining = 0, queueTotal = 0;
  try {
    const q = JSON.parse(sessionStorage.getItem('reviewQueue') || '[]');
    queueRemaining = q.length;
    queueTotal = parseInt(sessionStorage.getItem('reviewQueueTotal') || '0');
  } catch {}

  // PDF state
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);

  // Editable form state
  const [form, setForm] = useState<any>(null);
  const [items, setItems] = useState<any[]>([]);
  const [saved, setSaved] = useState(false);
  // Reset ALL local state when navigating to a different review (React Router reuses component)
  useEffect(() => {
    setSaved(false);
    setForm(null);
    setItems([]);
    setPdfUrl(null);
    setPdfError(null);
  }, [id]);

  // ── Load invoice data ──
  const { data: invoiceData, isLoading, isError } = useQuery({
    queryKey: ['invoice-review', id],
    queryFn: () => api(`/invoices/${id}/review`),
    enabled: !!id,
  });

  // Sync form + items from invoiceData whenever it changes.
  // Uses a ref to avoid the useEffect race condition — the form is populated
  // as soon as invoiceData arrives, before the next paint, so the Save button
  // works on the first click.
  const lastDataId = useRef<string | null>(null);
  if (invoiceData && invoiceData.id !== lastDataId.current) {
    lastDataId.current = invoiceData.id;
    if (form === null) {
      setForm({
        invoice_number: invoiceData.receipt_number || invoiceData.invoice_number || '',
        vendor_name: invoiceData.vendor_name || '',
        customer_id: invoiceData.customer_id || '',
        supplier_id: invoiceData.supplier_id || '',
        direction: invoiceData.direction || 'outgoing',
        issue_date: invoiceData.issue_date || '',
        due_date: invoiceData.due_date || '',
        currency: invoiceData.currency || 'HKD',
        tax_rate: invoiceData.tax_rate || 0,
        discount_amount: invoiceData.discount_amount || 0,
        notes: invoiceData.notes || '',
      });
      setItems((invoiceData.items || []).map((it: any) => ({
        id: it.id,
        description: it.description || '',
        quantity: it.quantity ?? 1,
        unit_price: it.unit_price ?? 0,
        amount: it.amount ?? 0,
      })));
    }
  }

  // ── Load original PDF via authenticated fetch ──
  // Determine if file is previewable (PDF or image)
  const fileName = invoiceData?.file_original_name || invoiceData?.filename || '';
  const fileExt = fileName.split('.').pop()?.toLowerCase() || '';
  const isPreviewable = ['pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(fileExt);

  useEffect(() => {
    if (!invoiceData?.file_id || !isPreviewable) return;
    let cancelled = false;
    let revokeUrl: string | null = null;
    (async () => {
      try {
        const token = localStorage.getItem('token') || '';
        const activeClientJson = localStorage.getItem('activeClient');
        const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
        try { const c = JSON.parse(activeClientJson || '{}'); if (c?.id) headers['X-Active-Client'] = c.id; } catch {}
        const resp = await fetch(`${WORKER_API_BASE}/file-storage/${invoiceData.file_id}/download`, { headers });
        if (!resp.ok) { if (!cancelled) setPdfError(`Could not load PDF (HTTP ${resp.status})`); return; }
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        revokeUrl = url;
        if (!cancelled) setPdfUrl(url);
      } catch (e: any) {
        if (!cancelled) setPdfError(e?.message || 'Failed to load PDF');
      }
    })();
    return () => { cancelled = true; if (revokeUrl) URL.revokeObjectURL(revokeUrl); };
  }, [invoiceData?.file_id, isPreviewable]);

  // ── Review queue: after save/discard, load next queued item ──
  // The queue always has the CURRENT item at position 0 (FileUpload pushes
  // all files including the one we're viewing). So we shift the current one,
  // then peek at the NEW first item — that's the NEXT review to navigate to.
  function goNextInQueue(): { url: string } | null {
    const raw = sessionStorage.getItem('reviewQueue');
    if (!raw) return null;
    try {
      const queue: {docType:string, reviewId:string, filename:string, flags:string}[] = JSON.parse(raw);
      // Remove the CURRENT item (position 0)
      if (queue.length > 0) {
        const current = queue.shift()!;
      }
      // If there's a NEXT item, navigate to it
      if (queue.length > 0) {
        const next = queue[0];
        sessionStorage.setItem('reviewQueue', JSON.stringify(queue));
        const url = next.docType === 'bank_statement' ? `/bank-statements/review/${next.reviewId}`
          : next.docType === 'card_statement' ? `/card-statements/review/${next.reviewId}`
          : `/invoices/review/${next.reviewId}${next.flags}`;
        return { url };
      }
      // Queue empty — clean up
      sessionStorage.removeItem('reviewQueue');
      sessionStorage.removeItem('reviewQueueTotal');
    } catch {}
    return null;
  }

  // ── Mutations ──
  const confirmMut = useMutation({
    mutationFn: (body: any) => {
      return api(`/invoices/${id}/confirm`, { method: 'POST', body });
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoices-receipts'] });
      const next = goNextInQueue();
      if (next) {
        setSaved(false);
        navigate(next.url);
      } else {
        const dest = isReceipt ? '/expense-receipts' : '/invoices';
        window.location.href = dest;
      }
    },
    onError: (err: any) => {
      toast.info(`Save failed: ${err?.message || 'Unknown error'}`);
      setSaved(false);
    },
  });

  const discardMut = useMutation({
    mutationFn: () => {
      return api(`/invoices/${id}`, { method: 'DELETE' });
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['file-storage'] });
      const next = goNextInQueue();
      if (next) {
        navigate(next.url);
      } else {
        window.location.href = '/file-storage';
      }
    },
    onError: (err: any) => {
      toast.info(`Discard failed: ${err?.message || 'Unknown error'}`);
    },
  });

  // ── Item helpers ──
  function updateItem(idx: number, field: string, value: any) {
    const next = [...items];
    next[idx] = { ...next[idx], [field]: value };
    if (field === 'quantity' || field === 'unit_price') {
      next[idx].amount = (next[idx].quantity || 0) * (next[idx].unit_price || 0);
    }
    if (field === 'amount') {
      // manual override of amount
    }
    setItems(next);
  }

  function addItem() {
    setItems([...items, { description: '', quantity: 1, unit_price: 0, amount: 0 }]);
  }

  function removeItem(idx: number) {
    setItems(items.filter((_, i) => i !== idx));
  }

  const subtotal = items.reduce((s, it) => s + (it.amount || 0), 0);
  const taxAmount = subtotal * ((form?.tax_rate || 0) / 100);
  const total = subtotal + taxAmount - (form?.discount_amount || 0);

  function handleSave() {
    confirmMut.mutate({ ...form, items, tax_rate: form.tax_rate || 0, discount_amount: form.discount_amount || 0 });
  }

  function handleDiscard() {
    if (!window.confirm('Discard this invoice? The file will remain in File Storage but the extracted data will be deleted.')) return;
    discardMut.mutate();
  }

  // Detect if this is a receipt (has receipt_number set, or invoice_number starts with REC-)
  const isReceipt = !!(invoiceData?.receipt_number || invoiceData?.invoice_number?.startsWith('REC-'));
  // Use form.direction so user can toggle; fall back to invoiceData.direction
  const isIncomingInvoice = !isReceipt && (form?.direction || invoiceData?.direction) === 'incoming';

  // For incoming invoices, also fetch suppliers for the link dropdown
  // NOTE: This hook MUST be before any conditional return (React Rules of Hooks)
  const { data: suppliersData } = useQuery({
    queryKey: ['suppliers-list'],
    queryFn: () => api('/suppliers?limit=200'),
    enabled: isIncomingInvoice,
  });
  const suppliers: any[] = (suppliersData?.data || []) as any[];

  // Auto-link supplier by matching vendor_name
  // NOTE: Must be before any conditional return (React Rules of Hooks)
  useEffect(() => {
    if (!isIncomingInvoice || !form || !suppliers.length || form.supplier_id) return;
    const vendorName = (form.vendor_name || '').toLowerCase().replace(/\b(limited|ltd|inc|co\.?|company|corp)\b/g, '').replace(/[^a-z0-9]/g, '').trim();
    if (!vendorName) return;
    const match = suppliers.find((s: any) => {
      const n = (s.name || '').toLowerCase().replace(/\b(limited|ltd|inc|co\.?|company|corp)\b/g, '').replace(/[^a-z0-9]/g, '').trim();
      return n === vendorName || n.includes(vendorName) || vendorName.includes(n);
    });
    if (match) setForm((prev: any) => prev ? { ...prev, supplier_id: match.id } : prev);
  }, [suppliers, form?.vendor_name, isIncomingInvoice]);

  // ── Render ──
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center space-y-3">
          <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full mx-auto" />
          <p className="text-sm text-muted-foreground">{tr('Loading invoice data…', '載入發票資料中…', '载入发票资料中…')}</p>
        </div>
      </div>
    );
  }
  if (isError || !form) {
    return (
      <div className="p-6 text-center">
        <p className="text-red-600">{tr('Invoice not found or failed to load.', '找不到發票或載入失敗。', '找不到发票或载入失败。')}</p>
        <button onClick={() => { sessionStorage.removeItem('reviewQueue'); sessionStorage.removeItem('reviewQueueTotal'); navigate(isReceipt ? '/expense-receipts' : '/invoices'); }}
          className="text-primary underline mt-2">← {tr('Back', '返回', '返回')}</button>
      </div>
    );
  }

  const docLabel = isReceipt
    ? (tr('Receipt', 'Receipt 收據', 'Receipt 收据'))
    : (tr('Invoice', 'Invoice 發票', 'Invoice 发票'));
  const customers: any[] = invoiceData?.customers || [];

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]" key={id}>
      {/* ── Top bar ── */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-card flex-shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="p-1 hover:bg-muted rounded text-muted-foreground">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div>
            <h2 className="font-semibold text-sm">{tr(`Review ${docLabel}`, `審核 ${docLabel}`, `审核 ${docLabel}`)}</h2>
            <p className="text-xs text-muted-foreground">
              {tr('Check the extracted data against the original PDF, edit if needed, then Save.', '對照原始 PDF 核查提取的數據，如需要可編輯，然後儲存。', '對照原始 PDF 核查提取的數據，如需要可編輯，然後储存。')}
            </p>
          </div>
        </div>
        {queueTotal > 0 && (
          <div className="text-xs bg-muted px-3 py-1 rounded-full font-medium text-muted-foreground">
            📋 {queueTotal - queueRemaining}/{queueTotal} {tr('reviewed', '已審核', '已审核')}
            {queueRemaining > 0 && <span className="ml-1">— {queueRemaining} {tr('remaining', '剩餘', '剩余')}</span>}
          </div>
        )}
      </div>

      {/* ── Direction review banner ── */}
      {needsDirectionReview && !isReceipt && (
        <div className="mx-4 mt-2 p-3 rounded-lg border-2 border-amber-300 bg-amber-50 dark:bg-amber-950/30 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-2xl">⚠️</span>
            <div>
              <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">
                {tr(
                  'AI OCR could not determine if this invoice was issued by you or received from a supplier.',
                  'AI OCR 無法確定此發票是由你公司開出還是從供應商接收。',
                  'AI OCR 无法确定此发票是由你公司开出还是从供应商接收。'
                )}
              </p>
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
                {tr(
                  'Please confirm the direction below. Default: AP (received from supplier).',
                  '請在下方確認類型。預設：AP 應付（從供應商接收）。',
                  '请在下方确认类型。预设：AP 应付（从供应商接收）。'
                )}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Company not detected banner ── */}
      {companyNotDetected && !isReceipt && (
        <div className="mx-4 mt-2 p-3 rounded-lg border-2 border-blue-300 bg-blue-50 dark:bg-blue-950/30 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-2xl">ℹ️</span>
            <div>
              <p className="text-sm font-semibold text-blue-800 dark:text-blue-200">
                {tr(
                  'AI OCR did not detect your company name in this invoice.',
                  'AI OCR 在此發票中未檢測到你公司名稱。',
                  'AI OCR 在此发票中未检测到你公司名称。'
                )}
              </p>
              <p className="text-xs text-blue-600 dark:text-blue-400 mt-0.5">
                {tr(
                  'This invoice appears to be between two third parties. Please verify who sent and received it before saving.',
                  '此發票似乎涉及兩個第三方。請在儲存前確認發送方和接收方。',
                  '此发票似乎涉及两个第三方。请在储存前确认发送方和接收方。'
                )}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Duplicate banner ── */}
      {isDuplicate && (
        <div className="mx-4 mt-2 p-3 rounded-lg border-2 border-orange-300 bg-orange-50 dark:bg-orange-950/30 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🔁</span>
            <div>
              <p className="text-sm font-semibold text-orange-800 dark:text-orange-200">
                {dupStatus === 'deleted'
                  ? tr('This document was previously imported and later deleted.', '此文件曾導入後被刪除。', '此文件曾导入后被删除。')
                  : tr('This document has already been imported.', '此文件已導入。', '此文件已导入。')}
              </p>
              <p className="text-xs text-orange-600 dark:text-orange-400 mt-0.5">
                {dupStatus === 'deleted'
                  ? tr('The previous record was soft-deleted. Saving will create a new record — journal entries will not be duplicated.', '舊記錄已軟刪除。儲存將建立新記錄 — 不會重複記帳。', '旧记录已软删除。储存将建立新记录 — 不会重复记帐。')
                  : tr('A duplicate was detected. Please verify and edit if needed before saving.', '檢測到重複。請在儲存前確認並編輯。', '检测到重复。请在储存前确认并编辑。')}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Auto-linked banner (receipt matched to invoice) ── */}
      {autoLinkedId && (
        <div className="mx-4 mt-2 p-3 rounded-lg border-2 border-green-300 bg-green-50 dark:bg-green-950/30 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🔗</span>
            <div>
              <p className="text-sm font-semibold text-green-800 dark:text-green-200">
                {tr(
                  'This receipt has been automatically linked to an invoice.',
                  '此收據已自動連結到一張發票。',
                  '此收据已自动连结到一张发票。'
                )}
              </p>
              <p className="text-xs text-green-600 dark:text-green-400 mt-0.5">
                {tr(
                  'The matching AR invoice has been marked as paid.',
                  '相符的 AR 發票已標記為已收款。',
                  '相符的 AR 发票已标记为已收款。'
                )}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Split pane ── */}
      <div className="flex flex-1 min-h-0 gap-0">
        {/* Left: original PDF */}
        <div className="w-[50%] border-r flex flex-col bg-gray-100">
          <div className="px-3 py-1.5 text-xs text-muted-foreground bg-card border-b flex-shrink-0">
            {tr('Original Document', '原始文件 Original Document', '原始文件 Original Document')}
            {invoiceData?.file_original_name && (
              <span className="ml-2 font-medium text-foreground">{invoiceData.file_original_name}</span>
            )}
          </div>
          <div className="flex-1 min-h-0">
            {pdfError ? (
              <div className="flex items-center justify-center h-full text-sm text-destructive p-4 text-center">
                {pdfError}
                <br />
                <span className="text-muted-foreground text-xs mt-1">You can still review the extracted data on the right.</span>
              </div>
            ) : !isPreviewable ? (
              <div className="flex items-center justify-center h-full p-6">
                <div className="text-center space-y-3">
                  <div className="text-4xl">📄</div>
                  <p className="text-sm font-medium">{fileName}</p>
                  <p className="text-xs text-muted-foreground">
                    {tr(
                      'Preview is not available for this file type. You can review and edit the extracted data on the right.',
                      '此檔案類型無法預覽。請在右側審閱並編輯提取的資料。',
                      '此文件类型无法预览。请在右侧审阅并编辑提取的资料。'
                    )}
                  </p>
                </div>
              </div>
            ) : !pdfUrl ? (
              <div className="flex items-center justify-center h-full">
                <div className="animate-spin h-6 w-6 border-4 border-primary border-t-transparent rounded-full" />
              </div>
            ) : (
              <iframe src={pdfUrl} className="w-full h-full border-0" title="Invoice PDF" />
            )}
          </div>
        </div>

        {/* Right: editable extracted data */}
        <div className="w-[50%] overflow-y-auto">
          <div className="p-5 space-y-5">

            {/* ── Header fields ── */}
            <div className="bg-card border rounded-xl p-4 space-y-3">
              <h3 className="font-semibold text-sm border-b pb-2">
                {tr(`${docLabel} Details`, `${docLabel} ${isReceipt ? '收據資料' : '發票資料'}`, `${docLabel} ${isReceipt ? '收据资料' : '发票资料'}`)}
              </h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground block mb-0.5">
                    {isReceipt
                      ? (tr('Receipt Number', 'Receipt Number 收據號碼', 'Receipt Number 收据號碼'))
                      : (tr('Invoice Number', 'Invoice Number 發票號碼', 'Invoice Number 发票號碼'))}
                  </label>
                  <input value={form.invoice_number} onChange={(e) => setForm({ ...form, invoice_number: e.target.value })}
                    className="w-full px-2 py-1.5 border rounded text-sm bg-background font-mono" placeholder="e.g. INV-2025-001" />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-0.5">{tr('Currency', 'Currency 貨幣', 'Currency 货币')}</label>
                  <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}
                    className="w-full px-2 py-1.5 border rounded text-sm bg-background">
                    <option value="HKD">HKD</option>
                    <option value="USD">USD</option>
                    <option value="CNY">CNY</option>
                    <option value="EUR">EUR</option>
                    <option value="GBP">GBP</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-0.5">{tr('Issue Date', 'Issue Date 開票日期', 'Issue Date 开票日期')}</label>
                  <input type="date" value={form.issue_date} onChange={(e) => setForm({ ...form, issue_date: e.target.value })}
                    className="w-full px-2 py-1.5 border rounded text-sm bg-background" />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-0.5">{tr('Due Date', 'Due Date 到期日', 'Due Date 到期日')}</label>
                  <input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })}
                    className="w-full px-2 py-1.5 border rounded text-sm bg-background" />
                </div>
              </div>
              {!isReceipt && (
                <div className="pt-1">
                  <label className="text-xs text-muted-foreground block mb-1">{tr('Direction', 'Direction 類型', 'Direction 类型')}</label>
                  <div className="flex gap-1 bg-muted/50 rounded-lg p-1 w-fit">
                    <button
                      type="button"
                      onClick={() => setForm({ ...form, direction: 'outgoing' })}
                      className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                        (form?.direction || invoiceData?.direction) === 'outgoing'
                          ? 'bg-blue-100 text-blue-700 shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {tr('AR — We issued', 'AR 應收 — We issued', 'AR 应收 — We issued')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setForm({ ...form, direction: 'incoming' })}
                      className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                        (form?.direction || invoiceData?.direction) === 'incoming'
                          ? 'bg-orange-100 text-orange-700 shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {tr('AP — Billed us', 'AP 應付 — Billed us', 'AP 应付 — Billed us')}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* ── Customer / Vendor ── */}
            <div className="bg-card border rounded-xl p-4 space-y-3">
              <h3 className="font-semibold text-sm border-b pb-2">
                {isIncomingInvoice
                  ? (tr('Supplier — who billed us', '供應商 Supplier — who billed us', '供应商 Supplier — who billed us'))
                  : (tr('Customer — who we billed', '客戶 Customer — who we billed', '客户 Customer — who we billed'))}
              </h3>
              {isIncomingInvoice && (
                <div>
                  <label className="text-xs text-muted-foreground block mb-0.5">
                    {tr('Supplier Name', 'Supplier Name 供應商名稱', 'Supplier Name 供应商名称')}
                  </label>
                  <input value={form.vendor_name} onChange={(e) => setForm({ ...form, vendor_name: e.target.value })}
                    className="w-full px-2 py-1.5 border rounded text-sm bg-background" placeholder="e.g. Muse Labs Engineering Limited" />
                </div>
              )}
              <div>
                <label className="text-xs text-muted-foreground block mb-0.5">
                  {isIncomingInvoice
                    ? (tr('Link to Supplier Record', 'Link to Supplier Record 關聯供應商', 'Link to Supplier Record 关联供应商'))
                    : (tr('Link to Customer Record', 'Link to Customer Record 關聯客戶', 'Link to Customer Record 关联客户'))}
                  {' '}<span className="text-muted-foreground">({tr('optional', '可選', '可选')})</span>
                </label>
                {isIncomingInvoice ? (
                  <select value={form.supplier_id || ''} onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}
                    className="w-full px-2 py-1.5 border rounded text-sm bg-background">
                    <option value="">{tr('— Select supplier —', '— 選擇供應商 —', '— 选择供应商 —')}</option>
                    {suppliers.map((s: any) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                ) : (
                  <select value={form.customer_id} onChange={(e) => setForm({ ...form, customer_id: e.target.value })}
                    className="w-full px-2 py-1.5 border rounded text-sm bg-background">
                    <option value="">{tr('— Select customer —', '— 選擇客戶 —', '— 选择客户 —')}</option>
                    {customers.map((c: any) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                )}
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {tr("If the vendor is a new contact, leave blank — they'll be created automatically.", '如果供應商是新聯絡人，請留空 — 系統將自動建立。', '如果供应商是新联络人，请留空 — 系统将自动建立。')}
                </p>
              </div>
            </div>

            {/* ── Line Items ── */}
            <div className="bg-card border rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between border-b pb-2">
                <h3 className="font-semibold text-sm">{tr('Line Items', 'Line Items 明細', 'Line Items 明细')}</h3>
                <button onClick={addItem}
                  className="flex items-center gap-1 text-xs text-primary hover:underline">
                  <Plus className="h-3 w-3" /> {tr('Add Row', '新增列', '新增列')}
                </button>
              </div>

              {/* Column headers */}
              <div className="grid grid-cols-12 gap-2 text-xs text-muted-foreground px-1">
                <span className="col-span-5">{tr('Description', 'Description 描述', 'Description 描述')}</span>
                <span className="col-span-2 text-center">{tr('Qty', 'Qty 數量', 'Qty 数量')}</span>
                <span className="col-span-2 text-right">{tr('Unit Price', 'Unit Price 單價', 'Unit Price 单价')}</span>
                <span className="col-span-2 text-right">{tr('Amount', 'Amount 金額', 'Amount 金额')}</span>
                <span className="col-span-1" />
              </div>

              <div className="space-y-2">
                {items.map((item, idx) => (
                  <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                    <input
                      value={item.description}
                      onChange={(e) => updateItem(idx, 'description', e.target.value)}
                      placeholder="Item description"
                      className="col-span-5 px-2 py-1 border rounded text-sm bg-background"
                    />
                    <input
                      type="number" min="0" step="1"
                      value={item.quantity}
                      onChange={(e) => updateItem(idx, 'quantity', parseFloat(e.target.value) || 0)}
                      className="col-span-2 px-2 py-1 border rounded text-sm text-center bg-background"
                    />
                    <div className="col-span-2">
                      <MoneyInput value={item.unit_price} onChange={(v) => updateItem(idx, 'unit_price', v)} />
                    </div>
                    <div className="col-span-2">
                      <MoneyInput value={item.amount} onChange={(v) => updateItem(idx, 'amount', v)} />
                    </div>
                    <button onClick={() => removeItem(idx)}
                      className="col-span-1 flex justify-center text-muted-foreground hover:text-destructive">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>

              {items.length === 0 && (
                <div className="text-center py-4 text-sm text-muted-foreground border border-dashed rounded-lg">
                  {tr('No line items — click "Add Row" to add one manually', '沒有明細項目 — 點擊「新增列」手動添加', '沒有明细项目 — 点击「新增列」手动添加')}
                </div>
              )}

              {/* Totals */}
              <div className="border-t pt-3 space-y-1.5 text-sm">
                <div className="flex justify-between text-muted-foreground">
                  <span>{tr('Subtotal', '小計', '小计')}</span>
                  <span className="font-mono">{form.currency} {subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between items-center text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <span>{tr('Tax Rate', '稅率', '税率')}</span>
                    <input type="number" min="0" max="100" step="0.5"
                      value={form.tax_rate}
                      onChange={(e) => setForm({ ...form, tax_rate: parseFloat(e.target.value) || 0 })}
                      className="w-16 px-1.5 py-0.5 border rounded text-xs text-center bg-background" />
                    <span>%</span>
                  </div>
                  <span className="font-mono">{form.currency} {taxAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                </div>
                {form.discount_amount > 0 && (
                  <div className="flex justify-between text-muted-foreground">
                    <span>{tr('Discount', '折扣', '折扣')}</span>
                    <span className="font-mono text-red-500">- {form.currency} {(form.discount_amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                  </div>
                )}
                <div className="flex justify-between font-bold border-t pt-1.5">
                  <span>{tr('Total', 'Total 合計', 'Total 合计')}</span>
                  <span className="font-mono text-base">{form.currency} {total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                </div>
              </div>
            </div>

            {/* ── Notes ── */}
            <div className="bg-card border rounded-xl p-4 space-y-2">
              <h3 className="font-semibold text-sm">{tr('Notes', 'Notes 備註', 'Notes 备注')}</h3>
              <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}
                rows={3} placeholder={tr('Payment terms, reference numbers, etc.', '付款條款、參考編號等', '付款条款、参考编号等')}
                className="w-full px-2 py-1.5 border rounded text-sm bg-background resize-none" />
            </div>

            {/* ── Action buttons (bottom) ── */}
            <div className="flex gap-3 pb-6">
              <button onClick={handleDiscard} disabled={discardMut.isPending}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 border rounded-md text-sm text-destructive hover:bg-destructive/10">
                <Trash2 className="h-4 w-4" /> {tr('Discard', 'Discard 放棄', 'Discard 放弃')}
              </button>
              <button onClick={handleSave} disabled={confirmMut.isPending || saved}
                className="flex-2 flex-1 flex items-center justify-center gap-2 py-2.5 bg-primary text-primary-foreground rounded-md text-sm hover:opacity-90 disabled:opacity-60">
                <Save className="h-4 w-4" />
                {saved
                  ? (tr('✓ Saved', '已儲存 ✓', '已储存 ✓'))
                  : confirmMut.isPending
                    ? (tr('Saving…', '儲存中…', '储存中…'))
                    : (tr(`Save ${docLabel}`, `儲存${docLabel}`, `储存${docLabel}`))}
              </button>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
