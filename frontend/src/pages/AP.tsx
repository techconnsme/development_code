import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, WORKER_API_BASE, iframeClientParam } from '../lib/api';
import { Plus, Search, Eye, Trash2, Download, Pencil, AlertTriangle, Info, Copy, Link2, FileText, Zap } from 'lucide-react';
import AutoMatchReviewModal from '../components/AutoMatchReviewModal';
import { tr } from '../lib/i18nHelpers';
import { useDateFilter } from '../contexts/DateFilterContext';
import { useToast } from '../components/Toast';

// Authenticated PDF download: fetches with Bearer token, opens as blob URL
async function downloadInvoicePDF(invoiceId: string, invoiceNumber: string) {
  const token = localStorage.getItem('token') || '';
  const activeClientJson = localStorage.getItem('activeClient');
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  try {
    const clientObj = activeClientJson ? JSON.parse(activeClientJson) : null;
    if (clientObj?.id) headers['X-Active-Client'] = clientObj.id;
  } catch {}
  try {
    const res = await fetch(`${WORKER_API_BASE}/pdf/invoice/${invoiceId}`, { headers });
    if (!res.ok) { alert('PDF generation failed — please try again.'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Bill_${invoiceNumber}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch {
    alert('Could not download PDF. Please check your connection.');
  }
}

export default function AP() {
  const { i18n } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [showForm, setShowForm] = useState(false);
  const [viewId, setViewId] = useState<string | null>(null);
  const [receiptMatchResults, setReceiptMatchResults] = useState<any[] | null>(null);
  const [bankMatchResults, setBankMatchResults] = useState<any[] | null>(null);
  const { startDate, endDate } = useDateFilter();
  const [form, setForm] = useState({ invoice_number: '', supplier_id: '', issue_date: new Date().toISOString().split('T')[0], due_date: '', receipt_number: '', paid_date: '', currency: 'HKD', tax_rate: 0, discount_amount: 0, discount_type: 'flat' as string, discount_value: 0, notes: '', terms: '', attn: '', customer_phone: '', customer_email: '', customer_address: '', items: [{ description: '', quantity: 1, unit_price: 0, amount: 0 }] });
  const [productSearch, setProductSearch] = useState<Record<number, string>>({});
  const [productDropdown, setProductDropdown] = useState<number | null>(null);
  const [addProductForm, setAddProductForm] = useState({ name: '', unit_price: 0 });

  const { data, isLoading } = useQuery({
    queryKey: ['invoices-ap', search, status, page, startDate, endDate],
    queryFn: () => {
      const params = new URLSearchParams({ q: search, status, page: String(page), limit: '20', doc_type: 'invoice', direction: 'incoming' });
      if (startDate) params.set('start_date', startDate);
      if (endDate) params.set('end_date', endDate);
      return api(`/invoices?${params.toString()}`);
    },
  });

  const { data: suppliers } = useQuery({
    queryKey: ['suppliers-list-ap'],
    queryFn: () => api('/suppliers?limit=200'),
  });

  const { data: products } = useQuery({
    queryKey: ['products-list-ap'],
    queryFn: () => api('/products?limit=500'),
  });

  const createProductMut = useMutation({
    mutationFn: (body: any) => api('/products', { method: 'POST', body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['products-list-ap'] }),
  });

  const { data: invoiceDetail } = useQuery({
    queryKey: ['invoice-ap', viewId],
    queryFn: () => api(`/invoices/${viewId}`),
    enabled: !!viewId,
  });

  const createMut = useMutation({
    mutationFn: (body: any) => api('/invoices', { method: 'POST', body }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['invoices-ap'] }); setShowForm(false); },
  });

  // Unified bank-transaction ↔ invoice match confirm (server posts GL + syncs file payment_status)
  const matchConfirmMut = useMutation({
    mutationFn: ({ txId, invoiceId }: { txId: string; invoiceId: string }) =>
      api(`/bank-statements/transactions/${txId}/match`, { method: 'PATCH', body: { invoice_id: invoiceId, action: 'confirm' } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices-ap'] });
      queryClient.invalidateQueries({ queryKey: ['entries'] });
      queryClient.invalidateQueries({ queryKey: ['bank-statements'] });
    },
    onError: (err: any) => toast.error(err?.error || err?.message || tr('Confirm failed', '確認失敗', '确认失败')),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api(`/invoices/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invoices-ap'] }),
  });

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api(`/invoices/${id}/status`, { method: 'PATCH', body: { status } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invoices-ap'] }),
  });

  const confirmReceiptMatchMut = useMutation({
    mutationFn: (body: { receipt_id: string; invoice_id: string }) => api('/invoices/confirm-receipt-match', { method: 'POST', body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invoices-ap'] }),
  });

  function addItem() {
    setForm({ ...form, items: [...form.items, { description: '', quantity: 1, unit_price: 0, amount: 0 }] });
  }

  function updateItem(idx: number, field: string, value: any) {
    const items = [...form.items];
    items[idx] = { ...items[idx], [field]: value };
    if (field === 'quantity' || field === 'unit_price') {
      items[idx].amount = items[idx].quantity * items[idx].unit_price;
    }
    setForm({ ...form, items });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const sub = form.items.reduce((s: number, i: any) => s + i.amount, 0);
    const tax = sub * ((form.tax_rate || 0) / 100);
    const disc = (form.discount_type === 'percent' ? sub * ((form.discount_value || 0) / 100) : (form.discount_value || 0));
    // Ensure incoming direction for AP
    createMut.mutate({ ...form, direction: 'incoming', total: sub + tax - disc, subtotal: sub, tax_amount: tax, discount_amount: disc });
  }

  const invoices = data?.data || [];

  const statusLabel = (s: string) => {
    const labels: Record<string, string> = { draft: tr('Draft', '草稿', '草稿'), sent: tr('Sent', '應付', '应付'), paid: tr('Paid', '已付', '已付'), overdue: tr('Overdue', '逾期未付', '逾期未付'), cancelled: tr('Cancelled', '已取消', '已取消') };
    return labels[s] || s;
  };
  const statusBadge = (s: string) => {
    const colors: Record<string, string> = { draft: 'bg-gray-100 text-gray-700', sent: 'bg-orange-100 text-orange-700', paid: 'bg-green-100 text-green-700', overdue: 'bg-red-100 text-red-700', cancelled: 'bg-gray-100 text-gray-500' };
    return `px-2 py-0.5 rounded-full text-xs font-medium ${colors[s] || 'bg-gray-100'}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">{tr('Accounts Payable (AP)', '應付帳款 AP', '应付账款 AP')}</h2>
          <p className="text-muted-foreground mt-1">{tr('Manage supplier bills and payments', '管理供應商帳單和付款', '管理供应商账单和付款')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={async () => {
            try {
              const result = await api('/invoices/auto-match-receipts?direction=incoming', { method: 'POST' });
              if (result.matched?.length > 0) {
                setReceiptMatchResults(result.matched);
              } else {
                toast.info(tr('No receipt matches found', '沒有找到收據配對', '没有找到收据配对'));
              }
            } catch (e: any) { toast.error(e?.message || 'Match failed'); }
          }}
            className="flex items-center gap-1 px-3 py-2 border rounded-md text-sm hover:bg-muted">
            <Link2 className="h-4 w-4" /> {tr('Match Receipts', '配對收據', '配对收据')}
          </button>
          <button onClick={async () => {
            try {
              const result = await api('/bank-statements/auto-match?direction=incoming', { method: 'POST' });
              if (result.matched?.length > 0) {
                setBankMatchResults(result.matched);
              } else {
                toast.info(tr('No bank matches found', '沒有找到銀行配對', '没有找到银行配对'));
              }
            } catch (e: any) { toast.error(e?.message || 'Match failed'); }
          }}
            className="flex items-center gap-1 px-3 py-2 border rounded-md text-sm hover:bg-muted">
            <Zap className="h-4 w-4" /> {tr('Match Bank Payments', '配對銀行付款', '配对银行付款')}
          </button>
          <button onClick={() => setShowForm(true)}
            className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:opacity-90">
            <Plus className="h-4 w-4" /> {tr('Create Bill', '建立帳單', '建立账单')}
          </button>
        </div>
      </div>

      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder={tr('Search bills...', '搜尋帳單...', '搜索账单...')} className="w-full pl-10 pr-4 py-2 border rounded-md bg-background text-sm" />
        </div>
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}
          className="px-3 py-2 border rounded-md bg-background text-sm">
          <option value="">{tr('All Status', '全部狀態', '全部状态')}</option>
          <option value="draft">{tr('Draft', '草稿', '草稿')}</option>
          <option value="sent">{tr('Payable', '應付', '应付')}</option>
          <option value="paid">{tr('Paid', '已付', '已付')}</option>
          <option value="overdue">{tr('Overdue', '逾期未付', '逾期未付')}</option>
        </select>
      </div>

      {isLoading ? <div className="text-center py-12 text-muted-foreground">{tr('Loading...', '載入中...', '载入中...')}</div> :
       invoices.length === 0 ? <div className="text-center py-12 text-muted-foreground">{tr('No payable records', '未有應付記錄', '未有应付记录')}</div> : (
        <div className="bg-card border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left p-3">{tr('Invoice No.', '帳單號碼', '账单号码')}</th>
                <th className="text-left p-3 hidden md:table-cell">{tr('Customer / Supplier', '客戶 / 供應商', '客户 / 供应商')}</th>
                <th className="text-left p-3 w-16">{tr('Type', '類型', '类型')}</th>
                <th className="text-left p-3">{tr('Status', '狀態', '状态')}</th>
                <th className="text-right p-3 hidden lg:table-cell">{tr('Amount', '金額', '金额')}</th>
                <th className="text-left p-3 hidden lg:table-cell">{tr('Date', '日期', '日期')}</th>
                <th className="text-right p-3">{tr('Actions', '操作', '操作')}</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv: any) => (
                <tr key={inv.id} className="border-b hover:bg-muted/30">
                  <td className="p-3 font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      {inv.invoice_number}
                      {inv.needs_review?.includes('direction') && (
                        <span title={tr('AI OCR could not determine if this is AR (you issued) or AP (you received). Please review.', 'AI OCR 無法判斷此為 AR（你開出）或 AP（你接收）。請審核。', 'AI OCR 无法判断此为 AR（你开出）或 AP（你接收）。请审核。')}>
                          <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                        </span>
                      )}
                      {inv.needs_review?.includes('company_not_detected') && (
                        <span title={tr('Your company name was not detected in this invoice. It may be between two third parties.', '未在此發票中檢測到你公司名稱。可能涉及兩個第三方。', '未在此发票中检测到你公司名称。可能涉及两个第三方。')}>
                          <Info className="h-3.5 w-3.5 text-blue-500" />
                        </span>
                      )}
                      {inv.needs_review?.includes('duplicate') && (
                        <span title={tr('An invoice with this number already existed. The number was adjusted to avoid conflict.', '此發票號碼已存在。號碼已調整以避免衝突。', '此发票号码已存在。号码已调整以避免冲突。')}>
                          <Copy className="h-3.5 w-3.5 text-orange-500" />
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="p-3 hidden md:table-cell">{inv.vendor_name || inv.supplier_name || inv.customer_name || '-'}</td>
                  <td className="p-3">
                    <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-orange-100 text-orange-700">
                      {tr('AP', '應付', '应付')}
                    </span>
                  </td>
                  <td className="p-3"><span className={statusBadge(inv.status)}>{statusLabel(inv.status)}</span></td>
                  <td className="p-3 text-right hidden lg:table-cell">{inv.currency} {inv.total?.toLocaleString()}</td>
                  <td className="p-3 hidden lg:table-cell">{inv.issue_date}</td>
                  <td className="p-3 text-right">
                    <button onClick={() => setViewId(inv.id)} className="p-1 hover:bg-muted rounded mr-1" title={tr('View', '查看', '查看')}><Eye className="h-4 w-4" /></button>
                    <button onClick={() => navigate(`/invoices/review/${inv.id}`)} className="p-1 hover:bg-muted rounded mr-1" title={tr('Edit', '編輯', '编辑')}><Pencil className="h-4 w-4" /></button>
                    <button onClick={() => downloadInvoicePDF(inv.id, inv.invoice_number)} className="p-1 hover:bg-muted rounded mr-1" title={tr('Download PDF', '下載 PDF', '下载 PDF')}><Download className="h-4 w-4" /></button>
                    {inv.status === 'draft' && (
                      <button onClick={() => updateStatus.mutate({ id: inv.id, status: 'sent' })} className="text-xs text-orange-600 hover:underline mr-2">{tr('Send (AP)', '發送（應付）', '发送（应付）')}</button>
                    )}
                    {inv.status === 'sent' && (
                      <button onClick={() => updateStatus.mutate({ id: inv.id, status: 'paid' })} className="text-xs text-green-600 hover:underline mr-2">{tr('Paid', '已付', '已付')}</button>
                    )}
                    <button onClick={() => { if (confirm(tr('Delete this item?', '確定刪除?', '确定删除?'))) deleteMut.mutate(inv.id); }} className="p-1 hover:bg-muted rounded text-destructive"><Trash2 className="h-4 w-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create Bill Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 overflow-y-auto" onClick={() => setShowForm(false)}>
          <div className="bg-card border rounded-xl p-6 w-full max-w-2xl mx-4 my-8 space-y-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-lg">{tr('Create Bill', '建立帳單', '建立账单')}</h3>
            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <input value={form.invoice_number} onChange={(e) => setForm({ ...form, invoice_number: e.target.value })}
                    placeholder={tr("Bill No. (auto if blank)", "帳單號碼（留空自動產生）", "账单号码（留空自动产生）")} className="w-full px-3 py-2 border rounded-md bg-background text-sm" />
                  {!form.invoice_number && <p className="text-[10px] text-muted-foreground mt-0.5">{tr('Leave blank to auto-generate', '留空則根據設定格式自動產生號碼', '留空则根据设定格式自动产生号码')}</p>}
                </div>
                <select required value={form.supplier_id} onChange={(e) => {
                  const sid = e.target.value;
                  const supp = (suppliers?.data || []).find((s: any) => s.id === sid);
                  setForm({
                    ...form, supplier_id: sid,
                    attn: supp?.name || '', customer_phone: supp?.phone || '',
                    customer_email: supp?.email || '', customer_address: supp?.address || '',
                  });
                }}
                  className="px-3 py-2 border rounded-md bg-background text-sm">
                  <option value="">{tr('Select Supplier *', '選擇供應商 *', '选择供应商 *')}</option>
                  {(suppliers?.data || []).map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <input type="date" value={form.issue_date} onChange={(e) => setForm({ ...form, issue_date: e.target.value })}
                  className="px-3 py-2 border rounded-md bg-background text-sm" />
                <input type="date" required value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })}
                  className="px-3 py-2 border rounded-md bg-background text-sm" placeholder={tr("Due date", "到期日", "到期日")} />
                <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}
                  className="px-3 py-2 border rounded-md bg-background text-sm">
                  <option value="HKD">HKD</option><option value="USD">USD</option><option value="CNY">CNY</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input value={form.receipt_number} onChange={(e) => setForm({ ...form, receipt_number: e.target.value })}
                  placeholder={tr("Receipt No.", "收據號碼", "收据号码")} className="px-3 py-2 border rounded-md bg-background text-sm" />
                <input type="date" value={form.paid_date} onChange={(e) => setForm({ ...form, paid_date: e.target.value })}
                  className="px-3 py-2 border rounded-md bg-background text-sm" placeholder={tr("Payment date", "付款日期", "付款日期")} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input value={form.attn} onChange={(e) => setForm({ ...form, attn: e.target.value })}
                  placeholder={tr("Attn Contact", "Attn 聯絡人", "Attn 联络人")} className="px-3 py-2 border rounded-md bg-background text-sm" />
                <input value={form.customer_phone} onChange={(e) => setForm({ ...form, customer_phone: e.target.value })}
                  placeholder={tr("Tel", "Tel 電話", "Tel 电话")} className="px-3 py-2 border rounded-md bg-background text-sm" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input value={form.customer_email} onChange={(e) => setForm({ ...form, customer_email: e.target.value })}
                  placeholder={tr("E-mail", "E-mail 電郵", "E-mail 电邮")} className="px-3 py-2 border rounded-md bg-background text-sm" />
                <input value={form.customer_address} onChange={(e) => setForm({ ...form, customer_address: e.target.value })}
                  placeholder={tr("Address", "Address 地址", "Address 地址")} className="px-3 py-2 border rounded-md bg-background text-sm" />
              </div>

              <div className="border rounded-md p-3 space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-medium">{tr('Items', '項目 Items', '项目 Items')}</span>
                  <button type="button" onClick={addItem} className="text-xs text-primary hover:underline">+ {tr('Add Item', '新增項目', '新增项目')}</button>
                </div>
                {form.items.map((item, idx) => {
                  const searchText = productSearch[idx] || '';
                  const filteredProducts = (products?.data || []).filter((p: any) =>
                    !searchText || p.name.toLowerCase().includes(searchText.toLowerCase())
                  ).slice(0, 8);
                  const showDropdown = productDropdown === idx;
                  return (
                  <div key={idx} className="grid grid-cols-12 gap-2 items-center relative">
                    <div className="col-span-5 relative">
                      <input required value={item.description} onChange={(e) => {
                        updateItem(idx, 'description', e.target.value);
                        setProductSearch({ ...productSearch, [idx]: e.target.value });
                        setProductDropdown(idx);
                      }}
                        onFocus={() => { setProductSearch({ ...productSearch, [idx]: item.description }); setProductDropdown(idx); }}
                        onBlur={() => setTimeout(() => setProductDropdown(null), 200)}
                        placeholder={tr("Search product or enter description", "搜尋產品或輸入描述", "搜索产品或输入描述")} className="w-full px-2 py-1 border rounded text-sm" />
                      {showDropdown && (
                        <div className="absolute z-10 left-0 right-0 top-full mt-1 bg-card border rounded-md shadow-lg max-h-48 overflow-y-auto">
                          {filteredProducts.map((p: any) => (
                            <button key={p.id} type="button"
                              onMouseDown={() => {
                                updateItem(idx, 'description', p.name);
                                updateItem(idx, 'unit_price', p.unit_price || 0);
                                updateItem(idx, 'product_id', p.id);
                                setProductDropdown(null);
                              }}
                              className="w-full text-left px-2 py-1.5 text-sm hover:bg-muted flex justify-between">
                              <span>{p.name}</span>
                              <span className="text-muted-foreground text-xs">{p.currency} {p.unit_price}</span>
                            </button>
                          ))}
                          {filteredProducts.length === 0 && searchText && (
                            <button type="button"
                              onMouseDown={() => {
                                const name = searchText.trim();
                                if (!name) return;
                                createProductMut.mutate({ name, unit_price: 0, currency: form.currency, category: 'Service' });
                                updateItem(idx, 'description', name);
                                setProductDropdown(null);
                              }}
                              className="w-full text-left px-2 py-1.5 text-sm hover:bg-muted text-primary">
                              {tr('+ New product', '+ 新增產品', '+ 新增产品')}「{searchText}」
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    <input type="number" value={item.quantity} onChange={(e) => updateItem(idx, 'quantity', parseFloat(e.target.value))}
                      className="col-span-2 px-2 py-1 border rounded text-sm" placeholder={tr("Qty", "數量", "数量")} />
                    <input type="number" step="0.01" value={item.unit_price} onChange={(e) => updateItem(idx, 'unit_price', parseFloat(e.target.value))}
                      className="col-span-2 px-2 py-1 border rounded text-sm" placeholder={tr("Unit Price", "單價", "单价")} />
                    <span className="col-span-2 text-sm text-right">{form.currency} {(item.amount || 0).toFixed(2)}</span>
                    <button type="button" onClick={() => { const items = form.items.filter((_, i) => i !== idx); setForm({ ...form, items: items.length ? items : [{ description: '', quantity: 1, unit_price: 0, amount: 0 }] }); }} className="col-span-1 text-destructive text-xs">✕</button>
                  </div>
                );})}
                <div className="flex items-center gap-1.5 justify-end text-xs text-muted-foreground pt-2 border-t">
                  <span>{tr('Tax %', '稅%', '税%')}</span>
                  <input type="number" min="0" max="100" step="0.5" value={form.tax_rate || 0}
                    onChange={(e) => setForm({ ...form, tax_rate: parseFloat(e.target.value) || 0 })}
                    className="w-14 px-1 py-0.5 border rounded text-xs text-center bg-background" />
                  <span className="mr-2">{tr('Discount', '折扣', '折扣')}</span>
                  <input type="number" min="0" step="0.01" value={form.discount_value || ''}
                    onChange={(e) => setForm({ ...form, discount_value: parseFloat(e.target.value) || 0 })}
                    placeholder="0" className="w-18 px-1 py-0.5 border rounded text-xs text-center bg-background" />
                  <select value={form.discount_type}
                    onChange={(e) => setForm({ ...form, discount_type: e.target.value })}
                    className="text-xs border rounded px-1 py-0.5 bg-background">
                    <option value="flat">$</option>
                    <option value="percent">%</option>
                  </select>
                </div>
                <div className="text-right font-bold text-sm pt-1">
                  {tr('Total', '總計', '总计')}: {form.currency} {(() => {
                    const sub = form.items.reduce((s: number, i: any) => s + i.amount, 0);
                    const tax = sub * ((form.tax_rate || 0) / 100);
                    const disc = (form.discount_type === 'percent' ? sub * ((form.discount_value || 0) / 100) : (form.discount_value || 0));
                    return (sub + tax - disc).toFixed(2);
                  })()}
                </div>
              </div>

              <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder={tr("Notes", "備註 Notes", "备注 Notes")} className="w-full px-3 py-2 border rounded-md bg-background text-sm" rows={2} />
              <div className="flex gap-3 justify-end">
                <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 border rounded-md text-sm">{tr('Cancel', '取消', '取消')}</button>
                <button type="submit" disabled={createMut.isPending}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm">{tr('Create', '建立', '建立')}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* View Bill Modal */}
      {viewId && invoiceDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setViewId(null)}>
          <div className="bg-card border rounded-xl p-6 w-[90vw] max-w-[90vw] h-[85vh] mx-4 flex gap-6" onClick={(e) => e.stopPropagation()}>
            {/* Left: details */}
            <div className="w-[45%] flex flex-col min-h-0 overflow-y-auto pr-2 space-y-4">
              <div className="flex justify-between items-center">
                <h3 className="font-bold text-lg">{tr('Bill', '帳單', '账单')} #{invoiceDetail.invoice_number}</h3>
                <button onClick={() => setViewId(null)} className="text-muted-foreground">✕</button>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-muted-foreground">{tr('Supplier', '供應商', '供应商')}:</span> {invoiceDetail.vendor_name || invoiceDetail.supplier_name || invoiceDetail.customer_name}</div>
                <div><span className="text-muted-foreground">{tr('Status', '狀態', '状态')}:</span> <span className={statusBadge(invoiceDetail.status)}>{statusLabel(invoiceDetail.status)}</span></div>
                <div><span className="text-muted-foreground">{tr('Date', '日期', '日期')}:</span> {invoiceDetail.issue_date}</div>
                <div><span className="text-muted-foreground">{tr('Due', '到期', '到期')}:</span> {invoiceDetail.due_date}</div>
                {invoiceDetail.receipt_number && <div><span className="text-muted-foreground">{tr('Receipt No.', '收據號碼', '收据号码')}:</span> {invoiceDetail.receipt_number}</div>}
                {invoiceDetail.paid_date && <div><span className="text-muted-foreground">{tr('Payment Date', '付款日期', '付款日期')}:</span> {invoiceDetail.paid_date}</div>}
              </div>
              <table className="w-full text-sm">
                <thead><tr className="border-b"><th className="text-left p-2">{tr('Item', '項目', '项目')}</th><th className="text-right p-2">{tr('Qty', '數量', '数量')}</th><th className="text-right p-2">{tr('Unit Price', '單價', '单价')}</th><th className="text-right p-2">{tr('Amount', '金額', '金额')}</th></tr></thead>
                <tbody>
                  {(invoiceDetail.items || []).map((item: any) => (
                    <tr key={item.id} className="border-b">
                      <td className="p-2">{item.description}</td>
                      <td className="p-2 text-right">{item.quantity}</td>
                      <td className="p-2 text-right">{invoiceDetail.currency} {item.unit_price?.toFixed(2)}</td>
                      <td className="p-2 text-right">{invoiceDetail.currency} {item.amount?.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><td colSpan={3} className="text-right font-bold p-2">{tr('Total', '總計', '总计')}</td><td className="text-right font-bold p-2">{invoiceDetail.currency} {invoiceDetail.total?.toFixed(2)}</td></tr></tfoot>
              </table>
              <button
                onClick={() => downloadInvoicePDF(invoiceDetail.id, invoiceDetail.invoice_number)}
                className="inline-flex items-center gap-2 text-sm text-primary hover:underline">
                <Download className="h-4 w-4" /> {tr('Download PDF', '下載 PDF', '下载 PDF')}
              </button>
            </div>
            {/* Right: uploaded document PDF (or fallback if manually created) */}
            <div className="flex-1 border rounded-lg overflow-auto bg-gray-100 flex items-center justify-center">
              {invoiceDetail.file_id ? (
                <iframe
                  src={`${WORKER_API_BASE}/file-storage/${invoiceDetail.file_id}/download?inline=1&token=${localStorage.getItem('token') || ''}${iframeClientParam()}`}
                  className="w-full h-full border-0"
                  title="Uploaded Document"
                />
              ) : (
                <div className="text-center text-muted-foreground p-8">
                  <FileText className="h-12 w-12 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">{tr('No uploaded document', '沒有上傳的文件', '没有上传的文件')}</p>
                  <p className="text-xs mt-1">{tr('This bill was created manually.', '此帳單為手動建立。', '此账单为手动建立。')}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Bank Match Review Modal (unified engine) */}
      {bankMatchResults && (
        <AutoMatchReviewModal
          matches={bankMatchResults}
          onConfirm={(txId, invoiceId) => matchConfirmMut.mutateAsync({ txId, invoiceId })}
          onReject={() => Promise.resolve() /* suggest-only: nothing persisted to unlink */}
          onClose={() => {
            setBankMatchResults(null);
            queryClient.invalidateQueries({ queryKey: ['invoices-ap'] });
          }}
        />
      )}

      {/* Receipt Match Review Modal */}
      {receiptMatchResults && (
        <ReceiptMatchReviewModal
          matches={receiptMatchResults}
          onConfirm={(receiptId, invoiceId) => {
            confirmReceiptMatchMut.mutate({ receipt_id: receiptId, invoice_id: invoiceId });
          }}
          onClose={() => {
            setReceiptMatchResults(null);
            queryClient.invalidateQueries({ queryKey: ['invoices-ap'] });
          }}
        />
      )}
    </div>
  );
}

// ── Receipt Match Review Modal (shared across AP, Invoices, AR) ──
export function ReceiptMatchReviewModal({ matches, onConfirm, onClose }: {
  matches: any[];
  onConfirm: (receiptId: string, invoiceId: string) => void;
  onClose: () => void;
}) {
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [rejected, setRejected] = useState<Set<string>>(new Set());

  const pending = matches.filter(m => !confirmed.has(m.receipt_id) && !rejected.has(m.receipt_id));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-card border rounded-xl p-6 w-full max-w-2xl mx-4 space-y-4 max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold flex items-center gap-2">
            <Link2 className="h-5 w-5 text-blue-600" />
            Receipt Match Suggestions ({confirmed.size + rejected.size}/{matches.length})
          </h3>
          <button onClick={onClose} className="p-1 hover:bg-muted rounded">✕</button>
        </div>

        {pending.length === 0 ? (
          <div className="text-center py-8 space-y-2">
            <span className="text-3xl">✓</span>
            <p className="text-sm font-medium">{tr('All suggestions reviewed!', '所有建議已審核！', '所有建议已审核！')}</p>
            <button onClick={onClose} className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm">
              {tr('Close', '關閉', '关闭')}
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {tr('Review each match. Confirm to link the receipt to its invoice.', '審核每個配對。確認後將收據連結至發票。', '审核每个配对。确认后将收据连结至发票。')}
              </span>
              <button
                onClick={() => {
                  pending.forEach(m => {
                    onConfirm(m.receipt_id, m.invoice_id);
                    setConfirmed(prev => new Set(prev).add(m.receipt_id));
                  });
                }}
                className="px-3 py-1.5 bg-green-600 text-white rounded text-xs font-medium hover:bg-green-700"
              >
                {tr('Accept All', '全部接受', '全部接受')} ({pending.length})
              </button>
            </div>
            <div className="space-y-2 overflow-y-auto flex-1">
              {pending.map(m => (
                <div key={m.receipt_id} className="border rounded-lg p-3 flex items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">
                        {m.direction === 'outgoing' ? 'AR' : 'AP'}
                      </span>
                      <span className="text-sm font-medium">Receipt #{m.receipt_number}</span>
                      <span className="text-xs text-muted-foreground">→</span>
                      <span className="text-sm font-medium">Invoice #{m.invoice_number}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      HKD {m.receipt_total?.toLocaleString()} → HKD {m.invoice_total?.toLocaleString()}
                      {m.receipt_vendor ? ` · ${m.receipt_vendor}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => {
                      onConfirm(m.receipt_id, m.invoice_id);
                      setConfirmed(prev => new Set(prev).add(m.receipt_id));
                    }}
                      className="px-3 py-1.5 bg-green-600 text-white rounded text-xs font-medium hover:bg-green-700">
                      ✓ Confirm
                    </button>
                    <button onClick={() => setRejected(prev => new Set(prev).add(m.receipt_id))}
                      className="px-3 py-1.5 border border-red-300 text-red-600 rounded text-xs hover:bg-red-50">
                      ✗ Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
