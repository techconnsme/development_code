import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../lib/api';
import Chatbot from './Chatbot';
import CookieConsent from './CookieConsent';
import TokenPopup from './TokenPopup';
import CompanySwitcher from './FirmClientSwitcher';
import DateFilterSelect from './DateFilterSelect';
import { DateFilterProvider, useDateFilter } from '../contexts/DateFilterContext';
import { tr } from '../lib/i18nHelpers';
import {
  LayoutDashboard, Users, Truck, Package, FileText, FileSpreadsheet, Mail,
  Calculator, Upload, Settings, LogOut, Menu, X, MessageCircle, Calendar, Briefcase, FolderOpen, Plug, Landmark, Receipt, CheckSquare, Globe, CreditCard, Smartphone, HardDrive, ShoppingCart, ClipboardList, AlertCircle, BookOpen, ChevronLeft, ChevronRight, ChevronDown, Building2, Shield, Tag, Bot, Link2, Trash2, ClipboardCheck, UserCog, List, Dot,
} from 'lucide-react';

// Subtitle translations map
const subMap: Record<string, [string, string, string]> = {
  'By financial year':          ['By financial year',        '按會計年度',   '按会计年度'],

  'Upload bank statements, invoices, receipts': ['Upload statements, invoices, receipts', '上傳月結單、發票、收據', '上传月结单、发票、收据'],
};
function subT(key: string | undefined): string {
  if (!key) return '';
  const e = subMap[key];
  return e ? tr(e[0], e[1], e[2]) : key;
}

// P1 Navigation — accounting-workflow structure with expandable groups
const navGroups = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, to: '/' },
  { key: 'documents', label: 'Documents', icon: FolderOpen, expandable: true, alwaysOpen: true, children: [
    { key: 'fileUpload', label: 'File Upload', to: '/file-upload' },
    { key: 'fileStorage', label: 'File Storage', to: '/file-storage' },
  ]},
  { key: 'coa', label: 'Chart of Accounts (COA)', icon: List, to: '/coa' },
  { key: 'generalLedger', label: 'General Ledger', icon: BookOpen, to: '/general-ledger' },
  { key: 'bookkeeping', label: 'Bookkeeping', icon: Calculator, expandable: true, children: [
    { key: 'bankStatements', label: 'Bank Statements', to: '/bank-statements' },
    { key: 'cardStatements', label: 'Card Statements', to: '/card-statements' },
    { key: 'invoices', label: 'Expenses', to: '/invoices' },
    { key: 'ap', label: 'Accounts Payable (AP)', to: '/ap' },
    { key: 'ar', label: 'Accounts Receivable (AR)', to: '/ar' },
    { key: 'payroll', label: 'Payroll', to: '/payroll' },
    { key: 'pettyCash', label: 'Petty Cash', to: '/petty-cash' },
    { key: 'gje', label: 'General Journal Entries (GJE)', to: '/GJE' },
    { key: 'reviewQueue', label: 'Pending Review', to: '/review-queue' },
  ]},
  { key: 'assets', label: 'Assets', icon: Building2, expandable: true, children: [
    { key: 'fixedAssets', label: 'Fixed Assets', to: '/fixed-assets' },
  ]},
  { key: 'financialStatements', label: 'Financial Statements', icon: FileText, expandable: true, children: [
    { key: 'incomeStatement', label: 'Income Statement', to: '/income-statement' },
    { key: 'balanceSheet', label: 'Balance Sheet', to: '/balance-sheet' },
    { key: 'trialBalance', label: 'Trial Balance', to: '/trial-balance' },
    { key: 'glReport', label: 'General Ledger Report', to: '/gl-report' },
    { key: 'export', label: 'Export', to: '/bookkeeping?tab=export' },
  ]},
  { key: 'settings', label: 'Settings', icon: Settings, to: '/settings' },
];

// Additional items shown when "Show all functions" is checked
const extraNavItems = [
  { key: 'userManagement', label: 'User Management', icon: UserCog, to: '/settings/users' },
  { key: 'applications', label: 'Applications', icon: ClipboardCheck, to: '/admin/applications' },
  { key: 'auditLog', label: 'Audit Log', icon: BookOpen, to: '/audit-log' },
  { key: 'compliance', label: 'Compliance', icon: Shield, to: '/compliance' },
  { key: 'aiMemory', label: 'AI Memory', icon: BookOpen, to: '/ai-memory' },
  { key: 'customers', label: 'Customers', icon: Users, to: '/customers' },
  { key: 'suppliers', label: 'Suppliers', icon: Truck, to: '/suppliers' },
  { key: 'quotations', label: 'Quotations', icon: FileSpreadsheet, to: '/quotations' },
  { key: 'products', label: 'Products', icon: Package, to: '/products' },
  { key: 'services', label: 'Services', icon: Briefcase, to: '/services' },
  { key: 'purchaseOrders', label: 'Purchase Orders', icon: ShoppingCart, to: '/purchase-orders' },
  { key: 'serviceOrders', label: 'Service Orders', icon: ClipboardList, to: '/service-orders' },
  { key: 'calendar', label: 'Calendar', icon: Calendar, to: '/calendar' },
  { key: 'messages', label: 'Messages', icon: MessageCircle, to: '/messages' },
  { key: 'mail', label: 'Mail', icon: Mail, to: '/mail' },
  { key: 'todos', label: 'Todos', icon: CheckSquare, to: '/todos' },
  { key: 'documents', label: 'Company Docs', icon: FolderOpen, to: '/documents' },
  { key: 'pricing', label: 'Pricing', icon: Tag, to: '/pricing' },
  { key: 'websiteGen', label: 'Website Generator', icon: Globe, to: '/website-generator' },
];

const languages = [
  { code: 'zh-Hant', label: '繁' },
  { code: 'zh-Hans', label: '简' },
  { code: 'en', label: 'EN' },
];

// Admin sees a completely different sidebar
const adminNavGroups = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, to: '/' },
  { key: 'applications', label: 'Applications', icon: ClipboardCheck, to: '/admin/applications' },
  { key: 'userManagement', label: 'User Management', icon: UserCog, to: '/settings/users' },
  { key: 'auditLog', label: 'Audit Log', icon: BookOpen, to: '/audit-log' },
  { key: 'settings', label: 'Settings', icon: Settings, to: '/settings' },
];

// Nav key → feature flag mapping
const NAV_FEATURE_MAP: Record<string, string> = {
  customers: 'customers',
  suppliers: 'suppliers',
  products: 'products',
  services: 'services',
  invoices: 'invoices',
  ap: 'invoices',
  quotations: 'quotations',
  bookkeeping: 'bookkeeping',
  reviewQueue: 'bookkeeping',
  bankStatements: 'bankStatements',
  cardStatements: 'cardStatements',
  expenseReceipts: 'expenseReceipts',
  calendar: 'calendar',
  messages: 'messages',
  documents: 'documents',
  fileStorage: 'fileStorage',
  purchaseOrders: 'purchaseOrders',
  serviceOrders: 'serviceOrders',
  fixedAssets: 'fixedAssets',
  compliance: 'compliance',
};

/** Invisible component — runs the review-queue count query inside DateFilterProvider */
function ReviewCountFetch({ onCount }: { onCount: (n: number) => void }) {
  const { startDate, endDate } = useDateFilter();
  const { data } = useQuery({
    queryKey: ['review-queue-count', startDate, endDate],
    queryFn: () => {
      const params = new URLSearchParams();
      if (startDate) params.set('start_date', startDate);
      if (endDate) params.set('end_date', endDate);
      return api(`/review-queue/count?${params.toString()}`);
    },
    refetchInterval: 10000,
  });
  React.useEffect(() => { onCount((data?.total as number) || 0); }, [data?.total, onCount]);
  return null;
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const { t, i18n } = useTranslation();
  const { user, logout, company, activeClient, isFirmUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Mobile states
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const [chatMobileOpen, setChatMobileOpen] = React.useState(false);

  // Desktop states
  const [sidebarDesktopOpen, setSidebarDesktopOpen] = React.useState(true);
  const [chatDesktopOpen, setChatDesktopOpen] = React.useState(false);
  const [chatWidth, setChatWidth] = React.useState(420);
  const [showAll, setShowAll] = React.useState(false);
  const [expandedGroups, setExpandedGroups] = React.useState<Record<string, boolean>>({ documents: true });

  const toggleGroup = (key: string) => {
    if (key === 'documents') return; // Documents always open
    setExpandedGroups(prev => ({ ...prev, [key]: !prev[key] }));
  };

  // Resize handler for chat panel
  const resizingRef = React.useRef(false);
  const startXRef = React.useRef(0);
  const startWidthRef = React.useRef(0);

  const handleResizeStart = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = chatWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handleMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const delta = startXRef.current - ev.clientX;
      const newWidth = Math.max(280, Math.min(800, startWidthRef.current + delta));
      setChatWidth(newWidth);
    };
    const handleUp = () => {
      resizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [chatWidth]);

  // React Query subscription: refetches when Modules page invalidates ['company']
  const { data: liveCompany } = useQuery({
    queryKey: ['company'],
    queryFn: () => api('/company'),
  });
  const activeCompany = liveCompany || company;

  const { data: fileIssues } = useQuery({
    queryKey: ['file-storage-issues'],
    queryFn: () => api('/file-storage/issues'),
    refetchInterval: 60000,
  });
  const issueCount = (fileIssues?.issues as number) || 0;

  const [sidebarReviewCount, setSidebarReviewCount] = React.useState(0);
  const reviewCount = sidebarReviewCount;

  // Parse features from live company data (or fallback to AuthContext)
  const features: Record<string, boolean> = React.useMemo(() => {
    try {
      const src = activeCompany?.features;
      if (src) return typeof src === 'string' ? JSON.parse(src) : src;
    } catch {}
    return {};
  }, [activeCompany]);

  const handleLogout = () => { logout(); navigate('/login'); };

  const sidebarCollapsed = !sidebarDesktopOpen;

  const renderSidebarContent = (collapsed: boolean) => (
    <div className="flex flex-col h-full">
      {/* Company header */}
      {collapsed ? (
        <div className="border-b flex justify-center w-16 py-3">
          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
            user?.role === 'admin' ? 'bg-red-600 text-white' : 'bg-primary text-primary-foreground'
          }`}>
            {user?.role === 'admin' ? '⚙' : (activeCompany?.name || 'O').charAt(0)}
          </div>
        </div>
      ) : (
        <div className="p-6 border-b">
          {user?.role === 'admin' ? (
            <>
              <h1 className="text-xl font-bold text-primary">{t('app.title')}</h1>
              <p className="text-sm text-muted-foreground mt-1 flex items-center gap-1.5">
                <Shield className="h-3.5 w-3.5 text-red-500" />
                {tr('Platform Admin', '平台管理員', '平台管理员')}
              </p>
            </>
          ) : (
            <>
              <h1 className="text-xl font-bold text-primary">
                {user?.name || t('app.title')}
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                {activeClient?.display_name || activeClient?.company_name || user?.company_name || user?.name || activeCompany?.name || ''}
              </p>
            </>
          )}
        </div>
      )}

      {/* Language toggle — hidden when collapsed */}
      {!collapsed && (
        <div className="pl-3 pr-4 py-2 flex gap-1">
          {languages.map((l) => {
            const active = i18n.language === l.code;
            return (
              <button key={l.code} onClick={() => i18n.changeLanguage(l.code)}
                className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  active ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}>
                {l.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Firm client switcher */}
      {!collapsed && <CompanySwitcher />}

      {/* Global fiscal year filter */}
      {!collapsed && <DateFilterSelect />}

      {/* Navigation */}
      <nav className={`flex-1 space-y-0.5 overflow-y-auto ${collapsed ? 'p-0' : 'px-2 py-2 pr-3'}`}>
        {(user?.role === 'admin' ? adminNavGroups : navGroups).map((group: any) => {
          // Feature gate check for simple nav items
          if (!group.expandable) {
            const featKey = NAV_FEATURE_MAP[group.key];
            if (featKey && features[featKey] === false) return null;
            // Role checks
            if (group.key === 'firmManagement' && !isFirmUser) return null;
            if (group.key === 'applications' && user?.role !== 'admin') return null;
            if (group.key === 'userManagement' && !['admin', 'supervisor', 'accountant'].includes(user?.role || '')) return null;
            if (group.key === 'settings' && ['staff', 'viewer'].includes(user?.role || '')) return null;
            if (group.key === 'auditLog' && !['admin', 'supervisor', 'accountant'].includes(user?.role || '')) return null;
          }

          if (group.expandable) {
            const isOpen = group.alwaysOpen ? true : (expandedGroups[group.key] !== false ? expandedGroups[group.key] !== false : false);
            const isCollapsible = !group.alwaysOpen;
            const GroupIcon = group.icon;
            return (
              <div key={group.key}>
                {!collapsed ? (
                  <>
                    <div
                      className={`flex items-center gap-2 text-xs font-semibold uppercase tracking-wider px-3 pt-3 pb-1 cursor-pointer select-none text-foreground`}
                      onClick={() => isCollapsible && toggleGroup(group.key)}
                    >
                      <GroupIcon className="h-3.5 w-3.5 flex-shrink-0" />
                      <span className="flex-1 truncate">{t(`nav.${group.key}`) as string}</span>
                      {isCollapsible && (
                        <ChevronDown className={`h-3 w-3 transition-transform duration-200 ${isOpen ? '' : '-rotate-90'}`} />
                      )}
                    </div>
                    <div className={`overflow-hidden transition-all duration-200 ${isOpen ? 'max-h-[600px] opacity-100' : 'max-h-0 opacity-0'}`}>
                      {group.children.map((child: any) => {
                        const ChildIcon = Dot;
                        const isActive = location.pathname === child.to;
                        const featKey = NAV_FEATURE_MAP[child.key];
                        if (featKey && features[featKey] === false) return null;
                        return (
                          <Link key={child.to} to={child.to} onClick={() => setSidebarOpen(false)}
                            className={`relative flex items-center gap-3 pl-3 pr-4 py-2 rounded-md text-sm transition-colors mr-1 ${
                              isActive ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted'
                            }`}>
                            <ChildIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground/30" />
                            <span className="flex-1 truncate">{t(`nav.${child.key}`) as string}</span>
                            {child.sub && !collapsed && (
                              <span className="text-[10px] text-muted-foreground/40">{subT(child.sub)}</span>
                            )}
                            {child.key === 'reviewQueue' && reviewCount > 0 && !collapsed && (
                              <span className="flex items-center gap-0.5 bg-orange-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">
                                {reviewCount}
                              </span>
                            )}
                          </Link>
                        );
                      })}
                    </div>
                  </>
                ) : (
                  /* Collapsed: just show the group icon */
                  <div key={group.key} className="flex justify-center py-1">
                    <GroupIcon className="h-5 w-5 text-muted-foreground" />
                  </div>
                )}
              </div>
            );
          }

          // Simple nav item (no children)
          const Icon = group.icon;
          const isActive = location.pathname === (group.to || '/');
          return (
            <Link key={group.to || group.key} to={group.to || '/'} onClick={() => setSidebarOpen(false)}
              title={collapsed ? t(`nav.${group.key}`) as string : undefined}
              className={`relative flex items-center gap-3 pl-3 pr-4 py-2 rounded-md text-sm transition-colors mr-1 ${
                collapsed ? 'justify-center px-0 w-16 h-10' : ''
              } ${isActive ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted'}`}>
              <Icon className={`flex-shrink-0 ${collapsed ? 'h-5 w-5' : 'h-4 w-4'}`} />
              {!collapsed && <span className="flex-1 truncate">{t(`nav.${group.key}`) as string}</span>}
              {!collapsed && group.key === 'fileStorage' && issueCount > 0 && (
                <span className="flex items-center gap-0.5 bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">
                  <AlertCircle className="h-2.5 w-2.5" />{issueCount}
                </span>
              )}
            </Link>
          );
        })}
        {/* Extra items shown when "Show all functions" is checked */}
        {showAll && !collapsed && (
          <>
            <div className="border-t border-border/50 my-2 mx-3" />
            <div className="text-xs font-semibold uppercase tracking-wider px-3 pt-3 pb-1 text-muted-foreground/60">
              {tr('Additional Functions', '額外功能', '额外功能')}
            </div>
            {extraNavItems.map((item: any) => {
              const Icon = item.icon;
              const isActive = location.pathname === item.to;
              const featKey = NAV_FEATURE_MAP[item.key];
              if (featKey && features[featKey] === false) return null;
              if (item.key === 'firmManagement' && !isFirmUser) return null;
              if (item.key === 'applications' && user?.role !== 'admin') return null;
              if (item.key === 'userManagement' && !['admin', 'supervisor', 'accountant'].includes(user?.role || '')) return null;
              if (item.key === 'auditLog' && !['admin', 'supervisor', 'accountant'].includes(user?.role || '')) return null;
              return (
                <Link key={item.to} to={item.to} onClick={() => setSidebarOpen(false)}
                  className={`relative flex items-center gap-3 pl-3 pr-4 py-2 rounded-md text-sm transition-colors mr-1 ${
                    isActive ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted'
                  }`}>
                  <Icon className="h-4 w-4 flex-shrink-0" />
                  <span className="flex-1">{t(`nav.${item.key}`) as string}</span>
                </Link>
              );
            })}
          </>
        )}
      </nav>

      {/* Footer */}
      {collapsed ? (
        <div className="border-t flex justify-center w-16 py-2">
          <button onClick={handleLogout}
            className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted" title={t('nav.logout')}>
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div className="p-4 border-t space-y-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer hover:text-foreground">
            <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)}
              className="rounded border-muted-foreground/30" />
            {tr('Show all features', '顯示全部功能', '显示全部功能')}
          </label>
          <div className="text-sm text-muted-foreground">{user?.email}</div>
          <button onClick={handleLogout}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground w-full px-3 py-2 rounded-md hover:bg-muted">
            <LogOut className="h-4 w-4" /> {t('nav.logout')}
          </button>
        </div>
      )}
    </div>
  );

  return (
    <DateFilterProvider>
    <ReviewCountFetch onCount={setSidebarReviewCount} />
    <div className="min-h-screen bg-background">
      {/* ====== MOBILE HEADER ====== */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-50 flex items-center justify-between p-4 bg-background border-b">
        <button onClick={() => setSidebarOpen(!sidebarOpen)} className="p-2 rounded-md hover:bg-muted">
          {sidebarOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
        <span className="font-bold text-primary">{activeCompany?.name || t('app.title')}</span>
        <button onClick={() => setChatMobileOpen(!chatMobileOpen)} className="p-2 rounded-md hover:bg-muted">
          <MessageCircle className="h-5 w-5" />
        </button>
      </div>

      {/* ====== MOBILE: Sidebar overlay ====== */}
      {sidebarOpen && (
        <div className="lg:hidden fixed inset-0 z-40 bg-black/50" onClick={() => setSidebarOpen(false)} />
      )}
      <aside className={`lg:hidden fixed top-0 left-0 z-50 h-full w-64 bg-card border-r transform transition-transform duration-200 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} pt-16`}>
        {renderSidebarContent(false)}
      </aside>

      {/* ====== MOBILE: Chat overlay ====== */}
      {chatMobileOpen && (
        <>
          <div className="lg:hidden fixed inset-0 z-40 bg-black/50" onClick={() => setChatMobileOpen(false)} />
          <div className="lg:hidden fixed inset-0 z-50 pt-16 bg-background slide-in-right">
            <Chatbot onClose={() => setChatMobileOpen(false)} className="h-full" />
          </div>
        </>
      )}

      {/* ====== DESKTOP 3-PANEL LAYOUT ====== */}
      <div className="hidden lg:flex lg:h-screen">

        {/* LEFT: Sidebar */}
        <aside className="bg-card border-r flex flex-col relative overflow-y-auto shrink-0" style={{
          width: sidebarDesktopOpen ? 'min(22vw, 340px)' : '64px',
          minWidth: sidebarDesktopOpen ? '280px' : '64px',
          transition: 'width 300ms cubic-bezier(0.4, 0, 0.2, 1), min-width 300ms cubic-bezier(0.4, 0, 0.2, 1)',
        }}>
          <div style={{ width: sidebarDesktopOpen ? 'min(22vw, 340px)' : '64px', minWidth: sidebarDesktopOpen ? '280px' : '64px' }}>
            {renderSidebarContent(sidebarCollapsed)}
          </div>
          {/* Collapse toggle */}
          <button
            onClick={() => setSidebarDesktopOpen(!sidebarDesktopOpen)}
            className="absolute -right-3 top-1/2 -translate-y-1/2 z-10 w-6 h-6 bg-card border rounded-full flex items-center justify-center hover:bg-muted shadow-sm cursor-pointer"
            title={sidebarDesktopOpen ? '收合側欄' : '展開側欄'}>
            {sidebarDesktopOpen
              ? <ChevronLeft className="h-3.5 w-3.5" />
              : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        </aside>

        {/* CENTER: Main content */}
        <main className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
          <div className="p-6">
            {children}
          </div>
        </main>

        {/* RIGHT: Chat panel */}
        <aside className="bg-card overflow-hidden flex flex-col relative shrink-0" style={{
          width: chatDesktopOpen ? chatWidth : 0,
          borderLeft: chatDesktopOpen ? '1px solid hsl(var(--border))' : 'none',
          transition: 'width 300ms cubic-bezier(0.4, 0, 0.2, 1)',
        }}>
          {/* Resize handle */}
          {chatDesktopOpen && (
            <div
              onMouseDown={handleResizeStart}
              className="absolute top-0 left-[-3px] w-[7px] h-full cursor-col-resize hover:bg-primary/30 z-10 group"
              title="拖曳調整寬度"
            >
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-muted-foreground/40 group-hover:text-primary text-xs select-none">⇔</div>
            </div>
          )}
          {/* Collapse toggle */}
          <button
            onClick={() => setChatDesktopOpen(!chatDesktopOpen)}
            className="absolute -left-3 top-1/2 -translate-y-1/2 z-20 w-6 h-6 bg-card border rounded-full flex items-center justify-center hover:bg-muted shadow-sm cursor-pointer"
            title={chatDesktopOpen ? '收合聊天' : '展開聊天'}>
            {chatDesktopOpen
              ? <ChevronRight className="h-3.5 w-3.5" />
              : <ChevronLeft className="h-3.5 w-3.5" />}
          </button>
          <div className="h-full" style={{ width: chatWidth }}>
            <Chatbot onClose={() => setChatDesktopOpen(false)} className="h-full" />
          </div>
        </aside>
      </div>

      {/* Desktop chat reopen button (when closed) */}
      {!chatDesktopOpen && (
        <button
          onClick={() => setChatDesktopOpen(true)}
          className="hidden lg:flex fixed right-0 top-1/2 -translate-y-1/2 z-30 w-6 h-12 items-center justify-center bg-card border rounded-l-md hover:bg-muted cursor-pointer shadow-sm"
          title="展開 AI 對話">
          <MessageCircle className="h-4 w-4" />
        </button>
      )}

      {/* ====== MOBILE: Main content ====== */}
      <div className="lg:hidden pt-16 min-h-screen">
        <div className="p-6 w-full">
          {children}
        </div>
      </div>
      <CookieConsent />
      <TokenPopup />
    </div>
    </DateFilterProvider>
  );
}
