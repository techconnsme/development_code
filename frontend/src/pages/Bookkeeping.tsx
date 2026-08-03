import React, { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import { Plus, Download, Save } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { tr } from '../lib/i18nHelpers';
import DropdownSelect from '../components/DropdownSelect';

// ── Fiscal year helpers (mirrors ChartOfAccounts.tsx) ──────────────────────
interface FiscalYearOption { label: string; startDate: string; endDate: string; }
function buildFiscalYearOptions(fiscalStartMD: string, fiscalEndMD: string): FiscalYearOption[] {
  const [sm, sd] = fiscalStartMD.split('-').map(Number);
  const [em, ed] = fiscalEndMD.split('-').map(Number);
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  let baseYear = now.getFullYear();
  if (currentMonth < sm) baseYear--;
  const opts: FiscalYearOption[] = [];
  for (let i = 5; i >= 0; i--) {
    const sy = baseYear - i;
    const ey = em <= sm ? sy + 1 : sy;
    const sD = `${sy}-${String(sm).padStart(2, '0')}-${String(sd).padStart(2, '0')}`;
    const eD = `${ey}-${String(em).padStart(2, '0')}-${String(ed).padStart(2, '0')}`;
    opts.push({ label: `${sy}-${sy + 1} (Apr ${sy} - Mar ${sy + 1})`, startDate: sD, endDate: eD });
  }
  return opts;
}

export default function Bookkeeping({ initialTab, hideTabs }: { initialTab?: 'entries' | 'accounts' | 'trial' | 'pl' | 'bs' | 'ledger' | 'export'; hideTabs?: boolean }) {
  const { i18n } = useTranslation();
  const toast = useToast();
  const { user } = useAuth();
  const isStaff = user?.role === 'staff' || user?.role === 'viewer';
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'entries' | 'accounts' | 'trial' | 'pl' | 'bs' | 'ledger' | 'export'>(initialTab || 'entries');
  useEffect(() => { if (initialTab) setTab(initialTab); }, [initialTab]);
  // Force-refresh when switching to ledger tab — ensure fresh data after page navigation
  useEffect(() => {
    if (tab === 'ledger') queryClient.invalidateQueries({ queryKey: ['ledger'] });
    if (tab === 'entries') queryClient.invalidateQueries({ queryKey: ['entries'] });
    if (tab === 'pl') queryClient.invalidateQueries({ queryKey: ['income-statement'] });
  }, [tab]);
  const [selectedFY, setSelectedFY] = useState('');
  const [showEntryForm, setShowEntryForm] = useState(false);
  const [ledgerAccount, setLedgerAccount] = useState('');

  // ── Fiscal year — mirrors ChartOfAccounts.tsx pattern ──────────────────
  const { data: fiscalData } = useQuery({
    queryKey: ['fiscal-period'],
    queryFn: () => api('/bookkeeping/fiscal-period'),
    staleTime: 0, // always fetch fresh on mount — critical for fyOptions init
  });
  const rawStart = (fiscalData as any)?.fiscal_year_start || '04-01';
  const rawEnd = (fiscalData as any)?.fiscal_year_end || '03-31';
  // Handle both "04-01" and "2026-04-01" formats — extract MM-DD portion
  const fyStartMD = rawStart.length > 5 ? rawStart.slice(5) : rawStart;
  const fyEndMD = rawEnd.length > 5 ? rawEnd.slice(5) : rawEnd;

  // useState for fyOptions + selectedFY, set atomically in useEffect (like COA)
  const [fyOptions, setFyOptions] = useState<FiscalYearOption[]>([]);

  useEffect(() => {
    const opts = buildFiscalYearOptions(fyStartMD, fyEndMD);
    setFyOptions(opts);
    if (!selectedFY) {
      const now = new Date();
      const [sm] = fyStartMD.split('-').map(Number);
      const baseYear = now.getFullYear() - (now.getMonth() + 1 < sm ? 1 : 0);
      const def = opts.find(o => o.label.startsWith(String(baseYear))) || opts[0];
      if (def) setSelectedFY(def.label);
    }
  }, [fyStartMD]);

  // Dates derived from selectedFY — always in sync
  const selectedFYOption = useMemo(() => fyOptions.find(o => o.label === selectedFY) || null, [fyOptions, selectedFY]);
  const startDate = selectedFYOption?.startDate || '';
  const endDate = selectedFYOption?.endDate || '';
  const [entryForm, setEntryForm] = useState({
    entry_number: '', entry_date: new Date().toISOString().split('T')[0], description: '',
    lines: [{ account_code: '', account_name: '', description: '', debit: 0, credit: 0 }],
  });

  const { data: entries } = useQuery({
    queryKey: ['entries', startDate, endDate],
    queryFn: () => api(`/bookkeeping/entries?start_date=${startDate}&end_date=${endDate}`),
    enabled: tab === 'entries',
    staleTime: 0,
  });

  const { data: accounts } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api('/bookkeeping/accounts'),
    enabled: tab === 'accounts' || tab === 'ledger',
  });

  const { data: trialBalance } = useQuery({
    queryKey: ['trial-balance'],
    queryFn: () => api('/bookkeeping/trial-balance'),
    enabled: tab === 'trial',
  });

  const { data: incomeStatement } = useQuery({
    queryKey: ['income-statement', startDate, endDate],
    queryFn: () => api(`/bookkeeping/income-statement?start_date=${startDate}&end_date=${endDate}`),
    enabled: tab === 'pl' && !!startDate,
    staleTime: 0,
  });

  const { data: balanceSheet } = useQuery({
    queryKey: ['balance-sheet'],
    queryFn: () => api('/bookkeeping/balance-sheet'),
    enabled: tab === 'bs',
  });

  const { data: ledgerData, isLoading: ledgerLoading, isFetching } = useQuery({
    queryKey: ['ledger', ledgerAccount, startDate, endDate],
    queryFn: () => {
      const params = new URLSearchParams();
      if (startDate) params.set('start_date', startDate);
      if (endDate) params.set('end_date', endDate);
      if (ledgerAccount) params.set('account_code', ledgerAccount);
      const qs = params.toString();
      return api(`/bookkeeping/ledger${qs ? `?${qs}` : ''}`);
    },
    enabled: tab === 'ledger',
    staleTime: 0,
    refetchOnMount: 'always',
  });


  const createEntry = useMutation({
    mutationFn: (body: any) => api('/bookkeeping/entries', { method: 'POST', body }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['entries'] }); setShowEntryForm(false); },
  });

  const exportCSV = async () => {
    try {
      const token = localStorage.getItem('token') || '';
      const res = await fetch(`https://opcc-crm-api.ruhan-farhan.workers.dev/api/bookkeeping/export?format=csv&start_date=${startDate}&end_date=${endDate}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) { toast.info('Export failed'); return; }
      const csv = await res.text();
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'bookkeeping-export.csv'; a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) { toast.info('Export error: ' + (e?.message || 'unknown')); }
  };

  function addLine() {
    setEntryForm({
      ...entryForm,
      lines: [...entryForm.lines, { account_code: '', account_name: '', description: '', debit: 0, credit: 0 }],
    });
  }

  function updateLine(idx: number, field: string, value: any) {
    const lines = [...entryForm.lines];
    lines[idx] = { ...lines[idx], [field]: value };
    if (field === 'debit') lines[idx].credit = 0;
    if (field === 'credit') lines[idx].debit = 0;
    setEntryForm({ ...entryForm, lines });
  }

  const tabs = [
    { id: 'entries', label: '分錄 Entries' },
    { id: 'accounts', label: '科目 Accounts' },
    { id: 'ledger', label: '分類帳 Ledger' },
    { id: 'trial', label: '試算 Trial Balance' },
    { id: 'pl', label: '損益 P&L' },
    { id: 'bs', label: '資產負債 Balance Sheet' },
    { id: 'export', label: '導出 Export' },
  ] as const;

  return (
    <div className="space-y-6">
      {hideTabs ? (
        <div>
          <h2 className="text-2xl font-bold">
            {tab === 'entries' ? tr('Entries', '分錄', '分录')
             : tab === 'pl' ? tr('Income Statement', '損益表', '损益表')
             : tab === 'trial' ? tr('Trial Balance', '試算表', '试算表')
             : tab === 'bs' ? tr('Balance Sheet', '資產負債表', '资产负债表')
             : tab === 'ledger' ? tr('General Ledger Report', '總帳報告', '总帐报告')
             : tab === 'export' ? tr('Export', '匯出', '导出')
             : tr('Entries', '分錄', '分录')}
          </h2>
          <p className="text-muted-foreground mt-1">
            {tab === 'entries' ? tr('All journal entries supporting the financial statements.', '所有支援財務報表的日記帳分錄。', '所有支援财务报表的日记帐分录。')
             : tab === 'pl' ? tr('Revenue, expenses, and profit/loss for the selected period.', '所選期間的收入、支出及損益。', '所选期间的收入、支出及损益。')
             : tab === 'trial' ? tr('Debit and credit balances for all accounts at period end.', '期末所有科目的借方及貸方餘額。', '期末所有科目的借方及贷方余额。')
             : tab === 'bs' ? tr('Assets, liabilities, and equity as at the selected date.', '截至選定日期的資產、負債及權益。', '截至选定日期的资产、负债及权益。')
             : tab === 'ledger' ? tr('Detailed transaction report by account and period.', '按科目及期間的詳細交易報告。', '按科目及期间的详细交易报告。')
             : tab === 'export' ? tr('Export your bookkeeping data to CSV.', '將記帳數據匯出為 CSV。', '将记帐数据导出为 CSV。')
             : ''}
          </p>
        </div>
      ) : (
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">記帳 Bookkeeping</h2>
          <p className="text-muted-foreground mt-1">雙式記帳管理</p>
        </div>
        <button onClick={() => setShowEntryForm(true)}
          className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:opacity-90">
          <Plus className="h-4 w-4" /> 新增分錄
        </button>
      </div>
      )}

      {/* Tabs */}
      {!hideTabs && (
      <div className="flex gap-1 border-b">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === t.id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
            {t.label}
          </button>
        ))}
      </div>
      )}

      {/* Fiscal year filter — same pattern as Chart of Accounts */}
      {(tab === 'entries' || tab === 'pl' || tab === 'ledger' || tab === 'export') && fyOptions.length > 0 && (
        <DropdownSelect
          value={selectedFY}
          options={fyOptions.map(o => ({ value: o.label, label: o.label }))}
          onChange={setSelectedFY}
          className="min-w-[260px]"
        />
      )}

      {/* Entries Tab */}
      {tab === 'entries' && (
        <div className="bg-card border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left p-3">號碼</th>
                <th className="text-left p-3">日期</th>
                <th className="text-left p-3">描述</th>
                <th className="text-right p-3">借方 Debit</th>
                <th className="text-right p-3">貸方 Credit</th>
                <th className="text-left p-3">狀態</th>
                <th className="text-center p-3 w-[80px]">操作</th>
              </tr>
            </thead>
            <tbody>
              {(entries?.data || []).map((e: any) => (
                <tr key={e.id} className="border-b hover:bg-muted/30">
                  <td className="p-3 font-medium">{e.entry_number}</td>
                  <td className="p-3">{e.entry_date}</td>
                  <td className="p-3">{e.description}</td>
                  <td className="p-3 text-right font-mono">{e.total_debit > 0 ? e.total_debit.toLocaleString(undefined, { minimumFractionDigits: 2 }) : ''}</td>
                  <td className="p-3 text-right font-mono">{e.total_credit > 0 ? e.total_credit.toLocaleString(undefined, { minimumFractionDigits: 2 }) : ''}</td>
                  <td className="p-3">
                    {e.status === 'stale' ? <span className="text-amber-600 font-medium" title="銀行交易已修改，分錄可能過時">⚠ 過時</span>
                     : e.status === 'draft' ? <span className="text-muted-foreground italic">草稿 Draft</span>
                     : e.status}
                    {e.status === 'draft' && (
                      <button onClick={async () => {
                        await api(`/bookkeeping/entries/${e.id}/status`, { method: 'PATCH', body: { status: 'posted' } });
                        queryClient.invalidateQueries({ queryKey: ['entries'] });
                      }} className="ml-2 text-xs text-primary hover:underline">過帳 Post</button>
                    )}
                  </td>
                  <td className="p-3 text-center">
                    <button onClick={() => {
                      if (!confirm('確定要刪除此分錄嗎？此操作不可撤銷。')) return;
                      api(`/bookkeeping/entries/${e.id}`, { method: 'DELETE' }).then(() => {
                        queryClient.invalidateQueries({ queryKey: ['entries'] });
                      }).catch(err => toast.info('刪除失敗：' + (err.message || '未知錯誤')));
                    }} className="text-destructive text-xs hover:underline">刪除</button>
                  </td>
                </tr>
              ))}
              {(!entries?.data || entries.data.length === 0) && (
                <tr><td colSpan={7} className="text-center p-6 text-muted-foreground">未有分錄記錄</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Accounts Tab */}
      {tab === 'accounts' && <AccountsTab accounts={accounts?.data || []} />}

      {/* Trial Balance Tab */}
      {tab === 'trial' && (
        <div className="bg-card border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left p-3">科目</th>
                <th className="text-right p-3">期初 Opening</th>
                <th className="text-right p-3">借方 Debit</th>
                <th className="text-right p-3">貸方 Credit</th>
                <th className="text-right p-3">期末 Ending</th>
              </tr>
            </thead>
            <tbody>
              {(trialBalance?.data || []).map((row: any) => (
                <tr key={row.account_code} className="border-b hover:bg-muted/30">
                  <td className="p-3">{row.account_code} – {row.account_name}</td>
                  <td className="p-3 text-right">{row.opening_balance?.toLocaleString() || '0'}</td>
                  <td className="p-3 text-right">{row.total_debit?.toLocaleString()}</td>
                  <td className="p-3 text-right">{row.total_credit?.toLocaleString()}</td>
                  <td className="p-3 text-right font-medium">{row.ending_balance?.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Ledger Tab */}
      {tab === 'ledger' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <DropdownSelect
              key={`ledger-acct-${accounts?.data?.length || 0}`}
              value={ledgerAccount}
              options={[
                { value: '', label: '所有科目' },
                ...(accounts?.data || []).map((a: any) => ({ value: a.account_code, label: `${a.account_code} – ${a.account_name}` })),
              ]}
              onChange={setLedgerAccount}
              className="min-w-[180px]"
            />
            <span className="text-xs text-muted-foreground">
              {tr('Source:', '資料來源：', '资料来源：')}
              {ledgerData?.source === 'journal' ? tr('Journal Entries', '分錄', '分录') : tr('Bank Transactions', '銀行交易', '银行交易')}
            </span>
          </div>

          {ledgerLoading ? (
            <div className="flex justify-center py-8"><div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" /></div>
          ) : (ledgerData?.accounts || []).length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">未有分類帳資料</p>
          ) : (
            (ledgerData?.accounts || []).map((acct: any) => (
              <div key={acct.account_code} className="bg-card border rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 bg-muted/50 border-b flex items-center justify-between">
                  <span className="font-medium text-sm">{acct.account_code} – {acct.account_name}</span>
                  <span className="text-xs text-muted-foreground capitalize">{acct.account_type}</span>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="text-left py-2 px-4 font-medium">日期</th>
                      <th className="text-left py-2 px-3 font-medium">描述</th>
                      <th className="text-right py-2 px-3 font-medium">借方 Debit</th>
                      <th className="text-right py-2 px-3 font-medium">貸方 Credit</th>
                      <th className="text-right py-2 px-3 font-medium">餘額 Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {acct.entries.map((e: any, i: number) => (
                      <tr key={i} className="border-b border-muted/30 hover:bg-muted/20">
                        <td className="py-1.5 px-4 whitespace-nowrap text-muted-foreground">{e.date}</td>
                        <td className="py-1.5 px-3 max-w-[300px] truncate">{e.description}</td>
                        <td className="py-1.5 px-3 text-right font-mono">{e.debit > 0 ? e.debit.toLocaleString(undefined, { minimumFractionDigits: 2 }) : ''}</td>
                        <td className="py-1.5 px-3 text-right font-mono">{e.credit > 0 ? e.credit.toLocaleString(undefined, { minimumFractionDigits: 2 }) : ''}</td>
                        <td className={`py-1.5 px-3 text-right font-mono font-medium ${e.balance >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {e.balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-muted/30 text-xs font-medium">
                      <td className="py-2 px-4" colSpan={2}>合計</td>
                      <td className="py-2 px-3 text-right font-mono">{acct.total_debit.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                      <td className="py-2 px-3 text-right font-mono">{acct.total_credit.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ))
          )}
        </div>
      )}

      {/* P&L Tab */}
      {tab === 'pl' && incomeStatement && (
        <div className="bg-card border rounded-xl p-6 max-w-md space-y-3">
          <div className="flex justify-between">
            <span className="text-muted-foreground">收入 Revenue</span>
            <span className="font-semibold text-green-600">HKD {incomeStatement.revenue?.toLocaleString()}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">支出 Expenses</span>
            <span className="font-semibold text-red-600">HKD {incomeStatement.expenses?.toLocaleString()}</span>
          </div>
          <div className="flex justify-between border-t pt-2">
            <span className="font-bold">淨利 Net Income</span>
            <span className={`font-bold ${(incomeStatement.net_income || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              HKD {incomeStatement.net_income?.toLocaleString()}
            </span>
          </div>
        </div>
      )}

      {/* Balance Sheet Tab */}
      {tab === 'bs' && balanceSheet && (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">截至 As of: {balanceSheet.as_of} | 來源 Source: {balanceSheet.source === 'journal' ? '分錄' : '銀行交易估算'}</p>

          {/* Assets */}
          <div className="bg-card border rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 bg-blue-50 dark:bg-blue-950/30 border-b font-semibold text-blue-700 dark:text-blue-300">
              資產 Assets
            </div>
            <table className="w-full text-sm">
              <tbody>
                {(balanceSheet.assets || []).map((a: any) => (
                  <tr key={a.code} className="border-b border-muted/30 hover:bg-muted/20">
                    <td className="py-2 px-4">{a.code} – {a.name}</td>
                    <td className="py-2 px-4 text-right font-mono">{a.balance?.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                  </tr>
                ))}
                <tr className="bg-muted/30 font-bold">
                  <td className="py-2.5 px-4">總資產 Total Assets</td>
                  <td className="py-2.5 px-4 text-right font-mono">{balanceSheet.total_assets?.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Liabilities */}
          <div className="bg-card border rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 bg-red-50 dark:bg-red-950/30 border-b font-semibold text-red-700 dark:text-red-300">
              負債 Liabilities
            </div>
            <table className="w-full text-sm">
              <tbody>
                {(balanceSheet.liabilities || []).length === 0 ? (
                  <tr><td className="py-4 px-4 text-center text-muted-foreground">無負債項目</td></tr>
                ) : (
                  (balanceSheet.liabilities || []).map((l: any) => (
                    <tr key={l.code} className="border-b border-muted/30 hover:bg-muted/20">
                      <td className="py-2 px-4">{l.code} – {l.name}</td>
                      <td className="py-2 px-4 text-right font-mono">{l.balance?.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                    </tr>
                  ))
                )}
                <tr className="bg-muted/30 font-bold">
                  <td className="py-2.5 px-4">總負債 Total Liabilities</td>
                  <td className="py-2.5 px-4 text-right font-mono">{balanceSheet.total_liabilities?.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Equity */}
          <div className="bg-card border rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 bg-green-50 dark:bg-green-950/30 border-b font-semibold text-green-700 dark:text-green-300">
              股東權益 Equity
            </div>
            <table className="w-full text-sm">
              <tbody>
                {(balanceSheet.equity || []).map((e: any) => (
                  <tr key={e.code} className="border-b border-muted/30 hover:bg-muted/20">
                    <td className="py-2 px-4">{e.code} – {e.name}</td>
                    <td className="py-2 px-4 text-right font-mono">{e.balance?.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                  </tr>
                ))}
                <tr className="bg-muted/30 font-bold">
                  <td className="py-2.5 px-4">總權益 Total Equity</td>
                  <td className="py-2.5 px-4 text-right font-mono">{balanceSheet.total_equity?.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Accounting Equation Check */}
          <div className={`p-3 rounded-lg text-sm font-medium text-center ${balanceSheet.check ? 'bg-green-50 dark:bg-green-950/30 text-green-700' : 'bg-red-50 dark:bg-red-950/30 text-red-700'}`}>
            {balanceSheet.check
              ? `✓ 會計等式平衡：Assets (${balanceSheet.total_assets?.toLocaleString()}) = Liabilities (${balanceSheet.total_liabilities?.toLocaleString()}) + Equity (${balanceSheet.total_equity?.toLocaleString()})`
              : `⚠ 會計等式不平衡！差異：${Math.abs((balanceSheet.total_assets || 0) - ((balanceSheet.total_liabilities || 0) + (balanceSheet.total_equity || 0))).toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
          </div>
        </div>
      )}

      {/* Export Tab */}
      {tab === 'export' && (
        <div className="bg-card border rounded-xl p-6 space-y-4">
          <h3 className="font-semibold">{tr('Export for Auditor', '導出給審計師 Export for Auditor', '导出給审计师 Export for Auditor')}</h3>
          <p className="text-sm text-muted-foreground">{tr('Select a date range and export CSV file', '選擇日期範圍後導出 CSV 檔案', '选择日期范围後导出 CSV 档案')}</p>
          <div className="flex gap-3 items-center">
            <input type="date" value={startDate} readOnly
              className="px-3 py-2 border rounded-md bg-background text-sm" />
            <span className="text-muted-foreground">至</span>
            <input type="date" value={endDate} readOnly
              className="px-3 py-2 border rounded-md bg-background text-sm" />
            {!isStaff && (
            <button onClick={exportCSV}
              className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm hover:opacity-90">
              <Download className="h-4 w-4" /> {tr('Export CSV', '導出 CSV', '导出 CSV')}
            </button>
            )}
          </div>
        </div>
      )}

      {/* Entry Form Modal */}
      {showEntryForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 overflow-y-auto" onClick={() => setShowEntryForm(false)}>
          <div className="bg-card border rounded-xl p-6 w-full max-w-2xl mx-4 my-8 space-y-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-lg">新增分錄 Journal Entry</h3>
            <form onSubmit={(e) => { e.preventDefault(); createEntry.mutate(entryForm); }} className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <input required value={entryForm.entry_number} onChange={(e) => setEntryForm({ ...entryForm, entry_number: e.target.value })}
                  placeholder="分錄號碼 *" className="px-3 py-2 border rounded-md bg-background text-sm" />
                <input type="date" required value={entryForm.entry_date} onChange={(e) => setEntryForm({ ...entryForm, entry_date: e.target.value })}
                  className="px-3 py-2 border rounded-md bg-background text-sm" />
                <input required value={entryForm.description} onChange={(e) => setEntryForm({ ...entryForm, description: e.target.value })}
                  placeholder="描述 *" className="px-3 py-2 border rounded-md bg-background text-sm" />
              </div>
              <div className="border rounded-md p-3 space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-medium">分錄行 Lines</span>
                  <button type="button" onClick={addLine} className="text-xs text-primary hover:underline">+ 新增行</button>
                </div>
                {entryForm.lines.map((line, idx) => (
                  <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                    <input required value={line.account_code} onChange={(e) => {
                      const code = e.target.value;
                      updateLine(idx, 'account_code', code);
                      const match = (accounts?.data || []).find((a: any) => a.account_code === code);
                      if (match) updateLine(idx, 'account_name', match.account_name);
                    }} placeholder="科目編號" list="account-list" className="col-span-2 px-2 py-1 border rounded text-sm" />
                    <select value={line.account_name} onChange={(e) => {
                      const name = e.target.value;
                      updateLine(idx, 'account_name', name);
                      const match = (accounts?.data || []).find((a: any) => a.account_name === name);
                      if (match) updateLine(idx, 'account_code', match.account_code);
                    }} className="col-span-3 px-2 py-1 border rounded text-sm bg-background">
                      <option value="">選擇科目...</option>
                      {(accounts?.data || []).map((a: any) => (
                        <option key={a.id} value={a.account_name}>{a.account_code} – {a.account_name}</option>
                      ))}
                    </select>
                    <input type="number" step="0.01" value={line.debit} onChange={(e) => updateLine(idx, 'debit', parseFloat(e.target.value))}
                      className="col-span-2 px-2 py-1 border rounded text-sm" placeholder="借方" />
                    <input type="number" step="0.01" value={line.credit} onChange={(e) => updateLine(idx, 'credit', parseFloat(e.target.value))}
                      className="col-span-2 px-2 py-1 border rounded text-sm" placeholder="貸方" />
                    <input value={line.description} onChange={(e) => updateLine(idx, 'description', e.target.value)}
                      placeholder="描述" className="col-span-2 px-2 py-1 border rounded text-sm" />
                    <button type="button" onClick={() => {
                      const lines = entryForm.lines.filter((_, i) => i !== idx);
                      setEntryForm({ ...entryForm, lines: lines.length ? lines : [{ account_code: '', account_name: '', description: '', debit: 0, credit: 0 }] });
                    }} className="col-span-1 text-destructive text-xs">✕</button>
                  </div>
                ))}
                <div className="text-sm text-muted-foreground">
                  借方總計: {entryForm.lines.reduce((s, l) => s + (l.debit || 0), 0).toFixed(2)} |
                  貸方總計: {entryForm.lines.reduce((s, l) => s + (l.credit || 0), 0).toFixed(2)}
                </div>
              </div>
              <div className="flex gap-3 justify-end">
                <button type="button" onClick={() => setShowEntryForm(false)} className="px-4 py-2 border rounded-md text-sm">取消</button>
                <button type="submit" disabled={createEntry.isPending}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm">建立</button>
              </div>
            </form>
            <datalist id="account-list">
              {(accounts?.data || []).map((a: any) => (
                <option key={a.id} value={a.account_code}>{a.account_code} – {a.account_name}</option>
              ))}
            </datalist>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════ Accounts Tab with B/F balance & fiscal period ═══════

function AccountsTab({ accounts }: { accounts: any[] }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [bfEdits, setBfEdits] = useState<Record<string, string>>({});
  const [fiscalStart, setFiscalStart] = useState('');
  const [fiscalEnd, setFiscalEnd] = useState('');
  const [fiscalSaved, setFiscalSaved] = useState(false);
  const [closedPeriods, setClosedPeriods] = useState<any[]>([]);

  const fetchClosedPeriods = () => {
    api('/bookkeeping/closed-periods').then((d: any) => setClosedPeriods(d.data || []));
  };

  // Fetch fiscal period and closed periods
  useEffect(() => {
    api('/bookkeeping/fiscal-period').then((d: any) => {
      if (d.fiscal_year_start) setFiscalStart(d.fiscal_year_start);
      if (d.fiscal_year_end) setFiscalEnd(d.fiscal_year_end);
    });
    fetchClosedPeriods();
  }, []);

  const saveBF = async (code: string) => {
    const val = parseFloat(bfEdits[code]);
    if (isNaN(val)) return;
    await api(`/bookkeeping/accounts/${code}`, { method: 'PATCH', body: { opening_balance: val } });
    queryClient.invalidateQueries({ queryKey: ['accounts'] });
    setBfEdits(prev => { const n = {...prev}; delete n[code]; return n; });
  };

  const saveFiscal = async () => {
    await api('/bookkeeping/fiscal-period', { method: 'PATCH', body: { fiscal_year_start: fiscalStart, fiscal_year_end: fiscalEnd } });
    setFiscalSaved(true);
    setTimeout(() => setFiscalSaved(false), 2000);
  };

  const grouped: Record<string, any[]> = {};
  for (const a of accounts) {
    const parent = a.parent_code || '__root__';
    if (!grouped[parent]) grouped[parent] = [];
    grouped[parent].push(a);
  }

  const topLevel = (code: string) => !accounts.find((a: any) => a.parent_code === code);

  return (
    <div className="space-y-4">
      {/* Fiscal period */}
      <div className="bg-card border rounded-xl p-4 flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium">財政年度 Fiscal Period</span>
        <span className="text-xs text-muted-foreground">起</span>
        <input type="month" value={fiscalStart} onChange={e => setFiscalStart(e.target.value)}
          className="px-2 py-1 border rounded text-sm bg-background" />
        <span className="text-xs text-muted-foreground">至</span>
        <input type="month" value={fiscalEnd} onChange={e => setFiscalEnd(e.target.value)}
          className="px-2 py-1 border rounded text-sm bg-background" />
        <button onClick={saveFiscal}
          className={`px-3 py-1 rounded text-xs font-medium ${fiscalSaved ? 'bg-green-100 text-green-700' : 'bg-primary text-primary-foreground hover:opacity-90'}`}>
          {fiscalSaved ? '✓ 已儲存' : '儲存'}
        </button>
      </div>

      {/* Period & Year-End Actions */}
      <div className="bg-card border rounded-xl p-4 space-y-3">
        <span className="text-sm font-medium">會計操作 Actions</span>
        <div className="flex flex-wrap gap-2">
          <button onClick={async () => {
            const start = prompt('關帳期間起 (YYYY-MM-DD)：');
            const end = prompt('關帳期間至 (YYYY-MM-DD)：');
            if (!start || !end) return;
            await api('/bookkeeping/close-period', { method: 'POST', body: { period_start: start, period_end: end } });
            fetchClosedPeriods();
            toast.info('已關帳');
          }} className="px-3 py-1.5 bg-amber-100 text-amber-800 rounded text-xs font-medium hover:bg-amber-200">
            關帳 Close Period
          </button>
          <button onClick={async () => {
            if (!confirm('確定要執行年結嗎？這會將所有收入/費用科目結轉至保留盈餘，並更新承上結餘。')) return;
            const date = prompt('財政年度結束日 (YYYY-MM-DD)：', fiscalEnd || '');
            if (!date) return;
            const res = await api('/bookkeeping/year-end-close', { method: 'POST', body: { fiscal_end_date: date } });
            toast.info(`年結完成！\n收入：HKD ${res.revenue?.toLocaleString()}\n支出：HKD ${res.expenses?.toLocaleString()}\n淨利：HKD ${res.net_income?.toLocaleString()}`);
            queryClient.invalidateQueries({ queryKey: ['entries'] });
            queryClient.invalidateQueries({ queryKey: ['accounts'] });
          }} className="px-3 py-1.5 bg-blue-100 text-blue-800 rounded text-xs font-medium hover:bg-blue-200">
            年結 Year-End Close
          </button>
          <button onClick={async () => {
            if (!confirm('確定要計算利得稅撥備嗎？（預設稅率 16.5%，首 $2M 為 8.25%）')) return;
            const date = prompt('財政年度結束日 (YYYY-MM-DD)：', fiscalEnd || '');
            if (!date) return;
            const res = await api('/bookkeeping/profits-tax-provision', { method: 'POST', body: { fiscal_end_date: date } });
            toast.info(`利得稅撥備完成！\n應評稅利潤：HKD ${res.net_income?.toLocaleString()}\n稅款：HKD ${res.tax_amount?.toLocaleString()}`);
            queryClient.invalidateQueries({ queryKey: ['entries'] });
          }} className="px-3 py-1.5 bg-red-100 text-red-800 rounded text-xs font-medium hover:bg-red-200">
            利得稅撥備 Tax Provision
          </button>
        </div>
        {closedPeriods.length > 0 && (
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">已關帳期間 Closed Periods</span>
            {closedPeriods.map((cp: any) => (
              <div key={cp.id} className="flex items-center justify-between bg-muted/30 rounded px-3 py-1.5">
                <span className="text-xs">{cp.period_start} ~ {cp.period_end}</span>
                <button onClick={async () => {
                  if (!confirm(`確定要重開 ${cp.period_start} ~ ${cp.period_end} 的關帳嗎？`)) return;
                  await api(`/bookkeeping/close-period/${cp.id}`, { method: 'DELETE' });
                  fetchClosedPeriods();
                }} className="text-xs text-destructive hover:underline">重開 Reopen</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Accounts with B/F balance */}
      <div className="bg-card border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="text-left p-3 w-[100px]">科目編號</th>
              <th className="text-left p-3">科目名稱</th>
              <th className="text-left p-3 w-[80px]">類別</th>
              <th className="text-right p-3 w-[180px]">承上結餘 B/F</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a: any) => {
              const isParent = grouped[a.account_code]?.length > 0;
              const indent = a.account_code?.length <= 5 ? 0 : (a.account_code?.length === 5 ? 1 : 2);
              const editing = a.account_code in bfEdits;
              const bfVal = editing ? bfEdits[a.account_code] : (a.opening_balance || 0);
              return (
                <tr key={a.id} className={`border-b hover:bg-muted/30 ${isParent ? 'font-semibold bg-muted/20' : ''}`}>
                  <td className="p-3 font-mono text-xs" style={{paddingLeft: `${12 + indent * 16}px`}}>
                    {a.account_code}
                  </td>
                  <td className="p-3 truncate max-w-[300px]">{a.account_name}</td>
                  <td className="p-3 text-xs capitalize text-muted-foreground">{a.account_type}</td>
                  <td className="p-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <input
                        type="number" step="0.01"
                        value={bfVal}
                        onChange={e => setBfEdits(prev => ({...prev, [a.account_code]: e.target.value}))}
                        onKeyDown={e => { if (e.key === 'Enter') saveBF(a.account_code); }}
                        onBlur={() => { if (editing) saveBF(a.account_code); }}
                        className="w-32 px-2 py-1 border rounded text-xs text-right bg-background"
                      />
                      {editing && (
                        <button onClick={() => saveBF(a.account_code)}
                          className="p-1 text-primary hover:bg-primary/10 rounded">
                          <Save className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
