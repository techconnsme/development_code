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
import ConfirmDialog from '../components/ConfirmDialog';
import MissingCodesModal from '../components/MissingCodesModal';
import { useDateFilter } from '../contexts/DateFilterContext';
import { useToast } from '../components/Toast';

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

function getReferenceLabel(type: string | null): string {
  switch (type) {
    case 'bank_transaction': return tr('Bank', '銀行', '银行');
    case 'invoice': return tr('Invoice', '發票', '发票');
    case 'payment': return tr('Payment', '付款', '付款');
    case 'year_end_close': return tr('Year-End', '年結', '年结');
    default: return type || '';
  }
}

function getDepthBgClass(code: string): string {
  if (!code) return '';
  if (isParentCode(code)) {
    const depth = getDepth(code);
    if (depth === 0) return 'bg-slate-100';
    if (depth === 1) return 'bg-slate-50';
    if (depth === 2) return 'bg-white';
    return '';
  }
  // Leaf accounts
  return 'bg-white';
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
  const toast = useToast();

  const [typeFilter, setTypeFilter] = useState('');
  const [search, setSearch] = useState('');
  const [expandedTypes, setExpandedTypes] = useState<Record<string, boolean>>({
    asset: true, liability: true, equity: true, revenue: true, expense: true,
  });
  const [expandedAccounts, setExpandedAccounts] = useState<Record<string, boolean>>({});
  const [collapsedParents, setCollapsedParents] = useState<Set<string>>(new Set());
  const [accountTxns, setAccountTxns] = useState<Record<string, any[]>>({});
  const [accountTxnLoading, setAccountTxnLoading] = useState<Record<string, boolean>>({});
  const [typeOrder, setTypeOrder] = useState<string[]>([...TYPE_ORDER]);
  const [hideZeroBalance, setHideZeroBalance] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [addFormParent, setAddFormParent] = useState<string | null>(null);
  const [showDisabled, setShowDisabled] = useState(false);
  const [showMissingModal, setShowMissingModal] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState<{ code: string; name: string } | null>(null);
  const [newAccount, setNewAccount] = useState({
    account_code: '', account_name: '', account_type: 'asset', parent_code: '', opening_balance: 0,
  });
  const { startDate, endDate } = useDateFilter();
  const queryAsOf = endDate;

  const { data, isLoading } = useQuery({
    queryKey: ['accounts', queryAsOf],
    queryFn: () => {
      const base = queryAsOf ? `/bookkeeping/accounts?as_of=${queryAsOf}` : '/bookkeeping/accounts';
      const path = `${base}${base.includes('?') ? '&' : '?'}include_inactive=true`;
      return api(path) as Promise<{ data?: any[]; results?: any[] }>;
    },
    enabled: true,
  });

  const accounts = ((data as any)?.data || (data as any)?.results || []) as any[];
  const hasCurrentBalance = !!(data as any)?.as_of;

  // Build parent lookup for hierarchy (parent expansion / descendant hiding)
  const parentMap = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const a of accounts) {
      map.set(a.account_code, a.parent_code || null);
    }
    return map;
  }, [accounts]);

  const isDescendantHidden = useCallback((code: string): boolean => {
    if (collapsedParents.size === 0) return false;
    let current: string | null | undefined = parentMap.get(code);
    while (current) {
      if (collapsedParents.has(current)) return true;
      current = parentMap.get(current);
    }
    return false;
  }, [collapsedParents, parentMap]);

  const seedMut = useMutation({
    mutationFn: () => api('/bookkeeping/accounts/seed', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['accounts'] }),
  });

  const createMut = useMutation({
    mutationFn: (body: typeof newAccount) => api('/bookkeeping/accounts', { method: 'POST', body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      setAddFormParent(null);
      setNewAccount({ account_code: '', account_name: '', account_type: 'asset', parent_code: '', opening_balance: 0 });
      toast.success(tr('Account created', '科目已建立', '科目已建立'));
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const updateStatusMut = useMutation({
    mutationFn: ({ code, is_active }: { code: string; is_active: number }) =>
      api(`/bookkeeping/accounts/${code}`, { method: 'PATCH', body: { is_active } }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      setConfirmDisable(null);
      toast.success(vars.is_active
        ? tr('Account enabled', '科目已啟用', '科目已启用')
        : tr('Account disabled', '科目已停用', '科目已停用'));
    },
    onError: (err: Error) => {
      setConfirmDisable(null);
      toast.error(err.message);
    },
  });

  const { data: missingCodesData, isLoading: missingLoading } = useQuery({
    queryKey: ['missing-codes'],
    queryFn: () => api('/bookkeeping/accounts/missing-codes') as Promise<{ missing: any[]; total_existing: number; total_expected: number }>,
    enabled: accounts.length > 0,
    refetchOnWindowFocus: false,
  });
  const missingCodes = missingCodesData?.missing || [];

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
    if (isParentCode(code)) {
      // Parent account — toggle child visibility
      setCollapsedParents(prev => {
        const next = new Set(prev);
        if (next.has(code)) next.delete(code); else next.add(code);
        return next;
      });
    } else {
      // Leaf account — fetch transactions
      setExpandedAccounts(prev => ({ ...prev, [code]: !prev[code] }));
      if (!accountTxns[code] && !accountTxnLoading[code]) {
        setAccountTxnLoading(prev => ({ ...prev, [code]: true }));
        try {
          const sd = startDate || '2000-01-01';
          const ed = endDate || '2099-12-31';
          const res = await api(`/bookkeeping/accounts/${code}/transactions?start_date=${sd}&end_date=${ed}`);
          setAccountTxns(prev => ({ ...prev, [code]: (res as any).transactions || [] }));
        } catch {
          setAccountTxns(prev => ({ ...prev, [code]: [] }));
        }
        setAccountTxnLoading(prev => ({ ...prev, [code]: false }));
      }
    }
  }, [startDate, endDate, accountTxns, accountTxnLoading]);

  const handleAddChild = useCallback((parentCode: string, parentType: string) => {
    setNewAccount({
      account_code: '', account_name: '', account_type: parentType, parent_code: parentCode, opening_balance: 0,
    });
    setAddFormParent(parentCode);
  }, []);

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
    if (isDescendantHidden(a.account_code)) return false;
    if (!showDisabled && a.is_active === 0) return false;
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
          <p className="text-xs text-muted-foreground mt-1 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded px-3 py-1.5 inline-block">
            ℹ️ {tr(
              'Balances are cumulative totals from all periods up to the as-of date shown at the bottom. They are not filtered by the sidebar fiscal year.',
              '結餘為截至頁尾所示日期的累計總額，不受側邊欄財政年度篩選影響。',
              '结余为截至页尾所示日期的累计总额，不受侧边栏财政年度筛选影响。'
            )}
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
              onClick={() => {
                setNewAccount({ account_code: '', account_name: '', account_type: 'asset', parent_code: '', opening_balance: 0 });
                setAddFormParent('__top__');
              }}
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
          <button
            onClick={() => setShowMissingModal(true)}
            className="px-3 py-1.5 text-xs font-medium bg-amber-600 text-white rounded-lg hover:bg-amber-700"
          >
            {tr('View Details', '查看詳情', '查看详情')}
          </button>
        </div>
      )}

      {/* Toolbar */}
      {hasAccounts && (
        <div className="flex items-center gap-3 flex-wrap">
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
          <label className={`inline-flex items-center gap-2 px-3 py-2 border rounded-lg text-sm cursor-pointer select-none hover:bg-muted/50 transition-colors ${showDisabled ? 'bg-primary/10 border-primary/30' : ''}`}>
            <input
              type="checkbox"
              checked={showDisabled}
              onChange={e => setShowDisabled(e.target.checked)}
              className="sr-only"
            />
            <span className="text-sm">{showDisabled
              ? tr('Hide Disabled Accounts', '隱藏已停用科目', '隐藏已停用科目')
              : tr('Show Disabled Accounts', '顯示已停用科目', '显示已停用科目')}</span>
          </label>
        </div>
      )}

      {/* Inline add form — at top (global '+' button) */}
      {addFormParent === '__top__' && (
        <div className="bg-card border rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold">{tr('New Account', '新增科目', '新增科目')}</h3>
            <button onClick={() => setAddFormParent(null)} className="p-1 hover:bg-muted rounded">
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
                  const isParentCollapsed = isParent && collapsedParents.has(a.account_code);
                  const isLeafExpanded = !isParent && !!expandedAccounts[a.account_code];
                  const isExpanded = isParent ? !isParentCollapsed : isLeafExpanded;
                  const txns = accountTxns[a.account_code];
                  const txnLoading = accountTxnLoading[a.account_code];
                  return (
                    <React.Fragment key={a.id || a.account_code || i}>
                      <tr
                        onClick={() => toggleAccount(a.account_code)}
                        className={`${i % 2 ? 'bg-muted/5' : ''} hover:bg-muted/30 transition-colors cursor-pointer ${a.is_active === 0 ? 'opacity-50' : ''} ${getDepthBgClass(a.account_code)}`}
                      >
                        <td className={`px-4 py-2.5 font-mono text-xs ${isParent ? 'font-bold' : ''}`}>
                          <span className="inline-flex items-center gap-1">
                            {isParent ? (
                              isParentCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                            ) : (
                              isLeafExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />
                            )}
                            {a.account_code || ''}
                            {isParent && (
                              <button
                                onClick={(e) => { e.stopPropagation(); handleAddChild(a.account_code, a.account_type); }}
                                title={tr('Add sub-account', '新增子科目', '新增子科目')}
                                className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground transition-colors"
                              >
                                <Plus className="h-3 w-3" />
                              </button>
                            )}
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
                          <div className="flex items-center gap-2">
                            <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${a.is_active !== 0 ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'}`}>
                              {a.is_active !== 0 ? tr('Active', '啟用', '启用') : tr('Inactive', '停用', '停用')}
                            </span>
                            {a.is_active !== 0 ? (
                              hasCurrentBalance && a.current_balance && Math.abs(a.current_balance) > 0.001 ? (
                                <span className="text-xs text-muted-foreground" title={tr(
                                  'Cannot disable account with non-zero balance',
                                  '無法停用有餘額的科目',
                                  '无法停用有余额的科目',
                                )}>
                                  {tr('Disable', '停用', '停用')}
                                </span>
                              ) : (
                                <button
                                  onClick={(e) => { e.stopPropagation(); setConfirmDisable({ code: a.account_code, name: a.account_name }); }}
                                  className="text-xs text-destructive hover:underline"
                                >
                                  {tr('Disable', '停用', '停用')}
                                </button>
                              )
                            ) : (
                              <button
                                onClick={(e) => { e.stopPropagation(); updateStatusMut.mutate({ code: a.account_code, is_active: 1 }); }}
                                className="text-xs text-primary hover:underline"
                              >
                                {tr('Enable', '啟用', '启用')}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {/* Expanded transaction rows — only for leaf accounts */}
                      {!isParent && isLeafExpanded && (
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
                      {/* Inline add form below this parent */}
                      {isParent && addFormParent === a.account_code && (
                        <tr>
                          <td colSpan={hasCurrentBalance ? 5 : 4} className="px-0 py-0">
                            <div className="bg-card border rounded-xl p-4 mx-4 my-2 shadow-sm">
                              <div className="flex items-center justify-between mb-3">
                                <h3 className="text-sm font-semibold">
                                  {tr('New sub-account under', '新增子科目於', '新增子科目于')} {a.account_code}
                                </h3>
                                <button onClick={() => setAddFormParent(null)} className="p-1 hover:bg-muted rounded">
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
                                  disabled
                                  className="px-3 py-2 border rounded-lg text-sm font-mono bg-muted/30 text-muted-foreground focus:outline-none"
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

      <ConfirmDialog
        show={!!confirmDisable}
        title={tr('Disable Account', '停用科目', '停用科目')}
        message={`${confirmDisable?.code} — ${confirmDisable?.name}\n\n${tr(
          'This account cannot be used in new journal entries, but its transaction history is preserved.',
          '此科目不能再用於新日記帳分錄，但交易記錄將保留。',
          '此科目不能再用于新日记账分录，但交易记录将保留。',
        )}`}
        confirmLabel={tr('Disable', '停用', '停用')}
        danger
        onConfirm={() => confirmDisable && updateStatusMut.mutate({ code: confirmDisable.code, is_active: 0 })}
        onCancel={() => setConfirmDisable(null)}
      />

      {showMissingModal && (
        <MissingCodesModal onClose={() => {
          setShowMissingModal(false);
          queryClient.invalidateQueries({ queryKey: ['missing-codes'] });
        }} />
      )}
    </div>
  );
}
