import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { tr } from '../lib/i18nHelpers';
import {
  Search, Plus, X, ChevronDown, ChevronRight, Building2, BookOpen,
  ExternalLink, FileText, Banknote, GripVertical, EyeOff,
} from 'lucide-react';
import DropdownSelect from '../components/DropdownSelect';

const TYPE_ORDER = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;

const TYPE_LABELS: Record<string, string> = {
  asset: tr('Assets', '資產', '资产'),
  liability: tr('Liabilities', '負債', '负债'),
  equity: tr('Equity', '權益', '权益'),
  revenue: tr('Revenue', '收入', '收入'),
  expense: tr('Expenses', '支出', '支出'),
};

const TYPE_COLORS: Record<string, string> = {
  asset: 'bg-blue-50 text-black font-bold dark:bg-blue-900/30 dark:text-white',
  liability: 'bg-red-50 text-black font-bold dark:bg-red-900/30 dark:text-white',
  equity: 'bg-purple-50 text-black font-bold dark:bg-purple-900/30 dark:text-white',
  revenue: 'bg-green-50 text-black font-bold dark:bg-green-900/30 dark:text-white',
  expense: 'bg-amber-50 text-black font-bold dark:bg-amber-900/30 dark:text-white',
};

function getDepth(code: string): number {
  if (!code) return 0;
  const stripped = code.replace(/0+$/, '');
  if (stripped.length <= 1) return 0;
  return Math.max(0, stripped.length - 1);
}

function isParentCode(code: string): boolean {
  return /00$/.test(code || '');
}

function formatBalance(v: number | null | undefined, forceZero = false): string {
  if (v == null) return '—';
  if (v === 0 && !forceZero) return '—';
  const abs = Math.abs(v);
  const formatted = abs.toLocaleString('en-HK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `(${formatted})` : formatted;
}

interface FiscalYearOption {
  label: string;
  startDate: string;
  endDate: string;
}

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
    opts.push({
      label: `${sy}-${sy + 1} (Apr ${sy} - Mar ${sy + 1})`,
      startDate: sD,
      endDate: eD,
    });
  }
  return opts;
}

function getReferenceLabel(type: string | null): string {
  switch (type) {
    case 'bank_transaction': return tr('Bank', '銀行', '银行');
    case 'invoice': return tr('Invoice', '發票', '发票');
    case 'payment': return tr('Payment', '付款', '付款');
    case 'year_end_close': return tr('Year-End', '年結', '年结');
    default: return type || '';
  }
}

function getReferenceRoute(type: string | null): string {
  switch (type) {
    case 'bank_transaction': return '/bank-statements';
    case 'invoice': return '/invoices';
    case 'payment': return '/bank-statements';
    default: return '';
  }
}

export default function ChartOfAccounts() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [typeFilter, setTypeFilter] = useState('');
  const [search, setSearch] = useState('');
  const [expandedTypes, setExpandedTypes] = useState<Record<string, boolean>>({
    asset: true, liability: true, equity: true, revenue: true, expense: true,
  });
  const [expandedAccounts, setExpandedAccounts] = useState<Record<string, boolean>>({});
  const [accountTxns, setAccountTxns] = useState<Record<string, any[]>>({});
  const [accountTxnLoading, setAccountTxnLoading] = useState<Record<string, boolean>>({});
  const [typeOrder, setTypeOrder] = useState<string[]>([...TYPE_ORDER]);
  const [hideZeroBalance, setHideZeroBalance] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newAccount, setNewAccount] = useState({
    account_code: '', account_name: '', account_type: 'asset', parent_code: '', opening_balance: 0,
  });
  const [selectedFY, setSelectedFY] = useState('');
  const [fyOptions, setFyOptions] = useState<FiscalYearOption[]>([]);
  const [asOfDate, setAsOfDate] = useState('');

  const { data: fiscalData } = useQuery({
    queryKey: ['fiscal-period'],
    queryFn: () => api('/bookkeeping/fiscal-period'),
  });

  const rawStart = (fiscalData as any)?.fiscal_year_start || '04-01';
  const rawEnd = (fiscalData as any)?.fiscal_year_end || '03-31';
  // Handle both "04-01" and "2026-04-01" formats — extract MM-DD portion
  const fyStart = rawStart.length > 5 ? rawStart.slice(5) : rawStart;
  const fyEnd = rawEnd.length > 5 ? rawEnd.slice(5) : rawEnd;

  useEffect(() => {
    const opts = buildFiscalYearOptions(fyStart, fyEnd);
    setFyOptions(opts);
    const now = new Date();
    const [sm] = fyStart.split('-').map(Number);
    const baseYear = now.getFullYear() - (now.getMonth() + 1 < sm ? 1 : 0);
    const defaultOpt = opts.find(o => o.label.startsWith(String(baseYear)));
    if (defaultOpt) {
      setSelectedFY(defaultOpt.label);
      setAsOfDate(now.toISOString().split('T')[0]);
    }
  }, [fyStart]);

  const selectedFYOption = useMemo(() => fyOptions.find(o => o.label === selectedFY), [fyOptions, selectedFY]);

  const queryAsOf = useMemo(() => {
    if (!selectedFYOption) return asOfDate || '';
    return selectedFYOption.endDate < (asOfDate || '2099-12-31') ? selectedFYOption.endDate : asOfDate;
  }, [selectedFYOption, asOfDate]);

  const { data, isLoading } = useQuery({
    queryKey: ['accounts', queryAsOf],
    queryFn: () => {
      const path = queryAsOf ? `/bookkeeping/accounts?as_of=${queryAsOf}` : '/bookkeeping/accounts';
      return api(path) as Promise<{ data?: any[]; results?: any[] }>;
    },
    enabled: !!fiscalData,
  });

  const accounts = ((data as any)?.data || (data as any)?.results || []) as any[];
  const hasCurrentBalance = !!(data as any)?.as_of;

  const seedMut = useMutation({
    mutationFn: () => api('/bookkeeping/accounts/seed', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['accounts'] }),
  });

  const createMut = useMutation({
    mutationFn: (body: typeof newAccount) => api('/bookkeeping/accounts', { method: 'POST', body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      setShowAddForm(false);
      setNewAccount({ account_code: '', account_name: '', account_type: 'asset', parent_code: '', opening_balance: 0 });
    },
  });

  const { data: missingCodesData, isLoading: missingLoading } = useQuery({
    queryKey: ['missing-codes'],
    queryFn: () => api('/bookkeeping/accounts/missing-codes') as Promise<{ missing: any[]; total_existing: number; total_expected: number }>,
    enabled: accounts.length > 0,
    refetchOnWindowFocus: false,
  });
  const missingCodes = missingCodesData?.missing || [];

  const createMissingMut = useMutation({
    mutationFn: () => api('/bookkeeping/auto-generate-entries', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['missing-codes'] });
    },
  });

  const toggleType = (t: string) => setExpandedTypes(prev => ({ ...prev, [t]: !prev[t] }));

  // ── Drag-and-drop type reordering ──
  const handleDragStart = useCallback((index: number) => {
    setDragIndex(index);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (dragIndex !== null && dragIndex !== index) {
      setTypeOrder(prev => {
        const next = [...prev];
        const [dragged] = next.splice(dragIndex, 1);
        next.splice(index, 0, dragged);
        return next;
      });
      setDragIndex(index);
    }
  }, [dragIndex]);

  const handleDragEnd = useCallback(() => {
    setDragIndex(null);
  }, []);

  const toggleAccount = useCallback(async (code: string) => {
    setExpandedAccounts(prev => ({ ...prev, [code]: !prev[code] }));
    if (!accountTxns[code] && !accountTxnLoading[code]) {
      setAccountTxnLoading(prev => ({ ...prev, [code]: true }));
      try {
        const sd = selectedFYOption?.startDate || '2000-01-01';
        const ed = selectedFYOption?.endDate || '2099-12-31';
        const res = await api(`/bookkeeping/accounts/${code}/transactions?start_date=${sd}&end_date=${ed}`);
        setAccountTxns(prev => ({ ...prev, [code]: (res as any).transactions || [] }));
      } catch {
        setAccountTxns(prev => ({ ...prev, [code]: [] }));
      }
      setAccountTxnLoading(prev => ({ ...prev, [code]: false }));
    }
  }, [selectedFYOption, accountTxns, accountTxnLoading]);

  const handleRefClick = (type: string | null, id: string | null) => {
    const route = getReferenceRoute(type);
    if (route) navigate(route);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  const filtered = accounts.filter((a: any) => {
    if (typeFilter && a.account_type !== typeFilter) return false;
    if (hideZeroBalance && hasCurrentBalance && (!a.current_balance || Math.abs(a.current_balance) < 0.001)) return false;
    if (search) {
      const q = search.toLowerCase();
      return (a.account_code || '').toLowerCase().includes(q) || (a.account_name || '').toLowerCase().includes(q);
    }
    return true;
  });

  const grouped: Record<string, any[]> = {};
  for (const t of typeOrder) grouped[t] = [];
  for (const a of filtered) {
    const t = a.account_type || 'expense';
    if (!grouped[t]) grouped[t] = [];
    grouped[t].push(a);
  }
  for (const t of Object.keys(grouped)) {
    grouped[t].sort((a: any, b: any) => (a.account_code || '').localeCompare(b.account_code || ''));
  }

  const hasAccounts = accounts.length > 0;

  const nonZeroByType: Record<string, number> = {};
  if (hasCurrentBalance) {
    for (const t of typeOrder) {
      nonZeroByType[t] = (grouped[t] || []).filter((a: any) => a.current_balance && Math.abs(a.current_balance) > 0.001).length;
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold">{tr('Chart of Accounts (COA)', '會計科目表', '会计科目表')}</h2>
          <p className="text-muted-foreground mt-1">
            {tr('5-digit tiered Hong Kong account structure.', '五位數分層香港會計科目結構。', '五位数分层香港会计科目结构。')}
          </p>
        </div>
      </div>

      {/* Empty state */}
      {!hasAccounts && (
        <div className="bg-card border rounded-xl p-12 text-center space-y-4">
          <div className="flex justify-center">
            <BookOpen className="h-12 w-12 text-muted-foreground/50" />
          </div>
          <p className="text-sm text-muted-foreground">{tr(
            'No accounts yet. Start by using the Hong Kong industry template or build your COA manually.',
            '尚無科目。可使用香港行業模板或手動建立會計科目表。',
            '尚无科目。可使用香港行业模板或手动建立会计科目表。',
          )}</p>
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={() => seedMut.mutate()}
              disabled={seedMut.isPending}
              className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              <Building2 className="h-4 w-4" />
              {seedMut.isPending ? tr('Seeding...', '正在建立...', '正在建立...') : tr('Use Industry Template', '使用行業模板', '使用行业模板')}
            </button>
            <button
              onClick={() => setShowAddForm(true)}
              className="inline-flex items-center gap-2 px-4 py-2 border rounded-lg text-sm font-medium hover:bg-muted/50"
            >
              <Plus className="h-4 w-4" />
              {tr('Build Manually', '手動建立', '手动建立')}
            </button>
          </div>
          {seedMut.isError && <p className="text-sm text-destructive">{(seedMut.error as Error).message}</p>}
          {seedMut.isSuccess && <p className="text-sm text-green-600">{tr('COA seeded successfully!', '科目表建立成功！', '科目表建立成功！')}</p>}
        </div>
      )}

      {/* Sparse COA banner */}
      {hasAccounts && !missingLoading && missingCodes.length > 0 && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg px-4 py-3 flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm text-amber-700 dark:text-amber-300">
            <span className="font-semibold">{missingCodes.length}</span> {tr(
              'transaction codes are not yet in the Chart of Accounts.',
              '個交易代碼尚未在會計科目表中。',
              '个交易代码尚未在会计科目表中。',
            )}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => createMissingMut.mutate()}
              disabled={createMissingMut.isPending}
              className="px-3 py-1.5 text-xs font-medium bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50"
            >
              {createMissingMut.isPending ? tr('Creating...', '建立中...', '建立中...') : tr('Create Missing', '建立缺失科目', '建立缺失科目')}
            </button>
            <button
              onClick={() => seedMut.mutate()}
              disabled={seedMut.isPending}
              className="px-3 py-1.5 text-xs font-medium border border-amber-300 dark:border-amber-700 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-800/30 disabled:opacity-50"
            >
              {tr('Use Industry Template', '使用行業模板', '使用行业模板')}
            </button>
          </div>
        </div>
      )}

      {/* Toolbar */}
      {hasAccounts && (
        <div className="flex items-center gap-3 flex-wrap">
          {fyOptions.length > 0 && (
            <DropdownSelect
              value={selectedFY}
              options={fyOptions.map(o => ({ value: o.label, label: o.label }))}
              onChange={setSelectedFY}
            />
          )}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder={tr('Search code or name...', '搜尋代碼或名稱...', '搜索代码或名称...')}
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 pr-3 py-2 border rounded-lg text-sm w-56 focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <select
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value)}
            className="px-3 py-2 border rounded-lg text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">{tr('All Types', '所有類型', '所有类型')}</option>
            {TYPE_ORDER.map(t => (
              <option key={t} value={t}>{TYPE_LABELS[t]}</option>
            ))}
          </select>
          <div className="flex-1" />
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            {tr('Add Account', '新增科目', '新增科目')}
          </button>
          <label className={`inline-flex items-center gap-2 px-3 py-2 border rounded-lg text-sm cursor-pointer select-none hover:bg-muted/50 transition-colors ${hideZeroBalance ? 'bg-primary/10 border-primary/30' : ''}`}>
            <input
              type="checkbox"
              checked={hideZeroBalance}
              onChange={e => setHideZeroBalance(e.target.checked)}
              className="sr-only"
            />
            <EyeOff className={`h-4 w-4 ${hideZeroBalance ? 'text-primary' : 'text-muted-foreground'}`} />
            <span className="text-sm">{tr('Hide zero balance', '隱藏零餘額', '隐藏零余额')}</span>
          </label>
        </div>
      )}

      {/* Inline add form */}
      {showAddForm && (
        <div className="bg-card border rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold">{tr('New Account', '新增科目', '新增科目')}</h3>
            <button onClick={() => setShowAddForm(false)} className="p-1 hover:bg-muted rounded">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <input
              placeholder={tr('Code', '代碼', '代码')}
              value={newAccount.account_code}
              onChange={e => setNewAccount(p => ({ ...p, account_code: e.target.value }))}
              className="px-3 py-2 border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <input
              placeholder={tr('Account Name', '科目名稱', '科目名称')}
              value={newAccount.account_name}
              onChange={e => setNewAccount(p => ({ ...p, account_name: e.target.value }))}
              className="px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <select
              value={newAccount.account_type}
              onChange={e => setNewAccount(p => ({ ...p, account_type: e.target.value }))}
              className="px-3 py-2 border rounded-lg text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {TYPE_ORDER.map(t => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
            </select>
            <input
              placeholder={tr('Parent Code', '上級代碼', '上级代码')}
              value={newAccount.parent_code}
              onChange={e => setNewAccount(p => ({ ...p, parent_code: e.target.value }))}
              className="px-3 py-2 border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              onClick={() => { if (newAccount.account_code && newAccount.account_name) createMut.mutate(newAccount); }}
              disabled={!newAccount.account_code || !newAccount.account_name || createMut.isPending}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {createMut.isPending ? tr('Creating...', '建立中...', '建立中...') : tr('Create', '建立', '建立')}
            </button>
          </div>
          {createMut.isError && <p className="text-sm text-destructive mt-2">{(createMut.error as Error).message}</p>}
        </div>
      )}

      {/* No results */}
      {hasAccounts && filtered.length === 0 && (
        <div className="bg-card border rounded-xl p-12 text-center">
          <p className="text-sm text-muted-foreground">{tr('No accounts match your filters.', '沒有符合篩選條件的科目。', '没有符合筛选条件的科目。')}</p>
        </div>
      )}

      {/* Grouped account sections */}
      {typeOrder.filter(t => grouped[t]?.length > 0).map((type, idx) => (
        <div key={type} className="bg-card border rounded-xl overflow-hidden">
          <button
            onClick={() => toggleType(type)}
            draggable
            onDragStart={() => handleDragStart(idx)}
            onDragOver={handleDragOver}
            onDragEnter={(e) => handleDragEnter(e, idx)}
            onDragEnd={handleDragEnd}
            className={`w-full flex items-center gap-3 px-4 py-3 bg-muted/30 hover:bg-muted/50 transition-colors text-left ${dragIndex === idx ? 'opacity-50 ring-2 ring-primary' : ''}`}
          >
            <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground/40 cursor-grab active:cursor-grabbing" />
            {expandedTypes[type] ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
            <span className={`inline-flex px-2 py-0.5 rounded text-xs font-semibold ${TYPE_COLORS[type]}`}>
              {TYPE_LABELS[type]}
            </span>
            <span className="text-xs text-muted-foreground">
              {grouped[type].length} {tr('accounts', '個科目', '个科目')}
            </span>
            {hasCurrentBalance && nonZeroByType[type] > 0 && (
              <span className="text-xs text-green-600 dark:text-green-400 font-medium ml-auto">
                {nonZeroByType[type]} {tr('non-zero', '非零', '非零')}
              </span>
            )}
          </button>

          {expandedTypes[type] && (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/20 text-xs">
                  <th className="px-4 py-2 font-medium text-left text-muted-foreground">{tr('Code', '代碼', '代码')}</th>
                  <th className="px-4 py-2 font-medium text-left text-muted-foreground">{tr('Account Name', '科目名稱', '科目名称')}</th>
                  <th className="px-4 py-2 font-medium text-right text-muted-foreground">{tr('Opening', '期初', '期初')}</th>
                  {hasCurrentBalance && (
                    <th className="px-4 py-2 font-medium text-right text-muted-foreground">{tr('Balance', '結餘', '结余')}</th>
                  )}
                  <th className="px-4 py-2 font-medium text-left text-muted-foreground">{tr('Status', '狀態', '状态')}</th>
                </tr>
              </thead>
              <tbody>
                {grouped[type].map((a: any, i: number) => {
                  const isParent = isParentCode(a.account_code);
                  const isExpanded = !!expandedAccounts[a.account_code];
                  const txns = accountTxns[a.account_code];
                  const txnLoading = accountTxnLoading[a.account_code];
                  return (
                    <React.Fragment key={a.id || a.account_code || i}>
                      <tr
                        onClick={() => toggleAccount(a.account_code)}
                        className={`${i % 2 ? 'bg-muted/5' : ''} hover:bg-muted/30 transition-colors cursor-pointer`}
                      >
                        <td className={`px-4 py-2.5 font-mono text-xs ${isParent ? 'font-bold' : ''}`}>
                          <span className="inline-flex items-center gap-1">
                            {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                            {a.account_code || ''}
                          </span>
                        </td>
                        <td className={`px-4 py-2.5 ${isParent ? 'font-bold' : ''}`}>
                          {a.account_name || ''}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-xs">
                          {formatBalance(a.opening_balance)}
                        </td>
                        {hasCurrentBalance && (
                          <td className={`px-4 py-2.5 text-right font-mono text-xs font-semibold ${
                            a.current_balance > 0 ? 'text-green-600 dark:text-green-400' :
                            a.current_balance < 0 ? 'text-red-600 dark:text-red-400' : ''
                          }`}>
                            {formatBalance(a.current_balance, true)}
                          </td>
                        )}
                        <td className="px-4 py-2.5">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${a.is_active !== 0 ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'}`}>
                            {a.is_active !== 0 ? tr('Active', '啟用', '启用') : tr('Inactive', '停用', '停用')}
                          </span>
                        </td>
                      </tr>
                      {/* Expanded transaction rows */}
                      {isExpanded && (
                        <tr>
                          <td colSpan={hasCurrentBalance ? 5 : 4} className="px-0 py-0">
                            <div className="bg-muted/10 border-t border-b px-4 py-3">
                              {txnLoading ? (
                                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                  <div className="animate-spin h-3 w-3 border-2 border-primary border-t-transparent rounded-full" />
                                  {tr('Loading transactions...', '載入交易中...', '载入交易中...')}
                                </div>
                              ) : txns && txns.length > 0 ? (
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="text-muted-foreground">
                                      <th className="pr-3 py-1 text-left font-medium">{tr('Date', '日期', '日期')}</th>
                                      <th className="pr-3 py-1 text-left font-medium">{tr('Description', '描述', '描述')}</th>
                                      <th className="pr-3 py-1 text-right font-medium">{tr('Debit', '借方', '借方')}</th>
                                      <th className="pr-3 py-1 text-right font-medium">{tr('Credit', '貸方', '贷方')}</th>
                                      <th className="pr-3 py-1 text-right font-medium">{tr('Balance', '餘額', '余额')}</th>
                                      <th className="py-1 text-left font-medium">{tr('Ref', '來源', '来源')}</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    <tr className="text-muted-foreground">
                                      <td className="pr-3 py-1.5 font-mono">—</td>
                                      <td className="pr-3 py-1.5 italic">{tr('Opening Balance', '期初結餘', '期初结余')}</td>
                                      <td className="pr-3 py-1.5 text-right font-mono">—</td>
                                      <td className="pr-3 py-1.5 text-right font-mono">—</td>
                                    <td className="pr-3 py-1.5 text-right font-mono font-semibold">{formatBalance(txns.length > 0 ? txns[0].running_balance - (txns[0].debit - txns[0].credit) : 0, true)}</td>
                                    <td className="py-1.5">—</td>
                                  </tr>
                                  {txns.map((tx: any, j: number) => (
                                      <tr key={j} className="hover:bg-muted/20 transition-colors">
                                        <td className="pr-3 py-1.5 font-mono">{tx.entry_date}</td>
                                        <td className="pr-3 py-1.5 max-w-64 truncate">{tx.description}</td>
                                        <td className="pr-3 py-1.5 text-right font-mono">{tx.debit > 0 ? formatBalance(tx.debit, true) : '—'}</td>
                                        <td className="pr-3 py-1.5 text-right font-mono">{tx.credit > 0 ? formatBalance(tx.credit, true) : '—'}</td>
                                        <td className={`pr-3 py-1.5 text-right font-mono font-medium ${
                                          tx.running_balance > 0 ? 'text-green-600 dark:text-green-400' :
                                          tx.running_balance < 0 ? 'text-red-600 dark:text-red-400' : ''
                                        }`}>
                                          {formatBalance(tx.running_balance, true)}
                                        </td>
                                        <td className="py-1.5">
                                          {tx.reference_type ? (
                                            <button
                                              onClick={(e) => { e.stopPropagation(); handleRefClick(tx.reference_type, tx.reference_id); }}
                                              className="inline-flex items-center gap-1 text-primary hover:underline"
                                              title={`${getReferenceLabel(tx.reference_type)}: ${tx.entry_number || ''}`}
                                            >
                                              {tx.reference_type === 'invoice' ? <FileText className="h-3 w-3" /> : <Banknote className="h-3 w-3" />}
                                              {getReferenceLabel(tx.reference_type)}
                                              <ExternalLink className="h-2.5 w-2.5" />
                                            </button>
                                          ) : (
                                            <span className="text-muted-foreground">—</span>
                                          )}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              ) : (
                                <span className="text-xs text-muted-foreground">{tr('No transactions in this period.', '本期間無交易。', '本期间无交易。')}</span>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      ))}

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{filtered.length} / {accounts.length} {tr('accounts', '個科目', '个科目')}</span>
        {queryAsOf && <span>{tr(`Balances as of ${queryAsOf}`, `結餘截至 ${queryAsOf}`, `结余截至 ${queryAsOf}`)}</span>}
      </div>
    </div>
  );
}
