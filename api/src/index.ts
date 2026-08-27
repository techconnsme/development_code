import { getJwtSecret } from './middleware/auth';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { prettyJSON } from 'hono/pretty-json';
import { Bindings, Variables } from './types';
import { authRoutes } from './routes/auth';
import { customerRoutes } from './routes/customers';
import { supplierRoutes } from './routes/suppliers';
import { productRoutes } from './routes/products';
import { invoiceRoutes } from './routes/invoices';
import { quotationRoutes } from './routes/quotations';
import { bookkeepingRoutes } from './routes/bookkeeping';
import { importRoutes } from './routes/import';
import { auditRoutes } from './routes/audit';
import { workbuddyRoutes } from './routes/workbuddy';
import { pdfRoutes } from './routes/pdf';
import { companyRoutes } from './routes/company';
import { messagingRoutes } from './routes/messaging';
import { calendarRoutes } from './routes/calendar';
import { workbuddyV1Routes, workbuddyMgmtRoutes } from './routes/workbuddy-v1';
import { documentRoutes } from './routes/documents';
import { adminRoutes } from './routes/admin';
import { bankStatementRoutes } from './routes/bank-statements';
import { cardStatementRoutes } from './routes/card-statements';
import { fixedAssetRoutes } from './routes/fixed-assets';
import { dashboardRoutes } from './routes/dashboard';
import { todoRoutes } from './routes/todos';
import { wsRoutes } from './routes/ws';
import { mailRoutes } from './routes/mail';
import { paymentRoutes } from './routes/payment';
import { websiteRoutes } from './routes/website';
import { expenseReceiptRoutes } from './routes/expense-receipts';
import { chatRoutes } from './routes/chat';
import { serviceRoutes } from './routes/services';
import { fileStorageRoutes } from './routes/file-storage';
import { purchaseOrderRoutes } from './routes/purchase-orders';
import { serviceOrderRoutes } from './routes/service-orders';
import { firmRoutes } from './routes/firms';
import { firmContextMiddleware } from './middleware/auth';
import { complianceRoutes } from './routes/compliance';
import { plansRoutes } from './routes/plans';
import payrollRoutes from './routes/payroll';
import { emailDashRoutes } from './routes/email-dash';
import { waitlistRoutes } from './routes/waitlist';
import { reviewQueueRoutes } from './routes/review-queue';

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Middleware
app.use('*', cors({
  origin: (origin) => origin || '*',
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Active-Client'],
}));

// Security headers
app.use('*', async (c, next) => {
  await next();
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  // X-Frame-Options removed — file-storage PDF download needs iframe embedding from Pages frontend
  c.res.headers.set('X-XSS-Protection', '1; mode=block');
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.res.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://api.deepseek.com https://openrouter.io");
});

// Simple in-memory rate limiter
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
function rateLimiter(maxRequests: number, windowMs: number) {
  return async (c: any, next: any) => {
    const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
    const now = Date.now();
    let entry = rateLimitMap.get(ip);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      rateLimitMap.set(ip, entry);
    }
    entry.count++;
    if (entry.count > maxRequests) {
      return c.json({ error: 'Too many requests. Please try again later.' }, 429);
    }
    await next();
  };
}

app.use('*', prettyJSON());

// DB routing middleware — routes to tenant-specific D1 database based on hostname
app.use('/api/*', async (c, next) => {
  const host = c.req.header('host') || '';
  if (host.includes('hayson.techforliving.net') && c.env.DB_HAYSON) {
    (c.env as any).DB = c.env.DB_HAYSON;
  } else if (host.includes('paultang.techforliving.net') && c.env.DB_PAULTANG) {
    (c.env as any).DB = c.env.DB_PAULTANG;
  }
  await next();
});

// Auth + Firm context — runs at app level, skips public routes
app.use('/api/*', async (c, next) => {
  const path = c.req.path;
  if (path === '/api/health' || path === '/api/auth/login' || path === '/api/auth/register' || path.startsWith('/api/waitlist')) {
    await next();
    return;
  }
  // Run auth
  const authHeader = c.req.header('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const { verify } = await import('jsonwebtoken');
      const payload = verify(authHeader.slice(7), getJwtSecret(c.env)) as any;
      c.set('user', payload);
    } catch {}
  }
  // Run firm context after auth
  const firmResult = await firmContextMiddleware(c, next);
  if (firmResult) return firmResult;
});

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// AI Memory — serve markdown files from GitHub
const MEMORY_FILES: Record<string, string> = {
  soul: '靈魂.md',
  tech: '技術記憶.md',
  ledger: '賬本脈絡.md',
  plan: 'plan.md',
};
app.get('/api/ai-memory/:key', async (c) => {
  const key = c.req.param('key');
  const path = MEMORY_FILES[key];
  if (!path) return c.json({ error: 'Unknown file' }, 404);
  try {
    const resp = await fetch(`https://api.github.com/repos/ai-caseylai/opcc-crm/contents/${encodeURIComponent(path)}?ref=main`, {
      headers: { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, 'User-Agent': 'opcc-crm', Accept: 'application/vnd.github.v3+json' },
    });
    if (!resp.ok) return c.json({ error: `GitHub ${resp.status}` }, 502);
    const data = await resp.json() as any;
    let content = '';
    if (data.content) {
      const binary = atob(data.content.replace(/\n/g, ''));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      content = new TextDecoder('utf-8').decode(bytes);
    }
    return c.json({ key, path, content, sha: data.sha });
  } catch (e: any) { return c.json({ error: e.message }, 500); }
});

// Routes
app.route('/api/auth', authRoutes);
app.route('/api/customers', customerRoutes);
app.route('/api/suppliers', supplierRoutes);
app.route('/api/products', productRoutes);
app.route('/api/invoices', invoiceRoutes);
app.route('/api/quotations', quotationRoutes);
app.route('/api/bookkeeping', bookkeepingRoutes);
app.route('/api/payroll', payrollRoutes);
app.route('/api/fixed-assets', fixedAssetRoutes);
app.route('/api/dashboard', dashboardRoutes);
app.route('/api/import', importRoutes);
app.route('/api/audit', auditRoutes);
app.route('/api/workbuddy', workbuddyRoutes);
app.route('/api/pdf', pdfRoutes);
app.route('/api/company', companyRoutes);
app.route('/api/messaging', messagingRoutes);
app.route('/api/bank-statements', bankStatementRoutes);
app.route('/api/card-statements', cardStatementRoutes);
app.route('/api/expense-receipts', expenseReceiptRoutes);
app.route('/api/todos', todoRoutes);
app.route('/api/ws', wsRoutes);
app.route('/api/mail', mailRoutes);
app.route('/api/payment', paymentRoutes);
app.route('/api/company/website', websiteRoutes);
app.route('/api/chat', chatRoutes);
app.route('/api/calendar', calendarRoutes);
app.route('/api/file-storage', fileStorageRoutes);
app.route('/api/services', serviceRoutes);

app.route('/api/services', serviceRoutes);
app.route('/api/wb/v1', workbuddyV1Routes);
app.route('/api/admin', adminRoutes);
app.route('/api/documents', documentRoutes);
app.route('/api/wb', workbuddyMgmtRoutes);
app.route('/api/file-storage', fileStorageRoutes);
app.route('/api/purchase-orders', purchaseOrderRoutes);
app.route('/api/service-orders', serviceOrderRoutes);
app.route('/api/firms', firmRoutes);
app.route('/api/compliance', complianceRoutes);
app.route('/api/plans', plansRoutes);
app.route('/api/email-dash', emailDashRoutes);
app.route('/api/waitlist', waitlistRoutes);
app.route('/api/review-queue', reviewQueueRoutes);

// 404
app.notFound((c) => c.json({ error: 'Not found' }, 404));

// Error handler
app.onError((err, c) => {
  console.error('Error:', err);
  return c.json({ error: err.message || 'Internal server error' }, 500);
});

export default app;

