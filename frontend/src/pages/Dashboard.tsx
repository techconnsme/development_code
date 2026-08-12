import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useDateFilter } from '../contexts/DateFilterContext';
import { FileSearch, GitCompare, ArrowLeftRight, Link2, GitMerge, FolderOpen, CalendarDays, Activity, ChevronRight, DollarSign, TrendingUp, TrendingDown, Receipt } from 'lucide-react';
import AdminDashboard from './AdminDashboard';
import { tr } from '../lib/i18nHelpers';

// Small helper card used in the period rows
function MiniCard({ icon: Icon, label, value, color, onClick }: {
  icon: any; label: string; value: string; color: string; onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={`bg-card border rounded-lg px-3 py-2 min-w-[120px] flex-1 ${onClick ? 'cursor-pointer hover:shadow-sm hover:border-primary/30 transition-shadow' : ''}`}
      style={{ borderTop: `2px solid ${color}` }}
    >
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-1">
        <Icon className="h-3 w-3" style={{ color }} />
        {label}
      </div>
      <div className="text-sm font-bold">{value}</div>
    </div>
  );
}

function Fmt(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

export default function Dashboard() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { startDate, endDate } = useDateFilter();

  if (user?.role === 'admin') return <AdminDashboard />;

  const dashParams = [startDate, endDate].filter(Boolean).length > 0
    ? `?start_date=${startDate || ''}&end_date=${endDate || ''}`
    : '';
  const { data: dashData, isFetching: dashFetching } = useQuery({ queryKey: ['dashboard', startDate, endDate], queryFn: () => api(`/dashboard${dashParams}`), refetchInterval: 30000, placeholderData: (prev: any) => prev });
  const { data: fileData } = useQuery({ queryKey: ['file-storage'], queryFn: () => api('/file-storage?limit=5') });

  const d = dashData || {};
  const files = (fileData?.data || []) as any[];
  const periods = (d.period_comparison || []) as any[];

  // Compliance deadlines
  const deadlines = (d.upcoming_compliance || []) as any[];
  const recentEntries = (d.recent_entries || []) as any[];

  return (
    <div className="space-y-6">
      <div className={`transition-opacity duration-200 ${dashFetching && dashData ? 'opacity-70' : ''}`}>
        <h2 className="text-2xl font-bold flex items-center gap-2">
          {tr('Welcome back', '歡迎回來', '欢迎回来')}, {user?.name}
          {dashFetching && dashData && (
            <span className="inline-block w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          )}
        </h2>
        <p className="text-muted-foreground mt-1">
          {tr('Review your outstanding tasks, documents, and reconciliation items.', '檢視您的待辦任務、文件及對賬項目。', '检视您的待办任务、文件及对账项目。')}
          {d.source === 'bank' && (
            <span className="text-amber-600 text-xs ml-2">
              {tr('(Bank data estimate — please post auto-generated entries)', '（銀行數據估算 — 請執行自動產生分錄）', '（银行數據估算 — 請執行自动產生分錄）')}
            </span>
          )}
        </p>
      </div>

      {/* ═══════════════════════════════════════════════════════════
          SECTION 1 — CURRENT POSITION (always today, no FY filter)
          ═══════════════════════════════════════════════════════════ */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          {tr('Current Position', '當前狀況', '当前状况')}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Cash on Hand */}
          <button
            onClick={() => navigate('/GJE')}
            className="bg-card border rounded-xl p-4 text-left hover:shadow-md transition-shadow cursor-pointer"
            style={{ borderTop: '3px solid #10b981' }}
          >
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
              <DollarSign className="h-4 w-4 text-green-600" />
              {tr('Cash on Hand', '手頭現金', '手头现金')}
            </div>
            <div className="text-2xl font-bold">
              {d.cash_balance != null
                ? `HKD ${(d.cash_balance as number).toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                : '—'}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {tr('Click to view GL entries', '點擊查看總帳分錄', '点击查看总账分录')}
            </div>
          </button>

          {/* Outstanding AP / AR */}
          <div className="bg-card border rounded-xl p-4" style={{ borderTop: '3px solid #10b981' }}>
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
              <ArrowLeftRight className="h-4 w-4 text-green-600" />
              {tr('Outstanding AP / AR', '未清應付/應收', '未清应付/应收')}
            </div>
            <div className="text-base font-bold text-orange-600 dark:text-orange-400">
              {tr('AP', '應付', '应付')}: HKD {(d.ap_balance || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </div>
            <div className="text-base font-bold text-blue-600 dark:text-blue-400 mt-1">
              {tr('AR', '應收', '应收')}: HKD {(d.ar_balance || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </div>
          </div>

          {/* Unreconciled */}
          <button
            onClick={() => navigate('/bank-statements')}
            className="bg-card border rounded-xl p-4 text-left hover:shadow-md transition-shadow cursor-pointer"
            style={{ borderTop: '3px solid #ef4444' }}
          >
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
              <GitCompare className="h-4 w-4 text-red-600" />
              {tr('Unreconciled', '未對賬', '未对账')}
            </div>
            <div className="text-2xl font-bold">{d.unmatched_transactions || 0}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {(d.unmatched_transactions || 0) > 0
                ? tr('Click to review bank statements', '點擊查看銀行月結單', '点击查看银行月结单')
                : tr('All matched!', '全部已匹配！', '全部已匹配！')}
            </div>
          </button>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════
          SECTION 2 — CURRENT PERIOD (matches selected FY)
          ═══════════════════════════════════════════════════════════ */}
      <div className={dashFetching && dashData ? 'opacity-70 transition-opacity duration-200' : ''}>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          {tr('Period Summary', '期間摘要', '期间摘要')}
          {periods[0] && <span className="ml-2 font-normal normal-case text-muted-foreground">— {periods[0].label}</span>}
        </h3>
        {periods[0] ? (
          <div className="space-y-2">
            {/* Row 1: Docs, Revenue, Expenses, Net P&L */}
            <div className="flex flex-wrap gap-2">
              <MiniCard
                icon={FileSearch} color="#6366f1"
                label="Docs to Review" value={String(periods[0].review_count || 0)}
                onClick={() => navigate('/review-queue')}
              />
              <MiniCard
                icon={TrendingUp} color="#22c55e"
                label="Revenue" value={`HKD ${Fmt(periods[0].revenue || 0)}`}
              />
              <MiniCard
                icon={TrendingDown} color="#ef4444"
                label="Expenses" value={`HKD ${Fmt(periods[0].expenses || 0)}`}
              />
              <MiniCard
                icon={Activity} color={periods[0].net_income >= 0 ? '#10b981' : '#ef4444'}
                label="Net P&L" value={`HKD ${Fmt(periods[0].net_income || 0)}`}
              />
            </div>
            {/* Row 2: Bank→Inv, Inv→Rec, Full Chain */}
            <div className="flex flex-wrap gap-2">
              <MiniCard
                icon={Link2} color="#3b82f6"
                label="Bank → Invoice" value={`${periods[0].bank_pct || 0}%`}
              />
              <MiniCard
                icon={Receipt} color="#8b5cf6"
                label="Inv → Receipt" value={`${periods[0].invoice_pct || 0}%`}
              />
              <MiniCard
                icon={GitMerge} color="#10b981"
                label="Full Chain" value={`${periods[0].chain_pct || 0}%`}
              />
            </div>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground py-4">{tr('Loading…', '載入中…', '载入中…')}</div>
        )}
      </div>

      {/* ═══════════════════════════════════════════════════════════
          SECTION 3 — LISTS (unchanged)
          ═══════════════════════════════════════════════════════════ */}
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
    </div>
  );
}
