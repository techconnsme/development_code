import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { Bindings, Variables } from '../types';
import { apiKeyAuth } from '../middleware/apikey';
import { authMiddleware } from '../middleware/auth';

const wb = new Hono<{ Bindings: Bindings; Variables: Variables }>();
wb.use('*', apiKeyAuth);

// ── Health ──
wb.get('/health', (c) => c.json({ service: 'workbuddy-v1', status: 'ok' }));

// ── Customers ──
wb.get('/customers', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const search = c.req.query('q') || '';
  let q = 'SELECT * FROM customers WHERE user_id = ?';
  const p: any[] = [user.id];
  if (search) { q += ' AND (name LIKE ? OR email LIKE ?)'; p.push(`%${search}%`, `%${search}%`); }
  q += ' ORDER BY name ASC LIMIT 100';
  const rows = await db.prepare(q).bind(...p).all();
  return c.json({ data: rows.results });
});

wb.post('/customers', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const body = await c.req.json();
  const id = `c-${uuidv4().slice(0, 8)}`;
  await db.prepare(
    'INSERT INTO customers (id, user_id, name, company_name, email, phone, address) VALUES (?,?,?,?,?,?,?)'
  ).bind(id, user.id, body.name || 'Unknown', body.company_name || null, body.email || null, body.phone || null, body.address || null).run();
  const row = await db.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first();
  return c.json(row, 201);
});

// ── Products ──
wb.get('/products', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const rows = await c.env.DB.prepare('SELECT * FROM products WHERE user_id = ? AND is_active = 1 ORDER BY name ASC LIMIT 200').bind(user.id).all();
  return c.json({ data: rows.results });
});

// ── Invoices ──
wb.get('/invoices', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const status = c.req.query('status') || '';
  let q = 'SELECT * FROM invoices WHERE user_id = ? AND deleted_at IS NULL';
  const p: any[] = [user.id];
  if (status) { q += ' AND status = ?'; p.push(status); }
  q += ' ORDER BY created_at DESC LIMIT 50';
  const rows = await db.prepare(q).bind(...p).all();
  return c.json({ data: rows.results });
});

wb.post('/invoices', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const body = await c.req.json();
  const id = `i-${uuidv4().slice(0, 8)}`;
  const items = body.items || [];
  const subtotal = items.reduce((s: number, i: any) => s + (i.amount || 0), 0);

  await db.prepare(
    'INSERT INTO invoices (id, user_id, invoice_number, customer_id, issue_date, due_date, subtotal, tax_rate, tax_amount, total, currency, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(id, user.id, body.invoice_number, body.customer_id, body.issue_date || new Date().toISOString().split('T')[0],
    body.due_date, subtotal, body.tax_rate || 0, subtotal * ((body.tax_rate || 0) / 100), subtotal + subtotal * ((body.tax_rate || 0) / 100),
    body.currency || 'HKD', body.notes || null).run();

  for (const item of items) {
    await db.prepare(
      'INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, amount, sort_order) VALUES (?,?,?,?,?,?,?)'
    ).bind(`ii-${uuidv4().slice(0, 8)}`, id, item.description, item.quantity || 1, item.unit_price || 0, item.amount || 0, 0).run();
  }

  const row = await db.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first();
  return c.json(row, 201);
});

// ── Quotations ──
wb.get('/quotations', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const rows = await c.env.DB.prepare('SELECT * FROM quotations WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').bind(user.id).all();
  return c.json({ data: rows.results });
});

wb.post('/quotations', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const body = await c.req.json();
  const id = `q-${uuidv4().slice(0, 8)}`;
  const items = body.items || [];
  const subtotal = items.reduce((s: number, i: any) => s + (i.amount || 0), 0);

  await db.prepare(
    'INSERT INTO quotations (id, user_id, quotation_number, customer_id, issue_date, valid_until, subtotal, tax_rate, tax_amount, total, currency, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(id, user.id, body.quotation_number, body.customer_id, body.issue_date || new Date().toISOString().split('T')[0],
    body.valid_until, subtotal, body.tax_rate || 0, subtotal * ((body.tax_rate || 0) / 100),
    subtotal + subtotal * ((body.tax_rate || 0) / 100), body.currency || 'HKD', body.notes || null).run();

  for (const item of items) {
    await db.prepare(
      'INSERT INTO quotation_items (id, quotation_id, description, quantity, unit_price, amount, sort_order) VALUES (?,?,?,?,?,?,?)'
    ).bind(`qi-${uuidv4().slice(0, 8)}`, id, item.description, item.quantity || 1, item.unit_price || 0, item.amount || 0, 0).run();
  }

  const row = await db.prepare('SELECT * FROM quotations WHERE id = ?').bind(id).first();
  return c.json(row, 201);
});

// ── PDF download ──
wb.get('/pdf/:type/:id', async (c) => {
  const type = c.req.param('type');
  const id = c.req.param('id');
  return Response.redirect(`https://opcc-crm.techforliving.net/api/pdf/${type}/${id}`, 302);
});

// ── API Key management (requires JWT, not API key) ──
const mgmt = new Hono<{ Bindings: Bindings; Variables: Variables }>();

mgmt.get('/key', authMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const row = await c.env.DB.prepare(
    'SELECT id, api_key, webhook_url, enabled, created_at FROM workbuddy_config WHERE user_id = ? LIMIT 1'
  ).bind(user.id).first();
  if (!row) return c.json({ api_key: null, message: 'No API key configured' });
  return c.json(row);
});

mgmt.post('/key', authMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;

  // Generate a random API key
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const apiKey = `wb_${Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')}`;

  const existing = await db.prepare('SELECT id FROM workbuddy_config WHERE user_id = ?').bind(user.id).first();
  if (existing) {
    await db.prepare("UPDATE workbuddy_config SET api_key = ?, updated_at = datetime('now') WHERE user_id = ?")
      .bind(apiKey, tenantId).run();
  } else {
    await db.prepare('INSERT INTO workbuddy_config (id, user_id, api_key) VALUES (?, ?, ?)')
      .bind('default', user.id, apiKey).run();
  }

  return c.json({ api_key: apiKey, message: 'Save this key — it will not be shown again' }, 201);
});

mgmt.delete('/key', authMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  await c.env.DB.prepare('UPDATE workbuddy_config SET enabled = 0 WHERE user_id = ?').bind(user.id).run();
  return c.json({ success: true });
});

export { wb as workbuddyV1Routes, mgmt as workbuddyMgmtRoutes };
