import React, { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import { tr } from '../lib/i18nHelpers';
import { filterLeafAccounts } from '../lib/coa-hierarchy';
import { ChevronDown, ChevronRight, FilePlus2, Paperclip, Trash2 } from 'lucide-react';
import type { PickedFile } from '../components/DocumentPickerModal';
import ExpenseAttachments from '../components/ExpenseAttachments';

// Others tab inside the Expenses page (/invoices?tab=others).
// Simplified single-expense form: description + amount + Dr expense account +
// Cr payment source, attach not-yet-linked documents, post a journal entry
// (reference_type 'other_expense'). Full multi-line power stays on the GJE page.
export default function ExpensesOthers() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailCache, setDetailCache] = useState<Record<string, { lines: any[]; files: any[] }>>({});
  const [form, setForm] = useState({
    entry_date: new Date().toISOString().split('T')[0],
    description: '',
    amount: '',
    dr_account: '',
    cr_account: '',
    files: [] as PickedFile[],
  });

  const { data: accountsData } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api('/bookkeeping/accounts'),
  });
  const leafAccounts = useMemo(
    () => filterLeafAccounts(accountsData?.data || []),
    [accountsData],
  );
  const expenseAccounts = useMemo(
    () => leafAccounts.filter((a: any) => a.account_type === 'expense' || a.account_type === 'cost'),
    [leafAccounts],
  );
  const byCode = (code: string) => leafAccounts.find((a: any) => a.account_code === code);

  const { data: entriesData, isLoading } = useQuery({
    queryKey: ['others-entries'],
    queryFn: () => api('/bookkeeping/entries?reference_type=other_expense&limit=50'),
  });
  const entries = entriesData?.data || [];

  const fmtMoney = (n: number) => (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2 });
  const amt = parseFloat(form.amount);
  const canSubmit = !!form.description.trim() && !!form.dr_account && !!form.cr_account
    && !!form.entry_date && !!amt && amt > 0 && form.dr_account !== form.cr_account;

  function resetForm() {
    setForm({
      entry_date: new Date().toISOString().split('T')[0],
      description: '', amount: '', dr_account: '', cr_account: '', files: [],
    });
  }

  function post(duplicateAcknowledged: boolean) {
    const dr = byCode(form.dr_account)!;
    const cr = byCode(form.cr_account)!;
    createMut.mutate({
      entry_date: form.entry_date,
      description: form.description.trim(),
      reference_type: 'other_expense',
      duplicate_acknowledged: duplicateAcknowledged,
      file_ids: form.files.map(f => f.id),
      lines: [
        { account_code: dr.account_code, account_name: dr.account_name, description: form.description.trim(), debit: amt, credit: 0 },
        { account_code: cr.account_code, account_name: cr.account_name, description: form.description.trim(), debit: 0, credit: amt },
      ],
    });
  }

  const createMut = useMutation({
    mutationFn: (body: any) => api('/bookkeeping/entries', { method: 'POST', body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['others-entries'] });
      queryClient.invalidateQueries({ queryKey: ['entries'] });
      setShowForm(false);
      resetForm();
      toast.success(tr('Journal entry posted', '日誌帳已記錄', '日志帐已记录'));
    },
    onError: (err: any) => {
      if (err?.body?.error_code === 'similar_entry_exists') {
        if (window.confirm(tr(
          'A similar entry with the same date, amount and account already exists. Post anyway?',
          '已存在相同日期、金額及科目的分錄。仍要記錄？',
          '已存在相同日期、金额及科录的分录。仍要记录？',
        ))) post(true);
        return;
      }
      toast.error(err?.message || tr('Failed to post', '記錄失敗', '记录失败'));
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api(`/bookkeeping/entries/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['others-entries'] });
      queryClient.invalidateQueries({ queryKey: ['entries'] });
    },
    onError: (err: any) => toast.error(err?.message || tr('Delete failed', '刪除失敗', '删除失败')),
  });

  async function toggleDetail(id: string) {
    if (expandedId === id) { setExpandedId(null); return; }
    setExpandedId(id);
    if (!detailCache[id]) {
      try {
        const d = await api(`/bookkeeping/entries/${id}`);
        setDetailCache(prev => ({ ...prev, [id]: { lines: d.lines || [], files: d.files || [] } }));
      } catch { /* row simply stays collapsed on failure */ }
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold flex items-center gap-2">
            <FilePlus2 className="h-5 w-5 text-primary" /> {tr('Other Expenses', '其他支出', '其他支出')}
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            {tr('Manually record an expense, attach documents and post the journal entry.', '手動記錄支出、附加文件並記錄日誌帳。', '手动记录支出、附加文件并记录日志帐。')}
          </p>
        </div>
        <button onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:opacity-90">
          <FilePlus2 className="h-4 w-4" />
          {tr('New Other Expense', '新增其他支出', '新增其他支出')}
        </button>
      </div>

      {/* Simplified single-expense form */}
      {showForm && (
        <form onSubmit={(e) => { e.preventDefault(); if (canSubmit) post(false); }}
          className="bg-card border rounded-xl p-4 space-y-3">
          <h4 className="font-semibold text-sm">{tr('Record Expense & Post Journal', '記錄支出並過帳', '记录支出并过帐')}</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground block mb-0.5">{tr('Date', '日期', '日期')}</label>
              <input type="date" required value={form.entry_date}
                onChange={(e) => setForm({ ...form, entry_date: e.target.value })}
                className="w-full px-3 py-2 border rounded-md bg-background text-sm" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-0.5">{tr('Amount (HKD)', '金額 (HKD)', '金额 (HKD)')}</label>
              <input type="number" step="0.01" min="0.01" required value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                className="w-full px-3 py-2 border rounded-md bg-background text-sm" placeholder="0.00" />
            </div>
            <div className="sm:col-span-2">
              <label className="text-xs text-muted-foreground block mb-0.5">{tr('Description', '支出描述', '支出描述')}</label>
              <input required value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder={tr('Expense description', '支出描述', '支出描述')}
                className="w-full px-3 py-2 border rounded-md bg-background text-sm" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-0.5">{tr('Expense Account (Dr)', '支出科目 (借方 Dr)', '支出科目 (借方 Dr)')}</label>
              <select required className="dr-account w-full px-3 py-2 border rounded-md bg-background text-sm"
                value={form.dr_account} onChange={(e) => setForm({ ...form, dr_account: e.target.value })}>
                <option value="">{tr('Select expense account...', '選擇支出科目...', '选择支出科目...')}</option>
                {expenseAccounts.map((a: any) => (
                  <option key={a.id} value={a.account_code}>{a.account_code} – {a.account_name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-0.5">{tr('Paid From (Cr)', '付款來源 (貸方 Cr)', '付款来源 (贷方 Cr)')}</label>
              <select required className="cr-account w-full px-3 py-2 border rounded-md bg-background text-sm"
                value={form.cr_account} onChange={(e) => setForm({ ...form, cr_account: e.target.value })}>
                <option value="">{tr('Select account...', '選擇科目...', '选择科目...')}</option>
                {leafAccounts.map((a: any) => (
                  <option key={a.id} value={a.account_code}>{a.account_code} – {a.account_name}</option>
                ))}
              </select>
            </div>
          </div>

          {form.dr_account && form.cr_account && form.dr_account === form.cr_account && (
            <p className="text-xs text-red-600">
              {tr('Dr and Cr accounts must differ', '借貸科目不可相同', '借贷科目不可相同')}
            </p>
          )}

          {/* Attachments: pick unlinked documents or upload directly (non-OCR) */}
          <ExpenseAttachments
            files={form.files}
            onChange={(files) => setForm({ ...form, files })}
            uploadFolder="Others"
          />

          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => { setShowForm(false); resetForm(); }}
              className="px-4 py-2 border rounded-md text-sm hover:bg-muted">{tr('Cancel', '取消', '取消')}</button>
            <button type="submit" disabled={!canSubmit || createMut.isPending}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed">
              {createMut.isPending ? tr('Posting…', '記錄中…', '记录中…') : tr('Post Journal', '記錄日誌帳', '记录日志帐')}
            </button>
          </div>
        </form>
      )}

      {/* Recent other-expense journal entries */}
      <div className="bg-card border rounded-xl overflow-hidden">
        <div className="px-4 py-2.5 bg-muted/50 border-b font-semibold text-sm">
          {tr('Recent Other Expenses', '最近其他支出', '最近其他支出')}
        </div>
        {isLoading ? (
          <div className="flex justify-center py-8"><div className="animate-spin h-5 w-5 border-2 border-primary border-t-transparent rounded-full" /></div>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            {tr('No other expenses posted yet.', '尚未記錄其他支出。', '尚未记录其他支出。')}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="w-8 py-2 px-3"></th>
                <th className="text-left py-2 px-3">{tr('Voucher No.', '總帳 #', '总帐 #')}</th>
                <th className="text-left py-2 px-3">{tr('Date', '日期', '日期')}</th>
                <th className="text-left py-2 px-3">{tr('Description', '描述', '描述')}</th>
                <th className="text-right py-2 px-3">{tr('Amount', '金額', '金额')}</th>
                <th className="text-center py-2 px-3 w-16">{tr('Del', '刪', '删')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e: any) => (
                <React.Fragment key={e.id}>
                  <tr className="border-b border-muted/30 hover:bg-muted/20 cursor-pointer" onClick={() => toggleDetail(e.id)}>
                    <td className="py-1.5 px-3">
                      {expandedId === e.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </td>
                    <td className="py-1.5 px-3 font-mono text-xs">{e.entry_number}</td>
                    <td className="py-1.5 px-3 whitespace-nowrap text-muted-foreground">{e.entry_date}</td>
                    <td className="py-1.5 px-3 max-w-[320px] truncate" title={e.description}>{e.description}</td>
                    <td className="py-1.5 px-3 text-right font-mono text-red-600">${fmtMoney(e.total_debit)}</td>
                    <td className="py-1.5 px-3 text-center">
                      <button onClick={(ev) => { ev.stopPropagation(); if (confirm(tr('Delete this entry?', '確定刪除此分錄？', '确定删除此分录？'))) deleteMut.mutate(e.id); }}
                        className="text-red-500 hover:text-red-700" title={tr('Delete', '刪除', '删除')}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                  {expandedId === e.id && (
                    <tr className="border-b border-muted/30">
                      <td colSpan={6} className="px-8 py-2 bg-muted/10">
                        {(detailCache[e.id]?.lines || []).length === 0 ? (
                          <span className="text-xs text-muted-foreground">{tr('Loading lines…', '載入分錄行…', '载入分录行…')}</span>
                        ) : (
                          <>
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-muted-foreground border-b">
                                  <th className="text-left py-1 font-medium">{tr('Account', '科目', '科目')}</th>
                                  <th className="text-left py-1 font-medium">{tr('Description', '描述', '描述')}</th>
                                  <th className="text-right py-1 font-medium">{tr('Debit ($Dr$)', '借方 ($Dr$)', '借方 ($Dr$)')}</th>
                                  <th className="text-right py-1 font-medium">{tr('Credit ($Cr$)', '貸方 ($Cr$)', '贷方 ($Cr$)')}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(detailCache[e.id]?.lines || []).map((l: any, i: number) => (
                                  <tr key={i} className="border-b border-muted/20">
                                    <td className="py-1">{l.account_code} – {l.account_name}</td>
                                    <td className="py-1">{l.description || '—'}</td>
                                    <td className="py-1 text-right font-mono">{l.debit > 0 ? '$' + fmtMoney(l.debit) : ''}</td>
                                    <td className="py-1 text-right font-mono">{l.credit > 0 ? '$' + fmtMoney(l.credit) : ''}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {(detailCache[e.id]?.files || []).length > 0 && (
                              <div className="flex items-center gap-2 flex-wrap pt-2">
                                <span className="text-xs text-muted-foreground">{tr('Attached documents:', '已附加文件：', '已附加文件：')}</span>
                                {(detailCache[e.id]?.files || []).map((f: any) => (
                                  <span key={f.id} className="inline-flex items-center gap-1 text-xs border rounded-md px-2 py-0.5">
                                    <Paperclip className="h-3 w-3" />{f.filename}
                                  </span>
                                ))}
                              </div>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>

    </div>
  );
}
