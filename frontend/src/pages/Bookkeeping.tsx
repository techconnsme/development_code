import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import { Plus, Download, Save, RefreshCw, ChevronRight, ChevronDown, AlertTriangle, X, ExternalLink } from 'lucide-react';
import { useHighlightTarget } from '../hooks/useHighlightTarget';
import { useAuth } from '../contexts/AuthContext';
import { tr } from '../lib/i18nHelpers';
import { filterLeafAccounts, stemOfCode } from '../lib/coa-hierarchy';
import DropdownSelect from '../components/DropdownSelect';
import { useDateFilter } from '../contexts/DateFilterContext';
import PnlFormulaBanner from '../components/PnlFormulaBanner';

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
  const [showEntryForm, setShowEntryForm] = useState(false);
  const [ledgerAccount, setLedgerAccount] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [entryDetails, setEntryDetails] = useState<Record<string, any[]>>({});
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null);
  const [entryAuditTrail, setEntryAuditTrail] = useState<Record<string, any[]>>({});
  const [loadingAudit, setLoadingAudit] = useState<string | null>(null);
  const highlightId = useHighlightTarget();
  const bookkeepingNavigate = useNavigate();
  const [expandedPL, setExpandedPL] = useState<Record<string, boolean>>({ cost: true });
  const [selectedPLAccount, setSelectedPLAccount] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const entryRowRef = useRef<HTMLTableRowElement | null>(null);
  const navigate = useNavigate();

  // Deep-link a bank transaction into its statement card on the Bank Statements page
  const handlePostClick = (bankStatementId: string, transactionId: string) => {
    navigate(`/bank-statements?statement=${encodeURIComponent(bankStatementId)}&highlight=${encodeURIComponent(transactionId)}`);
  };

  const { startDate, endDate } = useDateFilter();
  // P&L account transaction drill-down
  const { data: plTransactions, isFetching: plTxFetching } = useQuery({
    queryKey: ['pl-transactions', selectedPLAccount, startDate, endDate],
    queryFn: () => api(`/bookkeeping/income-statement/${selectedPLAccount}/transactions?start_date=${startDate}&end_date=${endDate}`),
    enabled: tab === 'pl' && !!selectedPLAccount,
  });
  const [entryForm, setEntryForm] = useState({
    entry_number: '', entry_date: new Date().toISOString().split('T')[0], description: '',
    lines: [{ account_code: '', account_name: '', description: '', debit: 0, credit: 0, project: '' }],
  });

  const { data: entries } = useQuery({
    queryKey: ['entries', startDate, endDate],
    queryFn: () => api(`/bookkeeping/entries?start_date=${startDate}&end_date=${endDate}`),
    enabled: tab === 'entries',
    staleTime: 0,
  });

  // Fetch a specific entry when ?entry=<id> is in the URL (from review queue).
  // This bypasses the fiscal-year date filter so the entry is always visible.
  const entryParam = searchParams.get('entry');
  const { data: highlightedEntry } = useQuery({
    queryKey: ['entry', entryParam],
    queryFn: () => api(`/bookkeeping/entries/${entryParam}`),
    enabled: tab === 'entries' && !!entryParam,
  });

  // Auto-expand the highlighted entry row if it's in the table
  useEffect(() => {
    if (!entryParam || tab !== 'entries' || !entries?.data) return;
    const inTable = entries.data.find((e: any) => e.id === entryParam);
    if (inTable) {
      setExpandedId(entryParam);
      if (!entryDetails[entryParam]) {
        setLoadingDetail(entryParam);
        api(`/bookkeeping/entries/${entryParam}`)
          .then(d => setEntryDetails(prev => ({ ...prev, [entryParam]: d.lines || [] })))
          .catch(() => {})
          .finally(() => setLoadingDetail(null));
      }
      const tryScroll = (retries: number) => {
        const row = document.getElementById(`entry-row-${entryParam}`);
        if (row) {
          row.scrollIntoView({ behavior: 'smooth', block: 'center' });
          row.classList.add('ring-2', 'ring-blue-400');
          setTimeout(() => row.classList.remove('ring-2', 'ring-blue-400'), 3000);
        } else if (retries > 0) {
          setTimeout(() => tryScroll(retries - 1), 150);
        }
      };
      tryScroll(5);
    }
  }, [entryParam, tab, entries?.data]);
  // suppress exhaustive-deps: only re-run when the entry param actually changes

  // Auto-expand from highlight navigation
  useEffect(() => {
    if (!highlightId || tab !== 'entries' || !entries?.data) return;
    const inTable = entries.data.find((e: any) => e.id === highlightId);
    if (inTable) {
      setExpandedId(highlightId);
      toggleEntryDetail(highlightId);
      setTimeout(() => {
        document.getElementById(`entry-row-${highlightId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    }
  }, [highlightId, entries?.data, tab]);

  const { data: accounts } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api('/bookkeeping/accounts'),
    enabled: tab === 'accounts' || tab === 'ledger' || tab === 'entries',
  });
  // Only leaf (postable) accounts for journal-entry pickers — parents are groups
  const leafAccounts = useMemo(
    () => filterLeafAccounts(accounts?.data || []),
    [accounts]
  );

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

  const autoGenerateMut = useMutation({
    mutationFn: () => api('/bookkeeping/auto-generate-entries', { method: 'POST' }),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['entries'] });
      if (data.created > 0) {
        toast.info(tr(
          `${data.created} journal entries generated, ${data.skipped || 0} skipped, ${data.stale_deleted || 0} stale cleaned up.`,
          `已產生 ${data.created} 筆日誌分錄，跳過 ${data.skipped || 0} 筆，清理 ${data.stale_deleted || 0} 筆過時記錄。`,
          `已产生 ${data.created} 笔日志分录，跳过 ${data.skipped || 0} 笔，清理 ${data.stale_deleted || 0} 笔过时记录。`,
        ));
      } else {
        toast.info(tr('All transactions already have journal entries.', '所有交易已有日誌分錄。', '所有交易已有日志分录。'));
      }
    },
    onError: (err: any) => {
      toast.info(tr('Auto-generate failed: ', '自動產生失敗：', '自动产生失败：') + (err?.message || err?.error || 'Unknown'));
    },
  });

  const exportCSV = async () => {
    try {
      const token = localStorage.getItem('token') || '';
      const res = await fetch(`/api/bookkeeping/export?format=csv&start_date=${startDate}&end_date=${endDate}`, {
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
      lines: [...entryForm.lines, { account_code: '', account_name: '', description: '', debit: 0, credit: 0, project: '' }],
    });
  }

  function updateLine(idx: number, field: string, value: any) {
    const lines = [...entryForm.lines];
    lines[idx] = { ...lines[idx], [field]: value };
    if (field === 'debit') lines[idx].credit = 0;
    if (field === 'credit') lines[idx].debit = 0;
    setEntryForm({ ...entryForm, lines });
  }

  // ── Shared helpers ──────────────────────────────────────────────────────
  const fmtMoney = (n: number) => (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2 });

  const totals = useMemo(() => {
    const debit = entryForm.lines.reduce((s, l) => s + (l.debit || 0), 0);
    const credit = entryForm.lines.reduce((s, l) => s + (l.credit || 0), 0);
    return { debit, credit, diff: debit - credit, balanced: Math.abs(debit - credit) <= 0.001 };
  }, [entryForm.lines]);
  const canSubmit = totals.balanced && entryForm.lines.length >= 2 && !createEntry.isPending;

  function suggestVoucherNumber(entryRows: any[] | undefined, date: string, prefix = 'GJ'): string {
    const ym = date.slice(0, 7).replace(/-/g, '');
    const pattern = `${prefix}-${ym}-`;
    let maxSeq = 0;
    for (const e of entryRows || []) {
      if ((e.entry_number || '').startsWith(pattern)) {
        const seq = parseInt((e.entry_number as string).slice(pattern.length), 10);
        if (!isNaN(seq)) maxSeq = Math.max(maxSeq, seq);
      }
    }
    return `${pattern}${String(maxSeq + 1).padStart(3, '0')}`;
  }

  // Reset form with fresh voucher suggestion when modal opens
  useEffect(() => {
    if (!showEntryForm) return;
    const today = new Date().toISOString().split('T')[0];
    setEntryForm({
      entry_number: suggestVoucherNumber(entries?.data, today),
      entry_date: today,
      description: '',
      lines: [{ account_code: '', account_name: '', description: '', debit: 0, credit: 0, project: '' }],
    });
  }, [showEntryForm]);

  const toggleEntryDetail = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (!entryDetails[id]) {
      setLoadingDetail(id);
      try {
        const data = await api(`/bookkeeping/entries/${id}`);
        setEntryDetails(prev => ({ ...prev, [id]: data.lines || [] }));
      } catch (err) {
        console.error('Failed to load entry details', err);
      } finally {
        setLoadingDetail(null);
      }
    }
    if (!entryAuditTrail[id]) {
      setLoadingAudit(id);
      try {
        const trail = await api(`/bookkeeping/entries/${id}/audit-trail`);
        setEntryAuditTrail(prev => ({ ...prev, [id]: trail }));
      } catch (err) {
        console.error('Failed to load audit trail', err);
      } finally {
        setLoadingAudit(null);
      }
    }
  };

  // 'stale' is no longer a status — deleted entries carry deleted_at instead and
  // are filtered out server-side, so they never reach this table.
  function statusBadge(s: string) {
    const styles: Record<string, string> = {
      draft: 'bg-muted text-muted-foreground',
      posted: 'bg-emerald-100 text-emerald-800 border border-emerald-200',
      reconciled: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40',
    };
    const labels: Record<string, string> = {
      draft: tr('Draft', '草稿 Draft', '草稿 Draft'),
      posted: tr('Posted', '已過帳 Posted', '已过帐 Posted'),
      reconciled: tr('Reconciled', '已對帳 Reconciled', '已对帐 Reconciled'),
    };
    return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${styles[s] || 'bg-muted text-muted-foreground'}`}>{labels[s] || s}</span>;
  }

  const tabs = [
    { id: 'entries', label: tr('GJE', 'GJE 日誌帳', 'GJE 日志帐') },
    { id: 'accounts', label: tr('Accounts', '科目 Accounts', '科目 Accounts') },
    { id: 'pl', label: tr('P&L', '損益 P&L', '损益 P&L') },
    { id: 'bs', label: tr('Balance Sheet', '資產負債 Balance Sheet', '资产负债表 Balance Sheet') },
    { id: 'trial', label: tr('Trial Balance', '試算 Trial Balance', '试算 Trial Balance') },
    { id: 'ledger', label: tr('Ledger', '分類帳 Ledger', '分类帐 Ledger') },
    { id: 'export', label: tr('Export', '導出 Export', '导出 Export') },
  ] as const;

  return (
    <div className="space-y-6">
      {hideTabs ? (
        <div>
          <h2 className="text-2xl font-bold">
            {tab === 'entries' ? tr('General Journal Entries (GJE)', '記帳日誌帳 (GJE)', '记账日志帐 (GJE)')
             : tab === 'pl' ? tr('Income Statement', '損益表', '损益表')
             : tab === 'trial' ? tr('Trial Balance', '試算表', '试算表')
             : tab === 'bs' ? tr('Balance Sheet', '資產負債表', '资产负债表')
             : tab === 'ledger' ? tr('General Ledger Report', '總帳報告', '总帐报告')
             : tab === 'export' ? tr('Export', '匯出', '导出')
             : tr('General Journal Entries (GJE)', '記帳日誌帳 (GJE)', '记账日志帐 (GJE)')}
          </h2>
          <p className="text-muted-foreground mt-1">
            {tab === 'entries' ? tr('General Journal Entries — record and manage double-entry journal vouchers.', '通用日誌帳 — 記錄及管理複式記帳日誌憑證。', '通用日志帐 — 记录及管理复式记账日志凭证。')
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
          <Plus className="h-4 w-4" /> {tr('+ New GJE', '+ 新增日誌帳', '+ 新增日志帐')}
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

      {/* Header controls bar for standalone GJE page */}
      {hideTabs && tab === 'entries' && (
        <div className="flex flex-wrap items-center gap-3 bg-card border rounded-xl px-4 py-3">
          <div className="flex-1" />
          {!isStaff && (
            <button onClick={() => setShowEntryForm(true)}
              className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:opacity-90">
              <Plus className="h-4 w-4" /> {tr('New General Journal Entry', '新增日誌帳', '新增日志帐')}
            </button>
          )}
          {!isStaff && (
            <button onClick={() => autoGenerateMut.mutate()}
              disabled={autoGenerateMut.isPending}
              className="flex items-center gap-2 border px-4 py-2 rounded-md text-sm font-medium hover:bg-muted disabled:opacity-50">
              <RefreshCw className={`h-4 w-4 ${autoGenerateMut.isPending ? 'animate-spin' : ''}`} />
              {autoGenerateMut.isPending ? tr('Generating...', '產生中...', '产生中...') : tr('+ Auto-Generate Journal Entries', '+ 自動產生日誌分錄', '+ 自动产生日志分录')}
            </button>
          )}
          {!isStaff && (
            <button onClick={exportCSV}
              className="flex items-center gap-2 border px-4 py-2 rounded-md text-sm font-medium hover:bg-muted">
              <Download className="h-4 w-4" /> {tr('Export CSV', '匯出 CSV', '导出 CSV')}
            </button>
          )}
        </div>
      )}

      {/* Entries Tab */}
      {tab === 'entries' && (() => {
        const draftCount = (entries?.data || []).filter((e: any) => e.status === 'draft').length;
        return (
        <div className="space-y-4">
          {draftCount > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                    {draftCount} unposted journal {draftCount === 1 ? 'entry' : 'entries'}
                  </p>
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    These affect your trial balance and financial statements. Review and post them to finalize.
                  </p>
                </div>
              </div>
              <a href="/review-queue" className="px-3 py-1.5 text-xs bg-amber-600 text-white rounded hover:bg-amber-700 shrink-0">
                Review →
              </a>
            </div>
          )}
        <div className="bg-card border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="w-8 p-3"></th>
                <th className="text-left p-3">{tr('Voucher No.', '總帳 #', '总帐 #')}</th>
                <th className="text-left p-3">{tr('Date', '日期', '日期')}</th>
                <th className="text-left p-3">{tr('Description', '備忘', '备记')}</th>
                <th className="text-right p-3">{tr('Debit ($Dr$)', '借方 ($Dr$)', '借方 ($Dr$)')}</th>
                <th className="text-right p-3">{tr('Credit ($Cr$)', '貸方 ($Cr$)', '贷方 ($Cr$)')}</th>
                <th className="text-left p-3">{tr('Status', '狀態', '状态')}</th>
                <th className="text-center p-3 w-[80px]">{tr('Actions', '操作', '操作')}</th>
              </tr>
            </thead>
            <tbody>
              {(entries?.data || []).map((e: any) => (
                <React.Fragment key={e.id}>
                <tr id={`entry-row-${e.id}`} onClick={() => toggleEntryDetail(e.id)} className={`border-b hover:bg-muted/30 cursor-pointer ${expandedId === e.id ? 'bg-muted/40' : ''} ${e.status === 'draft' ? 'bg-amber-50 dark:bg-amber-950/20' : ''}`}>
                  <td className="p-3">
                    <span className="p-0.5 inline-flex">
                      {expandedId === e.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </span>
                  </td>
                  <td className="p-3 font-medium font-mono text-xs">{e.entry_number}</td>
                  <td className="p-3">{e.entry_date}</td>
                  <td className="p-3 max-w-[200px] truncate" title={e.description}>{e.description}</td>
                  <td className="p-3 text-right font-mono">{e.total_debit > 0 ? '$' + fmtMoney(e.total_debit) : ''}</td>
                  <td className="p-3 text-right font-mono">{e.total_credit > 0 ? '$' + fmtMoney(e.total_credit) : ''}</td>
                  <td className="p-3">{statusBadge(e.status)}</td>
                  <td className="p-3 text-center">
                    <div className="flex items-center justify-center gap-2">
                      <button onClick={(ev) => { ev.stopPropagation(); toggleEntryDetail(e.id); }} className="text-primary text-xs hover:underline" title={tr('View details & audit trail', '查看詳情及審計軌跡', '查看详情及审计轨迹')}>
                        {expandedId === e.id ? tr('Hide', '隱藏', '隐藏') : tr('View', '查看', '查看')}
                      </button>
                      {!isStaff && (
                        <button onClick={(ev) => { ev.stopPropagation(); if (!confirm(tr('Confirm delete? This action cannot be undone.', '確定要刪除此分錄嗎？此操作不可撤銷。', '确定要删除此分录吗？此操作不可撤销。'))) return; api(`/bookkeeping/entries/${e.id}`, { method: 'DELETE' }).then(() => { queryClient.invalidateQueries({ queryKey: ['entries'] }); }).catch(err => toast.info(tr('Delete failed: ', '刪除失敗：', '删除失败：') + (err.message || ''))); }} className="text-destructive text-xs hover:underline">{tr('Delete', '刪除', '删除')}</button>
                      )}
                    </div>
                  </td>
                </tr>
                {expandedId === e.id && (
                  <tr key={`${e.id}-detail`} className="bg-muted/20 border-b animate-slide-down">
                    <td colSpan={8} className="p-0">
                      <div className="px-8 py-3">
                        {loadingDetail === e.id ? (
                          <div className="flex justify-center py-4"><div className="animate-spin h-5 w-5 border-2 border-primary border-t-transparent rounded-full" /></div>
                        ) : (entryDetails[e.id] || []).length === 0 ? (
                          <p className="text-xs text-muted-foreground py-2">{tr('No line details', '暫無分錄行資料', '暂无分录行资料')}</p>
                        ) : (
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="border-b text-muted-foreground">
                                <th className="text-left py-1.5 font-medium w-8">#</th>
                                <th className="text-left py-1.5 font-medium">{tr('Account', '科目', '科目')}</th>
                                <th className="text-left py-1.5 font-medium">{tr('Description', '描述', '描述')}</th>
                                <th className="text-left py-1.5 font-medium">{tr('Project/Item', '項目', '项目')}</th>
                                <th className="text-right py-1.5 font-medium">{tr('Debit ($Dr$)', '借方 ($Dr$)', '借方 ($Dr$)')}</th>
                                <th className="text-right py-1.5 font-medium">{tr('Credit ($Cr$)', '貸方 ($Cr$)', '贷方 ($Cr$)')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(entryDetails[e.id] || []).map((l: any, i: number) => (
                                <tr key={i} className="border-b border-muted/30">
                                  <td className="py-1 px-2 text-muted-foreground">{i + 1}</td>
                                  <td className="py-1 px-2">{l.account_code} – {l.account_name}</td>
                                  <td className="py-1 px-2 max-w-[240px] truncate" title={l.description || ''}>{l.description || '—'}</td>
                                  <td className="py-1 px-2 max-w-[120px] truncate" title={l.project || ''}>{l.project || '—'}</td>
                                  <td className="py-1 px-2 text-right font-mono">{l.debit > 0 ? '$' + fmtMoney(l.debit) : ''}</td>
                                  <td className="py-1 px-2 text-right font-mono">{l.credit > 0 ? '$' + fmtMoney(l.credit) : ''}</td>
                                </tr>
                              ))}
                            </tbody>
                            <tfoot>
                              <tr className="font-medium border-t">
                                <td colSpan={4} className="py-1.5 px-2">{tr('Totals', '合計', '合计')}</td>
                                <td className="py-1.5 px-2 text-right font-mono">${fmtMoney(e.total_debit)}</td>
                                <td className="py-1.5 px-2 text-right font-mono">${fmtMoney(e.total_credit)}</td>
                              </tr>
                            </tfoot>
                          </table>
                        )}
                        {/* Linked Items Section */}
                        {e.resolved_links && (
                          <div className="mt-4 border-t pt-3">
                            <h4 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
                              {tr('Linked Items', '關聯項目', '关联项目')}
                            </h4>
                            <div className="flex flex-wrap gap-2">
                              {e.resolved_links.bank_statement && (
                                <button
                                  onClick={() => bookkeepingNavigate('/bank-statements', { state: { highlight: e.resolved_links.bank_statement.id } })}
                                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300"
                                >
                                  <ExternalLink className="h-3 w-3" />
                                  {tr('Statement', '結單', '结单')}: {e.resolved_links.bank_statement.statement_number || e.resolved_links.bank_statement.id}
                                </button>
                              )}
                              {e.resolved_links.bank_transaction && (
                                <button
                                  onClick={() => {
                                    const stmtId = e.resolved_links.bank_transaction.statement_id;
                                    if (stmtId) bookkeepingNavigate(`/bank-statements/review/${stmtId}`, { state: { highlight: e.resolved_links.bank_transaction.id } });
                                  }}
                                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full border border-green-200 bg-green-50 text-green-700 hover:bg-green-100 dark:border-green-800 dark:bg-green-950 dark:text-green-300"
                                >
                                  <ExternalLink className="h-3 w-3" />
                                  {tr('Transaction', '交易', '交易')}: {e.resolved_links.bank_transaction.description || e.resolved_links.bank_transaction.id}
                                </button>
                              )}
                              {e.resolved_links.invoice && (
                                <button
                                  onClick={() => {
                                    const target = e.resolved_links.invoice.direction === 'incoming' ? '/ap' : '/ar';
                                    bookkeepingNavigate(target, { state: { highlight: e.resolved_links.invoice.id } });
                                  }}
                                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full border border-purple-200 bg-purple-50 text-purple-700 hover:bg-purple-100 dark:border-purple-800 dark:bg-purple-950 dark:text-purple-300"
                                >
                                  <ExternalLink className="h-3 w-3" />
                                  {e.resolved_links.invoice.direction === 'incoming' ? tr('Bill', '帳單', '账单') : tr('Invoice', '發票', '发票')}: {e.resolved_links.invoice.invoice_number}
                                  {e.resolved_links.invoice.vendor_or_customer ? ` (${e.resolved_links.invoice.vendor_or_customer})` : ''}
                                </button>
                              )}
                              {e.resolved_links.linked_invoices?.map((li: any) => (
                                <button
                                  key={li.id}
                                  onClick={() => bookkeepingNavigate('/ap', { state: { highlight: li.id } })}
                                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full border border-purple-200 bg-purple-50 text-purple-700 hover:bg-purple-100 dark:border-purple-800 dark:bg-purple-950 dark:text-purple-300"
                                >
                                  <ExternalLink className="h-3 w-3" />
                                  {tr('Bill', '帳單', '账单')}: {li.invoice_number} (${li.allocated_amount.toFixed(2)})
                                </button>
                              ))}
                              {e.resolved_links.reversal && (
                                <button
                                  onClick={() => bookkeepingNavigate('/GJE', { state: { highlight: e.resolved_links.reversal.id } })}
                                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full border border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
                                >
                                  <ExternalLink className="h-3 w-3" />
                                  {tr('Reversed by', '反轉由', '反转由')}: {e.resolved_links.reversal.entry_number}
                                </button>
                              )}
                            </div>
                          </div>
                        )}
                        {/* Audit Trail Section */}
                        <div className="mt-4 border-t pt-3">
                          <h4 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
                            {tr('Audit Trail', '審計軌跡', '审计轨迹')}
                          </h4>
                          {loadingAudit === e.id ? (
                            <div className="flex justify-center py-2"><div className="animate-spin h-4 w-4 border-2 border-primary border-t-transparent rounded-full" /></div>
                          ) : (entryAuditTrail[e.id] || []).length === 0 ? (
                            <p className="text-xs text-muted-foreground">{tr('No audit history', '暫無審計歷史', '暂无审计历史')}</p>
                          ) : (
                            <div className="space-y-2 max-h-60 overflow-y-auto">
                              {(entryAuditTrail[e.id] || []).map((trail: any) => (
                                <div key={trail.id} className="text-xs border-l-2 border-muted pl-3 py-1">
                                  <div className="flex items-center gap-2 text-muted-foreground">
                                    <span className="font-mono">{new Date(trail.created_at).toLocaleString()}</span>
                                    <span className="text-foreground font-medium">{trail.user_email}</span>
                                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted">
                                      {trail.action}
                                    </span>
                                  </div>
                                  {trail.changes?.filter((c: any) => !c.field.startsWith('_')).map((change: any, ci: number) => (
                                    <div key={ci} className="mt-0.5 text-muted-foreground">
                                      <span className="font-medium">{change.field}</span>: {JSON.stringify(change.old)} → {JSON.stringify(change.new)}
                                    </div>
                                  ))}
                                  {trail.action === 'create' && (
                                    <div className="mt-0.5 text-green-600 dark:text-green-400">
                                      {tr('Entry created', '分錄已建立', '分录已建立')}
                                    </div>
                                  )}
                                  {trail.action === 'delete' && (
                                    <div className="mt-0.5 text-red-600 dark:text-red-400">
                                      {tr('Entry deleted', '分錄已刪除', '分录已删除')}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
                </React.Fragment>
              ))}
              {(!entries?.data || entries.data.length === 0) && (
                <tr><td colSpan={8} className="text-center p-6 text-muted-foreground">{tr('No journal entries recorded.', '未有日誌帳記錄', '未有日志帐记录')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        </div>
        );
        })()}

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
                <th className="text-right p-3">借方 Debit ($Dr$)</th>
                <th className="text-right p-3">貸方 Credit ($Cr$)</th>
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
                { value: '', label: tr('All Accounts', '所有科目', '所有科目') },
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
                      <th className="text-right py-2 px-3 font-medium">借方 Debit ($Dr$)</th>
                      <th className="text-right py-2 px-3 font-medium">貸方 Credit ($Cr$)</th>
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
        <>
          <PnlFormulaBanner data={{
            revenue: incomeStatement.revenue || 0,
            cost: incomeStatement.cost || 0,
            gross_profit: incomeStatement.gross_profit || 0,
            expenses: incomeStatement.expenses || 0,
            net_income: incomeStatement.net_income || 0,
          }} />
          <div className="flex gap-4">
          {/* Main P&L card */}
          <div className={`bg-card border rounded-xl overflow-hidden ${selectedPLAccount ? 'max-w-xl' : 'max-w-2xl'} flex-1 transition-all duration-300`}>
            {/* Revenue section */}
            <div>
              <button
                onClick={() => setExpandedPL(prev => ({ ...prev, revenue: !prev.revenue }))}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors text-left"
              >
                <span className="shrink-0 text-muted-foreground">
                  {expandedPL.revenue ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </span>
                <span className="flex-1 font-medium text-sm">
                  {tr('Revenue', '收入', '收入')}
                </span>
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800 border border-emerald-200">
                  {(incomeStatement.revenue_accounts || []).length} {tr('COA Accounts', '科目', '科目')}
                </span>
                <span className="font-semibold text-green-600 text-sm ml-2">
                  HKD {((incomeStatement.revenue || 0)).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </span>
              </button>

              {/* Revenue drill-down with slide animation */}
              <div className={`expand-collapse ${expandedPL.revenue ? 'expand-collapse-open' : 'expand-collapse-closed'}`}>
                <div className="border-t bg-muted/10">
                  {(incomeStatement.revenue_accounts || []).length === 0 ? (
                    <p className="px-10 py-3 text-xs text-muted-foreground">
                      {tr('No linked COA accounts', '沒有關聯科目', '没有关联科目')}
                    </p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-xs text-muted-foreground">
                          <th className="text-left py-2 px-4 font-medium">{tr('Account Code', '科目編號', '科目编号')}</th>
                          <th className="text-left py-2 px-4 font-medium">{tr('Account Name', '科目名稱', '科目名称')}</th>
                          <th className="text-right py-2 px-4 font-medium">{tr('Amount', '金額', '金额')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(incomeStatement.revenue_accounts || []).map((acct: any) => (
                          <tr
                            key={acct.account_code}
                            onClick={() => setSelectedPLAccount(selectedPLAccount === acct.account_code ? null : acct.account_code)}
                            className={`border-b border-muted/20 hover:bg-muted/30 cursor-pointer transition-colors ${selectedPLAccount === acct.account_code ? 'bg-blue-50 dark:bg-blue-950/30 ring-1 ring-blue-300' : ''}`}
                          >
                            <td className="py-1.5 px-4 font-mono text-xs">{acct.account_code}</td>
                            <td className="py-1.5 px-4">{acct.account_name}</td>
                            <td className="py-1.5 px-4 text-right font-mono text-green-600">
                              HKD {(acct.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </div>

            {/* Cost section */}
            <div className="border-t">
              <button
                onClick={() => setExpandedPL(prev => ({ ...prev, cost: !prev.cost }))}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors text-left"
              >
                <span className="shrink-0 text-muted-foreground">
                  {expandedPL.cost ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </span>
                <span className="flex-1 font-medium text-sm">
                  {tr('Cost', '直接成本', '直接成本')}
                </span>
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-800 border border-orange-200">
                  {(incomeStatement.cost_accounts || []).length} {tr('COA Accounts', '科目', '科目')}
                </span>
                <span className="font-semibold text-orange-600 text-sm ml-2">
                  HKD {((incomeStatement.cost || 0)).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </span>
              </button>

              {/* Cost drill-down with slide animation */}
              <div className={`expand-collapse ${expandedPL.cost ? 'expand-collapse-open' : 'expand-collapse-closed'}`}>
                <div className="border-t bg-muted/10">
                  {(incomeStatement.cost_accounts || []).length === 0 ? (
                    <p className="px-10 py-3 text-xs text-muted-foreground">
                      {tr('No linked COA accounts', '沒有關聯科目', '没有关联科目')}
                    </p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-xs text-muted-foreground">
                          <th className="text-left py-2 px-4 font-medium">{tr('Account Code', '科目編號', '科目编号')}</th>
                          <th className="text-left py-2 px-4 font-medium">{tr('Account Name', '科目名稱', '科目名称')}</th>
                          <th className="text-right py-2 px-4 font-medium">{tr('Amount', '金額', '金额')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(incomeStatement.cost_accounts || []).map((acct: any) => (
                          <tr
                            key={acct.account_code}
                            onClick={() => setSelectedPLAccount(selectedPLAccount === acct.account_code ? null : acct.account_code)}
                            className={`border-b border-muted/20 hover:bg-muted/30 cursor-pointer transition-colors ${selectedPLAccount === acct.account_code ? 'bg-blue-50 dark:bg-blue-950/30 ring-1 ring-blue-300' : ''}`}
                          >
                            <td className="py-1.5 px-4 font-mono text-xs">{acct.account_code}</td>
                            <td className="py-1.5 px-4">{acct.account_name}</td>
                            <td className="py-1.5 px-4 text-right font-mono text-orange-600">
                              HKD {(acct.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </div>

            {/* Gross Profit subtotal */}
            <div className="border-t flex justify-between items-center px-4 py-3 bg-orange-50/40 dark:bg-orange-950/20">
              <span className="font-bold text-sm">
                {tr('Gross Profit', '毛利', '毛利')}
              </span>
              <span className={`font-bold text-sm ${(incomeStatement.gross_profit || 0) >= 0 ? 'text-orange-600' : 'text-red-600'}`}>
                HKD {(incomeStatement.gross_profit || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </span>
            </div>

            {/* Expenses section */}
            <div className="border-t">
              <button
                onClick={() => setExpandedPL(prev => ({ ...prev, expenses: !prev.expenses }))}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors text-left"
              >
                <span className="shrink-0 text-muted-foreground">
                  {expandedPL.expenses ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </span>
                <span className="flex-1 font-medium text-sm">
                  {tr('Expenses', '支出', '支出')}
                </span>
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-rose-100 text-rose-800 border border-rose-200">
                  {(incomeStatement.expense_accounts || []).length} {tr('COA Accounts', '科目', '科目')}
                </span>
                <span className="font-semibold text-red-600 text-sm ml-2">
                  HKD {((incomeStatement.expenses || 0)).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </span>
              </button>

              {/* Expenses drill-down with slide animation */}
              <div className={`expand-collapse ${expandedPL.expenses ? 'expand-collapse-open' : 'expand-collapse-closed'}`}>
                <div className="border-t bg-muted/10">
                  {(incomeStatement.expense_accounts || []).length === 0 ? (
                    <p className="px-10 py-3 text-xs text-muted-foreground">
                      {tr('No linked COA accounts', '沒有關聯科目', '没有关联科目')}
                    </p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-xs text-muted-foreground">
                          <th className="text-left py-2 px-4 font-medium">{tr('Account Code', '科目編號', '科目编号')}</th>
                          <th className="text-left py-2 px-4 font-medium">{tr('Account Name', '科目名稱', '科目名称')}</th>
                          <th className="text-right py-2 px-4 font-medium">{tr('Amount', '金額', '金额')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(incomeStatement.expense_accounts || []).map((acct: any) => (
                          <tr
                            key={acct.account_code}
                            onClick={() => setSelectedPLAccount(selectedPLAccount === acct.account_code ? null : acct.account_code)}
                            className={`border-b border-muted/20 hover:bg-muted/30 cursor-pointer transition-colors ${selectedPLAccount === acct.account_code ? 'bg-blue-50 dark:bg-blue-950/30 ring-1 ring-blue-300' : ''}`}
                          >
                            <td className="py-1.5 px-4 font-mono text-xs">{acct.account_code}</td>
                            <td className="py-1.5 px-4">{acct.account_name}</td>
                            <td className="py-1.5 px-4 text-right font-mono text-red-600">
                              HKD {(acct.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </div>

            {/* Net Income — always visible */}
            <div className="border-t flex justify-between items-center px-4 py-3 bg-muted/20">
              <span className="font-bold text-sm">
                {tr('Net Income', '淨利', '净利')}
              </span>
              <span className={`font-bold text-sm ${(incomeStatement.net_income || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                HKD {(incomeStatement.net_income || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </span>
            </div>
          </div>

          {/* Slide panel — transaction detail for selected account */}
          <div className={`slide-panel ${selectedPLAccount ? 'translate-x-0 opacity-100' : 'translate-x-full opacity-0 pointer-events-none absolute'} lg:relative bg-card border rounded-xl overflow-hidden flex-1 max-w-md self-start`}>
            {selectedPLAccount && (
              <div className="flex flex-col max-h-[70vh]">
                <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/20 shrink-0">
                  <div>
                    <span className="font-mono text-sm font-bold">{selectedPLAccount}</span>
                    <span className="text-xs text-muted-foreground ml-2">
                      {plTxFetching ? '…' : `${(plTransactions?.journal_entries?.length || 0) + (plTransactions?.bank_transactions?.length || 0)} entries`}
                    </span>
                  </div>
                  <button onClick={() => setSelectedPLAccount(null)} className="p-1 hover:bg-muted rounded">
                    <X className="h-4 w-4 text-muted-foreground" />
                  </button>
                </div>
                <div className="overflow-y-auto p-4 space-y-3">
                  {plTxFetching ? (
                    <p className="text-sm text-muted-foreground text-center py-8">{tr('Loading…', '載入中…', '载入中…')}</p>
                  ) : (
                    <>
                      {(plTransactions?.journal_entries || []).length > 0 && (
                        <div>
                          <h4 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wider">
                            {tr('Journal Entries', '日記帳分錄', '日记账分录')}
                          </h4>
                          <div className="space-y-2">
                            {(plTransactions?.journal_entries || []).map((je: any, i: number) => (
                              <div key={je.entry_id || i} className="bg-muted/30 rounded-lg p-2.5 text-xs">
                                <div className="flex items-center justify-between mb-1">
                                  <span className="font-mono font-medium">{je.entry_number}</span>
                                  <span className="text-muted-foreground">{je.entry_date}</span>
                                </div>
                                <p className="text-muted-foreground mb-1">{je.description || je.line_desc}</p>
                                <div className="flex gap-3 font-mono">
                                  {je.debit > 0 && <span className="text-blue-600">Dr {je.debit.toLocaleString()}</span>}
                                  {je.credit > 0 && <span className="text-orange-600">Cr {je.credit.toLocaleString()}</span>}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {(plTransactions?.bank_transactions || []).length > 0 && (
                        <div>
                          <h4 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wider">
                            {tr('Bank Transactions', '銀行交易', '银行交易')}
                          </h4>
                          <div className="space-y-2">
                            {(plTransactions?.bank_transactions || []).map((bt: any, i: number) => (
                              <div
                                key={bt.id || i}
                                className="bg-muted/30 rounded-lg p-2.5 text-xs"
                                onClick={bt.bank_statement_id ? () => handlePostClick(bt.bank_statement_id, bt.id) : undefined}
                                title={bt.bank_statement_id ? tr('Open in Bank Statements', '於銀行對賬開啟', '在银行对账打开') : undefined}
                              >
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-muted-foreground">{bt.transaction_date}</span>
                                  {bt.match_status && <span className="px-1 py-0.5 rounded text-[10px] bg-amber-100 text-amber-700">{bt.match_status}</span>}
                                </div>
                                <p className="text-muted-foreground mb-1">{bt.description}</p>
                                <div className="flex gap-3 font-mono">
                                  {bt.deposit_amount > 0 && <span className="text-green-600">{bt.deposit_amount.toLocaleString()}</span>}
                                  {bt.withdrawal_amount > 0 && <span className="text-red-600">({bt.withdrawal_amount.toLocaleString()})</span>}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {!(plTransactions?.journal_entries || []).length && !(plTransactions?.bank_transactions || []).length && (
                        <p className="text-sm text-muted-foreground text-center py-8">
                          {tr('No transactions for this account in this period.', '此期間該科目沒有交易。', '此期间该科目没有交易。')}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
        </>
      )}

      {/* Balance Sheet Tab */}
      {tab === 'bs' && balanceSheet && (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            {tr('As of', '截至', '截至')}: {balanceSheet.as_of} | {tr('Source', '來源', '来源')}: {balanceSheet.source === 'journal' ? tr('Journal', '分錄', '分录') : tr('Bank Estimate', '銀行交易估算', '银行交易估算')}
          </p>

          {/* Assets */}
          <div className="bg-card border rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 bg-blue-50 text-blue-900 font-bold border-b">
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
            <div className="px-4 py-2.5 bg-rose-50 text-rose-900 font-bold border-b">
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
            <div className="px-4 py-2.5 bg-emerald-50 text-emerald-900 font-bold border-b">
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

      {/* Entry Form Modal — GJE 輸入日誌帳 */}
      {showEntryForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 overflow-y-auto" onClick={() => setShowEntryForm(false)}>
          <div className="bg-card border rounded-xl p-6 w-full max-w-4xl mx-4 my-8 space-y-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-lg">{tr('Create / Edit Journal Entry', '輸入日誌帳', '输入日志帐')}</h3>
            <form onSubmit={(e) => { e.preventDefault(); createEntry.mutate(entryForm); }} className="space-y-3">
              {/* Header fields: Voucher No., Date, Narration */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">{tr('Voucher No.', '總帳 #', '总帐 #')}</label>
                  <div className="flex items-center gap-2">
                    <input required value={entryForm.entry_number}
                      onChange={(e) => setEntryForm({ ...entryForm, entry_number: e.target.value })}
                      placeholder="GJ000001" className="flex-1 px-3 py-2 border rounded-md bg-background text-sm font-mono" />
                    <button type="button" title={tr('Auto-Generate', '自動產生', '自动产生')}
                      onClick={() => setEntryForm({ ...entryForm, entry_number: suggestVoucherNumber(entries?.data, entryForm.entry_date) })}
                      className="px-2.5 py-2 border rounded-md text-xs hover:bg-muted flex items-center gap-1 shrink-0">
                      <RefreshCw className="h-3 w-3" /> {tr('Auto', '🔄', '🔄')}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">{tr('Date', '日期', '日期')}</label>
                  <input type="date" required value={entryForm.entry_date} onChange={(e) => setEntryForm({ ...entryForm, entry_date: e.target.value })}
                    className="w-full px-3 py-2 border rounded-md bg-background text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">{tr('Narration', '備忘', '备记')}</label>
                  <input required value={entryForm.description} onChange={(e) => setEntryForm({ ...entryForm, description: e.target.value })}
                    placeholder={tr('Narration', '備忘', '备记')} className="w-full px-3 py-2 border rounded-md bg-background text-sm" />
                </div>
              </div>

              {/* Lines table */}
              <div className="border rounded-md overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted/50 border-b text-xs text-muted-foreground">
                      <th className="py-2 px-2 w-8 font-medium">#</th>
                      <th className="py-2 px-2 text-left font-medium">{tr('Account #', '科目編號', '科目编号')}</th>
                      <th className="py-2 px-2 text-left font-medium">{tr('Account Name', '科目名稱', '科目名称')}</th>
                      <th className="py-2 px-2 text-right font-medium w-[120px]">{tr('Debit ($Dr$)', '借方 ($Dr$)', '借方 ($Dr$)')}</th>
                      <th className="py-2 px-2 text-right font-medium w-[120px]">{tr('Credit ($Cr$)', '貸方 ($Cr$)', '贷方 ($Cr$)')}</th>
                      <th className="py-2 px-2 text-left font-medium">{tr('Project/Item', '項目', '项目')}</th>
                      <th className="py-2 px-2 text-left font-medium">{tr('Line Memo', '記帳備忘', '记帐备记')}</th>
                      <th className="py-2 px-2 w-8"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {entryForm.lines.map((line, idx) => {
                      const matchedAccount = (accounts?.data || []).find((a: any) => a.account_code === line.account_code);
                      const typeBadge = matchedAccount ? ({
                        asset: 'bg-blue-100 text-blue-700', liability: 'bg-orange-100 text-orange-700',
                        equity: 'bg-green-100 text-green-700', revenue: 'bg-emerald-100 text-emerald-700', cost: 'bg-orange-100 text-orange-700', expense: 'bg-red-100 text-red-700',
                      } as Record<string, string>)[matchedAccount.account_type] || '' : '';
                      const normalSide = matchedAccount ? (
                        matchedAccount.account_type === 'asset' || matchedAccount.account_type === 'cost' || matchedAccount.account_type === 'expense' ? 'Dr' : 'Cr'
                      ) : '';
                      return (
                        <tr key={idx} className="border-b border-muted/30 hover:bg-muted/20">
                          <td className="py-1.5 px-2 text-muted-foreground text-xs text-center">{idx + 1}</td>
                          <td className="py-1.5 px-2">
                            <input required value={line.account_code}
                              onChange={(e) => {
                                const code = e.target.value;
                                updateLine(idx, 'account_code', code);
                                const match = (accounts?.data || []).find((a: any) => a.account_code === code);
                                if (match) updateLine(idx, 'account_name', match.account_name);
                              }}
                              placeholder={tr('Account #', '科目編號', '科目编号')}
                              list="account-list"
                              className="w-[90px] px-2 py-1 border rounded text-xs font-mono" />
                          </td>
                          <td className="py-1.5 px-2">
                            <div className="flex flex-col gap-0.5">
                              <select value={line.account_name}
                                onChange={(e) => {
                                  const name = e.target.value;
                                  updateLine(idx, 'account_name', name);
                                  const match = (accounts?.data || []).find((a: any) => a.account_name === name);
                                  if (match) updateLine(idx, 'account_code', match.account_code);
                                }}
                                className="w-full px-2 py-1 border rounded text-xs bg-background min-w-[130px]">
                                <option value="">{tr('Select...', '選擇科目...', '选择科目...')}</option>
                                {leafAccounts.map((a: any) => (
                                  <option key={a.id} value={a.account_name}>{a.account_code} – {a.account_name}</option>
                                ))}
                              </select>
                              {matchedAccount && (
                                <div className="flex items-center gap-1">
                                  <span className={`text-[10px] px-1 py-0 rounded ${typeBadge}`}>{matchedAccount.account_type}</span>
                                  <span className="text-[10px] text-muted-foreground">({normalSide})</span>
                                </div>
                              )}
                            </div>
                          </td>
                          <td className="py-1.5 px-2">
                            <input type="number" step="0.01" min="0"
                              value={line.debit || ''} onChange={(e) => updateLine(idx, 'debit', parseFloat(e.target.value) || 0)}
                              className="w-full px-2 py-1 border rounded text-xs text-right font-mono" placeholder="0.00" />
                          </td>
                          <td className="py-1.5 px-2">
                            <input type="number" step="0.01" min="0"
                              value={line.credit || ''} onChange={(e) => updateLine(idx, 'credit', parseFloat(e.target.value) || 0)}
                              className="w-full px-2 py-1 border rounded text-xs text-right font-mono" placeholder="0.00" />
                          </td>
                          <td className="py-1.5 px-2">
                            <input value={line.project || ''} onChange={(e) => updateLine(idx, 'project', e.target.value)}
                              placeholder={tr('Optional', '可選', '可选')} className="w-full px-2 py-1 border rounded text-xs" />
                          </td>
                          <td className="py-1.5 px-2">
                            <input value={line.description} onChange={(e) => updateLine(idx, 'description', e.target.value)}
                              placeholder={tr('Line memo', '記帳備忘', '记帐备记')} className="w-full px-2 py-1 border rounded text-xs" />
                          </td>
                          <td className="py-1.5 px-2 text-center">
                            <button type="button" onClick={() => {
                              const lines = entryForm.lines.filter((_, i) => i !== idx);
                              setEntryForm({ ...entryForm, lines: lines.length ? lines : [{ account_code: '', account_name: '', description: '', debit: 0, credit: 0, project: '' }] });
                            }} className="text-destructive text-xs hover:bg-destructive/10 rounded p-1">✕</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div className="px-3 py-2 border-t flex justify-between items-center">
                  <button type="button" onClick={addLine} className="text-xs text-primary hover:underline">{tr('+ Add Line', '+ 新增行', '+ 新增行')}</button>
                  <span className="text-xs text-muted-foreground">{entryForm.lines.length} {tr('line(s)', '行', '行')}</span>
                </div>
              </div>

              {/* Balance check footer */}
              <div className="border rounded-md p-4 space-y-2 bg-muted/20">
                <div className="flex justify-end gap-8 text-sm">
                  <div className="text-right">
                    <span className="text-muted-foreground">{tr('Total Debit', '總借項', '总借项')}: </span>
                    <span className="font-mono font-medium">HK$ {fmtMoney(totals.debit)}</span>
                  </div>
                  <div className="text-right">
                    <span className="text-muted-foreground">{tr('Total Credit', '總貸項', '总贷项')}: </span>
                    <span className="font-mono font-medium">HK$ {fmtMoney(totals.credit)}</span>
                  </div>
                  <div className="text-right">
                    <span className="text-muted-foreground">{tr('Difference', '差額', '差额')}: </span>
                    <span className={`font-mono font-medium ${totals.balanced ? 'text-green-600' : 'text-red-600'}`}>HK$ {fmtMoney(Math.abs(totals.diff))}</span>
                  </div>
                </div>
                <div aria-live="polite" className={`flex items-center justify-center gap-2 py-1.5 rounded-md text-sm font-medium ${
                  totals.balanced ? 'bg-green-100 dark:bg-green-950/40 text-green-700' : 'bg-red-100 dark:bg-red-950/40 text-red-700'
                }`}>
                  {totals.balanced ? (
                    <>{tr('✓ Balanced', '✓ 已平衡', '✓ 已平衡')}</>
                  ) : (
                    <>{tr('⚠ Unbalanced — Debits must equal credits', '⚠ 不平衡 — 借貸必須相等', '⚠ 不平衡 — 借贷必须相等')}</>
                  )}
                </div>
              </div>

              <div className="flex gap-3 justify-end pt-2">
                <button type="button" onClick={() => setShowEntryForm(false)} className="px-4 py-2 border rounded-md text-sm">
                  {tr('Cancel', '取消', '取消')}
                </button>
                <button type="submit" disabled={!canSubmit}
                  title={!totals.balanced ? tr('Debits must equal credits', '借貸不平衡', '借贷不平衡') : entryForm.lines.length < 2 ? tr('At least 2 lines required', '至少需要兩行', '至少需要两行') : ''}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed">
                  {tr('Post Entry', '記錄', '记录')}
                </button>
              </div>
            </form>
            <datalist id="account-list">
              {leafAccounts.map((a: any) => (
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
          {fiscalSaved ? tr('✓ Saved', '✓ 已儲存', '✓ 已储存') : tr('Save', '儲存', '储存')}
        </button>
      </div>

      {/* Period & Year-End Actions */}
      <div className="bg-card border rounded-xl p-4 space-y-3">
        <span className="text-sm font-medium">會計操作 Actions</span>
        <div className="flex flex-wrap gap-2">
          <button onClick={async () => {
            const start = prompt(tr('Close period start (YYYY-MM-DD):', '關帳期間起 (YYYY-MM-DD)：', '关帐期间起 (YYYY-MM-DD)：'));
            const end = prompt(tr('Close period end (YYYY-MM-DD):', '關帳期間至 (YYYY-MM-DD)：', '关帐期间至 (YYYY-MM-DD)：'));
            if (!start || !end) return;
            await api('/bookkeeping/close-period', { method: 'POST', body: { period_start: start, period_end: end } });
            fetchClosedPeriods();
            toast.info(tr('Period closed', '已關帳', '已关帐'));
          }} className="px-3 py-1.5 bg-amber-100 text-amber-800 rounded text-xs font-medium hover:bg-amber-200">
            {tr('Close Period', '關帳 Close Period', '关帐 Close Period')}
          </button>
          <button onClick={async () => {
            if (!confirm(tr(
              'Execute year-end close? This will transfer all revenue/expense accounts to retained earnings and update opening balances.',
              '確定要執行年結嗎？這會將所有收入/費用科目結轉至保留盈餘，並更新承上結餘。',
              '确定要执行年结吗？这会将所有收入/费用科目结转至保留盈余，并更新承上结余。',
            ))) return;
            const date = prompt(tr('Fiscal year end date (YYYY-MM-DD):', '財政年度結束日 (YYYY-MM-DD)：', '财政年度结束日 (YYYY-MM-DD)：'), fiscalEnd || '');
            if (!date) return;
            const res = await api('/bookkeeping/year-end-close', { method: 'POST', body: { fiscal_end_date: date } });
            toast.info(tr(
              `Year-end close complete!\nRevenue: HKD ${res.revenue?.toLocaleString()}\nExpenses: HKD ${res.expenses?.toLocaleString()}\nNet Income: HKD ${res.net_income?.toLocaleString()}`,
              `年結完成！\n收入：HKD ${res.revenue?.toLocaleString()}\n支出：HKD ${res.expenses?.toLocaleString()}\n淨利：HKD ${res.net_income?.toLocaleString()}`,
              `年结完成！\n收入：HKD ${res.revenue?.toLocaleString()}\n支出：HKD ${res.expenses?.toLocaleString()}\n净利：HKD ${res.net_income?.toLocaleString()}`,
            ));
            queryClient.invalidateQueries({ queryKey: ['entries'] });
            queryClient.invalidateQueries({ queryKey: ['accounts'] });
          }} className="px-3 py-1.5 bg-blue-100 text-blue-800 rounded text-xs font-medium hover:bg-blue-200">
            {tr('Year-End Close', '年結 Year-End Close', '年结 Year-End Close')}
          </button>
          <button onClick={async () => {
            if (!confirm(tr(
              'Calculate profits tax provision? (Default rate 16.5%, first $2M at 8.25%)',
              '確定要計算利得稅撥備嗎？（預設稅率 16.5%，首 $2M 為 8.25%）',
              '确定要计算利得税拨备吗？（预设税率 16.5%，首 $2M 为 8.25%）',
            ))) return;
            const date = prompt(tr('Fiscal year end date (YYYY-MM-DD):', '財政年度結束日 (YYYY-MM-DD)：', '财政年度结束日 (YYYY-MM-DD)：'), fiscalEnd || '');
            if (!date) return;
            const res = await api('/bookkeeping/profits-tax-provision', { method: 'POST', body: { fiscal_end_date: date } });
            toast.info(tr(
              `Profits tax provision complete!\nAssessable profit: HKD ${res.net_income?.toLocaleString()}\nTax: HKD ${res.tax_amount?.toLocaleString()}`,
              `利得稅撥備完成！\n應評稅利潤：HKD ${res.net_income?.toLocaleString()}\n稅款：HKD ${res.tax_amount?.toLocaleString()}`,
              `利得税拨备完成！\n应评税利润：HKD ${res.net_income?.toLocaleString()}\n税款：HKD ${res.tax_amount?.toLocaleString()}`,
            ));
            queryClient.invalidateQueries({ queryKey: ['entries'] });
          }} className="px-3 py-1.5 bg-red-100 text-red-800 rounded text-xs font-medium hover:bg-red-200">
            {tr('Profits Tax Provision', '利得稅撥備 Tax Provision', '利得税拨备 Tax Provision')}
          </button>
        </div>
        {closedPeriods.length > 0 && (
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">{tr('Closed Periods', '已關帳期間 Closed Periods', '已关帐期间 Closed Periods')}</span>
            {closedPeriods.map((cp: any) => (
              <div key={cp.id} className="flex items-center justify-between bg-muted/30 rounded px-3 py-1.5">
                <span className="text-xs">{cp.period_start} ~ {cp.period_end}</span>
                <button onClick={async () => {
                  if (!confirm(tr(
                    `Reopen period ${cp.period_start} ~ ${cp.period_end}?`,
                    `確定要重開 ${cp.period_start} ~ ${cp.period_end} 的關帳嗎？`,
                    `确定要重开 ${cp.period_start} ~ ${cp.period_end} 的关帐吗？`,
                  ))) return;
                  await api(`/bookkeeping/close-period/${cp.id}`, { method: 'DELETE' });
                  fetchClosedPeriods();
                }} className="text-xs text-destructive hover:underline">{tr('Reopen', '重開 Reopen', '重开 Reopen')}</button>
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
              // Depth from zero-stripped stem ('10000'→0, '11000'→1, leaves→2)
              const indent = Math.max(0, stemOfCode(a.account_code || '').length - 1);
              const editing = !isParent && a.account_code in bfEdits;
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
                        disabled={isParent}
                        onChange={e => setBfEdits(prev => ({...prev, [a.account_code]: e.target.value}))}
                        onKeyDown={e => { if (e.key === 'Enter') saveBF(a.account_code); }}
                        onBlur={() => { if (editing) saveBF(a.account_code); }}
                        title={isParent
                          ? tr('Group account — B/F balances are entered on its sub-accounts', '類別科目——承上結餘請填於其子科目', '类别科目——承上结余请填于其子科目')
                          : undefined}
                        className="w-32 px-2 py-1 border rounded text-xs text-right bg-background disabled:bg-transparent disabled:text-muted-foreground"
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
