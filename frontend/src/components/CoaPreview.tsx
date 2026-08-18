import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Search, Plus, Minus, Undo2, ChevronDown, ChevronRight, BookOpen, X, GripVertical,
} from 'lucide-react';
import { api } from '../lib/api';
import { tr } from '../lib/i18nHelpers';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';

// ── Types ──────────────────────────────────────────────────────────────────

export type CoaMode = 'industry' | 'manual';
export type CoaAccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'cost' | 'expense';

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

const TYPE_ORDER: CoaAccountType[] = ['asset', 'liability', 'equity', 'revenue', 'cost', 'expense'];

const TYPE_LABELS: Record<string, string> = {
  asset: tr('Assets', '資產', '资产'),
  liability: tr('Liabilities', '負債', '负债'),
  equity: tr('Equity', '權益', '权益'),
  revenue: tr('Revenue', '收入', '收入'),
  cost: tr('Cost', '直接成本', '直接成本'),
  expense: tr('Expenses', '支出', '支出'),
};

const TYPE_COLORS: Record<string, string> = {
  asset: 'bg-blue-50 text-black font-bold dark:bg-blue-900/30 dark:text-white',
  liability: 'bg-red-50 text-black font-bold dark:bg-red-900/30 dark:text-white',
  equity: 'bg-purple-50 text-black font-bold dark:bg-purple-900/30 dark:text-white',
  revenue: 'bg-green-50 text-black font-bold dark:bg-green-900/30 dark:text-white',
  cost: 'bg-orange-50 text-black font-bold dark:bg-orange-900/30 dark:text-white',
  expense: 'bg-amber-50 text-black font-bold dark:bg-amber-900/30 dark:text-white',
};

/** Code range per type for renumbering. Cost spans 50000-59999, Expense 60000-89999. */
const TYPE_CODE_RANGE: Record<string, { start: number; end: number }> = {
  asset: { start: 10000, end: 19999 },
  liability: { start: 20000, end: 29999 },
  equity: { start: 30000, end: 39999 },
  revenue: { start: 40000, end: 49999 },
  cost: { start: 50000, end: 59999 },
  expense: { start: 60000, end: 89999 },
};

function isParentCode(code: string): boolean {
  return /00$/.test(code || '');
}

function getDepth(code: string): number {
  if (!code) return 0;
  const stripped = code.replace(/0+$/, '');
  if (stripped.length <= 1) return 0;
  return Math.max(0, stripped.length - 1);
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
  return 'bg-white';
}

/** Collect all descendant codes (children, grandchildren, etc.) for cascade operations */
function collectDescendants(code: string, accounts: CoaAccount[]): string[] {
  const result: string[] = [];
  const queue = [code];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const a of accounts) {
      if (a.parent_code === cur && !result.includes(a.account_code)) {
        result.push(a.account_code);
        queue.push(a.account_code);
      }
    }
  }
  return result;
}

/** Return all codes that should move together when dragging an account (parent + all descendants) */
function getDragUnit(code: string, accounts: CoaAccount[]): string[] {
  if (isParentCode(code)) {
    const descendants = collectDescendants(code, accounts);
    return [code, ...descendants];
  }
  return [code];
}

/** Get the default code-sorted order for a list of accounts */
function getDefaultOrder(accounts: CoaAccount[]): string[] {
  return [...accounts]
    .sort((a, b) => a.account_code.localeCompare(b.account_code))
    .map(a => a.account_code);
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
  const [addFormParent, setAddFormParent] = useState<string | null>(null);
  const [draft, setDraft] = useState<CoaAccount>({
    account_code: '',
    account_name: '',
    account_type: 'expense',
    parent_code: null,
  });
  const [addError, setAddError] = useState('');
  const [confirmRemove, setConfirmRemove] = useState<{ code: string; name: string } | null>(null);

  // Drag & drop state
  const [customOrder, setCustomOrder] = useState<Record<string, string[]>>({});
  const [dragCode, setDragCode] = useState<string | null>(null);
  const dragRef = useRef<{ code: string; type: string } | null>(null); // ref for reliable access during drag events

  // Undo history for re-arrange
  const [undoHistory, setUndoHistory] = useState<{
    customAccounts: CoaAccount[];
    removedCodes: Set<string>;
    customOrder: Record<string, string[]>;
  } | null>(null);

  const toast = useToast();

  // ── Fetch template from API ────────────────────────────────────────────

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['coa-template', mode, industry || 'professional'],
    queryFn: () => api(`/bookkeeping/accounts/template?industry=${encodeURIComponent(industry || 'professional')}&mode=${mode}`),
  });

  const templateAccounts: CoaAccount[] = ((data as any)?.data || []);

  // ── Merge template + custom, respecting removed codes ───────────────────

  const allAccounts = useMemo(() => {
    const codeMap = new Map<string, CoaAccount>();

    for (const a of templateAccounts) {
      if (!removedCodes.has(a.account_code)) {
        codeMap.set(a.account_code, { ...a, is_custom: false });
      }
    }

    for (const a of customAccounts) {
      codeMap.set(a.account_code, { ...a, is_custom: true });
    }

    return [...codeMap.values()].sort(
      (a, b) => a.account_code.localeCompare(b.account_code),
    );
  }, [templateAccounts, customAccounts, removedCodes]);

  // Auto-expand all parent accounts on first load
  useEffect(() => {
    if (allAccounts.length === 0) return;
    const parents = new Set(allAccounts.filter(a =>
      allAccounts.some(c => c.parent_code === a.account_code)
    ).map(a => a.account_code));
    if (parents.size > 0) {
      setExpandedAccounts(prev => {
        const next = { ...prev };
        let changed = false;
        for (const code of parents) {
          if (!next[code]) { next[code] = true; changed = true; }
        }
        return changed ? next : prev;
      });
    }
  }, [allAccounts]);

  // ── Filter ─────────────────────────────────────────────────────────────

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

  // ── Ordered group (respects customOrder from drag-and-drop) ────────────

  const grouped: Record<string, CoaAccount[]> = useMemo(() => {
    const g: Record<string, CoaAccount[]> = {};
    for (const t of TYPE_ORDER) g[t] = [];

    for (const t of TYPE_ORDER) {
      const typeAccounts = filtered.filter(a => (a.account_type || 'expense') === t);
      const order = customOrder[t];
      if (order && order.length > 0) {
        // Sort by customOrder index; codes not in order append at end sorted by code
        const orderMap = new Map(order.map((code, idx) => [code, idx]));
        g[t] = [...typeAccounts].sort((a, b) => {
          const ai = orderMap.get(a.account_code);
          const bi = orderMap.get(b.account_code);
          if (ai !== undefined && bi !== undefined) return ai - bi;
          if (ai !== undefined) return -1;
          if (bi !== undefined) return 1;
          return a.account_code.localeCompare(b.account_code);
        });
      } else {
        g[t] = [...typeAccounts].sort((a, b) => a.account_code.localeCompare(b.account_code));
      }
    }
    return g;
  }, [filtered, customOrder]);

  // ── Rebuild full ordered list (all accounts per type, for renumbering) ─

  const orderedByType = useMemo(() => {
    const result: Record<string, CoaAccount[]> = {};
    for (const t of TYPE_ORDER) {
      const typeAccounts = allAccounts.filter(a => (a.account_type || 'expense') === t);
      const order = customOrder[t];
      if (order && order.length > 0) {
        const orderMap = new Map(order.map((code, idx) => [code, idx]));
        result[t] = [...typeAccounts].sort((a, b) => {
          const ai = orderMap.get(a.account_code);
          const bi = orderMap.get(b.account_code);
          if (ai !== undefined && bi !== undefined) return ai - bi;
          if (ai !== undefined) return -1;
          if (bi !== undefined) return 1;
          return a.account_code.localeCompare(b.account_code);
        });
      } else {
        result[t] = [...typeAccounts].sort((a, b) => a.account_code.localeCompare(b.account_code));
      }
    }
    return result;
  }, [allAccounts, customOrder]);

  const totalAccounts = allAccounts.length;
  const visibleAccounts = filtered.length;
  const removedCount = removedCodes.size;

  // ── Drag & drop handlers ───────────────────────────────────────────────

  const handleDragStart = (e: React.DragEvent, code: string, type: string) => {
    e.dataTransfer.setData('text/plain', code);
    e.dataTransfer.effectAllowed = 'move';
    setDragCode(code);
    dragRef.current = { code, type };
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDragEnter = (targetCode: string, type: string) => {
    const drag = dragRef.current;
    if (!drag || drag.code === targetCode) return;
    if (drag.type !== type) return;

    // Constrain to same parent group (siblings only)
    const dragAcct = allAccounts.find(a => a.account_code === drag.code);
    const targetAcct = allAccounts.find(a => a.account_code === targetCode);
    if (!dragAcct || !targetAcct) return;
    const dragParent = dragAcct.parent_code || '__root__';
    const targetParent = targetAcct.parent_code || '__root__';
    if (dragParent !== targetParent) return;

    setCustomOrder(prev => {
      const typeAccounts = allAccounts.filter(a => (a.account_type || 'expense') === type);
      const currentOrder = prev[type] && prev[type].length > 0
        ? [...prev[type]]
        : getDefaultOrder(typeAccounts);

      const dragUnit = getDragUnit(drag.code, allAccounts);

      const dragIndices = dragUnit
        .map(code => currentOrder.indexOf(code))
        .filter(idx => idx !== -1)
        .sort((a, b) => a - b);

      if (dragIndices.length === 0) return prev;

      const targetIndex = currentOrder.indexOf(targetCode);
      if (targetIndex === -1) return prev;

      const removed: string[] = [];
      for (let i = dragIndices.length - 1; i >= 0; i--) {
        removed.unshift(currentOrder.splice(dragIndices[i], 1)[0]);
      }

      let insertAt = currentOrder.indexOf(targetCode);
      if (insertAt === -1) insertAt = currentOrder.length;

      currentOrder.splice(insertAt, 0, ...removed);

      return { ...prev, [type]: currentOrder };
    });
  };

  const handleDragEnd = () => {
    setDragCode(null);
    dragRef.current = null;
  };

  // ── Re-arrange Code ────────────────────────────────────────────────────

  const handleRearrangeCodes = useCallback(() => {
    // Save current state for undo
    setUndoHistory({
      customAccounts: [...customAccounts],
      removedCodes: new Set(removedCodes),
      customOrder: { ...customOrder },
    });

    // Build old→new code mapping from current display order
    const oldToNew = new Map<string, string>();
    const newAccounts: CoaAccount[] = [];
    const allTemplateCodes = templateAccounts.map(a => a.account_code);

    for (const type of TYPE_ORDER) {
      const accounts = orderedByType[type] || [];
      const range = TYPE_CODE_RANGE[type];

      // Build a lookup: old_parent_code → children in display order
      const childrenByParent = new Map<string, CoaAccount[]>();
      for (const a of accounts) {
        const key = a.parent_code || '__root__';
        const arr = childrenByParent.get(key) || [];
        arr.push(a);
        childrenByParent.set(key, arr);
      }

      /** Child spacing based on parent's trailing zeros (HK 5-digit convention) */
      const getChildMultiplier = (parentCode: string): number => {
        const zeros = (parentCode.match(/0+$/) || [''])[0].length;
        if (zeros >= 4) return 1000;   // X0000 → children at XX000
        if (zeros === 3) return 100;    // XX000 → children at XXX00
        return 1;                        // XXX00 or deeper → sequential leaves
      };

      let topSlot = 0;

      /** Recursively renumber a parent and its descendants */
      const renumber = (oldParentCode: string | null, newParentCode: string) => {
        const key = oldParentCode || '__root__';
        const siblings = childrenByParent.get(key) || [];
        const multiplier = getChildMultiplier(newParentCode);
        const parentNum = parseInt(newParentCode, 10);
        let childIdx = 0;

        for (const account of siblings) {
          childIdx++;
          let newCode: string;
          if (isParentCode(account.account_code)) {
            // Parent: use hierarchical spacing
            newCode = String(parentNum + childIdx * multiplier);
          } else {
            // Leaf: sequential
            newCode = String(parentNum + childIdx);
          }
          oldToNew.set(account.account_code, newCode);

          // Recurse into children of this account
          if (isParentCode(account.account_code)) {
            renumber(account.account_code, newCode);
          }
        }
      };

      // Top-level: assign codes then recurse
      const topLevel = childrenByParent.get('__root__') || [];
      for (const account of topLevel) {
        let newCode: string;
        if (isParentCode(account.account_code)) {
          newCode = String(range.start + topSlot * 100);
        } else {
          newCode = String(range.start + topSlot);
        }
        topSlot++;
        oldToNew.set(account.account_code, newCode);
        renumber(account.account_code, newCode);
      }
    }

    // Build new accounts from the old→new mapping
    for (const type of TYPE_ORDER) {
      for (const account of orderedByType[type] || []) {
        const newCode = oldToNew.get(account.account_code);
        if (!newCode) continue;
        newAccounts.push({
          ...account,
          account_code: newCode,
          parent_code: account.parent_code ? (oldToNew.get(account.parent_code) || account.parent_code) : null,
          is_custom: true,
        });
      }
    }

    // All original template codes go into removedCodes so template doesn't seed
    const nextRemoved = new Set(removedCodes);
    for (const code of allTemplateCodes) {
      nextRemoved.add(code);
    }
    for (const oldCode of oldToNew.keys()) {
      nextRemoved.add(oldCode);
    }

    onCustomAccountsChange(newAccounts);
    onRemovedCodesChange(nextRemoved);
    setCustomOrder({}); // reset to code-sorted display

    toast.success(tr(
      'Codes re-arranged',
      '科目編碼已重新排列',
      '科目编码已重新排列',
    ));
  }, [orderedByType, templateAccounts, removedCodes, onCustomAccountsChange, onRemovedCodesChange, toast, customAccounts, customOrder]);

  /** Undo the last re-arrange operation */
  const handleUndoRearrange = useCallback(() => {
    if (!undoHistory) return;
    onCustomAccountsChange(undoHistory.customAccounts);
    onRemovedCodesChange(undoHistory.removedCodes);
    setCustomOrder(undoHistory.customOrder);
    setUndoHistory(null);
    toast.success(tr('Re-arrange undone', '已復原重新編碼', '已复原重新编码'));
  }, [undoHistory, onCustomAccountsChange, onRemovedCodesChange, toast]);

  // ── Actions ────────────────────────────────────────────────────────────

  const toggleType = (t: string) =>
    setExpandedTypes(prev => ({ ...prev, [t]: !prev[t] }));

  const toggleAccount = (code: string) =>
    setExpandedAccounts(prev => ({ ...prev, [code]: !prev[code] }));

  const handleAddChild = (parentCode: string, parentType: CoaAccountType) => {
    setDraft({
      account_code: '', account_name: '', account_type: parentType, parent_code: parentCode,
    });
    setAddFormParent(parentCode);
    setExpandedAccounts(prev => ({ ...prev, [parentCode]: true }));
    setAddError('');
  };

  const requestRemove = (code: string, name: string) => {
    const children = collectDescendants(code, allAccounts).filter(c => !removedCodes.has(c));
    if (children.length > 0) {
      setConfirmRemove({ code, name });
    } else {
      const next = new Set(removedCodes);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      onRemovedCodesChange(next);
      if (next.has(code)) {
        toast.success(tr('Account marked for removal', '科目已標記為移除', '科目已标记为移除'));
      } else {
        toast.success(tr('Account restored', '科目已還原', '科目已还原'));
      }
    }
  };

  const confirmRemoveAction = () => {
    if (!confirmRemove) return;
    const next = new Set(removedCodes);
    const doomed = [confirmRemove.code, ...collectDescendants(confirmRemove.code, allAccounts).filter(c => !removedCodes.has(c))];
    doomed.forEach(c => next.add(c));
    onRemovedCodesChange(next);
    toast.success(
      doomed.length > 1
        ? tr(`${doomed.length} accounts marked for removal`, `${doomed.length} 個科目已標記為移除`, `${doomed.length} 个科目已标记为移除`)
        : tr('Account marked for removal', '科目已標記為移除', '科目已标记为移除'),
    );
    setConfirmRemove(null);
  };

  const restoreAccount = (code: string) => {
    const next = new Set(removedCodes);
    next.delete(code);
    onRemovedCodesChange(next);
    toast.success(tr('Account restored', '科目已還原', '科目已还原'));
  };

  const handleAdd = () => {
    setAddError('');
    if (!draft.account_code.trim()) {
      const msg = tr('Account code is required', '請輸入科目編號', '请输入科目编号');
      setAddError(msg);
      toast.error(msg);
      return;
    }
    if (!draft.account_name.trim()) {
      const msg = tr('Account name is required', '請輸入科目名稱', '请输入科目名称');
      setAddError(msg);
      toast.error(msg);
      return;
    }
    const codeMap = new Map(allAccounts.map(a => [a.account_code, a]));
    if (codeMap.has(draft.account_code)) {
      const msg = tr('Duplicate code', '科目編號重複', '科目编号重复');
      setAddError(msg);
      toast.error(msg);
      return;
    }
    const nameDup = allAccounts.find(
      a => a.account_name.trim().toLowerCase() === draft.account_name.trim().toLowerCase(),
    );
    if (nameDup) {
      const msg = tr('Duplicate account name', '科目名稱重複', '科目名称重复');
      setAddError(msg);
      toast.error(msg);
      return;
    }
    onCustomAccountsChange([...customAccounts, { ...draft, is_custom: true }]);
    toast.success(tr('Account added', '科目已新增', '科目已新增'));
    setDraft({ account_code: '', account_name: '', account_type: 'expense', parent_code: null });
    setAddFormParent(null);
  };

  const confirmChildrenCount = confirmRemove
    ? collectDescendants(confirmRemove.code, allAccounts).filter(c => !removedCodes.has(c)).length
    : 0;

  // Check if any type has a custom order (for showing reset hint)
  const hasCustomOrder = Object.values(customOrder).some(arr => arr.length > 0);

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
          'Review the accounts that will be seeded. Use − to remove unwanted accounts, + to add custom ones. Drag rows to reorder within each type.',
          '審閱將建立的科目。使用 − 移除不需要的科目，使用 + 新增自訂科目。拖曳以重新排序。',
          '审阅将建立的科目。使用 − 移除不需要的科目，使用 + 新增自订科目。拖曳以重新排序。',
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

                {/* Re-arrange Code button */}
                <button
                  type="button"
                  onClick={handleRearrangeCodes}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 border rounded-lg text-xs font-medium hover:bg-muted/50 transition-colors"
                  title={tr(
                    'Re-number all account codes based on display order',
                    '根據顯示順序重新編排科目編碼',
                    '根据显示顺序重新编排科目编码',
                  )}
                >
                  {tr('Re-arrange Code', '重新編碼', '重新编码')}
                </button>

                {/* Undo re-arrange button */}
                <button
                  type="button"
                  onClick={handleUndoRearrange}
                  disabled={!undoHistory}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 border rounded-lg text-xs font-medium hover:bg-muted/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  title={tr('Undo last re-arrange', '復原上次重新編碼', '复原上次重新编码')}
                >
                  <Undo2 className="h-3 w-3" />
                  {tr('Undo', '復原', '复原')}
                </button>

                {/* Add Account button */}
                <button
                  type="button"
                  onClick={() => {
                    if (addFormParent === '__top__') {
                      setAddFormParent(null);
                      setAddError('');
                    } else {
                      setDraft({ account_code: '', account_name: '', account_type: 'expense', parent_code: null });
                      setAddFormParent('__top__');
                      setAddError('');
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs font-medium hover:opacity-90"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {tr('Add Account', '新增科目', '新增科目')}
                </button>
              </div>

              {/* Top-level add account form */}
              {addFormParent === '__top__' && (
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
                      onClick={() => { setAddFormParent(null); setAddError(''); }}
                      className="px-2 py-1 border rounded text-xs"
                    >
                      {tr('Cancel', '取消', '取消')}
                    </button>
                  </div>
                  {addError && <div className="text-xs text-red-600">{addError}</div>}
                </div>
              )}

              {/* Drag hint */}
              {hasCustomOrder && (
                <div className="text-xs text-muted-foreground flex items-center gap-1">
                  <GripVertical className="h-3 w-3" />
                  {tr(
                    'Rows reordered. Drag to adjust, or use "Re-arrange Code" to apply new numbering.',
                    '科目已重新排序。拖曳以調整，或使用「重新編碼」應用新編號。',
                    '科目已重新排序。拖曳以调整，或使用「重新编码」应用新编号。',
                  )}
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
                        {/* Only render top-level accounts (no living parent). Children render under their parent when expanded. */}
                        {grouped[type].filter(a => {
                          if (!a.parent_code) return true;
                          const parentExists = allAccounts.some(p => p.account_code === a.parent_code);
                          return !parentExists; // orphan — show standalone
                        }).map((a, i) => {
                          const isParent = isParentCode(a.account_code);
                          const isExpanded = !!expandedAccounts[a.account_code];
                          const isRemoved = removedCodes.has(a.account_code);
                          const childrenRaw = allAccounts.filter(c => c.parent_code === a.account_code);
                          // Sort children by customOrder if set, otherwise by code
                          const order = customOrder[type];
                          const children = order && order.length > 0
                            ? [...childrenRaw].sort((ca, cb) => {
                                const ai = order.indexOf(ca.account_code);
                                const bi = order.indexOf(cb.account_code);
                                if (ai !== -1 && bi !== -1) return ai - bi;
                                if (ai !== -1) return -1;
                                if (bi !== -1) return 1;
                                return ca.account_code.localeCompare(cb.account_code);
                              })
                            : [...childrenRaw].sort((ca, cb) => ca.account_code.localeCompare(cb.account_code));
                          const hasChildren = children.length > 0;
                          const isDragging = dragCode === a.account_code;

                          return (
                            <React.Fragment key={a.account_code}>
                              <div
                                draggable
                                onDragStart={(e) => handleDragStart(e, a.account_code, type)}
                                onDragOver={handleDragOver}
                                onDragEnter={() => handleDragEnter(a.account_code, type)}
                                onDragEnd={handleDragEnd}
                                onClick={() => hasChildren && toggleAccount(a.account_code)}
                                className={`flex items-center gap-2 px-3 py-1.5 border-b last:border-b-0 hover:bg-muted/30 transition-colors select-none ${
                                  hasChildren ? 'cursor-pointer' : ''
                                } ${getDepthBgClass(a.account_code)} ${
                                  isDragging ? 'opacity-50 ring-2 ring-primary' : ''
                                }`}
                              >
                                {/* Grip handle */}
                                <span className="flex-shrink-0 text-muted-foreground/40 cursor-grab active:cursor-grabbing">
                                  <GripVertical className="h-3 w-3" />
                                </span>

                                {/* Expand chevron for parents */}
                                <span className="w-4 flex-shrink-0">
                                  {hasChildren ? (
                                    isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />
                                  ) : (
                                    <span className="w-3" />
                                  )}
                                </span>

                                {/* Code */}
                                <code className={`flex-shrink-0 font-mono text-[11px] ${
                                  isParent ? 'font-bold' : ''
                                }`}>
                                  <span className="inline-flex items-center gap-1">
                                    {a.account_code}
                                    {isParent && (
                                      <button
                                        type="button"
                                        onClick={(e) => { e.stopPropagation(); handleAddChild(a.account_code, a.account_type); }}
                                        title={tr('Add sub-account', '新增子科目', '新增子科目')}
                                        className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground transition-colors flex-shrink-0"
                                      >
                                        <Plus className="h-2.5 w-2.5" />
                                      </button>
                                    )}
                                  </span>
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
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (isRemoved) {
                                      restoreAccount(a.account_code);
                                    } else {
                                      requestRemove(a.account_code, a.account_name);
                                    }
                                  }}
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
                              {isExpanded && hasChildren && children.map((child) => {
                                const childIsParent = isParentCode(child.account_code);
                                const childIsExpanded = !!expandedAccounts[child.account_code];
                                const childIsRemoved = removedCodes.has(child.account_code);
                                const grandchildrenRaw = allAccounts.filter(c => c.parent_code === child.account_code);
                                const grandchildren = order && order.length > 0
                                  ? [...grandchildrenRaw].sort((ga, gb) => {
                                      const ai = order.indexOf(ga.account_code);
                                      const bi = order.indexOf(gb.account_code);
                                      if (ai !== -1 && bi !== -1) return ai - bi;
                                      if (ai !== -1) return -1;
                                      if (bi !== -1) return 1;
                                      return ga.account_code.localeCompare(gb.account_code);
                                    })
                                  : [...grandchildrenRaw].sort((ga, gb) => ga.account_code.localeCompare(gb.account_code));
                                const childHasChildren = grandchildren.length > 0;
                                const childIsDragging = dragCode === child.account_code;
                                return (
                                  <React.Fragment key={child.account_code}>
                                    <div
                                      draggable
                                      onDragStart={(e) => handleDragStart(e, child.account_code, type)}
                                      onDragOver={handleDragOver}
                                      onDragEnter={() => handleDragEnter(child.account_code, type)}
                                      onDragEnd={handleDragEnd}
                                      onClick={() => childHasChildren && toggleAccount(child.account_code)}
                                      className={`flex items-center gap-2 px-3 py-1.5 border-b last:border-b-0 select-none ${
                                        getDepthBgClass(child.account_code)
                                      } ${childIsDragging ? 'opacity-50 ring-2 ring-primary' : ''} ${
                                        childHasChildren ? 'cursor-pointer' : ''
                                      }`}
                                    >
                                      <span className="flex-shrink-0 text-muted-foreground/40 cursor-grab active:cursor-grabbing">
                                        <GripVertical className="h-3 w-3" />
                                      </span>
                                      <span className="w-4 flex-shrink-0">
                                        {childHasChildren ? (
                                          childIsExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />
                                        ) : (
                                          <span className="w-3" />
                                        )}
                                      </span>
                                      <code className={`flex-shrink-0 font-mono text-[11px] ml-5 ${childIsParent ? 'font-bold' : ''}`}>
                                        <span className="inline-flex items-center gap-1">
                                          {child.account_code}
                                          {childIsParent && (
                                            <button
                                              type="button"
                                              onClick={(e) => { e.stopPropagation(); handleAddChild(child.account_code, child.account_type); }}
                                              title={tr('Add sub-account', '新增子科目', '新增子科目')}
                                              className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground transition-colors flex-shrink-0"
                                            >
                                              <Plus className="h-2.5 w-2.5" />
                                            </button>
                                          )}
                                        </span>
                                      </code>
                                      <span className={`flex-1 truncate ${childIsParent ? 'font-bold' : 'text-muted-foreground'}`}>
                                        {child.account_name}
                                      </span>
                                      {child.is_custom && (
                                        <span className="text-[9px] px-1 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300 flex-shrink-0">
                                          ✦
                                        </span>
                                      )}
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          if (childIsRemoved) {
                                            restoreAccount(child.account_code);
                                          } else {
                                            requestRemove(child.account_code, child.account_name);
                                          }
                                        }}
                                        className={`flex-shrink-0 p-0.5 rounded hover:bg-muted ${
                                          childIsRemoved
                                            ? 'text-green-600 hover:text-green-700'
                                            : 'text-muted-foreground hover:text-red-600'
                                        }`}
                                        title={
                                          childIsRemoved
                                            ? tr('Undo remove', '取消移除', '取消移除')
                                            : tr('Remove account', '移除科目', '移除科目')
                                        }
                                      >
                                        {childIsRemoved ? (
                                          <Undo2 className="h-3.5 w-3.5" />
                                        ) : (
                                          <Minus className="h-3.5 w-3.5" />
                                        )}
                                      </button>
                                    </div>
                                    {/* Grandchildren */}
                                    {childIsExpanded && childHasChildren && grandchildren.map((gc) => (
                                      <div
                                        key={gc.account_code}
                                        draggable
                                        onDragStart={(e) => handleDragStart(e, gc.account_code, type)}
                                        onDragOver={handleDragOver}
                                        onDragEnter={() => handleDragEnter(gc.account_code, type)}
                                        onDragEnd={handleDragEnd}
                                        className={`flex items-center gap-2 px-3 py-1.5 border-b last:border-b-0 select-none ${
                                          getDepthBgClass(gc.account_code)
                                        } ${dragCode === gc.account_code ? 'opacity-50 ring-2 ring-primary' : ''}`}
                                      >
                                        <span className="flex-shrink-0 text-muted-foreground/40 cursor-grab active:cursor-grabbing">
                                          <GripVertical className="h-3 w-3" />
                                        </span>
                                        <span className="w-4 flex-shrink-0" />
                                        <span className="w-4 flex-shrink-0" />
                                        <code className="flex-shrink-0 font-mono text-[11px] ml-8">
                                          {gc.account_code}
                                        </code>
                                        <span className="flex-1 truncate text-muted-foreground">
                                          {gc.account_name}
                                        </span>
                                        {gc.is_custom && (
                                          <span className="text-[9px] px-1 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300 flex-shrink-0">
                                            ✦
                                          </span>
                                        )}
                                        <button
                                          type="button"
                                          onClick={() => {
                                            if (removedCodes.has(gc.account_code)) {
                                              restoreAccount(gc.account_code);
                                            } else {
                                              requestRemove(gc.account_code, gc.account_name);
                                            }
                                          }}
                                          className={`flex-shrink-0 p-0.5 rounded hover:bg-muted ${
                                            removedCodes.has(gc.account_code)
                                              ? 'text-green-600 hover:text-green-700'
                                              : 'text-muted-foreground hover:text-red-600'
                                          }`}
                                          title={
                                            removedCodes.has(gc.account_code)
                                              ? tr('Undo remove', '取消移除', '取消移除')
                                              : tr('Remove account', '移除科目', '移除科目')
                                          }
                                        >
                                          {removedCodes.has(gc.account_code) ? (
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

                              {/* Inline add form below this parent */}
                              {isExpanded && addFormParent === a.account_code && (
                                <div className="border rounded-lg p-3 mx-2 my-2 bg-muted/30 space-y-2">
                                  <div className="flex items-center justify-between">
                                    <span className="text-xs font-semibold">
                                      {tr('New sub-account under', '新增子科目於', '新增子科目于')} {a.account_code}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => { setAddFormParent(null); setAddError(''); }}
                                      className="p-0.5 hover:bg-muted rounded"
                                    >
                                      <X className="h-3 w-3" />
                                    </button>
                                  </div>
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
                                    <input
                                      type="text"
                                      value={draft.parent_code || ''}
                                      disabled
                                      className="w-20 px-2 py-1 border rounded text-xs font-mono bg-muted/30 text-muted-foreground"
                                    />
                                    <button
                                      type="button"
                                      onClick={handleAdd}
                                      className="px-3 py-1 bg-primary text-primary-foreground rounded text-xs font-medium"
                                    >
                                      {tr('Add', '新增', '新增')}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => { setAddFormParent(null); setAddError(''); }}
                                      className="px-2 py-1 border rounded text-xs"
                                    >
                                      {tr('Cancel', '取消', '取消')}
                                    </button>
                                  </div>
                                  {addError && <div className="text-xs text-red-600">{addError}</div>}
                                </div>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}

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

      {/* ConfirmDialog for cascading parent removal */}
      <ConfirmDialog
        show={!!confirmRemove}
        title={tr('Remove Account', '移除科目', '移除科目')}
        message={`${confirmRemove?.code} — ${confirmRemove?.name}\n\n${
          confirmChildrenCount > 0
            ? tr(
                `This account has ${confirmChildrenCount} sub-account(s). They will also be marked for removal.`,
                `此科目有 ${confirmChildrenCount} 個子科目，將一併標記為移除。`,
                `此科目有 ${confirmChildrenCount} 个子科目，将一并标记为移除。`,
              )
            : tr('This account will not be seeded.', '此科目將不會被建立。', '此科目将不会被建立。')
        }`}
        confirmLabel={tr('Remove', '移除', '移除')}
        danger
        onConfirm={confirmRemoveAction}
        onCancel={() => setConfirmRemove(null)}
      />
    </div>
  );
}
