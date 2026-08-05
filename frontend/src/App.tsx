import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ToastProvider } from './components/Toast';
import { api } from './lib/api';
import Layout from './components/Layout';
import Login from './pages/Login';
import Register from './pages/Register';
import Dashboard from './pages/Dashboard';
import PrivacyPolicy from './pages/PrivacyPolicy';
import Customers from './pages/Customers';
import Suppliers from './pages/Suppliers';
import Products from './pages/Products';
import Invoices from './pages/Invoices';
import InvoiceReview from './pages/InvoiceReview';
import AP from './pages/AP';
import AR from './pages/AR';
import Quotations from './pages/Quotations';
import PurchaseOrders from './pages/PurchaseOrders';
import ServiceOrders from './pages/ServiceOrders';
import Bookkeeping from './pages/Bookkeeping';
import ReviewQueue from './pages/ReviewQueue';
import FileUpload from './pages/FileUpload';
import FixedAssets from './pages/FixedAssets';
import ImportData from './pages/ImportData';
import CalendarPage from './pages/CalendarPage';
import ServicesPage from './pages/Services';
import Messages from './pages/Messages';
import Documents from './pages/Documents';
import Todos from './pages/Todos';
import MailInbox from './pages/MailInbox';
import BankStatements from './pages/BankStatements';
import BankStatementReview from './pages/BankStatementReview';
import Apply from './pages/Apply';
import UserManagement from './pages/UserManagement';
import AdminApplications from './pages/AdminApplications';
import AdminCompanyView from './pages/AdminCompanyView';
import AuditLog from './pages/AuditLog';
// import Reconciliation from './pages/Reconciliation'; // OBSOLETE — merged into Bank Statements
import RecycleBin from './pages/RecycleBin';
import ExpenseReceipts from './pages/ExpenseReceipts';
import Modules from './pages/Modules';
import Integrations from './pages/Integrations';
import PaymentPage from './pages/PaymentPage';
import CommunicationPage from './pages/CommunicationPage';
import WebsiteGenerator from './pages/WebsiteGenerator';
import CardGenerator from './pages/CardGenerator';
import Settings from './pages/Settings';
import FileStorage from './pages/FileStorage';
import FirmManagement from './pages/FirmManagement';
import Compliance from './pages/Compliance';
import AiMemory from './pages/AiMemory';
import PricingPage from './pages/PricingPage';
import SubscriptionPage from './pages/SubscriptionPage';
import StubPage from './pages/StubPage';
import PettyCash from './pages/PettyCash';
import ChartOfAccounts from './pages/ChartOfAccounts';
import CardStatements from './pages/CardStatements';
import CardStatementReview from './pages/CardStatementReview';
import NewClient from './pages/NewClient';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000, // 30s — prevent refetch cascade during navigation
      retry: 1,
    },
  },
});

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!user) return <Navigate to="/login" />;
  return <Layout>{children}</Layout>;
}

const FEATURE_ROUTES: Record<string, string> = {
  '/customers': 'customers',
  '/suppliers': 'suppliers',
  '/products': 'products',
  '/services': 'services',
  '/invoices': 'invoices',
  '/quotations': 'quotations',
  '/GJE': 'bookkeeping',
  '/review-queue': 'bookkeeping',
  '/bookkeeping': 'bookkeeping',
  '/bank-statements': 'bankStatements',
  '/card-statements': 'cardStatements',
  '/expense-receipts': 'expenseReceipts',
  '/calendar': 'calendar',
  '/messages': 'messages',
  '/documents': 'documents',
  '/file-storage': 'fileStorage',
  '/purchase-orders': 'purchaseOrders',
  '/service-orders': 'serviceOrders',
  '/compliance': 'compliance',
  '/fixed-assets': 'fixedAssets',
};

function FeatureGuard({ children }: { children: React.ReactNode }) {
  const location = window.location.pathname;
  const featKey = FEATURE_ROUTES[location];
  if (!featKey) return <>{children}</>;

  // Subscribe to React Query — refetches when Modules page invalidates ['company']
  const { data: company } = useQuery({
    queryKey: ['company'],
    queryFn: () => api('/company'),
  });

  try {
    const features = company?.features ? (typeof company.features === 'string' ? JSON.parse(company.features) : company.features) : {};
    if (features[featKey] === false) return <Navigate to="/" />;
  } catch {}
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/privacy" element={<PrivacyPolicy />} />
      <Route path="/apply" element={<Apply />} />
      <Route path="/register" element={<Apply />} />
      <Route path="/settings/users" element={<ProtectedRoute><UserManagement /></ProtectedRoute>} />
      <Route path="/admin/applications" element={<ProtectedRoute><AdminApplications /></ProtectedRoute>} />
      <Route path="/admin/company/:userId" element={<ProtectedRoute><AdminCompanyView /></ProtectedRoute>} />
      <Route path="/audit-log" element={<ProtectedRoute><AuditLog /></ProtectedRoute>} />
      <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
      <Route path="/compliance" element={<ProtectedRoute><FeatureGuard><Compliance /></FeatureGuard></ProtectedRoute>} />
      <Route path="/ai-memory" element={<ProtectedRoute><AiMemory /></ProtectedRoute>} />
      <Route path="/pricing" element={<ProtectedRoute><PricingPage /></ProtectedRoute>} />
      <Route path="/subscription" element={<ProtectedRoute><SubscriptionPage /></ProtectedRoute>} />
      <Route path="/customers" element={<ProtectedRoute><FeatureGuard><Customers /></FeatureGuard></ProtectedRoute>} />
      <Route path="/suppliers" element={<ProtectedRoute><FeatureGuard><Suppliers /></FeatureGuard></ProtectedRoute>} />
      <Route path="/products" element={<ProtectedRoute><FeatureGuard><Products /></FeatureGuard></ProtectedRoute>} />
      <Route path="/invoices" element={<ProtectedRoute><FeatureGuard><Invoices /></FeatureGuard></ProtectedRoute>} />
      <Route path="/invoices/review/:id" element={<ProtectedRoute><InvoiceReview /></ProtectedRoute>} />
      <Route path="/invoices/:id/edit" element={<ProtectedRoute><FeatureGuard><Invoices /></FeatureGuard></ProtectedRoute>} />
      <Route path="/quotations" element={<ProtectedRoute><FeatureGuard><Quotations /></FeatureGuard></ProtectedRoute>} />
      <Route path="/purchase-orders" element={<ProtectedRoute><FeatureGuard><PurchaseOrders /></FeatureGuard></ProtectedRoute>} />
      <Route path="/service-orders" element={<ProtectedRoute><FeatureGuard><ServiceOrders /></FeatureGuard></ProtectedRoute>} />
      <Route path="/bookkeeping" element={<ProtectedRoute><FeatureGuard><Bookkeeping /></FeatureGuard></ProtectedRoute>} />
              <Route path="/fixed-assets" element={<ProtectedRoute><FeatureGuard><FixedAssets /></FeatureGuard></ProtectedRoute>} />
      <Route path="/bank-statements" element={<ProtectedRoute><FeatureGuard><BankStatements /></FeatureGuard></ProtectedRoute>} />
      <Route path="/bank-statements/review/:id" element={<ProtectedRoute><FeatureGuard><BankStatementReview /></FeatureGuard></ProtectedRoute>} />
{/* <Route path="/reconciliation" element={<ProtectedRoute><FeatureGuard><Reconciliation /></FeatureGuard></ProtectedRoute>} /> OBSOLETE — merged into Bank Statements */}
      <Route path="/recycle-bin" element={<ProtectedRoute><FeatureGuard><RecycleBin /></FeatureGuard></ProtectedRoute>} />
      <Route path="/todos" element={<ProtectedRoute><Todos /></ProtectedRoute>} />
      <Route path="/expense-receipts" element={<ProtectedRoute><FeatureGuard><ExpenseReceipts /></FeatureGuard></ProtectedRoute>} />
      <Route path="/import" element={<ProtectedRoute><ImportData /></ProtectedRoute>} />
      <Route path="/calendar" element={<ProtectedRoute><FeatureGuard><CalendarPage /></FeatureGuard></ProtectedRoute>} />
      <Route path="/services" element={<ProtectedRoute><FeatureGuard><ServicesPage /></FeatureGuard></ProtectedRoute>} />
      <Route path="/mail" element={<ProtectedRoute><MailInbox /></ProtectedRoute>} />
      <Route path="/messages" element={<ProtectedRoute><FeatureGuard><Messages /></FeatureGuard></ProtectedRoute>} />
      <Route path="/documents" element={<ProtectedRoute><FeatureGuard><Documents /></FeatureGuard></ProtectedRoute>} />
      <Route path="/file-storage" element={<ProtectedRoute><FeatureGuard><FileStorage /></FeatureGuard></ProtectedRoute>} />
      <Route path="/modules" element={<ProtectedRoute><Modules /></ProtectedRoute>} />
      <Route path="/payment" element={<ProtectedRoute><PaymentPage /></ProtectedRoute>} />
      <Route path="/communication" element={<ProtectedRoute><CommunicationPage /></ProtectedRoute>} />
      <Route path="/integrations" element={<ProtectedRoute><Integrations /></ProtectedRoute>} />
      <Route path="/website-generator" element={<ProtectedRoute><WebsiteGenerator /></ProtectedRoute>} />
      <Route path="/card-generator" element={<ProtectedRoute><CardGenerator /></ProtectedRoute>} />
      <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
      <Route path="/firm/manage" element={<ProtectedRoute><FirmManagement /></ProtectedRoute>} />
      {/* P1 Stub Pages */}
      <Route path="/new-client" element={<ProtectedRoute><NewClient /></ProtectedRoute>} />
      <Route path="/file-upload" element={<ProtectedRoute><FileUpload /></ProtectedRoute>} />
      <Route path="/GJE" element={<ProtectedRoute><Bookkeeping hideTabs initialTab="entries" /></ProtectedRoute>} />
      <Route path="/review-queue" element={<ProtectedRoute><FeatureGuard><ReviewQueue /></FeatureGuard></ProtectedRoute>} />
      <Route path="/entries" element={<Navigate to="/GJE" />} />
      <Route path="/income-statement" element={<ProtectedRoute><Bookkeeping hideTabs initialTab="pl" /></ProtectedRoute>} />
      <Route path="/trial-balance" element={<ProtectedRoute><Bookkeeping hideTabs initialTab="trial" /></ProtectedRoute>} />
      <Route path="/balance-sheet" element={<ProtectedRoute><Bookkeeping hideTabs initialTab="bs" /></ProtectedRoute>} />
      <Route path="/gl-report" element={<ProtectedRoute><Bookkeeping hideTabs initialTab="ledger" /></ProtectedRoute>} />
      <Route path="/general-ledger" element={<ProtectedRoute><Bookkeeping hideTabs initialTab="ledger" /></ProtectedRoute>} />
      <Route path="/coa" element={<ProtectedRoute><ChartOfAccounts /></ProtectedRoute>} />
      <Route path="/card-statements" element={<ProtectedRoute><FeatureGuard><CardStatements /></FeatureGuard></ProtectedRoute>} />
      <Route path="/card-statements/review/:id" element={<ProtectedRoute><FeatureGuard><CardStatementReview /></FeatureGuard></ProtectedRoute>} />
      <Route path="/ap" element={<ProtectedRoute><AP /></ProtectedRoute>} />
      <Route path="/ar" element={<ProtectedRoute><AR /></ProtectedRoute>} />
      <Route path="/payroll" element={<ProtectedRoute><StubPage title="Payroll" zhHant="薪資" zhHans="薪资" /></ProtectedRoute>} />
      <Route path="/petty-cash" element={<ProtectedRoute><FeatureGuard><PettyCash /></FeatureGuard></ProtectedRoute>} />
      <Route path="/mpf" element={<ProtectedRoute><StubPage title="MPF" zhHant="強積金" zhHans="强积金" /></ProtectedRoute>} />
      <Route path="/financial-statements" element={<Navigate to="/GJE" />} />
      <Route path="/company/br" element={<ProtectedRoute><StubPage title="Business Registration (BR)" zhHant="商業登記證" zhHans="商业登记证" /></ProtectedRoute>} />
      <Route path="/company/ci" element={<ProtectedRoute><StubPage title="Certificate of Incorporation" zhHant="公司註冊證書" zhHans="公司注册证书" /></ProtectedRoute>} />
      <Route path="/company/ei" element={<ProtectedRoute><StubPage title="Employer Information (EI)" zhHant="僱主資料" zhHans="雇主资料" /></ProtectedRoute>} />
      <Route path="/contracts" element={<ProtectedRoute><StubPage title="Contracts" zhHant="合約" zhHans="合约" /></ProtectedRoute>} />
      <Route path="/company/financial-year" element={<ProtectedRoute><StubPage title="Financial Year" zhHant="會計年度" zhHans="会计年度" /></ProtectedRoute>} />
      <Route path="/company/opening-year" element={<ProtectedRoute><StubPage title="Opening Year" zhHant="開始年度" zhHans="开始年度" /></ProtectedRoute>} />
      <Route path="/company/accounting-info" element={<ProtectedRoute><StubPage title="Accounting Information" zhHant="會計資料" zhHans="会计资料" /></ProtectedRoute>} />
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <ToastProvider>
            <AppRoutes />
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
