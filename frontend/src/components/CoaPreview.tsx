import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Search, Plus, Minus, Undo2, ChevronDown, ChevronRight, BookOpen,
} from 'lucide-react';
import { api } from '../lib/api';
import { tr } from '../lib/i18nHelpers';

// ── Types ──────────────────────────────────────────────────────────────────

export type CoaMode = 'industry' | 'manual';
export type CoaAccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export interface CoaAccount {
  account_code: string;
  account_name: string;
  account_type: CoaAccountType;
  parent_code: string | null;
  is_custom?: boolean;
}

interface CoaPreviewProps {
  industry: string;
  mode: CoaMode;
  onModeChange: (mode: CoaMode) => void;
  customAccounts: CoaAccount[];
  onCustomAccountsChange: (accounts: CoaAccount[]) => void;
  removedCodes: Set<string>;
  onRemovedCodesChange: (codes: Set<string>) => void;
}

// ── Constants ──────────────────────────────────────────────────────────────

const TYPE_ORDER: CoaAccountType[] = ['asset', 'liability', 'equity', 'revenue', 'expense'];

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

function isParentCode(code: string): boolean {
  return /00$/.test(code || '');
}

// ── Component ──────────────────────────────────────────────────────────────

export default function CoaPreview({
  industry,
  mode,
  onModeChange,
  customAccounts,
  onCustomAccountsChange,
  removedCodes,
  onRemovedCodesChange,
}: CoaPreviewProps) {
  const [expanded, setExpanded] = useState(true);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [expandedTypes, setExpandedTypes] = useState<Record<string, boolean>>({
    asset: true, liability: true, equity: true, revenue: true, expense: true,
  });
  const [expandedAccounts, setExpandedAccounts] = useState<Record<string, boolean>>({});
  const [showAddForm, setShowAddForm] = useState(false);
  const [draft, setDraft] = useState<CoaAccount>({
    account_code: '',
    account_name: '',
    account_type: 'expense',
    parent_code: null,
  });
  const [addError, setAddError] = useState('');

  // ── Fetch template from API ────────────────────────────────────────────

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['coa-template', mode, industry || 'professional'],
    queryFn: () => api(`/bookkeeping/accounts/template?industry=${encodeURIComponent(industry || 'professional')}&mode=${mode}`),
  });

  const templateAccounts: CoaAccount[] = ((data as any)?.data || []);

  // ── Merge template + custom, respecting removed codes ───────────────────

  const allAccounts = useMemo(() => {
    const codeMap = new Map<string, CoaAccount>();

    // Template accounts first (exclude removed)
    for (const a of templateAccounts) {
      if (!removedCodes.has(a.account_code)) {
        codeMap.set(a.account_code, { ...a, is_custom: false });
      }
    }

    // Custom accounts overwrite
    for (const a of customAccounts) {
      codeMap.set(a.account_code, { ...a, is_custom: true });
    }

    return [...codeMap.values()].sort(
      (a, b) => a.account_code.localeCompare(b.account_code),
    );
  }, [templateAccounts, customAccounts, removedCodes]);

  // ── Filter + group ─────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    return allAccounts.filter((a) => {
      if (typeFilter && a.account_type !== typeFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        return (a.account_code || '').toLowerCase().includes(q)
          || (a.account_name || '').toLowerCase().includes(q);
      }
      return true;
    });
  }, [allAccounts, typeFilter, search]);

  const grouped: Record<string, CoaAccount[]> = useMemo(() => {
    const g: Record<string, CoaAccount[]> = {};
    for (const t of TYPE_ORDER) g[t] = [];
    for (const a of filtered) {
      const t = a.account_type || 'expense';
      if (!g[t]) g[t] = [];
      g[t].push(a);
    }
    return g;
  }, [filtered]);

  const totalAccounts = allAccounts.length;
  const visibleAccounts = filtered.length;
  const removedCount = removedCodes.size;

  // ── Actions ────────────────────────────────────────────────────────────

  const toggleType = (t: string) =>
    setExpandedTypes(prev => ({ ...prev, [t]: !prev[t] }));

  const toggleAccount = (code: string) =>
    setExpandedAccounts(prev => ({ ...prev, [code]: !prev[code] }));

  const toggleRemove = (code: string) => {
    const next = new Set(removedCodes);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    onRemovedCodesChange(next);
  };

  const handleAdd = () => {
    setAddError('');
    if (!draft.account_code.trim()) {
      setAddError(tr('Account code is required', '請輸入科目編號', '请输入科目编号'));
      return;
    }
    if (!draft.account_name.trim()) {
      setAddError(tr('Account name is required', '請輸入科目名稱', '请输入科目名称'));
      return;
    }
    const codeMap = new Map(allAccounts.map(a => [a.account_code, a]));
    if (codeMap.has(draft.account_code)) {
      setAddError(tr('Duplicate code', '科目編號重複', '科目编号重复'));
      return;
    }
    onCustomAccountsChange([...customAccounts, { ...draft, is_custom: true }]);
    setDraft({ account_code: '', account_name: '', account_type: 'expense', parent_code: null });
    setShowAddForm(false);
  };

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="space-y-3">
      {/* Section header */}
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">
          {tr('Chart of Accounts Review', '會計科目表審閱', '会计科目表审阅')}
        </label>
      </div>

      {/* Mode toggle */}
      <div className="flex gap-4">
        <label
          className="flex items-center gap-2 text-sm cursor-pointer"
          onClick={() => onModeChange('industry')}
        >
          <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
            mode === 'industry' ? 'border-primary bg-primary' : 'border-muted-foreground'
          }`}>
            {mode === 'industry' && <div className="w-2 h-2 rounded-full bg-primary-foreground" />}
          </div>
          <span className={mode === 'industry' ? 'font-medium' : 'text-muted-foreground'}>
            {tr('Industry Template', '行業模板', '行业模板')}
          </span>
        </label>
        <label
          className="flex items-center gap-2 text-sm cursor-pointer"
          onClick={() => onModeChange('manual')}
        >
          <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
            mode === 'manual' ? 'border-primary bg-primary' : 'border-muted-foreground'
          }`}>
            {mode === 'manual' && <div className="w-2 h-2 rounded-full bg-primary-foreground" />}
          </div>
          <span className={mode === 'manual' ? 'font-medium' : 'text-muted-foreground'}>
            {tr('Manual', '手動', '手动')}
          </span>
        </label>
      </div>

      {/* Info banner */}
      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg px-3 py-2 text-xs text-blue-700 dark:text-blue-300">
        {tr(
          'Review the accounts that will be seeded. Use − to remove unwanted accounts, + to add custom ones.',
          '審閱將建立的科目。使用 − 移除不需要的科目，使用 + 新增自訂科目。',
          '审阅将建立的科目。使用 − 移除不需要的科目，使用 + 新增自订科目。',
        )}
      </div>

      {/* Loading / Error */}
      {isLoading && (
        <div className="text-xs text-muted-foreground py-4 text-center">
          {tr('Loading template…', '載入模板中…', '载入模板中…')}
        </div>
      )}
      {error && (
        <div className="text-xs text-red-600 py-2">
          {tr('Failed to load template.', '載入模板失敗。', '载入模板失败。')}{' '}
          <button onClick={() => refetch()} className="underline">
            {tr('Retry', '重試', '重试')}
          </button>
        </div>
      )}

      {!isLoading && !error && (
        <div className="border rounded-lg overflow-hidden">
          {/* Collapsible header */}
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-full flex items-center gap-3 px-4 py-3 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
          >
            {expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
            <BookOpen className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="flex-1">
              <span className="text-sm font-semibold">
                {tr('Chart of Accounts Preview', '會計科目表預覽', '会计科目表预览')}
              </span>
              <span className="text-xs text-muted-foreground ml-2">
                {mode === 'industry'
                  ? tr(`${totalAccounts} accounts`, `${totalAccounts} 個科目`, `${totalAccounts} 个科目`)
                  : tr('Manual — add accounts below', '手動 — 請在下方新增科目', '手动 — 请在下方新增科目')}
              </span>
            </div>
            <span className="text-xs text-muted-foreground">
              {mode === 'industry'
                ? tr('HK 5-digit bilingual template', '香港五位數雙語模板', '香港五位数双语模板')
                : tr('Root accounts only', '僅根科目', '仅根科目')}
            </span>
          </button>

          {expanded && (
            <div className="border-t px-4 py-3 space-y-3">
              {/* Toolbar */}
              <div className="flex items-center gap-2 flex-wrap">
                {/* Search */}
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <input
                    type="text"
                    placeholder={tr('Search code or name...', '搜尋代碼或名稱...', '搜索代码或名称...')}
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="pl-8 pr-3 py-1.5 border rounded-lg text-xs w-48 focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>

                {/* Type filter */}
                <select
                  value={typeFilter}
                  onChange={e => setTypeFilter(e.target.value)}
                  className="px-3 py-1.5 border rounded-lg text-xs bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">{tr('All Types', '所有類型', '所有类型')}</option>
                  {TYPE_ORDER.map(t => (
                    <option key={t} value={t}>{TYPE_LABELS[t]}</option>
                  ))}
                </select>

                <div className="flex-1" />

                {/* Add Account button */}
                <button
                  type="button"
                  onClick={() => setShowAddForm(!showAddForm)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs font-medium hover:opacity-90"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {tr('Add Account', '新增科目', '新增科目')}
                </button>
              </div>

              {/* Add account inline form */}
              {showAddForm && (
                <div className="border rounded-lg p-3 bg-muted/30 space-y-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={draft.account_code}
                      onChange={e => setDraft(d => ({ ...d, account_code: e.target.value }))}
                      placeholder={tr('Code', '編號', '编号')}
                      className="w-20 px-2 py-1 border rounded text-xs font-mono"
                      maxLength={20}
                    />
                    <input
                      type="text"
                      value={draft.account_name}
                      onChange={e => setDraft(d => ({ ...d, account_name: e.target.value }))}
                      placeholder={tr('Account name', '科目名稱', '科目名称')}
                      className="flex-1 px-2 py-1 border rounded text-xs"
                      maxLength={200}
                    />
                    <select
                      value={draft.account_type}
                      onChange={e => setDraft(d => ({ ...d, account_type: e.target.value as CoaAccountType }))}
                      className="px-2 py-1 border rounded text-xs bg-background"
                    >
                      {TYPE_ORDER.map(t => (
                        <option key={t} value={t}>{TYPE_LABELS[t]}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={handleAdd}
                      className="px-3 py-1 bg-primary text-primary-foreground rounded text-xs font-medium"
                    >
                      {tr('Add', '新增', '新增')}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setShowAddForm(false); setAddError(''); }}
                      className="px-2 py-1 border rounded text-xs"
                    >
                      {tr('Cancel', '取消', '取消')}
                    </button>
                  </div>
                  {addError && <div className="text-xs text-red-600">{addError}</div>}
                </div>
              )}

              {/* Summary counts */}
              <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                {TYPE_ORDER.map(t => {
                  const count = grouped[t]?.length || 0;
                  if (count === 0) return null;
                  return (
                    <span key={t} className="inline-flex items-center gap-1">
                      <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold ${TYPE_COLORS[t]}`}>
                        {TYPE_LABELS[t]}
                      </span>
                      <span>{count}</span>
                    </span>
                  );
                })}
                <span className="text-muted-foreground/50">|</span>
                <span>
                  {visibleAccounts !== totalAccounts
                    ? tr(`${visibleAccounts} of ${totalAccounts} accounts`, `${visibleAccounts} / ${totalAccounts} 個科目`, `${visibleAccounts} / ${totalAccounts} 个科目`)
                    : tr(`${totalAccounts} accounts`, `${totalAccounts} 個科目`, `${totalAccounts} 个科目`)}
                </span>
                {customAccounts.length > 0 && (
                  <span className="text-green-600">
                    {tr(`${customAccounts.length} custom`, `${customAccounts.length} 個自訂`, `${customAccounts.length} 个自订`)}
                  </span>
                )}
                {removedCount > 0 && (
                  <span className="text-red-500">
                    {tr(`${removedCount} removed`, `${removedCount} 個已移除`, `${removedCount} 个已移除`)}
                  </span>
                )}
              </div>

              {/* Account table by type group */}
              <div className="space-y-2 max-h-[500px] overflow-y-auto">
                {TYPE_ORDER.filter(t => grouped[t]?.length > 0).map(type => (
                  <div key={type} className="border rounded-lg overflow-hidden">
                    {/* Type group header */}
                    <button
                      onClick={() => toggleType(type)}
                      className="w-full flex items-center gap-2 px-3 py-2 bg-muted/20 hover:bg-muted/40 transition-colors text-left"
                    >
                      {expandedTypes[type] ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                      <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-semibold ${TYPE_COLORS[type]}`}>
                        {TYPE_LABELS[type]}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {grouped[type].length} {tr('accounts', '個科目', '个科目')}
                      </span>
                    </button>

                    {expandedTypes[type] && (
                      <div className="text-xs">
                        {grouped[type].map((a, i) => {
                          const isParent = isParentCode(a.account_code);
                          const isExpanded = !!expandedAccounts[a.account_code];
                          const isRemoved = removedCodes.has(a.account_code);
                          const children = allAccounts.filter(c => c.parent_code === a.account_code);
                          const hasChildren = children.length > 0;

                          return (
                            <React.Fragment key={a.account_code}>
                              <div
                                onClick={() => hasChildren && toggleAccount(a.account_code)}
                                className={`flex items-center gap-2 px-3 py-1.5 border-b last:border-b-0 hover:bg-muted/30 transition-colors ${
                                  hasChildren ? 'cursor-pointer' : ''
                                } ${i % 2 ? 'bg-muted/5' : ''}`}
                              >
                                {/* Expand chevron for parents */}
                                <span className="w-4 flex-shrink-0">
                                  {hasChildren ? (
                                    isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />
                                  ) : (
                                    <span className="w-3" />
                                  )}
                                </span>

                                {/* Code */}
                                <code className={`w-16 flex-shrink-0 font-mono text-[11px] ${
                                  isParent ? 'font-bold' : ''
                                }`}>
                                  {a.account_code}
                                </code>

                                {/* Name */}
                                <span className={`flex-1 truncate ${isParent ? 'font-bold' : ''}`}>
                                  {a.account_name}
                                </span>

                                {/* Custom indicator */}
                                {a.is_custom && (
                                  <span className="text-[9px] px-1 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300 flex-shrink-0">
                                    ✦
                                  </span>
                                )}

                                {/* − / undo button */}
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); toggleRemove(a.account_code); }}
                                  className={`flex-shrink-0 p-0.5 rounded hover:bg-muted ${
                                    isRemoved
                                      ? 'text-green-600 hover:text-green-700'
                                      : 'text-muted-foreground hover:text-red-600'
                                  }`}
                                  title={
                                    isRemoved
                                      ? tr('Undo remove', '取消移除', '取消移除')
                                      : tr('Remove account', '移除科目', '移除科目')
                                  }
                                >
                                  {isRemoved ? (
                                    <Undo2 className="h-3.5 w-3.5" />
                                  ) : (
                                    <Minus className="h-3.5 w-3.5" />
                                  )}
                                </button>
                              </div>

                              {/* Expanded children */}
                              {isExpanded && hasChildren && children.map((child, ci) => (
                                <div
                                  key={child.account_code}
                                  className={`flex items-center gap-2 px-3 py-1.5 border-b last:border-b-0 bg-muted/10 ${
                                    (i + ci) % 2 ? 'bg-muted/5' : ''
                                  }`}
                                >
                                  <span className="w-4 flex-shrink-0" />
                                  <code className="w-16 flex-shrink-0 font-mono text-[11px] ml-5">
                                    {child.account_code}
                                  </code>
                                  <span className="flex-1 truncate text-muted-foreground">
                                    {child.account_name}
                                  </span>
                                  {child.is_custom && (
                                    <span className="text-[9px] px-1 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300 flex-shrink-0">
                                      ✦
                                    </span>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => toggleRemove(child.account_code)}
                                    className={`flex-shrink-0 p-0.5 rounded hover:bg-muted ${
                                      removedCodes.has(child.account_code)
                                        ? 'text-green-600 hover:text-green-700'
                                        : 'text-muted-foreground hover:text-red-600'
                                    }`}
                                    title={
                                      removedCodes.has(child.account_code)
                                        ? tr('Undo remove', '取消移除', '取消移除')
                                        : tr('Remove account', '移除科目', '移除科目')
                                    }
                                  >
                                    {removedCodes.has(child.account_code) ? (
                                      <Undo2 className="h-3.5 w-3.5" />
                                    ) : (
                                      <Minus className="h-3.5 w-3.5" />
                                    )}
                                  </button>
                                </div>
                              ))}
                            </React.Fragment>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}

                {/* No results */}
                {filtered.length === 0 && (
                  <div className="py-8 text-center">
                    <p className="text-xs text-muted-foreground">
                      {search || typeFilter
                        ? tr('No accounts match your filters.', '沒有符合篩選條件的科目。', '没有符合筛选条件的科目。')
                        : tr('No accounts in this template.', '此模板沒有科目。', '此模板没有科目。')}
                    </p>
                  </div>
                )}
              </div>

              {/* Hidden removed accounts section */}
              {removedCount > 0 && (
                <div className="text-xs text-muted-foreground border-t pt-2">
                  {tr(
                    `${removedCount} account(s) marked for removal — they will not be seeded. Click the "−" button on any account to remove it, or the undo button to restore.`,
                    `${removedCount} 個科目已標記為移除 — 將不會被建立。點擊任何科目的「−」按鈕移除，或點擊還原按鈕恢復。`,
                    `${removedCount} 个科目已标记为移除 — 将不会被建立。点击任何科目的「−」按钮移除，或点击还原按钮恢复。`,
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
