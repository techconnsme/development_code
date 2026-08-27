import React, { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import { tr } from '../lib/i18nHelpers';
import { filterLeafAccounts } from '../lib/coa-hierarchy';
import ExpenseAttachments from '../components/ExpenseAttachments';
import type { PickedFile } from '../components/DocumentPickerModal';
import { Plus, Wallet, Trash2 } from 'lucide-react';

// Petty Cash tab inside the Expenses page (/invoices?tab=petty-cash).
// Embeddable component — no page-level padding; the Expenses shell provides it.
// Journal posting already existed pre-2026-08-27 rework: the form posts a
// balanced GJE (Dr expense category / Cr 11101 Cash on Hand) via
// POST /bookkeeping/entries with reference_type 'petty_cash'.
export default function PettyCash() {
  const { i18n } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    amount: '', description: '', category: '',
    entry_date: new Date().toISOString().split('T')[0],
    files: [] as PickedFile[],
  });

  // Fetch petty cash journal entries
  const { data: entriesData, isLoading } = useQuery({
    queryKey: ['petty-cash-entries'],
    queryFn: () => api('/bookkeeping/ledger?account_code=11101&limit=100'),
  });

  // Fetch COA accounts — categories are the tenant's own expense accounts.
  // Hardcoded category codes (62401, 64202, …) 400'd on tenants whose COA
  // doesn't carry them ("Account code(s) not found"), so the picker now
  // reflects the real chart of accounts.
  const { data: accountsData } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api('/bookkeeping/accounts'),
  });

  const accounts = accountsData?.data || [];
  const CATEGORIES = useMemo(
    () => filterLeafAccounts(accounts).filter((a: any) => a.account_type === 'expense' || a.account_type === 'cost'),
    [accounts],
  );
  // Default to the first expense account once the COA loads
  useEffect(() => {
    if (!form.category && CATEGORIES.length > 0) setForm(f => ({ ...f, category: CATEGORIES[0].account_code }));
  }, [CATEGORIES]);
  const accountMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of accounts) m.set(a.account_code, a.account_name);
    return m;
  }, [accounts]);

  // Filter to only show petty cash entries (reference_type = petty_cash)
  const cashLedger = entriesData?.accounts?.find((a: any) => a.account_code === '11101');
  const entries = useMemo(() => {
    if (!cashLedger?.entries) return [];
    return cashLedger.entries
      .filter((e: any) => e.description?.includes('[PC]') || e.reference_type === 'petty_cash')
      .slice(0, 50);
  }, [cashLedger]);

  // Calculate running balance (most recent first)
  const balance = cashLedger?.entries?.[0]?.balance ?? 0;

  const createMut = useMutation({
    mutationFn: (body: any) => api('/bookkeeping/entries', { method: 'POST', body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['petty-cash-entries'] });
      queryClient.invalidateQueries({ queryKey: ['entries'] });
      setShowForm(false);
      setForm({
        amount: '', description: '', category: CATEGORIES[0]?.account_code || '',
        entry_date: new Date().toISOString().split('T')[0], files: [],
      });
      toast.success(tr('Petty cash expense recorded!', '零用金支出已記錄！', '零用金支出已记录！'));
    },
    onError: (err: any) => {
      toast.info(`Failed: ${err?.message || err?.error || 'Unknown error'}`);
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api(`/bookkeeping/entries/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['petty-cash-entries'] });
      queryClient.invalidateQueries({ queryKey: ['entries'] });
    },
    onError: (err: any) => toast.info(`Delete failed: ${err?.message || 'Unknown error'}`),
  });

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const amt = parseFloat(form.amount);
    if (!amt || amt <= 0) return;
    const cat = CATEGORIES.find((c: any) => c.account_code === form.category);
    if (!cat) return;
    const label = cat.account_name;
    const desc = `[PC] ${form.description || label}`;
    const entryNum = `PC-${Date.now().toString(36).toUpperCase()}`;
    createMut.mutate({
      entry_number: entryNum,
      entry_date: form.entry_date,
      description: desc,
      reference_type: 'petty_cash',
      reference_id: `pc-${Date.now().toString(36)}`,
      file_ids: form.files.map(f => f.id),
      lines: [
        { account_code: cat.account_code, account_name: label, description: form.description || label, debit: amt, credit: 0 },
        { account_code: '11101', account_name: accountMap.get('11101') || 'Cash on Hand', description: form.description || label, debit: 0, credit: amt },
      ],
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold flex items-center gap-2">
            <Wallet className="h-5 w-5 text-amber-600" /> {tr('Petty Cash', '零用金', '零用金')}
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            {tr('Track small cash expenses — office supplies, meals, transport, etc.', '記錄小額現金支出 — 辦公室用品、餐飲、交通等。', '记录小额现金支出 — 办公室用品、餐饮、交通等。')}
          </p>
        </div>
        <button onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700 flex items-center gap-2">
          <Plus className="h-4 w-4" />
          {tr('New Expense', '新支出', '新支出')}
        </button>
      </div>

      {/* Balance card */}
      <div className="bg-card border rounded-xl p-6 flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">{tr('Cash on Hand Balance', '現金結餘', '现金结余')}</p>
          <p className={`text-3xl font-bold ${balance >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            HKD {balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </p>
        </div>
        <Wallet className="h-10 w-10 text-amber-200" />
      </div>

      {/* Add expense form */}
      {showForm && (
        <form onSubmit={handleCreate} className="bg-card border rounded-xl p-4 space-y-3">
          <h3 className="font-semibold text-sm">{tr('Record Cash Expense', '記錄現金支出', '记录现金支出')}</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground block mb-0.5">{tr('Date', '日期', '日期')}</label>
              <input type="date" value={form.entry_date} onChange={e => setForm({ ...form, entry_date: e.target.value })}
                className="w-full px-3 py-2 border rounded-md bg-background text-sm" required />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-0.5">{tr('Amount (HKD)', '金額 (HKD)', '金额 (HKD)')}</label>
              <input type="number" step="0.01" min="0.01" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })}
                className="w-full px-3 py-2 border rounded-md bg-background text-sm" placeholder="0.00" required />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-0.5">{tr('Category', '類別', '类别')}</label>
              <select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}
                className="pc-category w-full px-3 py-2 border rounded-md bg-background text-sm">
                {CATEGORIES.map((c: any) => (
                  <option key={c.id} value={c.account_code}>{c.account_code} – {c.account_name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-0.5">{tr('Description', '描述', '描述')}</label>
              <input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
                className="w-full px-3 py-2 border rounded-md bg-background text-sm" placeholder={tr('e.g. taxi, stationery', '例：的士、文具', '例：的士、文具')} />
            </div>
          </div>

          {/* Attachments: pick unlinked documents or upload directly (non-OCR) */}
          <ExpenseAttachments
            files={form.files}
            onChange={(files) => setForm({ ...form, files })}
            uploadFolder="Petty Cash"
          />

          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setShowForm(false)}
              className="px-4 py-2 border rounded-md text-sm hover:bg-muted">{tr('Cancel', '取消', '取消')}</button>
            <button type="submit" disabled={createMut.isPending}
              className="px-4 py-2 bg-amber-600 text-white rounded-md text-sm font-medium hover:bg-amber-700 disabled:opacity-50">
              {createMut.isPending ? tr('Saving…', '儲存中…', '储存中…') : tr('Record Expense', '記錄支出', '记录支出')}
            </button>
          </div>
        </form>
      )}

      {/* Transaction list */}
      <div className="bg-card border rounded-xl overflow-hidden">
        <div className="px-4 py-2.5 bg-muted/50 border-b font-semibold text-sm">
          {tr('Recent Cash Transactions', '最近現金交易', '最近现金交易')}
        </div>
        {isLoading ? (
          <div className="flex justify-center py-8"><div className="animate-spin h-5 w-5 border-2 border-amber-600 border-t-transparent rounded-full" /></div>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">{tr('No petty cash transactions yet.', '尚無零用金交易。', '尚无零用金交易。')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="text-left py-2 px-4">{tr('Date', '日期', '日期')}</th>
                <th className="text-left py-2 px-3">{tr('Description', '描述', '描述')}</th>
                <th className="text-right py-2 px-3">{tr('Amount', '金額', '金额')}</th>
                <th className="text-right py-2 px-3">{tr('Balance', '結餘', '结余')}</th>
                <th className="text-center py-2 px-3 w-16">{tr('Del', '刪', '删')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e: any, i: number) => (
                <tr key={i} className="border-b border-muted/30 hover:bg-muted/20">
                  <td className="py-1.5 px-4 whitespace-nowrap text-muted-foreground">{e.date}</td>
                  <td className="py-1.5 px-3 max-w-[300px] truncate" title={e.description}>
                    {e.description?.replace('[PC] ', '')}
                  </td>
                  <td className="py-1.5 px-3 text-right font-mono text-red-600">
                    {e.debit > 0 ? `-${e.debit.toLocaleString(undefined, { minimumFractionDigits: 2 })}` : ''}
                  </td>
                  <td className={`py-1.5 px-3 text-right font-mono font-medium ${e.balance >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {e.balance?.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </td>
                  <td className="py-1.5 px-3 text-center">
                    <button onClick={() => { if (confirm(tr('Delete?', '確定刪除？', '确定删除？'))) deleteMut.mutate(e.entry_id || e.id); }}
                      className="text-red-500 hover:text-red-700 text-xs" title="Delete">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
