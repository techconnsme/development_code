import React, { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, WORKER_API_BASE } from '../lib/api';
import { Plus, Search, FileText, Eye, Trash2, Download, Pencil, AlertTriangle, Info, Copy, Link2, Link, Link2Off } from 'lucide-react';
import { tr } from '../lib/i18nHelpers';
import { useToast } from '../components/Toast';
import { ReceiptMatchReviewModal } from './AP';

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
    a.download = `Invoice_${invoiceNumber}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch {
    alert('Could not download PDF. Please check your connection.');
  }
}

export default function Invoices() {
  const { i18n } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [docType, setDocType] = useState<'invoice' | 'receipt'>('invoice');
  const [expenseCategory, setExpenseCategory] = useState<'all' | 'cash' | 'reimburse' | 'director'>('all');
  const [linkFilter, setLinkFilter] = useState<'all' | 'linked' | 'unlinked'>('all');
  const [page, setPage] = useState(1);
  const [showForm, setShowForm] = useState(false);
  const [viewId, setViewId] = useState<string | null>(null);
  const [receiptMatchResults, setReceiptMatchResults] = useState<any[] | null>(null);
  const [form, setForm] = useState({ invoice_number: '', customer_id: '', issue_date: new Date().toISOString().split('T')[0], due_date: '', receipt_number: '', paid_date: '', currency: 'HKD', tax_rate: 0, discount_amount: 0, discount_type: 'flat' as string, discount_value: 0, notes: '', terms: '', attn: '', customer_phone: '', customer_email: '', customer_address: '', items: [{ description: '', quantity: 1, unit_price: 0, amount: 0 }] });
  const [productSearch, setProductSearch] = useState<Record<number, string>>({});
  const [productDropdown, setProductDropdown] = useState<number | null>(null);
  const [addProductForm, setAddProductForm] = useState({ name: '', unit_price: 0 });

  const { data, isLoading } = useQuery({
    queryKey: ['invoices', search, status, page, expenseCategory, docType],
    queryFn: () => {
      const params = new URLSearchParams({ q: search, status, page: String(page), limit: '20', doc_type: docType });
      if (docType === 'invoice' && expenseCategory !== 'all') {
        params.set('expense_category', expenseCategory);
      }
      return api(`/invoices?${params.toString()}`);
    },
  });

  const { data: customers } = useQuery({
    queryKey: ['customers-list'],
    queryFn: () => api('/customers?limit=200'),
  });

  const { data: products } = useQuery({
    queryKey: ['products-list'],
    queryFn: () => api('/products?limit=500'),
  });

  const createProductMut = useMutation({
    mutationFn: (body: any) => api('/products', { method: 'POST', body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['products-list'] }),
  });

  const { data: invoiceDetail } = useQuery({
    queryKey: ['invoice', viewId],
    queryFn: () => api(`/invoices/${viewId}`),
    enabled: !!viewId,
  });

  const createMut = useMutation({
    mutationFn: (body: any) => api('/invoices', { method: 'POST', body }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['invoices'] }); setShowForm(false); },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api(`/invoices/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invoices'] }),
  });

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api(`/invoices/${id}/status`, { method: 'PATCH', body: { status } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invoices'] }),
  });

  const confirmReceiptMatchMut = useMutation({
    mutationFn: (body: { receipt_id: string; invoice_id: string }) => api('/invoices/confirm-receipt-match', { method: 'POST', body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invoices'] }),
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
    if (docType === 'receipt') {
      createMut.mutate({
        ...form,
        receipt_number: form.receipt_number || form.invoice_number || null,
        invoice_number: form.receipt_number || undefined,
        direction: 'incoming',
        status: 'draft',
        total: sub + tax - disc,
        subtotal: sub,
        tax_amount: tax,
        discount_amount: disc,
        items: form.items.length > 0 ? form.items : [{ description: form.attn || 'Receipt item', quantity: 1, unit_price: 0, amount: 0 }],
      });
    } else {
      createMut.mutate({ ...form, total: sub + tax - disc, subtotal: sub, tax_amount: tax, discount_amount: disc });
    }
  }

  const invoicesRaw = data?.data || [];
  const invoices = docType === 'receipt'
    ? linkFilter === 'linked' ? invoicesRaw.filter((r: any) => r.linked_invoice_id)
    : linkFilter === 'unlinked' ? invoicesRaw.filter((r: any) => !r.linked_invoice_id)
    : invoicesRaw
    : invoicesRaw;
  const statusLabel = (s: string) => {
    const labels: Record<string, string> = { draft: tr('Draft', '草稿', '草稿'), sent: tr('Sent', '已發送', '已发送'), paid: tr('Paid', '已付', '已付'), overdue: tr('Overdue', '逾期', '逾期'), cancelled: tr('Cancelled', '已取消', '已取消'), pending_review: tr('⏳ Pending', '⏳ 待審', '⏳ 待审') };
    return labels[s] || s;
  };
  const statusBadge = (s: string) => {
    const colors: Record<string, string> = { draft: 'bg-gray-100 text-gray-700', sent: 'bg-blue-100 text-blue-700', paid: 'bg-green-100 text-green-700', overdue: 'bg-red-100 text-red-700', cancelled: 'bg-gray-100 text-gray-500', pending_review: 'bg-yellow-100 text-yellow-700' };
    return `px-2 py-0.5 rounded-full text-xs font-medium ${colors[s] || 'bg-gray-100'}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">
            {docType === 'invoice'
              ? tr('Expenses', '支出 Expenses', '支出 Expenses')
              : tr('Receipts', '收據 Receipts', '收据 Receipts')}
          </h2>
          <p className="text-muted-foreground mt-1">
            {docType === 'invoice'
              ? tr('Manage invoices, expenses and reimbursements', '管理發票、支出與報銷', '管理发票、支出与报销')
              : tr('Manage payment receipts and link them to invoices', '管理付款收據，連結至發票', '管理付款收据，连结至发票')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={async () => {
            try {
              const dir = docType === 'receipt' ? '' : '';
              const result = await api(`/invoices/auto-match-receipts?direction=${docType === 'receipt' ? 'outgoing' : ''}`, { method: 'POST' });
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
          <button onClick={() => setShowForm(true)}
            className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:opacity-90">
            <Plus className="h-4 w-4" />
            {docType === 'invoice'
              ? tr('Create Invoice', '建立發票', '建立发票')
              : tr('Create Receipt', '建立收據', '建立收据')}
          </button>
        </div>
      </div>

      {/* Invoice / Receipt tabs */}
      <div className="flex gap-1 bg-muted/50 rounded-lg p-1 w-fit">
        {([
          { key: 'invoice' as const, label: tr('Invoices', '發票', '发票') },
          { key: 'receipt' as const, label: tr('Receipts', '收據', '收据') },
        ]).map(t => (
          <button
            key={t.key}
            onClick={() => { setDocType(t.key); setPage(1); }}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              docType === t.key
                ? 'bg-background shadow-sm text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Expense category tabs — invoice mode only */}
      {docType === 'invoice' && (
        <div className="flex gap-1 bg-muted/50 rounded-lg p-1 w-fit flex-wrap">
          {([
            { key: 'all', label: tr('All', '全部', '全部') },
            { key: 'cash', label: tr('Cash Expenses', '現金支出', '现金支出') },
            { key: 'reimburse', label: tr('Employee Reimb.', '員工報銷', '员工报销') },
            { key: 'director', label: tr('Director Expenses', '董事支出', '董事支出') },
          ] as const).map(t => (
            <button
              key={t.key}
              onClick={() => { setExpenseCategory(t.key); setPage(1); }}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                expenseCategory === t.key
                  ? 'bg-background shadow-sm text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* Link filter tabs — receipt mode only */}
      {docType === 'receipt' && (
        <div className="flex gap-1 bg-muted/50 rounded-lg p-1 w-fit">
          {([
            { key: 'all', label: tr('All Receipts', '全部收據', '全部收据'), count: invoicesRaw.length },
            { key: 'linked', label: tr('Linked to Invoice', '已連結發票', '已连结发票'), count: invoicesRaw.filter((r: any) => r.linked_invoice_id).length },
            { key: 'unlinked', label: tr('Unlinked', '未連結', '未连结'), count: invoicesRaw.filter((r: any) => !r.linked_invoice_id).length },
          ] as const).map(t => (
            <button
              key={t.key}
              onClick={() => { setLinkFilter(t.key); }}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                linkFilter === t.key
                  ? 'bg-background shadow-sm text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.label}
              <span className="ml-1.5 text-xs text-muted-foreground">({t.count})</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder={docType === 'invoice'
              ? tr('Search invoices...', '搜尋發票...', '搜索发票...')
              : tr('Search receipts...', '搜尋收據...', '搜索收据...')} className="w-full pl-10 pr-4 py-2 border rounded-md bg-background text-sm" />
        </div>
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}
          className="px-3 py-2 border rounded-md bg-background text-sm">
          <option value="">{tr('All Status', '全部狀態', '全部状态')}</option>
          <option value="draft">{tr('Draft', '草稿', '草稿')}</option>
          <option value="sent">{tr('Sent', '已發送', '已发送')}</option>
          <option value="paid">{tr('Paid', '已付', '已付')}</option>
          <option value="pending_review">{tr('⏳ Pending Review', '⏳ 待審核', '⏳ 待审核')}</option>
          <option value="overdue">{tr('Overdue', '逾期', '逾期')}</option>
        </select>
      </div>

      {isLoading ? <div className="text-center py-12 text-muted-foreground">{tr('Loading...', '載入中...', '载入中...')}</div> :
       invoices.length === 0 ? <div className="text-center py-12 text-muted-foreground">
        {docType === 'invoice'
          ? tr('No invoice records', '未有發票記錄', '未有发票记录')
          : tr('No receipt records', '未有收據記錄', '未有收据记录')}
      </div> : (
        <div className="bg-card border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left p-3">
                  {docType === 'invoice'
                    ? tr('Invoice No.', '發票號碼', '发票号码')
                    : tr('Receipt No.', '收據號碼', '收据号码')}
                </th>
                <th className="text-left p-3 hidden md:table-cell">
                  {docType === 'invoice'
                    ? tr('Customer / Supplier', '客戶/供應商', '客户/供应商')
                    : tr('Payer / Supplier', '付款方 / 供應商', '付款方 / 供应商')}
                </th>
                {docType === 'receipt' && <th className="text-left p-3 w-20">{tr('Link', '連結', '连结')}</th>}
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
                      {docType === 'receipt' ? (inv.receipt_number || inv.invoice_number?.replace(/^REC-\w+$/, '') || inv.invoice_number) : inv.invoice_number}
                      {inv.needs_review?.includes('duplicate') && (
                        <span title={tr('Duplicate detected', '檢測到重複', '检测到重复')}>
                          <Copy className="h-3.5 w-3.5 text-orange-500" />
                        </span>
                      )}
                      {docType === 'receipt' && inv.status !== 'paid' && !inv.linked_invoice_id && (
                        <span title={tr('Unlinked — no invoice matched yet', '未連結 — 尚未配對發票', '未连结 — 尚未配对发票')}>
                          <Link2Off className="h-3.5 w-3.5 text-red-400" />
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="p-3 hidden md:table-cell">
                    {docType === 'receipt'
                      ? (inv.vendor_name || inv.customer_name || '-')
                      : (inv.direction === 'incoming'
                          ? (inv.vendor_name || inv.supplier_name || inv.customer_name || '-')
                          : (inv.customer_name || '-'))}
                  </td>
                  {docType === 'receipt' && (
                    <td className="p-3">
                      {inv.linked_invoice_id ? (
                        <span className="inline-flex items-center gap-1 text-xs text-green-600"><Link className="h-3 w-3" /> {tr('Yes', '是', '是')}</span>
                      ) : <span className="text-xs text-muted-foreground">—</span>}
                    </td>
                  )}
                  <td className="p-3">
                    {docType === 'receipt' ? (
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${inv.direction === 'outgoing' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                        {tr('Receipt', '收據', '收据')}
                      </span>
                    ) : (
                      (() => {
                        const cat = inv.expense_category;
                        if (cat === 'cash') return <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-amber-100 text-amber-700">{tr('Cash', '現金', '现金')}</span>;
                        if (cat === 'reimburse') return <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-purple-100 text-purple-700">{tr('Reimb.', '報銷', '报销')}</span>;
                        if (cat === 'director') return <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-teal-100 text-teal-700">{tr('Director', '董事', '董事')}</span>;
                        return (
                          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                            inv.direction === 'incoming'
                              ? 'bg-orange-100 text-orange-700'
                              : 'bg-blue-100 text-blue-700'
                          }`}>
                            {inv.direction === 'incoming' ? (tr('AP', '應付', '应付')) : (tr('AR', '應收', '应收'))}
                          </span>
                        );
                      })()
                    )}
                  </td>
                  <td className="p-3"><span className={statusBadge(inv.status)}>{statusLabel(inv.status)}</span></td>
                  <td className="p-3 text-right hidden lg:table-cell">{inv.currency} {inv.total?.toLocaleString()}</td>
                  <td className="p-3 hidden lg:table-cell">{inv.issue_date}</td>
                  <td className="p-3 text-right">
                    <button onClick={() => setViewId(inv.id)} className="p-1 hover:bg-muted rounded mr-1" title={tr('View', '查看', '查看')}><Eye className="h-4 w-4" /></button>
                    <button onClick={() => navigate(`/invoices/review/${inv.id}`)} className="p-1 hover:bg-muted rounded mr-1" title={tr('Edit', '編輯', '编辑')}><Pencil className="h-4 w-4" /></button>
                    <button onClick={() => downloadInvoicePDF(inv.id, inv.receipt_number || inv.invoice_number)} className="p-1 hover:bg-muted rounded mr-1" title={tr('Download PDF', '下載 PDF', '下载 PDF')}><Download className="h-4 w-4" /></button>
                    {inv.status === 'draft' && (
                      <button onClick={() => updateStatus.mutate({ id: inv.id, status: 'sent' })} className="text-xs text-blue-600 hover:underline mr-2">
                        {tr('Send', '發送', '发送')}
                      </button>
                    )}
                    {inv.status === 'sent' && (
                      <button onClick={() => updateStatus.mutate({ id: inv.id, status: 'paid' })} className="text-xs text-green-600 hover:underline mr-2">
                        {tr('Mark Paid', '標記已付', '标记已付')}
                      </button>
                    )}
                    <button onClick={() => { if (confirm(tr('Delete this item?', '確定刪除?', '确定删除?'))) deleteMut.mutate(inv.id); }} className="p-1 hover:bg-muted rounded text-destructive"><Trash2 className="h-4 w-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create Invoice Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 overflow-y-auto" onClick={() => setShowForm(false)}>
          <div className="bg-card border rounded-xl p-6 w-full max-w-2xl mx-4 my-8 space-y-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-lg">
              {docType === 'invoice'
                ? tr('Create Invoice', '建立發票', '建立发票')
                : tr('Create Receipt', '建立收據', '建立收据')}
            </h3>
            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <input value={form.invoice_number} onChange={(e) => setForm({ ...form, invoice_number: e.target.value })}
                    placeholder={tr("Invoice No. (auto if blank)", "發票號碼（留空自動產生）", "发票号码（留空自动产生）")} className="w-full px-3 py-2 border rounded-md bg-background text-sm" />
                  {!form.invoice_number && <p className="text-[10px] text-muted-foreground mt-0.5">{tr('Leave blank to auto-generate', '留空則根據設定格式自動產生號碼', '留空则根据设定格式自动产生号码')}</p>}
                </div>
                <select required value={form.customer_id} onChange={(e) => {
                  const cid = e.target.value;
                  const cust = (customers?.data || []).find((c: any) => c.id === cid);
                  setForm({
                    ...form, customer_id: cid,
                    attn: cust?.name || '', customer_phone: cust?.phone || '',
                    customer_email: cust?.email || '', customer_address: cust?.address || '',
                  });
                }}
                  className="px-3 py-2 border rounded-md bg-background text-sm">
                  <option value="">{tr('Select Customer *', '選擇客戶 *', '选择客户 *')}</option>
                  {(customers?.data || []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
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
                  <button type="button" onClick={addItem} className="text-xs text-primary hover:underline">+ 新增項目</button>
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

      {/* View Invoice Modal */}
      {viewId && invoiceDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setViewId(null)}>
          <div className="bg-card border rounded-xl p-6 w-[90vw] max-w-[90vw] h-[85vh] mx-4 flex gap-6" onClick={(e) => e.stopPropagation()}>
            {/* Left: details */}
            <div className="w-[45%] flex flex-col min-h-0 overflow-y-auto pr-2 space-y-4">
              <div className="flex justify-between items-center">
                <h3 className="font-bold text-lg">
                  {invoiceDetail.receipt_number || docType === 'receipt'
                    ? (tr('Receipt', '收據', '收据') + ' #' + (invoiceDetail.receipt_number || invoiceDetail.invoice_number))
                    : (tr('Invoice', '發票', '发票') + ' #' + invoiceDetail.invoice_number)}
                </h3>
                <button onClick={() => setViewId(null)} className="text-muted-foreground">✕</button>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-muted-foreground">
                  {invoiceDetail.receipt_number
                    ? tr('Payer / Supplier', '付款方 / 供應商', '付款方 / 供应商')
                    : invoiceDetail.direction === 'incoming' ? tr('Supplier', '供應商', '供应商') : tr('Customer', '客戶', '客户')}
                  :</span> {invoiceDetail.receipt_number
                    ? (invoiceDetail.vendor_name || invoiceDetail.customer_name || '-')
                    : invoiceDetail.direction === 'incoming'
                      ? (invoiceDetail.vendor_name || invoiceDetail.supplier_name || invoiceDetail.customer_name)
                      : invoiceDetail.customer_name}
                </div>
                <div><span className="text-muted-foreground">{tr('Status', '狀態', '状态')}:</span> <span className={statusBadge(invoiceDetail.status)}>{statusLabel(invoiceDetail.status)}</span></div>
                <div><span className="text-muted-foreground">{tr('Date', '日期', '日期')}:</span> {invoiceDetail.issue_date}</div>
                <div><span className="text-muted-foreground">{tr('Due', '到期', '到期')}:</span> {invoiceDetail.due_date || '-'}</div>
                {invoiceDetail.receipt_number && <div><span className="text-muted-foreground">{tr('Receipt No.', '收據號碼', '收据号码')}:</span> {invoiceDetail.receipt_number}</div>}
                {invoiceDetail.paid_date && <div><span className="text-muted-foreground">{tr('Payment Date', '付款日期', '付款日期')}:</span> {invoiceDetail.paid_date}</div>}
                {invoiceDetail.linked_invoice_id && (
                  <div className="col-span-2"><span className="text-muted-foreground">{tr('Linked Invoice', '已連結發票', '已连结发票')}:</span> <span className="text-green-600 font-medium">{invoiceDetail.linked_invoice_id}</span></div>
                )}
              </div>
              <table className="w-full text-sm">
                <thead><tr className="border-b"><th className="text-left p-2">{tr('Item', '項目', '项目')}</th><th className="text-right p-2">數量</th><th className="text-right p-2">單價</th><th className="text-right p-2">金額</th></tr></thead>
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
            {/* Right: uploaded document PDF (or placeholder if none) */}
            <div className="flex-1 border rounded-lg overflow-auto bg-gray-100 flex items-center justify-center">
              {invoiceDetail.file_id ? (
                <iframe
                  src={`${WORKER_API_BASE}/file-storage/${invoiceDetail.file_id}/download?token=${localStorage.getItem('token') || ''}`}
                  className="w-full h-full border-0"
                  title="Uploaded Document"
                />
              ) : (
                <div className="text-center text-muted-foreground p-8">
                  <FileText className="h-12 w-12 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">{tr('No uploaded document', '沒有上傳的文件', '没有上传的文件')}</p>
                  <p className="text-xs mt-1">{tr('This invoice was created manually.', '此發票為手動建立。', '此发票为手动建立。')}</p>
                </div>
              )}
            </div>
          </div>
        </div>
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
            queryClient.invalidateQueries({ queryKey: ['invoices'] });
          }}
        />
      )}
    </div>
  );
}
