import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useDateFilter } from '../contexts/DateFilterContext';
import { FileSearch, GitCompare, ArrowLeftRight, Link2, GitMerge, FolderOpen, CalendarDays, Activity, ChevronRight } from 'lucide-react';
import AdminDashboard from './AdminDashboard';
import MatchSuggestionsModal from '../components/MatchSuggestionsModal';
import { tr } from '../lib/i18nHelpers';

export default function Dashboard() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();

  if (user?.role === 'admin') return <AdminDashboard />;

  const { startDate, endDate } = useDateFilter();
  const dashParams = [startDate, endDate].filter(Boolean).length > 0
    ? `?start_date=${startDate || ''}&end_date=${endDate || ''}`
    : '';
  const { data: dashData } = useQuery({ queryKey: ['dashboard', startDate, endDate], queryFn: () => api(`/dashboard${dashParams}`), refetchInterval: 30000 });
  const { data: reviewCount } = useQuery({ queryKey: ['review-queue-count'], queryFn: () => api('/review-queue/count'), refetchInterval: 10000 });
  const { data: linkStats } = useQuery({ queryKey: ['link-stats'], queryFn: () => api('/dashboard/link-stats'), refetchInterval: 30000 });
  const { data: fileData } = useQuery({ queryKey: ['file-storage'], queryFn: () => api('/file-storage?limit=5') });

  const d = dashData || {};
  const rq = (reviewCount as any) || {};
  const ls = (linkStats as any) || {};
  const files = (fileData?.data || []) as any[];

  const [showMatchModal, setShowMatchModal] = useState(false);

  // Row 1 — 2 cards
  const statCardsRow1 = [
    {
      key: 'documents', icon: FileSearch, color: 'hsl(var(--primary))', textColor: 'text-primary',
      label: tr('Documents to Review', '待檢視文件', '待检视文件'),
      value: rq.total || 0,
      sub: rq.total > 0
        ? [
            rq.counts?.bank_statements > 0 ? `${rq.counts.bank_statements} ${tr('bank', '銀行', '银行')}` : '',
            rq.counts?.invoices > 0 ? `${rq.counts.invoices} ${tr('invoices', '發票', '发票')}` : '',
            rq.counts?.card_statements > 0 ? `${rq.counts.card_statements} ${tr('cards', '信用卡', '信用卡')}` : '',
            rq.counts?.journal_entries > 0 ? `${rq.counts.journal_entries} ${tr('JE', '分錄', '分录')}` : '',
          ].filter(Boolean).join(' · ') || undefined
        : undefined,
      onClick: () => navigate('/review-queue'),
    },
    {
      key: 'unreconciled', icon: GitCompare, color: '#ef4444', textColor: 'text-red-600',
      label: tr('Unreconciled', '未對賬', '未对账'),
      value: d.unmatched_transactions || 0,
      sub: (d.unmatched_transactions || 0) > 0
        ? tr('Click to review suggestions', '點擊查看建議', '点击查看建议')
        : tr('All matched!', '全部已匹配！', '全部已匹配！'),
      onClick: () => setShowMatchModal(true),
    },
  ];

  // Row 2 — 4 cards (link coverage + AP/AR)
  const bankPct = ls.bank?.pct ?? 0;
  const invPct = ls.invoices?.pct ?? 0;
  const chainPct = ls.full_chain?.pct ?? 0;

  const statCardsRow2 = [
    {
      key: 'bank-inv', icon: Link2, color: '#3b82f6', textColor: 'text-blue-600',
      label: tr('Bank → Invoice Linked', '銀行→發票已連結', '银行→发票已连结'),
      value: `${bankPct}%`,
      sub: ls.bank ? `${ls.bank.linked} / ${ls.bank.total} ${tr('txns', '筆', '笔')}` : undefined,
      progress: bankPct,
    },
    {
      key: 'inv-receipt', icon: FileSearch, color: '#8b5cf6', textColor: 'text-purple-600',
      label: tr('Invoice → Receipt Linked', '發票→收據已連結', '发票→收据已连结'),
      value: `${invPct}%`,
      sub: ls.invoices ? `${ls.invoices.linked_receipts} / ${ls.invoices.total} ${tr('invoices', '張發票', '张发票')}` : undefined,
      progress: invPct,
    },
    {
      key: 'full-chain', icon: GitMerge, color: '#10b981', textColor: 'text-green-600',
      label: tr('Full Chain Linked', '完整鏈已連結', '完整链已连结'),
      value: `${chainPct}%`,
      sub: ls.full_chain ? `${ls.full_chain.count} ${tr('txns', '筆', '笔')}` : undefined,
      progress: chainPct,
    },
    {
      key: 'outstanding', icon: ArrowLeftRight, color: '#10b981', textColor: 'text-green-600',
      label: tr('Outstanding AP / AR', '未清應付/應收', '未清应付/应收'),
      value: null as any,
      sub: null as any,
      ap: d.ap_balance,
      ar: d.ar_balance,
      progress: undefined as number | undefined,
    },
  ];

  // Compliance deadlines
  const deadlines = (d.upcoming_compliance || []) as any[];

  // Recent activity from journal entries
  const recentEntries = (d.recent_entries || []) as any[];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">{tr('Welcome back', '歡迎回來', '欢迎回来')}, {user?.name}</h2>
        <p className="text-muted-foreground mt-1">
          {tr('Review your outstanding tasks, documents, and reconciliation items.', '檢視您的待辦任務、文件及對賬項目。', '检视您的待办任务、文件及对账项目。')}
          {d.source === 'bank' && (
            <span className="text-amber-600 text-xs ml-2">
              {tr('(Bank data estimate — please post auto-generated entries)', '（銀行數據估算 — 請執行自動產生分錄）', '（银行數據估算 — 請執行自动產生分錄）')}
            </span>
          )}
        </p>
      </div>

      {/* Row 1 — 2 cards */}
      <div className="grid grid-cols-2 gap-4">
        {statCardsRow1.map(s => {
          const Icon = s.icon;
          return (
            <button
              key={s.key}
              onClick={s.onClick}
              className="bg-card border rounded-xl p-4 text-left hover:shadow-md transition-shadow cursor-pointer"
              style={{ borderTop: `3px solid ${s.color}` }}
            >
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
                <Icon className="h-4 w-4" style={{ color: s.color }} />
                {s.label}
              </div>
              <div className="text-2xl font-bold">{s.value ?? '—'}</div>
              {s.sub && <div className="text-xs text-muted-foreground mt-1">{s.sub}</div>}
            </button>
          );
        })}
      </div>

      {/* Row 2 — 4 cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {statCardsRow2.map(s => {
          const Icon = s.icon;
          if (s.key === 'outstanding') {
            return (
              <div key={s.key} className="bg-card border rounded-xl p-4" style={{ borderTop: `3px solid ${s.color}` }}>
                <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
                  <Icon className="h-4 w-4" style={{ color: s.color }} />
                  {s.label}
                </div>
                <div className="text-lg font-bold">
                  {tr('AP', '應付', '应付')}: {tr('HKD', '港幣', '港币')} {(s.ap || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {tr('AR', '應收', '应收')}: {tr('HKD', '港幣', '港币')} {(s.ar || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </div>
              </div>
            );
          }
          return (
            <div key={s.key} className="bg-card border rounded-xl p-4" style={{ borderTop: `3px solid ${s.color}` }}>
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
                <Icon className="h-4 w-4" style={{ color: s.color }} />
                {s.label}
              </div>
              <div className="text-2xl font-bold">{s.value ?? '—'}</div>
              {s.progress !== undefined && (
                <div className="mt-2 h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${Math.min(s.progress, 100)}%`, backgroundColor: s.color }}
                  />
                </div>
              )}
              {s.sub && <div className="text-xs text-muted-foreground mt-1">{s.sub}</div>}
            </div>
          );
        })}
      </div>

      {/* Dashboard Body */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Recent Documents */}
        <div className="bg-card border rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <FolderOpen className="h-4 w-4 text-blue-600" />
              {tr('Recent Documents', '最近文件', '最近文件')}
            </h3>
            <a href="/file-storage" className="text-xs text-primary hover:underline flex items-center gap-1">
              {tr('View all', '檢視全部', '检视全部')} <ChevronRight className="h-3 w-3" />
            </a>
          </div>
          {files.length > 0 ? (
            <div className="space-y-0">
              {files.slice(0, 5).map((f: any, i: number) => (
                <div key={f.id || i} className={`flex items-center justify-between py-2 ${i < Math.min(files.length, 5) - 1 ? 'border-b border-border/50' : ''}`}>
                  <span className="text-sm truncate flex-1">{f.original_name || f.filename || f.name || `File #${i + 1}`}</span>
                  <span className="text-xs font-mono text-muted-foreground ml-2">{f.id || f.ref || ''}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-6 text-center text-sm text-muted-foreground">
              {tr('No documents yet. Upload bank statements or invoices to get started.', '暫無文件。上傳銀行月結單或發票以開始使用。', '暂无文件。上传银行月结单或发票以开始使用。')}
            </div>
          )}
        </div>

        {/* Upcoming Deadlines */}
        <div className="bg-card border rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <CalendarDays className="h-4 w-4 text-amber-600" />
              {tr('Upcoming Deadlines', '即將到期', '即将到期')}
            </h3>
            <a href="/compliance" className="text-xs text-primary hover:underline flex items-center gap-1">
              {tr('View all', '檢視全部', '检视全部')} <ChevronRight className="h-3 w-3" />
            </a>
          </div>
          {deadlines.length > 0 ? (
            <div className="space-y-0">
              {deadlines.slice(0, 4).map((dl: any, i: number) => (
                <div key={i} className={`flex items-center gap-3 py-2 ${i < Math.min(deadlines.length, 4) - 1 ? 'border-b border-border/50' : ''}`}>
                  <span className="text-xs font-mono font-medium px-2 py-0.5 rounded whitespace-nowrap bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-400">
                    {dl.date_value || '—'}
                  </span>
                  <span className="text-sm flex-1">{dl.title_en || dl.title_zh || '—'}</span>
                  <span className={`text-xs font-medium ${dl.status === 'overdue' || dl.status === 'pending' ? 'text-red-600' : 'text-muted-foreground'}`}>
                    {dl.status || ''}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-6 text-center text-sm text-muted-foreground">
              {tr('No upcoming deadlines.', '暫無即將到期項目。', '暂无即将到期项目。')}
            </div>
          )}
        </div>

        {/* Recent Activity */}
        <div className="bg-card border rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Activity className="h-4 w-4 text-purple-600" />
              {tr('Recent Activity', '最近活動', '最近活动')}
            </h3>
            <a href="/audit-log" className="text-xs text-primary hover:underline flex items-center gap-1">
              {tr('Full log', '完整記錄', '完整记录')} <ChevronRight className="h-3 w-3" />
            </a>
          </div>
          {recentEntries.length > 0 ? (
            <div className="space-y-0">
              {recentEntries.slice(0, 5).map((e: any, i: number) => (
                <div key={e.id || i} className={`flex items-start gap-3 py-2 ${i < Math.min(recentEntries.length, 5) - 1 ? 'border-b border-border/50' : ''}`}>
                  <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${e.status === 'posted' ? 'bg-green-500' : 'bg-amber-500'}`} />
                  <div className="min-w-0">
                    <p className="text-sm">
                      <span className="font-medium">{e.entry_number || `#${i + 1}`}</span>
                      {' — '}{e.description || tr('Journal entry', '日記帳分錄', '日记帐分录')}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">{e.entry_date || e.created_at?.slice(0, 10)}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-6 text-center text-sm text-muted-foreground">
              {tr('No recent activity.', '暫無最近活動。', '暂无最近活动。')}
            </div>
          )}
        </div>
      </div>

      {/* Match Suggestions Modal */}
      {showMatchModal && (
        <MatchSuggestionsModal onClose={() => setShowMatchModal(false)} />
      )}
    </div>
  );
}
