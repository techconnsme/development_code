import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, WORKER_API_BASE } from '../lib/api';
import { tr } from '../lib/i18nHelpers';
import { Trash2, Download, Search, Pencil, Eye, Plus, AlertTriangle, Info, Copy, Link, Link2Off } from 'lucide-react';

async function downloadReceiptPDF(receiptId: string, receiptNumber: string) {
  const token = localStorage.getItem('token') || '';
  const activeClientJson = localStorage.getItem('activeClient');
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  try { const c = JSON.parse(activeClientJson || '{}'); if (c?.id) headers['X-Active-Client'] = c.id; } catch {}
  try {
    const res = await fetch(`${WORKER_API_BASE}/pdf/invoice/${receiptId}`, { headers });
    if (!res.ok) { alert('PDF generation failed — please try again.'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Receipt_${receiptNumber}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch { alert('Could not download PDF. Please check your connection.'); }
}

export default function ExpenseReceipts() {
  const { i18n } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [linkFilter, setLinkFilter] = useState<'all' | 'linked' | 'unlinked'>('all');
  const [showForm, setShowForm] = useState(false);
  const [viewId, setViewId] = useState<string | null>(null);
  const [form, setForm] = useState({ receipt_number: '', payer_name: '', amount: 0, issue_date: new Date().toISOString().split('T')[0], currency: 'HKD', payment_method: '', notes: '', linked_invoice_id: '' });

  const { data: receiptsData, isLoading } = useQuery({
    queryKey: ['invoices-receipts', search, statusFilter],
    queryFn: () => api(`/invoices?doc_type=receipt&limit=200${statusFilter ? `&status=${statusFilter}` : ''}${search ? `&q=${search}` : ''}`),
  });

  // Manual link targets: ANY unpaid non-receipt invoice (AR or AP) — the old
  // outgoing+sent-only filter left AP receipts unlinkable (2026-08-26 fix).
  const { data: invoiceData } = useQuery({
    queryKey: ['invoices-for-linking'],
    queryFn: () => api('/invoices?limit=200'),
  });

  const { data: receiptDetail } = useQuery({
    queryKey: ['receipt', viewId],
    queryFn: () => api(`/invoices/${viewId}`),
    enabled: !!viewId,
  });

  const createMut = useMutation({
    mutationFn: (body: any) => api('/invoices', { method: 'POST', body }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['invoices-receipts'] }); setShowForm(false); },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api(`/invoices/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invoices-receipts'] }),
  });

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api(`/invoices/${id}/status`, { method: 'PATCH', body: { status } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invoices-receipts'] }),
  });

  const linkMut = useMutation({
    mutationFn: ({ receiptId, invoiceId }: { receiptId: string; invoiceId: string }) =>
      api(`/invoices/${receiptId}`, { method: 'PUT', body: { linked_invoice_id: invoiceId } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invoices-receipts'] }),
  });

  const allReceipts = (receiptsData as any)?.data || [];
  const receipts = linkFilter === 'all' ? allReceipts
    : linkFilter === 'linked' ? allReceipts.filter((r: any) => r.linked_invoice_id)
    : allReceipts.filter((r: any) => !r.linked_invoice_id);
  const arInvoices = ((invoiceData as any)?.data || []).filter((inv: any) =>
    !inv.receipt_number && !inv.linked_invoice_id && !['paid', 'cancelled'].includes(inv.status));

  const statusLabel = (s: string) => {
    const labels: Record<string, string> = {
      draft: tr('Draft', '草稿', '草稿'), sent: tr('Sent', '已發出', '已发出'),
      paid: tr('Confirmed', '已確認', '已确认'), overdue: tr('Overdue', '逾期', '逾期'), cancelled: tr('Cancelled', '已取消', '已取消'),
    };
    return labels[s] || s;
  };
  const statusBadge = (s: string) => {
    const colors: Record<string, string> = {
      draft: 'bg-gray-100 text-gray-700', paid: 'bg-green-100 text-green-700',
      overdue: 'bg-red-100 text-red-700', cancelled: 'bg-gray-100 text-gray-500',
    };
    return `px-2 py-0.5 rounded-full text-xs font-medium ${colors[s] || 'bg-gray-100 text-gray-600'}`;
  };

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    createMut.mutate({
      ...form,
      customer_id: form.linked_invoice_id ? undefined : (arInvoices[0]?.customer_id || ''),
      receipt_number: form.receipt_number || null,
      invoice_number: form.receipt_number || undefined,
      direction: 'incoming',
      status: 'draft',
      total: form.amount,
      subtotal: form.amount,
      items: [{ description: form.payer_name || 'Receipt item', quantity: 1, unit_price: form.amount, amount: form.amount }],
    });
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">{tr('Receipts', '收據 Receipts', '收据 Receipts')}</h2>
          <p className="text-muted-foreground text-sm mt-1">{tr('Manage payment receipts', '管理付款收據', '管理付款收据')}</p>
        </div>
        <button onClick={() => setShowForm(true)}
          className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:opacity-90">
          <Plus className="h-4 w-4" /> {tr('Create Receipt', '建立收據', '建立收据')}
        </button>
      </div>

      {/* Link filter tabs */}
      <div className="flex gap-1 bg-muted/50 rounded-lg p-1 w-fit">
        {([
          { key: 'all', label: tr('All Receipts', '全部收據', '全部收据') },
          { key: 'linked', label: tr('Linked to Invoice', '已連結發票', '已连结发票') },
          { key: 'unlinked', label: tr('Unlinked', '未連結', '未连结') },
        ] as const).map(t => (
          <button key={t.key} onClick={() => setLinkFilter(t.key)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              linkFilter === t.key ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}>
            {t.label}
            <span className="ml-1.5 text-xs text-muted-foreground">
              ({t.key === 'all' ? allReceipts.length : t.key === 'linked' ? allReceipts.filter((r: any) => r.linked_invoice_id).length : allReceipts.filter((r: any) => !r.linked_invoice_id).length})
            </span>
          </button>
        ))}
      </div>

      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder={tr('Search receipts...', '搜尋收據...', '搜索收据...')} className="w-full pl-10 pr-4 py-2 border rounded-md bg-background text-sm" />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 border rounded-md bg-background text-sm">
          <option value="">{tr('All Status', '全部狀態', '全部状态')}</option>
          <option value="draft">{tr('Draft', '草稿', '草稿')}</option>
          <option value="paid">{tr('Confirmed', '已確認', '已确认')}</option>
        </select>
      </div>

      {isLoading ? <div className="text-center py-12 text-muted-foreground">{tr('Loading...', '載入中...', '载入中...')}</div> :
       receipts.length === 0 ? <div className="text-center py-12 text-muted-foreground">
        <p className="text-sm">{tr('No receipt records', '未有收據記錄', '未有收据记录')}</p>
        <p className="text-xs mt-2">{tr('Upload receipt PDFs through File Storage, or create one manually.', '通過 File Storage 上傳收據 PDF，或手動建立。', '通过 File Storage 上传收据 PDF，或手动建立。')}</p>
      </div> : (
        <div className="bg-card border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left p-3">{tr('Receipt No.', '收據號碼', '收据号码')}</th>
                <th className="text-left p-3 hidden md:table-cell">{tr('Payer / Supplier', '付款方 / 供應商', '付款方 / 供应商')}</th>
                <th className="text-left p-3 w-20">{tr('Link', '連結', '连结')}</th>
                <th className="text-left p-3">{tr('Status', '狀態', '状态')}</th>
                <th className="text-right p-3 hidden lg:table-cell">{tr('Amount', '金額', '金额')}</th>
                <th className="text-left p-3 hidden lg:table-cell">{tr('Date', '日期', '日期')}</th>
                <th className="text-right p-3">{tr('Actions', '操作', '操作')}</th>
              </tr>
            </thead>
            <tbody>
              {receipts.map((rec: any) => (
                <tr key={rec.id} className="border-b hover:bg-muted/30">
                  <td className="p-3 font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      {rec.receipt_number || rec.invoice_number?.replace(/^REC-\w+$/, '') || rec.invoice_number}
                      {rec.needs_review?.includes('direction') && <span title={tr('AI OCR unclear on direction', 'AI OCR 方向不明', 'AI OCR 方向不明')}><AlertTriangle className="h-3.5 w-3.5 text-amber-500" /></span>}
                      {rec.needs_review?.includes('company_not_detected') && <span title={tr('Your company not detected in this receipt', '未檢測到你公司', '未检测到你公司')}><Info className="h-3.5 w-3.5 text-blue-500" /></span>}
                      {rec.needs_review?.includes('duplicate') && <span title={tr('Duplicate receipt number', '重複收據號碼', '重复收据号码')}><Copy className="h-3.5 w-3.5 text-orange-500" /></span>}
                      {rec.status !== 'paid' && !rec.linked_invoice_id && <span title={tr('Unlinked — no invoice matched yet', '未連結 — 尚未配對發票', '未连结 — 尚未配对发票')}><Link2Off className="h-3.5 w-3.5 text-red-400" /></span>}
                      {rec.counterparty_ref && <span className="text-[10px] text-muted-foreground ml-1">({tr('Their ref:', '對方編號:', '对方编号:')} {rec.counterparty_ref})</span>}
                    </span>
                  </td>
                  <td className="p-3 hidden md:table-cell">{rec.vendor_name || rec.customer_name || '-'}</td>
                  <td className="p-3">
                    {rec.linked_invoice_id ? (
                      <span className="inline-flex items-center gap-1 text-xs text-green-600"><Link className="h-3 w-3" /> {tr('Yes', '是', '是')}</span>
                    ) : <span className="text-xs text-muted-foreground">—</span>}
                  </td>
                  <td className="p-3"><span className={statusBadge(rec.status)}>{statusLabel(rec.status)}</span></td>
                  <td className="p-3 text-right hidden lg:table-cell font-mono">{rec.currency || 'HKD'} {Number(rec.total || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                  <td className="p-3 hidden lg:table-cell text-muted-foreground">{rec.issue_date}</td>
                  <td className="p-3 text-right">
                    <button onClick={() => setViewId(rec.id)} className="p-1 hover:bg-muted rounded mr-1" title={tr('View', '查看', '查看')}><Eye className="h-4 w-4" /></button>
                    <button onClick={() => navigate(`/invoices/review/${rec.id}`)} className="p-1 hover:bg-muted rounded mr-1" title={tr('Edit', '編輯', '编辑')}><Pencil className="h-4 w-4" /></button>
                    <button onClick={() => downloadReceiptPDF(rec.id, rec.receipt_number || rec.invoice_number)} className="p-1 hover:bg-muted rounded mr-1" title={tr('Download PDF', '下載 PDF', '下载 PDF')}><Download className="h-4 w-4" /></button>
                    {rec.status === 'draft' && (
                      <button onClick={() => updateStatus.mutate({ id: rec.id, status: 'paid' })} className="text-xs text-green-600 hover:underline mr-2">{tr('Confirm', '確認', '确认')}</button>
                    )}
                    <button onClick={() => { if (confirm(tr('Delete this receipt?', '確定刪除此收據?', '确定删除此收据?'))) deleteMut.mutate(rec.id); }} className="p-1 hover:bg-muted rounded text-destructive"><Trash2 className="h-4 w-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create Receipt Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowForm(false)}>
          <div className="bg-card border rounded-xl p-6 w-full max-w-lg mx-4 space-y-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-lg">{tr('Create Receipt', '建立收據', '建立收据')}</h3>
            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <input value={form.receipt_number} onChange={(e) => setForm({ ...form, receipt_number: e.target.value })}
                  placeholder={tr('Receipt No. (auto if blank)', '收據號碼（留空自動產生）', '收据号码（留空自动产生）')} className="px-3 py-2 border rounded-md bg-background text-sm" />
                <input required value={form.payer_name} onChange={(e) => setForm({ ...form, payer_name: e.target.value })}
                  placeholder={tr('Payer / Supplier *', '付款方 / 供應商 *', '付款方 / 供应商 *')} className="px-3 py-2 border rounded-md bg-background text-sm" />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <input type="number" required step="0.01" value={form.amount || ''} onChange={(e) => setForm({ ...form, amount: parseFloat(e.target.value) || 0 })}
                  placeholder={tr('Amount *', '金額 *', '金额 *')} className="px-3 py-2 border rounded-md bg-background text-sm" />
                <input type="date" value={form.issue_date} onChange={(e) => setForm({ ...form, issue_date: e.target.value })}
                  className="px-3 py-2 border rounded-md bg-background text-sm" />
                <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}
                  className="px-3 py-2 border rounded-md bg-background text-sm">
                  <option value="HKD">HKD</option><option value="USD">USD</option><option value="CNY">CNY</option>
                </select>
              </div>
              <input value={form.payment_method} onChange={(e) => setForm({ ...form, payment_method: e.target.value })}
                placeholder={tr('Payment method (optional)', '付款方式（可選）', '付款方式（可选）')} className="w-full px-3 py-2 border rounded-md bg-background text-sm" />
              <select value={form.linked_invoice_id} onChange={(e) => setForm({ ...form, linked_invoice_id: e.target.value })}
                className="w-full px-3 py-2 border rounded-md bg-background text-sm">
                <option value="">{tr('— Link to invoice (optional) —', '— 連結到發票（可選）—', '— 连结到发票（可选）—')}</option>
                {arInvoices.map((inv: any) => (
                  <option key={inv.id} value={inv.id}>{inv.invoice_number} — {inv.customer_name || inv.vendor_name} — {inv.currency} {inv.total?.toLocaleString()}</option>
                ))}
              </select>
              <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder={tr('Notes (optional)', '備註（可選）', '备注（可选）')} className="w-full px-3 py-2 border rounded-md bg-background text-sm" rows={2} />
              <div className="flex gap-3 justify-end">
                <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 border rounded-md text-sm">{tr('Cancel', '取消', '取消')}</button>
                <button type="submit" disabled={createMut.isPending} className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm">{tr('Create', '建立', '建立')}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* View Receipt Modal */}
      {viewId && receiptDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setViewId(null)}>
          <div className="bg-card border rounded-xl p-6 w-full max-w-lg mx-4 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h3 className="font-bold text-lg">{tr('Receipt', '收據', '收据')} {receiptDetail.receipt_number || receiptDetail.invoice_number}</h3>
              <button onClick={() => setViewId(null)} className="text-muted-foreground">✕</button>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><span className="text-muted-foreground">{tr('Payer', '付款方', '付款方')}:</span> {receiptDetail.vendor_name || receiptDetail.customer_name || '-'}</div>
              <div><span className="text-muted-foreground">{tr('Status', '狀態', '状态')}:</span> <span className={statusBadge(receiptDetail.status)}>{statusLabel(receiptDetail.status)}</span></div>
              <div><span className="text-muted-foreground">{tr('Amount', '金額', '金额')}:</span> {receiptDetail.currency} {Number(receiptDetail.total || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
              <div><span className="text-muted-foreground">{tr('Date', '日期', '日期')}:</span> {receiptDetail.issue_date}</div>
              {receiptDetail.counterparty_ref && <div className="col-span-2"><span className="text-muted-foreground">{tr('Their Ref', '對方編號', '对方编号')}:</span> {receiptDetail.counterparty_ref}</div>}
              {receiptDetail.linked_invoice_id && (
                <div className="col-span-2"><span className="text-muted-foreground">{tr('Linked Invoice', '已連結發票', '已连结发票')}:</span> <span className="text-green-600 font-medium">{receiptDetail.linked_invoice_id}</span></div>
              )}
            </div>
            {receiptDetail.notes && <div className="text-sm text-muted-foreground border-t pt-3">{receiptDetail.notes}</div>}
            <button onClick={() => downloadReceiptPDF(receiptDetail.id, receiptDetail.receipt_number || receiptDetail.invoice_number)}
              className="inline-flex items-center gap-2 text-sm text-primary hover:underline"><Download className="h-4 w-4" /> {tr('Download PDF', '下載 PDF', '下载 PDF')}</button>
          </div>
        </div>
      )}

      {/* Info tip */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-700">
        <b>{tr('Tip:', '提示：', '提示：')}</b> {tr('Upload receipt PDFs through File Storage — they appear here automatically. Or create one manually.', '通過 File Storage 上傳收據 PDF 即可自動出現在此。或手動建立。', '通过 File Storage 上传收据 PDF 即可自动出现在此。或手动建立。')}
      </div>
    </div>
  );
}
