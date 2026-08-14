import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { tr } from '../lib/i18nHelpers';
import { ChevronDown, ChevronRight, CreditCard, Landmark } from 'lucide-react';

interface Props {
  endpoint: string;          // e.g. '/bank-statements/continuity' or '/card-statements/continuity'
  queryKey: string;          // e.g. 'bank-continuity' or 'card-continuity'
  type: 'bank' | 'card';    // affects labels and grouping display
}

export default function ContinuityChain({ endpoint, queryKey, type }: Props) {
  const { i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: [queryKey],
    queryFn: () => api(endpoint),
    staleTime: 0, // never serve stale — continuity must always reflect current DB state
  });

  const groups: any[] = (data as any)?.groups || [];
  if (isLoading || groups.length === 0) return null;

  const hasIssues = groups.some((g: any) => g.status !== 'complete');

  const groupKey = (g: any) => type === 'card' ? (g.card_number || g.card_issuer) : g.account_number;
  const groupIcon = (g: any) => type === 'card' ? <CreditCard className="h-4 w-4 text-muted-foreground" /> : <Landmark className="h-4 w-4 text-muted-foreground" />;
  const groupLabel = (g: any) => type === 'card'
    ? `${g.card_issuer || ''} ${g.card_network || ''} ••••${g.card_number || ''}`
    : `${g.bank_name || ''} ${g.account_number || ''}`;
  const itemPeriod = (link: any) => `${link.statement_year}-${String(link.statement_month).padStart(2, '0')}`;
  const fmtAmount = (v: any) =>
    v == null ? '—' : Number(v).toLocaleString('en-HK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const issueIcon = (issues: string[]) => {
    if (issues.includes('gap')) return '🔴';
    if (issues.includes('balance_mismatch')) return '🟡';
    if (issues.includes('duplicate')) return '🟣';
    if (issues.includes('overlap') || issues.includes('date_overlap')) return '🟠';
    if (issues.includes('matched')) return '🟢';
    if (issues.includes('first')) return '⚪';
    return '⚪';
  };

  const groupStatusColor = (status: string) => {
    if (status === 'complete') return 'border-green-400 bg-green-50 dark:bg-green-950/30';
    if (status === 'has_gaps') return 'border-red-400 bg-red-50 dark:bg-red-950/30';
    if (status === 'has_mismatches') return 'border-yellow-400 bg-yellow-50 dark:bg-yellow-950/30';
    if (status === 'has_duplicates') return 'border-purple-400 bg-purple-50 dark:bg-purple-950/30';
    return 'border-orange-400 bg-orange-50 dark:bg-orange-950/30';
  };

  return (
    <div className={`rounded-lg border-2 p-4 space-y-3 ${hasIssues ? 'border-red-400 bg-red-50 dark:bg-red-950/20' : 'border-green-400 bg-green-50 dark:bg-green-950/20'}`}>
      <button onClick={() => setExpanded(!expanded)} className="w-full flex items-center justify-between">
        <div className="flex items-center gap-2">
          {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
          <span className="font-bold text-sm">
            {hasIssues ? '⚠️' : '✅'}{' '}
            {tr('Statement Continuity Chain', '月結單連續性檢查', '月结单连续性检查')}
          </span>
          {!expanded && <span className="text-xs text-muted-foreground ml-2">
            {groups.length} {type === 'card' ? tr('card(s)', '張卡', '张卡') : tr('account(s)', '個帳戶', '个账户')}
            {hasIssues && <span className="text-red-600 font-medium ml-2">{tr('— issues found', '— 發現問題', '— 发现问题')}</span>}
          </span>}
        </div>
        <div className="flex items-center gap-1">
          {groups.map((g: any) => (
            <span key={groupKey(g)} className={`w-2.5 h-2.5 rounded-full ${g.status === 'complete' ? 'bg-green-500' : g.status === 'has_gaps' ? 'bg-red-500' : g.status === 'has_mismatches' ? 'bg-yellow-500' : 'bg-orange-500'}`} />
          ))}
        </div>
      </button>

      {expanded && (
        <div className="space-y-3 pt-1">
          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
            <span>🟢 {tr('Matched', '正常', '正常')}</span>
            <span>🔴 {tr('Gap', '缺失', '缺失')}</span>
            <span>🟡 {tr('Mismatch', '餘額不符', '余额不符')}</span>
            <span>🟠 {tr('Overlap', '重疊', '重叠')}</span>
            <span>🟣 {tr('Duplicate', '重複', '重复')}</span>
          </div>

          {groups.map((g: any) => (
            <div key={groupKey(g)} className={`rounded-lg border p-3 space-y-2 ${groupStatusColor(g.status)}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {groupIcon(g)}
                  <span className="text-sm font-medium">{groupLabel(g)}</span>
                  <span className="text-xs text-muted-foreground">{g.currency}</span>
                </div>
                <span className={`text-xs font-medium px-2 py-0.5 rounded ${g.status === 'complete' ? 'bg-green-200 text-green-800' : 'bg-red-200 text-red-800'}`}>
                  {g.status === 'complete' ? tr('Complete', '完整', '完整') : tr('Issues found', '有問題', '有问题')}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-1">
                {g.chain.map((link: any, idx: number) => (
                  <div key={link.id} className="flex items-center gap-1">
                    {idx > 0 && !link.issues.includes('first') && (
                      <span className="text-xs">{issueIcon(link.issues)}</span>
                    )}
                    <div className={`relative group px-2 py-1 rounded text-xs border cursor-default ${
                      link.issues.includes('gap') ? 'border-red-400 bg-red-100 dark:bg-red-900/30' :
                      link.issues.includes('balance_mismatch') ? 'border-yellow-400 bg-yellow-100 dark:bg-yellow-900/30' :
                      link.issues.includes('duplicate') ? 'border-purple-400 bg-purple-100 dark:bg-purple-900/30' :
                      link.issues.includes('overlap') || link.issues.includes('date_overlap') ? 'border-orange-400 bg-orange-100 dark:bg-orange-900/30' :
                      'border-green-300 bg-green-100 dark:bg-green-900/30'}`}>
                      <div className="text-center font-mono font-medium">{itemPeriod(link)}</div>
                      <div className="text-center text-[10px] font-mono text-muted-foreground" title={tr('Opening → Closing', '期初 → 期末', '期初 → 期末')}>
                        {fmtAmount(link.opening_balance)} → {fmtAmount(link.closing_balance)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {g.chain.some((l: any) => l.issues.includes('balance_mismatch')) && (
                <div className="text-xs text-yellow-700 dark:text-yellow-400 mt-2 space-y-1">
                  {tr('Balance mismatches between closing and next opening:', '期末與下期期初餘額不符：', '期末与下期期初余额不符：')}
                  {g.chain.filter((l: any) => l.issues.includes('balance_mismatch')).map((l: any) => {
                    const idx = g.chain.findIndex((c: any) => c.id === l.id);
                    const prev = idx > 0 ? g.chain[idx - 1] : null;
                    return (
                      <div key={l.id} className="font-mono">
                        {prev ? `${itemPeriod(prev)} ${tr('closing', '期末', '期末')} ${fmtAmount(prev.closing_balance)} → ${itemPeriod(l)} ${tr('opening', '期初', '期初')} ${fmtAmount(l.actual_opening)}` : ''}
                        {' '}· {tr('expected', '應為', '应为')} {fmtAmount(l.expected_opening)}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
