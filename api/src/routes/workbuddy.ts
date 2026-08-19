import { getJwtSecret } from '../middleware/auth';
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { v4 as uuidv4 } from 'uuid';
import { createHash, randomBytes } from 'crypto';
import { jePosted, jeNotOrphaned } from '../lib/journal-filters';
import { Bindings, Variables, AppContext, AppNext } from '../types';
import { authMiddleware } from '../middleware/auth';
import { hash } from 'bcryptjs';
import { verify as jwtVerify } from 'jsonwebtoken';

const workbuddy = new Hono<{ Bindings: Bindings; Variables: Variables }>();

async function tokenAuth(c: AppContext, next: AppNext) {
  const header = c.req.header('Authorization');
  if (!header || !header.startsWith('Bearer ')) return c.json({ error: 'API token required' }, 401);
  const token = header.slice(7);
  const hash = createHash('sha256').update(token).digest('hex');
  const row = await c.env.DB.prepare(
    'SELECT t.*, u.id as user_id, u.email, u.name, u.role FROM api_tokens t JOIN users u ON t.user_id = u.id WHERE t.token_hash = ? AND t.is_active = 1'
  ).bind(hash).first<{ user_id: string; email: string; name: string; role: string; scopes: string }>();
  if (!row) return c.json({ error: 'Invalid or expired token' }, 401);
  await c.env.DB.prepare('UPDATE api_tokens SET last_used_at = datetime(\'now\') WHERE token_hash = ?').bind(hash).run();
  c.set('user', { id: row.user_id, email: row.email, name: row.name, role: row.role, scopes: row.scopes });
  await next();
}

workbuddy.get('/manifest', (c) => {
  return c.json({
    name: 'opcc-crm', version: '1.0.0',
    description: 'OPCC CRM — Customer Relationship Management with Invoicing & Bookkeeping',
    base_url: 'https://opcc-crm.techforliving.net/api/workbuddy',
    skills: [
      { name: 'list_customers', tier: 'starter', description: 'List/search customers', endpoint: '/customers', method: 'GET', parameters: { q: 'search query', page: 'page number' } },
      { name: 'create_customer', tier: 'starter', description: 'Create customer', endpoint: '/customers', method: 'POST', parameters: { name: 'Name *', email: 'Email', phone: 'Phone', address: 'Address', company_name: 'Company' } },
      { name: 'list_suppliers', tier: 'starter', description: 'List suppliers', endpoint: '/suppliers', method: 'GET', parameters: { q: 'search query' } },
      { name: 'create_supplier', tier: 'starter', description: 'Create supplier', endpoint: '/suppliers', method: 'POST', parameters: { name: 'Name *', email: 'Email', phone: 'Phone' } },
      { name: 'list_products', tier: 'starter', description: 'List products/services', endpoint: '/products', method: 'GET', parameters: { q: 'search query' } },
      { name: 'create_product', tier: 'starter', description: 'Create product', endpoint: '/products', method: 'POST', parameters: { name: 'Name *', unit_price: 'Price *', currency: 'HKD/USD/CNY' } },
      { name: 'list_invoices', tier: 'starter', description: 'List invoices with status filter', endpoint: '/invoices', method: 'GET', parameters: { status: 'draft/sent/paid/overdue', q: 'search' } },
      { name: 'create_invoice', tier: 'starter', description: 'Create invoice with line items', endpoint: '/invoices', method: 'POST', parameters: { invoice_number: '# *', customer_id: 'ID *', items: '[{description,quantity,unit_price,amount}]', due_date: 'Due date' } },
      { name: 'update_invoice_status', tier: 'starter', description: 'Update invoice status', endpoint: '/invoices/:id/status', method: 'PATCH', parameters: { status: 'draft/sent/paid/overdue' } },
      { name: 'delete_invoice', tier: 'growth', description: 'Delete draft invoice', endpoint: '/invoices/:id', method: 'DELETE', parameters: { id: 'Invoice ID *' } },
      { name: 'list_quotations', tier: 'growth', description: 'List quotations', endpoint: '/quotations', method: 'GET', parameters: { status: 'draft/sent/accepted/rejected' } },
      { name: 'create_quotation', tier: 'growth', description: 'Create quotation', endpoint: '/quotations', method: 'POST', parameters: { quotation_number: '# *', customer_id: 'ID *', items: '[{description,quantity,unit_price,amount}]', valid_until: 'Date' } },
      { name: 'convert_quotation', tier: 'growth', description: 'Convert quotation to invoice', endpoint: '/quotations/:id/convert', method: 'POST' },
      { name: 'delete_quotation', tier: 'growth', description: 'Delete draft quotation', endpoint: '/quotations/:id', method: 'DELETE', parameters: { id: 'Quotation ID *' } },
      { name: 'list_purchase_orders', tier: 'growth', description: 'List purchase orders', endpoint: '/purchase-orders', method: 'GET', parameters: { status: 'draft/approved/received/paid/cancelled' } },
      { name: 'delete_purchase_order', tier: 'growth', description: 'Delete draft purchase order', endpoint: '/purchase-orders/:id', method: 'DELETE', parameters: { id: 'PO ID *' } },
      { name: 'list_service_orders', tier: 'growth', description: 'List service orders', endpoint: '/service-orders', method: 'GET', parameters: { status: 'draft/active/completed/cancelled' } },
      { name: 'delete_service_order', tier: 'growth', description: 'Delete draft service order', endpoint: '/service-orders/:id', method: 'DELETE', parameters: { id: 'SO ID *' } },
      { name: 'generate_pdf', tier: 'starter', description: 'Download invoice/quotation PDF (public)', endpoint: '/pdf/:type/:id', method: 'GET', parameters: { type: 'invoice or quotation', id: 'Document ID' } },
      { name: 'list_todos', tier: 'starter', description: 'List todo items', endpoint: '/todos', method: 'GET', parameters: { status: 'pending/completed' } },
      { name: 'create_todo', tier: 'starter', description: 'Create todo item', endpoint: '/todos', method: 'POST', parameters: { title: 'Title *', priority: 'high/medium/low', due_date: 'YYYY-MM-DD' } },
      { name: 'update_todo', tier: 'starter', description: 'Update todo (complete, edit)', endpoint: '/todos/:id', method: 'PATCH', parameters: { status: 'completed', title: 'New title' } },
      { name: 'list_bank_statements', tier: 'growth', description: 'List bank statements', endpoint: '/bank-statements', method: 'GET', parameters: { year: 'YYYY' } },
      { name: 'upload_bank_statement', tier: 'growth', description: 'Upload bank statement (base64)', endpoint: '/bank-statements/upload', method: 'POST', parameters: { file_data: 'Base64 *', bank_name: 'Bank', statement_year: 'YYYY', statement_month: 'MM' } },
      { name: 'list_expense_receipts', tier: 'growth', description: 'List expense receipts', endpoint: '/expense-receipts', method: 'GET', parameters: { year: 'YYYY', category: '餐飲/交通/...' } },
      { name: 'upload_expense_receipt', tier: 'growth', description: 'Upload expense receipt (base64)', endpoint: '/expense-receipts/upload', method: 'POST', parameters: { file_data: 'Base64 *', vendor_name: 'Vendor', amount: 'Amount', expense_date: 'YYYY-MM-DD', category: 'Category' } },
      { name: 'list_documents', tier: 'business', description: 'List BR/CI documents', endpoint: '/documents', method: 'GET', parameters: { type: 'br or ci' } },
      { name: 'upload_document', tier: 'business', description: 'Upload BR/CI document (base64)', endpoint: '/documents/upload', method: 'POST', parameters: { doc_type: 'br or ci *', doc_year: 'YYYY', file_data: 'Base64 *' } },
      { name: 'import_invoices_csv', tier: 'growth', description: 'Import invoices from CSV', endpoint: '/import/invoices', method: 'POST', parameters: { data: 'Array of invoice rows' } },
      { name: 'import_quotations_csv', tier: 'business', description: 'Import quotations from CSV', endpoint: '/import/quotations', method: 'POST', parameters: { data: 'Array of quotation rows' } },
      { name: 'import_customers_csv', tier: 'growth', description: 'Import customers from CSV', endpoint: '/import/customers', method: 'POST', parameters: { data: 'Array of customer rows' } },
      { name: 'import_products_csv', tier: 'growth', description: 'Import products from CSV', endpoint: '/import/products', method: 'POST', parameters: { data: 'Array of product rows' } },
      { name: 'trial_balance', tier: 'business', description: 'Get trial balance', endpoint: '/bookkeeping/trial-balance', method: 'GET', parameters: { as_of: 'YYYY-MM-DD' } },
      { name: 'income_statement', tier: 'business', description: 'Get P&L statement', endpoint: '/bookkeeping/income-statement', method: 'GET', parameters: { start_date: 'Start', end_date: 'End' } },
      { name: 'export_bookkeeping', tier: 'business', description: 'Export bookkeeping (CSV for auditor)', endpoint: '/bookkeeping/export', method: 'GET', parameters: { format: 'csv', start_date: 'Start', end_date: 'End' } },
      { name: 'list_calendar', tier: 'business', description: 'List calendar events', endpoint: '/calendar/events', method: 'GET', parameters: { start: 'Start date', end: 'End date' } },
      { name: 'create_event', tier: 'business', description: 'Create calendar event', endpoint: '/calendar/events', method: 'POST', parameters: { title: 'Title *', start_time: 'ISO datetime *', customer_id: 'Optional' } },
      { name: 'list_services', tier: 'business', description: 'List services', endpoint: '/services', method: 'GET' },
      { name: 'create_service', tier: 'business', description: 'Create service', endpoint: '/services', method: 'POST', parameters: { name: 'Name *', price: 'Price', duration_minutes: 'Duration', category: 'Category' } },
      { name: 'list_bookings', tier: 'business', description: 'List service bookings', endpoint: '/services/bookings', method: 'GET', parameters: { date: 'YYYY-MM-DD' } },
      { name: 'create_booking', tier: 'business', description: 'Create service booking', endpoint: '/services/bookings', method: 'POST', parameters: { service_id: '*', customer_id: '*', booking_date: '*', start_time: '*' } },
      { name: 'list_conversations', tier: 'business', description: 'List message conversations', endpoint: '/messaging/conversations', method: 'GET', parameters: { channel: 'telegram/whatsapp' } },
      { name: 'send_message', tier: 'business', description: 'Send reply in conversation', endpoint: '/messaging/send', method: 'POST', parameters: { conversation_id: 'ID *', content: 'Text *' } },
      { name: 'ai_chat', tier: 'enterprise', description: 'AI chatbot — ask about CRM data (Llama 3.1 with D1 function calling)', endpoint: '/chat', method: 'POST', parameters: { message: 'Question *', history: 'Chat history array' } },
      { name: 'company_profile', tier: 'starter', description: 'Get/update company profile', endpoint: '/company', method: 'GET/PUT', parameters: { name: 'Company name', features: 'JSON module toggles' } },
      { name: 'admin_onboard', tier: 'enterprise', description: 'One-click onboard new tenant (user + domain + DNS + Pages)', endpoint: '/admin/onboard', method: 'POST', parameters: { domain: 'Domain *', company_name: 'Company *', email: 'Admin email *', password: 'Password *' } },
      { name: 'admin_list_tenants', tier: 'enterprise', description: 'List all tenants with stats', endpoint: '/admin/users', method: 'GET' },
      { name: 'tenant_export', tier: 'enterprise', description: 'Export all tenant data as JSON/CSV', endpoint: '/admin/tenants/:id/export', method: 'GET', parameters: { format: 'json or csv', table: 'optional table name' } },
      { name: 'tenant_summary', tier: 'enterprise', description: 'Get tenant data counts', endpoint: '/admin/tenants/:id/summary', method: 'GET' },
    ],
  });
});

workbuddy.get('/tokens', authMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const rows = await c.env.DB.prepare(
    'SELECT id, name, scopes, last_used_at, expires_at, is_active, created_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(user.id).all();
  return c.json({ data: rows.results });
});

workbuddy.post('/tokens', authMiddleware, zValidator('json', z.object({ name: z.string().min(1), scopes: z.string().optional() })), async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const { name, scopes } = c.req.valid('json');
  const db = c.env.DB;
  const token = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const id = `tk-${uuidv4().slice(0, 8)}`;
  await db.prepare('INSERT INTO api_tokens (id, user_id, name, token_hash, scopes) VALUES (?, ?, ?, ?, ?)').bind(id, user.id, name, tokenHash, scopes || 'read').run();
  return c.json({ id, name, token, scopes: scopes || 'read', message: 'Save this token — it won\'t be shown again' }, 201);
});

workbuddy.delete('/tokens/:id', authMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  await c.env.DB.prepare('UPDATE api_tokens SET is_active = 0 WHERE id = ? AND user_id = ?').bind(c.req.param('id'), tenantId).run();
  return c.json({ success: true });
});

workbuddy.get('/customers', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const search = c.req.query('q') || '';
  let query = 'SELECT * FROM customers WHERE user_id = ?';
  const params: any[] = [user.id];
  if (search) { query += ' AND (name LIKE ? OR company_name LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  query += ' ORDER BY name ASC LIMIT 50';
  const rows = await db.prepare(query).bind(...params).all();
  return c.json({ data: rows.results });
});

workbuddy.post('/customers', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const body = await c.req.json();
  const id = `c-${uuidv4().slice(0, 8)}`;
  await c.env.DB.prepare('INSERT INTO customers (id, user_id, name, company_name, email, phone) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, user.id, body.name, body.company_name || null, body.email || null, body.phone || null).run();
  const row = await c.env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first();
  return c.json(row, 201);
});

workbuddy.get('/suppliers', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const rows = await c.env.DB.prepare('SELECT * FROM suppliers WHERE user_id = ? AND is_active = 1 ORDER BY name ASC LIMIT 50').bind(user.id).all();
  return c.json({ data: rows.results });
});

workbuddy.get('/products', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const rows = await c.env.DB.prepare('SELECT * FROM products WHERE user_id = ? AND is_active = 1 ORDER BY name ASC LIMIT 100').bind(user.id).all();
  return c.json({ data: rows.results });
});

workbuddy.get('/invoices', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const status = c.req.query('status');
  let query = 'SELECT * FROM invoices WHERE user_id = ? AND deleted_at IS NULL';
  const params: any[] = [user.id];
  if (status) { query += ' AND status = ?'; params.push(status); }
  query += ' ORDER BY created_at DESC LIMIT 50';
  const rows = await c.env.DB.prepare(query).bind(...params).all();
  return c.json({ data: rows.results });
});

workbuddy.post('/invoices', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const body = await c.req.json();
  const id = `i-${uuidv4().slice(0, 8)}`;
  const items = body.items || [];
  const subtotal = items.reduce((s: number, i: any) => s + (i.amount || 0), 0);
  await c.env.DB.prepare(
    'INSERT INTO invoices (id, user_id, invoice_number, customer_id, issue_date, due_date, subtotal, total, currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, user.id, body.invoice_number, body.customer_id, body.issue_date || new Date().toISOString().split('T')[0], body.due_date, subtotal, subtotal, body.currency || 'HKD').run();
  for (const item of items) {
    await c.env.DB.prepare(
      'INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, amount, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(`ii-${uuidv4().slice(0, 8)}`, id, item.description, item.quantity || 1, item.unit_price || 0, item.amount || 0, 0).run();
  }
  const row = await c.env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first();
  return c.json(row, 201);
});

workbuddy.delete('/invoices/:id', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT id, status FROM invoices WHERE id = ? AND user_id = ?').bind(id, tenantId).first<{ id: string; status: string }>();
  if (!existing) return c.json({ error: 'Invoice not found' }, 404);
  await c.env.DB.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM invoices WHERE id = ? AND user_id = ?').bind(id, tenantId).run();
  return c.json({ success: true, deleted: id, status: existing.status });
});

workbuddy.get('/purchase-orders', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const status = c.req.query('status');
  let query = 'SELECT po.*, s.name as supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id WHERE po.user_id = ?';
  const params: any[] = [user.id];
  if (status) { query += ' AND po.status = ?'; params.push(status); }
  query += ' ORDER BY po.created_at DESC LIMIT 50';
  const rows = await c.env.DB.prepare(query).bind(...params).all();
  return c.json({ data: rows.results });
});

workbuddy.delete('/purchase-orders/:id', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT id, status FROM purchase_orders WHERE id = ? AND user_id = ?').bind(id, tenantId).first<{ id: string; status: string }>();
  if (!existing) return c.json({ error: 'Purchase order not found' }, 404);
  await c.env.DB.prepare('DELETE FROM purchase_order_items WHERE po_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM purchase_orders WHERE id = ? AND user_id = ?').bind(id, tenantId).run();
  return c.json({ success: true, deleted: id, status: existing.status });
});

workbuddy.get('/quotations', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const status = c.req.query('status');
  let query = 'SELECT * FROM quotations WHERE user_id = ?';
  const params: any[] = [user.id];
  if (status) { query += ' AND status = ?'; params.push(status); }
  query += ' ORDER BY created_at DESC LIMIT 50';
  const rows = await c.env.DB.prepare(query).bind(...params).all();
  return c.json({ data: rows.results });
});

workbuddy.delete('/quotations/:id', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT id, status FROM quotations WHERE id = ? AND user_id = ?').bind(id, tenantId).first<{ id: string; status: string }>();
  if (!existing) return c.json({ error: 'Quotation not found' }, 404);
  await c.env.DB.prepare('DELETE FROM quotation_items WHERE quotation_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM quotations WHERE id = ? AND user_id = ?').bind(id, tenantId).run();
  return c.json({ success: true, deleted: id, status: existing.status });
});

workbuddy.get('/service-orders', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const status = c.req.query('status');
  let query = 'SELECT so.*, c.name as customer_name FROM service_orders so LEFT JOIN customers c ON so.customer_id = c.id WHERE so.user_id = ?';
  const params: any[] = [user.id];
  if (status) { query += ' AND so.status = ?'; params.push(status); }
  query += ' ORDER BY so.created_at DESC LIMIT 50';
  const rows = await c.env.DB.prepare(query).bind(...params).all();
  return c.json({ data: rows.results });
});

workbuddy.delete('/service-orders/:id', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT id, status FROM service_orders WHERE id = ? AND user_id = ?').bind(id, tenantId).first<{ id: string; status: string }>();
  if (!existing) return c.json({ error: 'Service order not found' }, 404);
  await c.env.DB.prepare('DELETE FROM service_order_items WHERE so_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM service_orders WHERE id = ? AND user_id = ?').bind(id, tenantId).run();
  return c.json({ success: true, deleted: id, status: existing.status });
});

// ── Customer Update / Delete ──
workbuddy.put('/customers/:id', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const id = c.req.param('id');
  const body = await c.req.json();
  const fields = ['name', 'company_name', 'email', 'phone', 'address', 'city', 'state', 'postal_code', 'country', 'notes', 'tax_id'];
  const sets: string[] = [];
  const params: any[] = [];
  for (const f of fields) {
    if (body[f] !== undefined) { sets.push(`${f} = ?`); params.push(body[f]); }
  }
  if (sets.length === 0) return c.json({ error: 'No fields to update' }, 400);
  sets.push("updated_at = datetime('now')");
  params.push(id, tenantId);
  await c.env.DB.prepare(`UPDATE customers SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...params).run();
  const row = await c.env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first();
  return c.json(row);
});

workbuddy.delete('/customers/:id', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  await c.env.DB.prepare("UPDATE customers SET is_active = 0, updated_at = datetime('now') WHERE id = ? AND user_id = ?").bind(c.req.param('id'), tenantId).run();
  return c.json({ success: true });
});

// ── Supplier Create / Update / Delete ──
workbuddy.post('/suppliers', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const body = await c.req.json();
  const id = `s-${uuidv4().slice(0, 8)}`;
  await c.env.DB.prepare('INSERT INTO suppliers (id, user_id, name, company_name, email, phone, address, payment_terms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, user.id, body.name, body.company_name || null, body.email || null, body.phone || null, body.address || null, body.payment_terms || null).run();
  const row = await c.env.DB.prepare('SELECT * FROM suppliers WHERE id = ?').bind(id).first();
  return c.json(row, 201);
});

workbuddy.put('/suppliers/:id', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const id = c.req.param('id');
  const body = await c.req.json();
  const fields = ['name', 'company_name', 'email', 'phone', 'address', 'payment_terms'];
  const sets: string[] = [];
  const params: any[] = [];
  for (const f of fields) {
    if (body[f] !== undefined) { sets.push(`${f} = ?`); params.push(body[f]); }
  }
  if (sets.length === 0) return c.json({ error: 'No fields to update' }, 400);
  sets.push("updated_at = datetime('now')");
  params.push(id, tenantId);
  await c.env.DB.prepare(`UPDATE suppliers SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...params).run();
  const row = await c.env.DB.prepare('SELECT * FROM suppliers WHERE id = ?').bind(id).first();
  return c.json(row);
});

workbuddy.delete('/suppliers/:id', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  await c.env.DB.prepare("UPDATE suppliers SET is_active = 0, updated_at = datetime('now') WHERE id = ? AND user_id = ?").bind(c.req.param('id'), tenantId).run();
  return c.json({ success: true });
});

// ── Product Create / Update / Delete ──
workbuddy.post('/products', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const body = await c.req.json();
  const id = `p-${uuidv4().slice(0, 8)}`;
  await c.env.DB.prepare('INSERT INTO products (id, user_id, name, unit_price, currency, unit, category, sku, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, user.id, body.name, body.unit_price || 0, body.currency || 'HKD', body.unit || 'pcs', body.category || null, body.sku || null, body.description || null).run();
  const row = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
  return c.json(row, 201);
});

workbuddy.put('/products/:id', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const id = c.req.param('id');
  const body = await c.req.json();
  const fields = ['name', 'unit_price', 'currency', 'unit', 'category', 'sku', 'description'];
  const sets: string[] = [];
  const params: any[] = [];
  for (const f of fields) {
    if (body[f] !== undefined) { sets.push(`${f} = ?`); params.push(body[f]); }
  }
  if (sets.length === 0) return c.json({ error: 'No fields to update' }, 400);
  sets.push("updated_at = datetime('now')");
  params.push(id, tenantId);
  await c.env.DB.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...params).run();
  const row = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
  return c.json(row);
});

workbuddy.delete('/products/:id', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  await c.env.DB.prepare("UPDATE products SET is_active = 0, updated_at = datetime('now') WHERE id = ? AND user_id = ?").bind(c.req.param('id'), tenantId).run();
  return c.json({ success: true });
});

// ── Single entity GET (invoices, quotations, POs, SOs) ──
workbuddy.get('/invoices/:id', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const inv = await c.env.DB.prepare('SELECT i.*, c.name as customer_name FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id WHERE i.id = ? AND i.user_id = ?').bind(c.req.param('id'), tenantId).first();
  if (!inv) return c.json({ error: 'Invoice not found' }, 404);
  const items = await c.env.DB.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order').bind(c.req.param('id')).all();
  return c.json({ ...inv, items: items.results });
});

workbuddy.patch('/invoices/:id/status', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const { status } = await c.req.json();
  if (!status) return c.json({ error: 'status required' }, 400);
  await c.env.DB.prepare("UPDATE invoices SET status = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").bind(status, c.req.param('id'), tenantId).run();
  if (status === 'paid') await c.env.DB.prepare("UPDATE invoices SET paid_date = datetime('now') WHERE id = ?").bind(c.req.param('id')).run();
  return c.json({ success: true, status });
});

workbuddy.get('/quotations/:id', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const row = await c.env.DB.prepare('SELECT q.*, c.name as customer_name FROM quotations q LEFT JOIN customers c ON q.customer_id = c.id WHERE q.id = ? AND q.user_id = ?').bind(c.req.param('id'), tenantId).first();
  if (!row) return c.json({ error: 'Quotation not found' }, 404);
  const items = await c.env.DB.prepare('SELECT * FROM quotation_items WHERE quotation_id = ? ORDER BY sort_order').bind(c.req.param('id')).all();
  return c.json({ ...row, items: items.results });
});

workbuddy.post('/quotations', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const body = await c.req.json();
  const id = `q-${uuidv4().slice(0, 8)}`;
  const items: any[] = body.items || [];
  const subtotal = items.reduce((s: number, i: any) => s + (i.amount || 0), 0);
  await c.env.DB.prepare(
    'INSERT INTO quotations (id, user_id, quotation_number, customer_id, issue_date, valid_until, subtotal, total, currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, user.id, body.quotation_number, body.customer_id, body.issue_date || new Date().toISOString().split('T')[0], body.valid_until, subtotal, subtotal, body.currency || 'HKD').run();
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    await c.env.DB.prepare('INSERT INTO quotation_items (id, quotation_id, description, quantity, unit_price, amount, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(`qi-${uuidv4().slice(0, 8)}`, id, it.description, it.quantity || 1, it.unit_price || 0, it.amount || 0, idx).run();
  }
  const row = await c.env.DB.prepare('SELECT * FROM quotations WHERE id = ?').bind(id).first();
  return c.json(row, 201);
});

workbuddy.post('/quotations/:id/convert', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const quo = await c.env.DB.prepare('SELECT * FROM quotations WHERE id = ? AND user_id = ?').bind(c.req.param('id'), tenantId).first<any>();
  if (!quo) return c.json({ error: 'Quotation not found' }, 404);
  const invId = `i-${uuidv4().slice(0, 8)}`;
  const invNum = `INV-${Date.now().toString(36).toUpperCase()}`;
  await c.env.DB.prepare('INSERT INTO invoices (id, user_id, invoice_number, customer_id, issue_date, subtotal, total, currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(invId, user.id, invNum, quo.customer_id, new Date().toISOString().split('T')[0], quo.subtotal, quo.total, quo.currency).run();
  const qItems = await c.env.DB.prepare('SELECT * FROM quotation_items WHERE quotation_id = ?').bind(c.req.param('id')).all();
  for (const qi of qItems.results as any[]) {
    await c.env.DB.prepare('INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, amount, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(`ii-${uuidv4().slice(0, 8)}`, invId, qi.description, qi.quantity, qi.unit_price, qi.amount, qi.sort_order).run();
  }
  await c.env.DB.prepare("UPDATE quotations SET status = 'converted', converted_invoice_id = ? WHERE id = ?").bind(invId, c.req.param('id')).run();
  return c.json({ success: true, invoice_id: invId, invoice_number: invNum });
});

workbuddy.get('/purchase-orders/:id', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const row = await c.env.DB.prepare('SELECT po.*, s.name as supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id WHERE po.id = ? AND po.user_id = ?').bind(c.req.param('id'), tenantId).first();
  if (!row) return c.json({ error: 'Purchase order not found' }, 404);
  const items = await c.env.DB.prepare('SELECT * FROM purchase_order_items WHERE po_id = ? ORDER BY sort_order').bind(c.req.param('id')).all();
  return c.json({ ...row, items: items.results });
});

workbuddy.post('/purchase-orders', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const body = await c.req.json();
  const id = `po-${uuidv4().slice(0, 8)}`;
  const items: any[] = body.items || [];
  const subtotal = items.reduce((s: number, i: any) => s + (i.amount || 0), 0);
  await c.env.DB.prepare(
    'INSERT INTO purchase_orders (id, user_id, po_number, supplier_id, issue_date, due_date, subtotal, total, currency, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, user.id, body.po_number || `PO-${Date.now().toString(36).toUpperCase()}`, body.supplier_id || null, new Date().toISOString().split('T')[0], body.due_date, subtotal, subtotal, body.currency || 'HKD', body.notes || null).run();
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    await c.env.DB.prepare('INSERT INTO purchase_order_items (id, po_id, description, quantity, unit_price, amount, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(`poi-${uuidv4().slice(0, 8)}`, id, it.description, it.quantity || 1, it.unit_price || 0, it.amount || 0, idx).run();
  }
  const row = await c.env.DB.prepare('SELECT * FROM purchase_orders WHERE id = ?').bind(id).first();
  return c.json(row, 201);
});

workbuddy.patch('/purchase-orders/:id/status', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const { status } = await c.req.json();
  if (!status) return c.json({ error: 'status required' }, 400);
  await c.env.DB.prepare("UPDATE purchase_orders SET status = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").bind(status, c.req.param('id'), tenantId).run();
  if (status === 'paid') await c.env.DB.prepare("UPDATE purchase_orders SET paid_date = datetime('now') WHERE id = ?").bind(c.req.param('id')).run();
  return c.json({ success: true, status });
});

workbuddy.get('/service-orders/:id', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const row = await c.env.DB.prepare('SELECT so.*, c.name as customer_name FROM service_orders so LEFT JOIN customers c ON so.customer_id = c.id WHERE so.id = ? AND so.user_id = ?').bind(c.req.param('id'), tenantId).first();
  if (!row) return c.json({ error: 'Service order not found' }, 404);
  const items = await c.env.DB.prepare('SELECT * FROM service_order_items WHERE so_id = ? ORDER BY sort_order').bind(c.req.param('id')).all();
  return c.json({ ...row, items: items.results });
});

workbuddy.post('/service-orders', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const body = await c.req.json();
  const id = `so-${uuidv4().slice(0, 8)}`;
  const items: any[] = body.items || [];
  const subtotal = items.reduce((s: number, i: any) => s + (i.amount || 0), 0);
  await c.env.DB.prepare(
    'INSERT INTO service_orders (id, user_id, so_number, customer_id, issue_date, valid_from, valid_until, subtotal, total, currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, user.id, body.so_number || `SO-${Date.now().toString(36).toUpperCase()}`, body.customer_id, new Date().toISOString().split('T')[0], body.valid_from, body.valid_until, subtotal, subtotal, body.currency || 'HKD').run();
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    await c.env.DB.prepare('INSERT INTO service_order_items (id, so_id, description, quantity, unit_price, amount, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(`soi-${uuidv4().slice(0, 8)}`, id, it.description, it.quantity || 1, it.unit_price || 0, it.amount || 0, idx).run();
  }
  const row = await c.env.DB.prepare('SELECT * FROM service_orders WHERE id = ?').bind(id).first();
  return c.json(row, 201);
});

workbuddy.patch('/service-orders/:id/status', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const { status } = await c.req.json();
  if (!status) return c.json({ error: 'status required' }, 400);
  await c.env.DB.prepare("UPDATE service_orders SET status = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").bind(status, c.req.param('id'), tenantId).run();
  return c.json({ success: true, status });
});

// ── Services ──
workbuddy.get('/services', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const rows = await c.env.DB.prepare('SELECT * FROM services WHERE user_id = ? AND is_active = 1 ORDER BY name').bind(user.id).all();
  return c.json({ data: rows.results });
});

workbuddy.post('/services', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const body = await c.req.json();
  const id = `svc-${uuidv4().slice(0, 8)}`;
  await c.env.DB.prepare('INSERT INTO services (id, user_id, name, price, duration_minutes, category) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, user.id, body.name, body.price || 0, body.duration_minutes || 60, body.category || 'general').run();
  const row = await c.env.DB.prepare('SELECT * FROM services WHERE id = ?').bind(id).first();
  return c.json(row, 201);
});

// ── Bookings ──
workbuddy.get('/services/bookings', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const date = c.req.query('date');
  let q = 'SELECT sb.*, s.name as service_name, c.name as customer_name FROM service_bookings sb JOIN services s ON sb.service_id = s.id LEFT JOIN customers c ON sb.customer_id = c.id WHERE sb.user_id = ?';
  const params: any[] = [user.id];
  if (date) { q += ' AND sb.booking_date = ?'; params.push(date); }
  q += ' ORDER BY sb.start_time';
  const rows = await c.env.DB.prepare(q).bind(...params).all();
  return c.json({ data: rows.results });
});

workbuddy.post('/services/bookings', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const body = await c.req.json();
  const id = `bk-${uuidv4().slice(0, 8)}`;
  await c.env.DB.prepare('INSERT INTO service_bookings (id, user_id, service_id, customer_id, booking_date, start_time, end_time, notes, price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, user.id, body.service_id, body.customer_id, body.booking_date, body.start_time, body.end_time || null, body.notes || null, body.price || null).run();
  const row = await c.env.DB.prepare('SELECT * FROM service_bookings WHERE id = ?').bind(id).first();
  return c.json(row, 201);
});

// ── Calendar ──
workbuddy.get('/calendar/events', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const start = c.req.query('start') || new Date().toISOString().split('T')[0];
  const end = c.req.query('end') || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
  const rows = await c.env.DB.prepare('SELECT * FROM calendar_events WHERE user_id = ? AND start_time BETWEEN ? AND ? ORDER BY start_time').bind(tenantId, start, end).all();
  return c.json({ data: rows.results });
});

workbuddy.post('/calendar/events', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const body = await c.req.json();
  const id = `evt-${uuidv4().slice(0, 8)}`;
  await c.env.DB.prepare('INSERT INTO calendar_events (id, user_id, title, start_time, end_time, description, location, customer_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, user.id, body.title, body.start_time, body.end_time || null, body.description || null, body.location || null, body.customer_id || null).run();
  const row = await c.env.DB.prepare('SELECT * FROM calendar_events WHERE id = ?').bind(id).first();
  return c.json(row, 201);
});

workbuddy.delete('/calendar/events/:id', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  await c.env.DB.prepare('DELETE FROM calendar_events WHERE id = ? AND user_id = ?').bind(c.req.param('id'), tenantId).run();
  return c.json({ success: true });
});

// ── Company Profile ──
workbuddy.get('/company', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const row = await c.env.DB.prepare('SELECT * FROM company_settings WHERE user_id = ?').bind(user.id).first();
  return c.json(row || {});
});

workbuddy.put('/company', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const body = await c.req.json();
  const fields = ['name', 'address', 'phone', 'email', 'website', 'tagline', 'legal_name', 'short_name', 'tax_id', 'bank_name', 'bank_account'];
  const sets: string[] = [];
  const params: any[] = [];
  for (const f of fields) {
    if (body[f] !== undefined) { sets.push(`${f} = ?`); params.push(body[f]); }
  }
  if (sets.length === 0) return c.json({ error: 'No fields to update' }, 400);
  sets.push("updated_at = datetime('now')");
  params.push(tenantId);
  await c.env.DB.prepare(`UPDATE company_settings SET ${sets.join(', ')} WHERE user_id = ?`).bind(...params).run();
  const row = await c.env.DB.prepare('SELECT * FROM company_settings WHERE user_id = ?').bind(user.id).first();
  return c.json(row);
});

// ── Aggregate / Summary ──
workbuddy.get('/counts', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const tables = ['customers', 'suppliers', 'products', 'invoices', 'quotations', 'purchase_orders', 'service_orders', 'todos'];
  const result: Record<string, number> = {};
  for (const t of tables) {
    try {
      const r = await c.env.DB.prepare(`SELECT COUNT(*) as cnt FROM ${t} WHERE user_id = ?`).bind(user.id).first<{ cnt: number }>();
      result[t] = r?.cnt || 0;
    } catch { result[t] = 0; }
  }
  return c.json(result);
});

workbuddy.get('/summary', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const counts: Record<string, number> = {};
  for (const t of ['customers', 'suppliers', 'products', 'invoices', 'quotations', 'purchase_orders', 'service_orders', 'todos']) {
    try {
      const r = await c.env.DB.prepare(`SELECT COUNT(*) as cnt FROM ${t} WHERE user_id = ?`).bind(user.id).first<{ cnt: number }>();
      counts[t] = r?.cnt || 0;
    } catch { counts[t] = 0; }
  }
  try {
    const invTotal = await c.env.DB.prepare("SELECT COALESCE(SUM(total),0) as total FROM invoices WHERE user_id = ? AND status = 'paid' AND deleted_at IS NULL").bind(user.id).first<{ total: number }>();
    const poTotal = await c.env.DB.prepare("SELECT COALESCE(SUM(total),0) as total FROM purchase_orders WHERE user_id = ? AND status = 'paid'").bind(user.id).first<{ total: number }>();
    counts.income_paid = invTotal?.total || 0;
    counts.expense_paid = poTotal?.total || 0;
    counts.net = (invTotal?.total || 0) - (poTotal?.total || 0);
  } catch {}
  return c.json(counts);
});

workbuddy.get('/bookkeeping', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const start = c.req.query('start_date') || '2020-01-01';
  const end = c.req.query('end_date') || '2099-12-31';
  try {
    const rows = await c.env.DB.prepare(
      `SELECT a.account_code as code, a.account_name as name, a.account_type as type, SUM(COALESCE(jl.debit,0)) as total_debit, SUM(COALESCE(jl.credit,0)) as total_credit FROM journal_lines jl JOIN accounts a ON jl.account_code = a.account_code AND je.user_id = a.user_id JOIN journal_entries je ON jl.entry_id = je.id WHERE je.user_id = ? AND je.entry_date BETWEEN ? AND ? AND ${jePosted()} AND ${jeNotOrphaned()} GROUP BY a.account_code, a.account_name, a.account_type ORDER BY a.account_code`
    ).bind(tenantId, start, end).all();
    if (rows.results.length > 0) return c.json({ data: rows.results });
  } catch {}
  // Fallback: bank transactions
  try {
    const deposits = await c.env.DB.prepare('SELECT COALESCE(SUM(deposit_amount),0) as total FROM bank_transactions WHERE user_id = ? AND transaction_date >= ? AND transaction_date <= ? AND deleted_at IS NULL').bind(tenantId, start, end).first<{ total: number }>();
    const withdrawals = await c.env.DB.prepare('SELECT COALESCE(SUM(withdrawal_amount),0) as total FROM bank_transactions WHERE user_id = ? AND transaction_date >= ? AND transaction_date <= ? AND deleted_at IS NULL').bind(tenantId, start, end).first<{ total: number }>();
    return c.json({ data: [
      { code: 'REV', name: 'Revenue (Bank Deposits)', type: 'revenue', total_credit: deposits?.total || 0 },
      { code: 'EXP', name: 'Expenses (Bank Withdrawals)', type: 'expense', total_debit: withdrawals?.total || 0 },
      { code: 'NET', name: 'Net Income', type: 'equity', total_credit: (deposits?.total || 0) - (withdrawals?.total || 0) },
    ] });
  } catch { return c.json({ data: [] }); }
});

workbuddy.get('/activity', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const limit = parseInt(c.req.query('limit') || '20');
  const rows = await c.env.DB.prepare('SELECT action, entity_type, entity_id, created_at FROM audit_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').bind(tenantId, limit).all();
  return c.json({ data: rows.results });
});

// ── Search endpoints ──
workbuddy.get('/customers/search', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const q = c.req.query('q') || '';
  const rows = await c.env.DB.prepare(
    'SELECT id, name, company_name, email, phone, address FROM customers WHERE user_id = ? AND is_active = 1 AND (name LIKE ? OR email LIKE ? OR company_name LIKE ?) ORDER BY name LIMIT ?'
  ).bind(tenantId, `%${q}%`, `%${q}%`, `%${q}%`, 20).all();
  return c.json({ data: rows.results });
});

workbuddy.get('/suppliers/search', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const q = c.req.query('q') || '';
  const rows = await c.env.DB.prepare(
    'SELECT id, name, company_name, email, phone FROM suppliers WHERE user_id = ? AND is_active = 1 AND (name LIKE ? OR company_name LIKE ?) ORDER BY name LIMIT ?'
  ).bind(tenantId, `%${q}%`, `%${q}%`, 20).all();
  return c.json({ data: rows.results });
});

workbuddy.get('/products/search', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const q = c.req.query('q') || '';
  const rows = await c.env.DB.prepare(
    'SELECT id, name, category, unit_price, currency FROM products WHERE user_id = ? AND is_active = 1 AND (name LIKE ? OR category LIKE ?) ORDER BY name LIMIT ?'
  ).bind(tenantId, `%${q}%`, `%${q}%`, 20).all();
  return c.json({ data: rows.results });
});

workbuddy.get('/invoices/search', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const q = c.req.query('q') || '';
  const rows = await c.env.DB.prepare(
    `SELECT i.id, i.invoice_number, i.status, i.total, i.currency, i.issue_date, c.name as customer_name FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id WHERE i.user_id = ? AND i.deleted_at IS NULL AND (i.invoice_number LIKE ? OR c.name LIKE ?) ORDER BY i.created_at DESC LIMIT ?`
  ).bind(tenantId, `%${q}%`, `%${q}%`, 20).all();
  return c.json({ data: rows.results });
});

// ── Services Update / Delete ──
workbuddy.put('/services/:id', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const body = await c.req.json();
  const fields = ['name', 'price', 'duration_minutes', 'category', 'description'];
  const sets: string[] = [];
  const params: any[] = [];
  for (const f of fields) {
    if (body[f] !== undefined) { sets.push(`${f} = ?`); params.push(body[f]); }
  }
  if (sets.length === 0) return c.json({ error: 'No fields to update' }, 400);
  sets.push("updated_at = datetime('now')");
  params.push(c.req.param('id'), tenantId);
  await c.env.DB.prepare(`UPDATE services SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...params).run();
  const row = await c.env.DB.prepare('SELECT * FROM services WHERE id = ?').bind(c.req.param('id')).first();
  return c.json(row);
});

workbuddy.delete('/services/:id', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  await c.env.DB.prepare("UPDATE services SET is_active = 0, updated_at = datetime('now') WHERE id = ? AND user_id = ?").bind(c.req.param('id'), tenantId).run();
  return c.json({ success: true });
});

// ── Calendar Event Update ──
workbuddy.put('/calendar/events/:id', tokenAuth, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const body = await c.req.json();
  const fields = ['title', 'start_time', 'end_time', 'description', 'location', 'status'];
  const sets: string[] = [];
  const params: any[] = [];
  for (const f of fields) {
    if (body[f] !== undefined) { sets.push(`${f} = ?`); params.push(body[f]); }
  }
  if (sets.length === 0) return c.json({ error: 'No fields to update' }, 400);
  sets.push("updated_at = datetime('now')");
  params.push(c.req.param('id'), tenantId);
  await c.env.DB.prepare(`UPDATE calendar_events SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...params).run();
  const row = await c.env.DB.prepare('SELECT * FROM calendar_events WHERE id = ?').bind(c.req.param('id')).first();
  return c.json(row);
});

// ── One-click onboard — dual auth: JWT or API token ──
workbuddy.post('/admin/onboard', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return c.json({ error: 'Bearer token required' }, 401);
  const token = authHeader.slice(7);

  let role = '';
  // Try JWT first
  try {
    const payload = jwtVerify(token, getJwtSecret(c.env)) as { role: string };
    role = payload.role;
  } catch {
    // Fall back to API token (SHA256 hash)
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const tokenRow = await c.env.DB.prepare(
      'SELECT u.role FROM api_tokens t JOIN users u ON t.user_id = u.id WHERE t.token_hash = ? AND t.is_active = 1'
    ).bind(tokenHash).first<{ role: string }>();
    if (tokenRow) role = tokenRow.role;
  }
  // Third fallback: workbuddy_config API key (plain-text)
  if (!role) {
    const wbRow = await c.env.DB.prepare(
      'SELECT u.role FROM workbuddy_config wc JOIN users u ON wc.user_id = u.id WHERE wc.api_key = ? AND wc.enabled = 1'
    ).bind(token).first<{ role: string }>();
    if (wbRow) role = wbRow.role;
  }

  if (!role) return c.json({ error: 'Invalid or expired token' }, 401);
  if (role !== 'admin') return c.json({ error: 'Admin access required' }, 403);

  const body = await c.req.json();
  const { domain, company_name, email, password, name } = body;
  if (!domain || !company_name || !email || !password) {
    return c.json({ error: 'domain, company_name, email, password required' }, 400);
  }

  const db = c.env.DB;
  const steps: string[] = [];

  // 1. Create user
  const userId = `u-${uuidv4().slice(0, 8)}`;
  const passwordHash = await hash(password, 10);
  await db.prepare(
    'INSERT INTO users (id, email, password_hash, name, company_name, role) VALUES (?,?,?,?,?,?)'
  ).bind(userId, email, passwordHash, name || company_name, company_name, 'admin').run();
  steps.push('✅ 用戶已創建');

  // 2. Create company_settings
  await db.prepare(
    `INSERT OR REPLACE INTO company_settings (user_id, name, email, website, address)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(userId, company_name, email, `https://${domain}`, 'Hong Kong').run();
  steps.push('✅ 公司資料已設定');

  // 3. Domain mapping
  const dmId = `dm-${uuidv4().slice(0, 8)}`;
  await db.prepare(
    'INSERT INTO domains (id, user_id, domain, is_primary) VALUES (?,?,?,1)'
  ).bind(dmId, userId, domain).run();
  steps.push('✅ 域名已映射');

  // 4. Cloudflare DNS + Pages
  const cfToken = c.env.CF_API_TOKEN || '';
  const accountId = c.env.CF_ACCOUNT_ID || '';
  const zoneId = c.env.CF_ZONE_ID || '';

  if (cfToken) {
    try {
      const dnsRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'CNAME', name: domain.split('.')[0], content: 'oppc-crm.pages.dev', ttl: 1, proxied: true }),
      });
      const dnsJson: any = await dnsRes.json();
      if (dnsJson.success) steps.push('✅ DNS CNAME 已創建');
      else steps.push(`⚠️ DNS: ${dnsJson.errors?.[0]?.message || 'unknown'}`);
    } catch (e: any) { steps.push(`⚠️ DNS: ${e.message}`); }

    try {
      const pagesRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/oppc-crm/domains`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: domain }),
      });
      const pagesJson: any = await pagesRes.json();
      if (pagesJson.success) steps.push('✅ Pages 域名已添加');
      else steps.push(`⚠️ Pages: ${pagesJson.errors?.[0]?.message || 'unknown'}`);
    } catch (e: any) { steps.push(`⚠️ Pages: ${e.message}`); }
  } else {
    steps.push('ℹ️ CF_API_TOKEN 未設定，DNS/Pages 需手動');
  }

  return c.json({
    success: true,
    user: { id: userId, email, name: name || company_name, company: company_name },
    domain: `https://${domain}`,
    password,
    steps,
  }, 201);
});

export { workbuddy as workbuddyRoutes };
