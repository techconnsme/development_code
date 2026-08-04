/**
 * AdminDashboard.tsx
 * Platform admin dashboard — shows system overview, companies, pending applications.
 * Only rendered when user.role === 'admin'.
 */
import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { tr } from '../lib/i18nHelpers';
import {
  Building2, Users, ClipboardCheck, FileText, Activity, AlertCircle, Landmark,
  ChevronRight, ExternalLink, Search, Shield,
} from 'lucide-react';

interface UserRow {
  id: string;
  email: string;
  name: string;
  company_name: string | null;
  role: string;
  created_at: string;
  customer_count: number;
  invoice_count: number;
  quotation_count: number;
}

interface Application {
  id: string;
  company_name: string;
  contact_name: string;
  email: string;
  status: string;
  created_at: string;
}

export default function AdminDashboard() {
  const { i18n } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchQ, setSearchQ] = useState('');

  const { data: usersData, isLoading: usersLoading, error: usersError } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api('/admin/users'),
  });

  const { data: auditStats } = useQuery({
    queryKey: ['admin-audit-stats'],
    queryFn: () => api('/admin/audit-stats') as Promise<any>,
    refetchInterval: 60000,
  });

  const { data: appsData } = useQuery({
    queryKey: ['admin-applications'],
    queryFn: () => api('/admin/applications?status=pending'),
  });

  // Debug: handle both {data: [...]} and direct array responses
  const rawUsers = usersData?.data || usersData?.results || (Array.isArray(usersData) ? usersData : []);
  const allUsers: UserRow[] = rawUsers as UserRow[];
  const pendingApps: Application[] = ((appsData?.data || appsData?.results || (Array.isArray(appsData) ? appsData : [])) as Application[]);

  // Separate companies (supervisors) from staff/admin
  const companies = allUsers.filter(u => u.role === 'supervisor');
  const totalStaff = allUsers.filter(u => u.role === 'staff' || u.role === 'viewer').length;
  const totalInvoices = allUsers.reduce((s, u) => s + (u.invoice_count || 0), 0);

  // Search filter
  const filteredCompanies = companies.filter(c => {
    if (!searchQ) return true;
    const q = searchQ.toLowerCase();
    return (c.company_name || '').toLowerCase().includes(q) ||
           (c.name || '').toLowerCase().includes(q) ||
           (c.email || '').toLowerCase().includes(q);
  });

  return (
    <div className="space-y-6 max-w-6xl">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
          <Shield className="h-3.5 w-3.5" />
          <span>{tr('Platform Administration', '平台管理', '平台管理')}</span>
        </div>
        <h1 className="text-2xl font-bold">
          {tr(`Welcome back, ${user?.name || 'Admin'}`, `歡迎回來，${user?.name || '管理員'}`, `歡迎回來，${user?.name || '管理員'}`)}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {tr('System overview and company management', '系統概覽和公司管理', '系統概覽和公司管理')}
        </p>
      </div>

      {/* Error state */}
      {usersError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
          {tr('Failed to load data: ', '載入失敗：', '载入失败：')}{(usersError as any)?.message || 'Unknown error'}
        </div>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatsCard
          icon={Building2}
          label={tr('Companies', '公司', '公司')}
          value={companies.length}
          color="text-blue-600"
          bg="bg-blue-50 dark:bg-blue-950/30"
        />
        <StatsCard
          icon={ClipboardCheck}
          label={tr('Pending Applications', '待審核申請', '待审核申请')}
          value={pendingApps.length}
          color={pendingApps.length > 0 ? 'text-orange-600' : 'text-green-600'}
          bg={pendingApps.length > 0 ? 'bg-orange-50 dark:bg-orange-950/30' : 'bg-green-50 dark:bg-green-950/30'}
          onClick={() => navigate('/admin/applications')}
        />
        <StatsCard
          icon={Users}
          label={tr('Total Users', '總用戶', '总用戶')}
          value={allUsers.length}
          sub={tr(`${totalStaff} staff`, `${totalStaff} 員工`, `${totalStaff} 員工`)}
          color="text-purple-600"
          bg="bg-purple-50 dark:bg-purple-950/30"
        />
        <StatsCard
          icon={FileText}
          label={tr('Total Invoices', '總發票', '总发票')}
          value={totalInvoices}
          color="text-emerald-600"
          bg="bg-emerald-50 dark:bg-emerald-950/30"
        />
        <StatsCard
          icon={AlertCircle}
          label={tr('Doc Compliance', '文件合規', '文件合规')}
          value={`${auditStats?.missing_doc_pct ?? 0}%`}
          sub={auditStats ? tr(`${auditStats.statements_with_docs}/${auditStats.total_statements} linked`, `${auditStats.statements_with_docs}/${auditStats.total_statements} 已連結`, `${auditStats.statements_with_docs}/${auditStats.total_statements} 已连结`) : ''}
          color={(auditStats?.missing_doc_pct ?? 0) > 20 ? 'text-red-600' : 'text-green-600'}
          bg={(auditStats?.missing_doc_pct ?? 0) > 20 ? 'bg-red-50 dark:bg-red-950/30' : 'bg-green-50 dark:bg-green-950/30'}
        />
        <StatsCard
          icon={Landmark}
          label={tr('Receipt vs Expense', '收入 vs 支出', '收入 vs 支出')}
          value={`${auditStats?.receipt_pct ?? 50} / ${auditStats?.expense_pct ?? 50}`}
          sub="%"
          color="text-indigo-600"
          bg="bg-indigo-50 dark:bg-indigo-950/30"
        />
      </div>

      {/* Pending Applications Alert */}
      {pendingApps.length > 0 && (
        <div className="rounded-lg border-2 border-orange-300 bg-orange-50 dark:bg-orange-950/20 p-4">
          <div className="flex items-start gap-3">
            <ClipboardCheck className="h-5 w-5 text-orange-600 mt-0.5 flex-shrink-0" />
            <div className="flex-1">
              <h3 className="font-semibold text-orange-900 dark:text-orange-200 text-sm">
                {tr(`${pendingApps.length} application(s) awaiting review`, `${pendingApps.length} 個申請待審核`, `${pendingApps.length} 个申请待审核`)}
              </h3>
              <div className="mt-2 space-y-1">
                {pendingApps.slice(0, 3).map(app => (
                  <div key={app.id} className="text-sm text-orange-800 dark:text-orange-300 flex items-center gap-2">
                    <span className="font-medium">{app.company_name}</span>
                    <span className="text-orange-600">·</span>
                    <span>{app.contact_name}</span>
                    <span className="text-orange-600">·</span>
                    <span className="text-xs text-orange-500">{app.created_at?.slice(0, 10)}</span>
                  </div>
                ))}
              </div>
              <button
                onClick={() => navigate('/admin/applications')}
                className="mt-2 text-sm text-orange-700 dark:text-orange-300 font-medium hover:underline flex items-center gap-1"
              >
                {tr('Review applications', '審核申請', '审核申请')} <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Companies List */}
      <div className="bg-card border rounded-xl overflow-hidden">
        <div className="p-4 border-b flex items-center justify-between gap-3">
          <h2 className="font-semibold text-sm flex items-center gap-2">
            <Building2 className="h-4 w-4" />
            {tr(`Companies (${companies.length})`, `公司 (${companies.length})`, `公司 (${companies.length})`)}
          </h2>
          <div className="relative">
            <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
              placeholder={tr('Search companies...', '搜尋公司...', '搜索公司...')}
              className="pl-8 pr-3 py-1.5 border rounded-md text-sm bg-background w-52"
            />
          </div>
        </div>

        {usersLoading ? (
          <div className="p-8 text-center text-muted-foreground text-sm">
            {tr('Loading...', '載入中...', '载入中...')}
          </div>
        ) : companies.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground">
            <Building2 className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">{tr('No companies yet. Approve an application to get started.', '尚無公司。批准申請以開始。', '尚无公司。批准申请以开始。')}</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">{tr('Company', '公司', '公司')}</th>
                <th className="text-left px-4 py-2.5 font-medium">{tr('Contact', '聯絡人', '聯络人')}</th>
                <th className="text-center px-4 py-2.5 font-medium">{tr('Invoices', '發票', '发票')}</th>
                <th className="text-center px-4 py-2.5 font-medium">{tr('Customers', '客戶', '客户')}</th>
                <th className="text-left px-4 py-2.5 font-medium">{tr('Created', '建立日期', '建立日期')}</th>
                <th className="text-right px-4 py-2.5 font-medium">{tr('Actions', '操作', '操作')}</th>
              </tr>
            </thead>
            <tbody>
              {filteredCompanies.map(c => (
                <tr key={c.id} className="border-t hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-medium">{c.company_name || c.name}</div>
                    <div className="text-xs text-muted-foreground">{c.email}</div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{c.name}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={`font-mono ${c.invoice_count > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                      {c.invoice_count || 0}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`font-mono ${c.customer_count > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                      {c.customer_count || 0}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {c.created_at?.slice(0, 10)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => navigate(`/admin/company/${c.id}`)}
                      className="text-xs px-2.5 py-1 border rounded hover:bg-muted inline-flex items-center gap-1"
                    >
                      <ExternalLink className="h-3 w-3" />
                      {tr('View', '查看', '查看')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Recent Activity */}
      <div className="bg-card border rounded-xl p-4">
        <h2 className="font-semibold text-sm flex items-center gap-2 mb-3">
          <Activity className="h-4 w-4" />
          {tr('Recent System Activity', '最近系統活動', '最近系統活動')}
        </h2>
        <RecentActivity />
      </div>
    </div>
  );
}

function StatsCard({ icon: Icon, label, value, sub, color, bg, onClick }: {
  icon: any; label: string; value: number | string; sub?: string; color: string; bg: string; onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={`rounded-xl border p-4 ${bg} ${onClick ? 'cursor-pointer hover:opacity-80 transition-opacity' : ''}`}
    >
      <div className="flex items-center justify-between mb-2">
        <Icon className={`h-5 w-5 ${color}`} />
        {onClick && <ChevronRight className="h-4 w-4 text-muted-foreground" />}
      </div>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
      {sub && <div className="text-xs text-muted-foreground/70 mt-0.5">{sub}</div>}
    </div>
  );
}

function RecentActivity() {
  const { i18n } = useTranslation();

  // Use admin users endpoint as a proxy for recent activity
  const { data } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api('/admin/users'),
  });

  const users: UserRow[] = ((data?.data || data?.results || (Array.isArray(data) ? data : [])) as UserRow[]);
  // Show the 5 most recently created users
  const recent = [...users].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).slice(0, 5);

  if (recent.length === 0) {
    return <p className="text-sm text-muted-foreground">{tr('No recent activity.', '暫無最近活動。', '暫无最近活動。')}</p>;
  }

  return (
    <div className="space-y-2">
      {recent.map(u => (
        <div key={u.id} className="flex items-center gap-3 text-sm py-1.5">
          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
            u.role === 'admin' ? 'bg-red-500' : u.role === 'supervisor' ? 'bg-blue-500' : 'bg-gray-400'
          }`} />
          <span className="text-muted-foreground flex-shrink-0 w-20 text-xs">{u.created_at?.slice(0, 10)}</span>
          <span className="font-medium">{u.name}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground truncate">{u.company_name || u.name}</span>
          <span className="flex-1" />
          <span className={`text-xs px-1.5 py-0.5 rounded ${
            u.role === 'admin' ? 'bg-red-100 text-red-700' :
            u.role === 'supervisor' ? 'bg-blue-100 text-blue-700' :
            u.role === 'staff' ? 'bg-gray-100 text-gray-600' :
            'bg-gray-100 text-gray-500'
          }`}>{u.role}</span>
        </div>
      ))}
    </div>
  );
}
