import { useState } from 'react';
import { Check, Lock, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { tr } from '../lib/i18nHelpers';
import { CoaNode, isTemporaryAccount } from '../lib/coa-hierarchy';

export interface PostingLine {
  account_code: string;
  amount: number;
}

interface TxPostingPanelProps {
  kind: 'bank' | 'card';
  /** Movement amount to allocate (abs of deposit/withdrawal/amount) */
  movementAmount: number;
  /** Which side the EDITABLE lines sit on: deposit ⇒ 'Cr' (bank Dr fixed), withdrawal ⇒ 'Dr' (bank Cr fixed); cards ⇒ 'Dr' */
  contraSide: 'Dr' | 'Cr';
  /** Fixed side display: code + name (bank account or Cash on Hand) */
  fixedCode: string;
  fixedName: string;
  /** Existing posting from GET detail; null = not yet posted / auto only */
  posting: { entry_id: string; entry_number: string; entry_source: string; lines: { account_code: string; account_name: string; debit: number; credit: number }[] } | null;
  /** Current single-code fallback when no posting exists yet */
  currentCode?: string | null;
  /** Review suggestion seed (only honoured when no posting exists yet) */
  initialContraLines?: PostingLine[];
  accounts: any[];
  tree: CoaNode[];
  disabled?: boolean;
  lockedReason?: string;
  onSave: (lines: PostingLine[]) => Promise<void>;
  onResetAuto?: () => Promise<void>;
}

/**
 * Inline multi-account posting editor shown under an expanded transaction row.
 * Fixed side (bank line / card cash line) renders locked; the editable side is
 * split across N accounts with amounts. Save validates allocation == movement.
 */
export default function TxPostingPanel({
  kind, movementAmount, contraSide, fixedCode, fixedName, posting, currentCode, initialContraLines,
  accounts, tree, disabled, lockedReason, onSave, onResetAuto,
}: TxPostingPanelProps) {
  const rounded = Math.round(movementAmount * 100) / 100;
  const fixedSide: 'Dr' | 'Cr' = contraSide === 'Dr' ? 'Cr' : 'Dr';
  const isContraLine = (l: { debit: number; credit: number }) => contraSide === 'Cr' ? l.credit > 0 : l.debit > 0;
  const isFixedLine = (l: { debit: number; credit: number }) => contraSide === 'Cr' ? l.debit > 0 : l.credit > 0;
  // Legacy auto-JEs (pre 2026-08-22) posted the fixed side to hardcoded 11101
  // instead of the statement's real bank account. Derive sides by Dr/Cr, not by
  // code, so those render honestly: actual fixed line locked, real contra lines editable.
  const postedFixedLine = posting?.lines.find(isFixedLine) || null;
  const displayFixedCode = postedFixedLine?.account_code || fixedCode;
  const displayFixedName = postedFixedLine?.account_name || fixedName;
  const displayFixedAmount = postedFixedLine
    ? Math.round((postedFixedLine.debit || postedFixedLine.credit || 0) * 100) / 100
    : rounded;
  const [lines, setLines] = useState<PostingLine[]>(() => {
    if (posting && posting.lines.length > 0) {
      const bySide = posting.lines.filter(isContraLine);
      const fallback = bySide.length > 0 ? bySide : posting.lines.filter(l => l.account_code !== fixedCode);
      if (fallback.length > 0) {
        return fallback
          .map(l => ({ account_code: l.account_code, amount: Math.round((l.debit || l.credit || 0) * 100) / 100 }));
      }
    }
    if (initialContraLines && initialContraLines.length > 0) return initialContraLines;
    if (currentCode) return [{ account_code: currentCode, amount: rounded }];
    return [{ account_code: '', amount: rounded }];
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const allocated = Math.round(lines.reduce((s, l) => s + (Number(l.amount) || 0), 0) * 100) / 100;
  const balanced = Math.abs(allocated - rounded) < 0.01;
  const allPicked = lines.every(l => !!l.account_code);
  const canSave = !disabled && !saving && balanced && allPicked && lines.length > 0;

  const addLine = () => {
    const remaining = Math.round((rounded - allocated) * 100) / 100;
    setLines(prev => [...prev, { account_code: '', amount: remaining > 0 ? remaining : 0 }]);
  };
  const updLine = (i: number, patch: Partial<PostingLine>) =>
    setLines(prev => prev.map((l, idx) => idx === i ? { ...l, ...patch } : l));
  const rmLine = (i: number) => setLines(prev => prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev);

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      await onSave(lines.map(l => ({ account_code: l.account_code, amount: Math.round(l.amount * 100) / 100 })));
    } catch (e: any) {
      setError(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const resetAuto = async () => {
    setConfirmReset(false);
    setError(null);
    setSaving(true);
    try { await onResetAuto?.(); } catch (e: any) { setError(e?.message || 'Reset failed'); } finally { setSaving(false); }
  };

  const isTemp = (code: string) => isTemporaryAccount(accounts.find(a => a.account_code === code)?.account_name);

  if (disabled) {
    return (
      <div className="px-4 py-2 text-xs text-muted-foreground flex items-center gap-2">
        <Lock className="h-3 w-3" /> {lockedReason || tr('Posting is locked', '過賬已鎖定', '过账已锁定')}
      </div>
    );
  }

  return (
    <div className="bg-muted/20 border-t border-border px-4 py-3 space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          {tr('Journal posting', '日記賬分錄', '日记账分录')}
          {posting?.entry_number && <span className="ml-2 font-mono opacity-70">{posting.entry_number}</span>}
        </span>
        {posting?.entry_source === 'manual' && (
          <button onClick={() => setConfirmReset(true)} disabled={saving}
            className="text-[10px] flex items-center gap-1 text-amber-600 hover:text-amber-700 border border-amber-300 rounded px-1.5 py-0.5">
            <RotateCcw className="h-3 w-3" /> {tr('Reset to auto', '重設為自動', '重设为自动')}
          </button>
        )}
      </div>

      {/* Fixed bank/cash side — shows the ACTUAL posted fixed line (legacy JEs may differ from the statement's bank account) */}
      <div className="flex items-center gap-2 text-xs bg-muted/60 border border-border rounded px-2 py-1.5">
        <span className={`font-mono font-bold ${fixedSide === 'Dr' ? 'text-red-600' : 'text-green-600'}`}>
          {fixedSide}
        </span>
        <span className="font-mono">{displayFixedCode}</span>
        <span className="text-muted-foreground truncate flex-1">{displayFixedName}</span>
        <span className="font-mono font-medium">{displayFixedAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
        <Lock className="h-3 w-3 text-muted-foreground" />
      </div>

      {/* Editable contra lines — side shown once as group label, not per row */}
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <span className={`font-mono font-bold text-xs ${contraSide === 'Dr' ? 'text-red-600' : 'text-green-600'}`}>{contraSide}</span>
        <span>
          {contraSide === 'Dr' ? tr('Debit accounts', '借方科目', '借方科目') : tr('Credit accounts', '貸方科目', '贷方科目')}
          {' — '}{tr('amounts must sum to', '各行金額總和須等於', '各行金额总和须等于')}
        </span>
        <span className="font-mono font-medium text-foreground">{rounded.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
      </div>
      {lines.map((l, i) => {
        const temp = isTemp(l.account_code);
        const selAcct = accounts.find(a => a.account_code === l.account_code);
        return (
          <div key={i} className={`flex items-center gap-2 text-xs border rounded px-2 py-1.5 ${
            temp ? 'border-red-300 bg-red-50 dark:bg-red-950/40' : 'border-input bg-background'
          }`}>
            <select
              value={l.account_code}
              onChange={e => updLine(i, { account_code: e.target.value })}
              title={
                temp
                  ? tr('Temporary account — reclassify to a specific COA account later', '暫記科目——稍後重新分類至具體會計科目', '暂记科目——稍后重新分类至具体会计科目')
                  : tr('COA account for this allocation', '此分配的會計科目', '此分配的会计科目')
              }
              className={`flex-1 min-w-0 border rounded px-1 py-0.5 bg-background truncate ${
                temp ? 'border-red-300 text-red-700 dark:text-red-300' : 'border-input'
              }`}
            >
              <option value="">{tr('-- Select account --', '-- 選科目 --', '-- 選科目 --')}</option>
              {tree.map(n => n.isParent ? (
                <option key={n.account.account_code} value="" disabled>
                  {`${'\u00A0'.repeat(n.depth * 2)}${n.account.account_code} ${n.account.account_name}`}
                </option>
              ) : (
                <option key={n.account.account_code} value={n.account.account_code}>
                  {`${'\u00A0'.repeat(n.depth * 3)}${n.account.account_code} ${n.account.account_name}${isTemporaryAccount(n.account.account_name) ? ' · 暫記' : ''}`}
                </option>
              ))}
            </select>
            <input
              type="number" step="0.01" min="0"
              value={l.amount || ''}
              onChange={e => updLine(i, { amount: parseFloat(e.target.value) || 0 })}
              className="w-24 px-1 py-0.5 border border-input rounded text-right font-mono bg-background"
            />
            {selAcct && temp && (
              <span className="text-[9px] px-1 rounded bg-red-100 text-red-700 dark:bg-red-900/40">暫記</span>
            )}
            <button onClick={() => rmLine(i)} disabled={lines.length <= 1}
              className="p-0.5 text-muted-foreground hover:text-red-500 disabled:opacity-30" title={tr('Remove line', '刪除此行', '删除此行')}>
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        );
      })}

      {/* Add + totals */}
      <div className="flex items-center justify-between">
        <button onClick={addLine} disabled={disabled}
          className="text-xs flex items-center gap-1 text-primary hover:underline disabled:opacity-40">
          <Plus className="h-3 w-3" /> {tr('Add account', '加入科目', '加入科目')}
        </button>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">
            {tr('Allocated', '已分配', '已分配')} {allocated.toLocaleString(undefined, { minimumFractionDigits: 2 })} / {rounded.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </span>
          {balanced
            ? <span className="inline-flex items-center text-green-600"><Check className="h-3.5 w-3.5 mr-0.5" />{tr('Balanced', '平衡', '平衡')}</span>
            : <span className="text-red-600 font-medium">{allocated > rounded ? '+' : ''}{(allocated - rounded).toFixed(2)}</span>}
        </div>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          onClick={save}
          disabled={!canSave}
          className="px-3 py-1 text-xs bg-primary text-primary-foreground rounded hover:opacity-90 disabled:opacity-30"
        >
          {saving ? '…' : tr('Save posting', '儲存分錄', '储存分录')}
        </button>
      </div>

      {/* Reset-to-auto confirmation */}
      {confirmReset && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setConfirmReset(false)}>
          <div className="bg-card border rounded-xl p-6 w-full max-w-md mx-4 space-y-3" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-base">{tr('Reset to automatic categorization?', '重設為自動分類？', '重设为自动分类？')}</h3>
              <button onClick={() => setConfirmReset(false)} className="ml-auto p-1 hover:bg-muted rounded"><X className="h-4 w-4" /></button>
            </div>
            <p className="text-sm text-muted-foreground">
              {tr(
                'Your manual categorization will be overridden — including any multiple-account split. The system will delete this custom posting and replace it with a single automatically mapped COA account. This cannot be undone.',
                '您的手動分類將被覆蓋——包括任何多科目拆分。系統將刪除此自訂分錄，並以單一自動映射的會計科目取代。此操作無法復原。',
                '您的手动分类将被覆盖——包括任何多科目拆分。系统将删除此自定义分录，并以单一自动映射的会计科目取代。此操作无法复原。',
              )}
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setConfirmReset(false)} className="px-4 py-1.5 border rounded text-sm hover:bg-muted">
                {tr('Cancel', '取消', '取消')}
              </button>
              <button onClick={resetAuto} className="px-4 py-1.5 bg-amber-600 text-white rounded text-sm hover:bg-amber-700">
                {tr('Reset to Auto', '重設為自動', '重设为自动')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
