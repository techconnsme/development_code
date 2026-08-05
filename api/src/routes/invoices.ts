import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { v4 as uuidv4 } from 'uuid';
import { Bindings, Variables } from '../types';
import { authMiddleware } from '../middleware/auth';
import { ensureProducts } from '../lib/auto-product';
import { generateInvoiceNumber, generateReceiptNumber } from '../lib/numbering';

const invoices = new Hono<{ Bindings: Bindings; Variables: Variables }>();
invoices.use('*', authMiddleware);

invoices.get('/', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const status = c.req.query('status') || '';
  const search = c.req.query('q') || '';
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '20');
  const offset = (page - 1) * limit;
  const docType = c.req.query('doc_type') || ''; // 'receipt' | 'invoice' | ''
  const direction = c.req.query('direction') || ''; // 'incoming' | 'outgoing' | ''

  // Default: exclude pending_review unless explicitly requested
  const showPendingReview = status === 'pending_review';
  let query = `SELECT i.*, c.name as customer_name, c.company_name as customer_company, s.name as supplier_name FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id LEFT JOIN suppliers s ON i.supplier_id = s.id WHERE i.user_id = ?`;
  if (!showPendingReview) query += " AND i.status != 'pending_review'";
  const params: any[] = [tenantId];
  if (status) { const statuses = status.split(',').filter(Boolean); query += ` AND i.status IN (${statuses.map(() => '?').join(',')})`; params.push(...statuses); }
  if (search) { query += ' AND (i.invoice_number LIKE ? OR c.name LIKE ? OR s.name LIKE ? OR i.vendor_name LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
  // doc_type filter: receipt = has receipt_number, invoice = no receipt_number
  if (docType === 'receipt') { query += ' AND i.receipt_number IS NOT NULL'; }
  else if (docType === 'invoice') { query += ' AND i.receipt_number IS NULL'; }
  if (direction === 'incoming') { query += " AND i.direction = 'incoming'"; }
  else if (direction === 'outgoing') { query += " AND i.direction = 'outgoing'"; }
  query += ' ORDER BY i.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = await db.prepare(query).bind(...params).all();
  const countRow = await db.prepare(
    `SELECT COUNT(*) as count FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id LEFT JOIN suppliers s ON i.supplier_id = s.id WHERE i.user_id = ?` +
    (showPendingReview ? '' : " AND i.status != 'pending_review'") +
    (status ? ` AND i.status IN (${status.split(',').filter(Boolean).map(() => '?').join(',')})` : '') +
    (search ? ' AND (i.invoice_number LIKE ? OR c.name LIKE ? OR s.name LIKE ? OR i.vendor_name LIKE ?)' : '') +
    (docType === 'receipt' ? ' AND i.receipt_number IS NOT NULL' : docType === 'invoice' ? ' AND i.receipt_number IS NULL' : '') +
    (direction === 'incoming' ? " AND i.direction = 'incoming'" : direction === 'outgoing' ? " AND i.direction = 'outgoing'" : '')
  ).bind(...params.slice(0, -2)).first<{ count: number }>();
  return c.json({ data: rows.results, total: countRow?.count || 0, page, limit });
});

// Review endpoint — returns invoice + items + customer + file_id for the review page PDF
invoices.get('/:id/review', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const id = c.req.param('id');
  const invoice = await db.prepare(
    `SELECT i.*, c.name as customer_name, c.email as customer_email, c.address as customer_address,
     f.original_name as file_original_name, f.file_type as file_mime_type
     FROM invoices i
     LEFT JOIN customers c ON i.customer_id = c.id
     LEFT JOIN file_records f ON i.file_id = f.id
     WHERE i.id = ? AND i.user_id = ?`
  ).bind(id, tenantId).first();
  if (!invoice) return c.json({ error: 'Invoice not found' }, 404);
  const items = await db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order').bind(id).all();
  // Also return available customers list for the name dropdown
  const customers = await db.prepare('SELECT id, name, email, address, phone FROM customers WHERE user_id = ? ORDER BY name LIMIT 200').bind(tenantId).all();
  return c.json({ ...invoice, items: items.results, customers: customers.results });
});

invoices.get('/:id', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const id = c.req.param('id');
  const invoice = await db.prepare(
    'SELECT i.*, c.name as customer_name, c.email as customer_email, c.address as customer_address FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id WHERE i.id = ? AND i.user_id = ?'
  ).bind(id, tenantId).first();
  if (!invoice) return c.json({ error: 'Invoice not found' }, 404);
  const items = await db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order').bind(id).all();
  return c.json({ ...invoice, items: items.results });
});

const itemSchema = z.object({
  product_id: z.string().optional(), description: z.string().min(1), quantity: z.number(),
  unit_price: z.number(), amount: z.number(), sort_order: z.number().optional(),
});

const createSchema = z.object({
  invoice_number: z.string().optional(), customer_id: z.string().min(1), supplier_id: z.string().optional(),
  issue_date: z.string(), due_date: z.string(), status: z.string().optional(), direction: z.enum(['incoming', 'outgoing']).optional(),
  currency: z.string().optional(), tax_rate: z.number().optional(), discount_amount: z.number().optional(),
  notes: z.string().optional(), terms: z.string().optional(),
  receipt_number: z.string().optional(), paid_date: z.string().optional(),
  attn: z.string().optional(), customer_phone: z.string().optional(),
  customer_email: z.string().optional(), customer_address: z.string().optional(),
  items: z.array(itemSchema).min(1),
});

invoices.post('/', zValidator('json', createSchema), async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const data = c.req.valid('json');
  const id = `i-${uuidv4().slice(0, 8)}`;

  const invoice_number = data.invoice_number || await generateInvoiceNumber(db, tenantId);

  // Step 7: duplicate invoice number detection
  if (data.invoice_number) {
    const dupInv = await db.prepare('SELECT id FROM invoices WHERE user_id = ? AND invoice_number = ?')
      .bind(tenantId, data.invoice_number).first<{ id: string }>();
    if (dupInv) return c.json({ error: `Invoice number ${data.invoice_number} already exists`, existing_id: dupInv.id }, 409);
  }

  const subtotal = data.items.reduce((sum, item) => sum + item.amount, 0);
  const taxRate = data.tax_rate || 0;
  const taxAmount = subtotal * (taxRate / 100);
  const discount = data.discount_amount || 0;
  const total = subtotal + taxAmount - discount;

  // Auto-fill BR number from company settings
  const company = await db.prepare('SELECT br_number FROM company_settings WHERE user_id = ?').bind(tenantId).first<{ br_number: string }>();
  const brNumber = company?.br_number || null;

  await db.prepare(
    `INSERT INTO invoices (id, user_id, invoice_number, customer_id, supplier_id, status, issue_date, due_date, subtotal, tax_rate, tax_amount, discount_amount, total, currency, notes, terms, receipt_number, paid_date, direction) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, tenantId, invoice_number, data.customer_id, data.supplier_id || null, data.status || 'draft', data.issue_date, data.due_date, subtotal, taxRate, taxAmount, discount, total, data.currency || 'HKD', data.notes || null, data.terms || null, data.receipt_number || null, data.paid_date || null, data.direction || 'outgoing').run();

  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i];
    await db.prepare(
      'INSERT INTO invoice_items (id, invoice_id, product_id, description, quantity, unit_price, amount, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(`ii-${uuidv4().slice(0, 8)}`, id, item.product_id || null, item.description, item.quantity, item.unit_price, item.amount, item.sort_order || i).run();
  }

  await db.prepare('INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, changes) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(`al-${uuidv4().slice(0, 8)}`, user.id, 'create', 'invoice', id, JSON.stringify({ invoice_number: data.invoice_number, total })).run();

  await ensureProducts(db, user.id, data.items);

  const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first();
  const items = await db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order').bind(id).all();
  return c.json({ ...invoice, items: items.results }, 201);
});

// Generate a draft invoice pre-filled from a bank credit transaction (Step 4)
invoices.post('/generate-from-transaction', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const body = await c.req.json<{ transaction_id: string }>();
  const { transaction_id } = body;
  if (!transaction_id) return c.json({ error: 'transaction_id required' }, 400);

  const tx = await db.prepare(
    'SELECT id, description, deposit_amount, transaction_date, invoice_id FROM bank_transactions WHERE id = ? AND user_id = ?'
  ).bind(transaction_id, tenantId).first<{ id: string; description: string; deposit_amount: number; transaction_date: string; invoice_id: string | null }>();
  if (!tx) return c.json({ error: 'Transaction not found' }, 404);
  if (tx.invoice_id) return c.json({ error: 'Transaction already linked to an invoice', invoice_id: tx.invoice_id }, 409);
  if (!tx.deposit_amount || tx.deposit_amount <= 0) return c.json({ error: 'Only credit (deposit) transactions can generate invoices' }, 400);

  // Extract a customer name from the description
  // e.g. "INWARD REMITTANCE-KONICA MINOLTA HK" → "Konica Minolta HK"
  // e.g. "TRANSFER FROM ACME CORP LTD" → "Acme Corp Ltd"
  function extractCustomerName(desc: string): string {
    const cleaned = desc
      .replace(/^(INWARD REMITTANCE[-\s]+|TRANSFER FROM[-\s]+|CREDIT[-\s]+|PAYMENT FROM[-\s]+|FPS[-\s]+FROM[-\s]+|FPS[-\s]+|TT[-\s]+FROM[-\s]+)/i, '')
      .replace(/[-_/|]+/g, ' ')
      .replace(/\b(LTD|LIMITED|CO|CORP|COMPANY|HK|HONG KONG)\b/gi, (m) => m[0].toUpperCase() + m.slice(1).toLowerCase())
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  }

  const customerName = extractCustomerName(tx.description);

  // Match or auto-create customer
  let customerId: string | null = null;
  const existCust = await db.prepare('SELECT id FROM customers WHERE user_id = ? AND name LIKE ? LIMIT 1')
    .bind(tenantId, `%${customerName}%`).first<{ id: string }>();
  if (existCust) {
    customerId = existCust.id;
  } else {
    customerId = `c-${uuidv4().slice(0, 8)}`;
    await db.prepare('INSERT INTO customers (id, user_id, name, is_active) VALUES (?, ?, ?, 1)')
      .bind(customerId, tenantId, customerName).run();
  }

  const invoiceNumber = await generateInvoiceNumber(db, tenantId);
  const id = `i-${uuidv4().slice(0, 8)}`;
  const issueDate = tx.transaction_date;
  const dueDate = tx.transaction_date; // already received
  const amount = tx.deposit_amount;
  const description = tx.description;

  await db.prepare(
    `INSERT INTO invoices (id, user_id, invoice_number, customer_id, status, issue_date, due_date, subtotal, tax_rate, tax_amount, discount_amount, total, currency, notes)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, 0, 0, 0, ?, 'HKD', ?)`
  ).bind(id, tenantId, invoiceNumber, customerId, issueDate, dueDate, amount, amount, `Auto-generated from bank transaction: ${description}`).run();

  await db.prepare(
    'INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, amount, sort_order) VALUES (?, ?, ?, 1, ?, ?, 0)'
  ).bind(`ii-${uuidv4().slice(0, 8)}`, id, description, amount, amount).run();

  // Link transaction to invoice
  await db.prepare('UPDATE bank_transactions SET invoice_id = ?, match_status = ? WHERE id = ?')
    .bind(id, 'matched', transaction_id).run();

  await db.prepare('INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, changes) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(`al-${uuidv4().slice(0, 8)}`, user.id, 'create', 'invoice', id, JSON.stringify({ source: 'bank_transaction', transaction_id, invoice_number: invoiceNumber })).run();

  const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first();
  const items = await db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order').bind(id).all();
  return c.json({ ...invoice, items: items.results, customer_name: customerName }, 201);
});

// Full update (PUT) for invoice edit page
invoices.put('/:id', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const id = c.req.param('id');
  const existing = await db.prepare('SELECT id FROM invoices WHERE id = ? AND user_id = ?').bind(id, tenantId).first();
  if (!existing) return c.json({ error: 'Invoice not found' }, 404);

  const data = await c.req.json<any>();
  const subtotal = (data.items || []).reduce((s: number, it: any) => s + (it.amount || 0), 0);
  const taxRate = data.tax_rate || 0;
  const taxAmount = subtotal * (taxRate / 100);
  const discount = data.discount_amount || 0;
  const total = subtotal + taxAmount - discount;

  await db.prepare(
    `UPDATE invoices SET invoice_number=?, customer_id=?, supplier_id=?, status=?, issue_date=?, due_date=?, subtotal=?, tax_rate=?, tax_amount=?, discount_amount=?, total=?, currency=?, notes=?, terms=?, receipt_number=?, paid_date=?, attn=?, customer_phone=?, customer_email=?, customer_address=?, direction=?, updated_at=datetime('now') WHERE id=? AND user_id=?`
  ).bind(data.invoice_number, data.customer_id, data.supplier_id || null, data.status || 'draft', data.issue_date, data.due_date, subtotal, taxRate, taxAmount, discount, total, data.currency || 'HKD', data.notes || null, data.terms || null, data.receipt_number || null, data.paid_date || null, data.attn || null, data.customer_phone || null, data.customer_email || null, data.customer_address || null, data.direction || null, id, tenantId).run();

  // Replace line items
  await db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').bind(id).run();
  for (let i = 0; i < (data.items || []).length; i++) {
    const item = data.items[i];
    await db.prepare('INSERT INTO invoice_items (id, invoice_id, product_id, description, quantity, unit_price, amount, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(`ii-${uuidv4().slice(0, 8)}`, id, item.product_id || null, item.description, item.quantity, item.unit_price, item.amount, item.sort_order ?? i).run();
  }

  const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first();
  const items = await db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order').bind(id).all();
  return c.json({ ...invoice, items: items.results });
});

// Confirm review: promote pending_review → draft (user has validated the data)
invoices.post('/:id/confirm', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const id = c.req.param('id');

  const existing = await db.prepare('SELECT id, status, invoice_number, receipt_number FROM invoices WHERE id = ? AND user_id = ?').bind(id, tenantId).first<{ id: string; status: string; invoice_number: string; receipt_number: string | null }>();
  if (!existing) return c.json({ error: 'Invoice not found' }, 404);

  // Detect if this is a receipt (invoice_number starts with REC- OR receipt_number already set)
  const isReceipt = existing.invoice_number?.startsWith('REC-') || !!existing.receipt_number;

  // Accept data overrides from body (user may have edited fields on review page)
  let body: any = {};
  try { body = await c.req.json(); } catch {}

  const subtotal = (body.items || []).reduce((s: number, it: any) => s + (it.amount || 0), 0) || undefined;
  const taxRate = body.tax_rate ?? 0;
  const taxAmount = subtotal !== undefined ? subtotal * (taxRate / 100) : undefined;
  const discount = body.discount_amount ?? 0;
  const total = subtotal !== undefined ? subtotal + (taxAmount ?? 0) - discount : undefined;

  // Build dynamic SET clause
  const sets: string[] = ["status = 'draft'", "updated_at = datetime('now')"];
  const params: any[] = [];
  const fieldMap: Record<string, any> = {
    // For receipts: invoice_number stays as REC-xxx (never update it — avoid UNIQUE clash).
    // Instead store the human receipt number in receipt_number column.
    ...(isReceipt
      ? { receipt_number: body.invoice_number || body.receipt_number }  // form.invoice_number holds the displayed receipt number
      : { invoice_number: body.invoice_number }),                        // real invoice: update invoice_number normally
    customer_id: body.customer_id,
    supplier_id: body.supplier_id,
    direction: body.direction,
    issue_date: body.issue_date,
    due_date: body.due_date,
    currency: body.currency,
    notes: body.notes,
    terms: body.terms,
    vendor_name: body.vendor_name,
  };
  for (const [col, val] of Object.entries(fieldMap)) {
    if (val !== undefined && val !== null && val !== '') { sets.push(`${col} = ?`); params.push(val); }
  }
  if (subtotal !== undefined) { sets.push('subtotal = ?', 'tax_rate = ?', 'tax_amount = ?', 'discount_amount = ?', 'total = ?'); params.push(subtotal, taxRate, taxAmount, discount, total); }
  params.push(id, tenantId);

  await db.prepare(`UPDATE invoices SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...params).run();

  // Replace line items if provided
  if (body.items && Array.isArray(body.items) && body.items.length > 0) {
    await db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').bind(id).run();
    for (let i = 0; i < body.items.length; i++) {
      const item = body.items[i];
      await db.prepare('INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, amount, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(`ii-${uuidv4().slice(0, 8)}`, id, item.description, item.quantity ?? 1, item.unit_price ?? 0, item.amount ?? 0, i).run();
    }
  }

  await db.prepare('INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, changes) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(`al-${uuidv4().slice(0, 8)}`, user.id, 'confirm_review', 'invoice', id, JSON.stringify({ previous_status: existing.status })).run();

  const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first();
  const items = await db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order').bind(id).all();
  return c.json({ ...invoice, items: items.results });
});

invoices.patch('/:id/status', zValidator('json', z.object({ status: z.string() })), async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const id = c.req.param('id');
  const { status } = c.req.valid('json');
  const existing = await db.prepare('SELECT id FROM invoices WHERE id = ? AND user_id = ?').bind(id, tenantId).first();
  if (!existing) return c.json({ error: 'Invoice not found' }, 404);
  await db.prepare('UPDATE invoices SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').bind(status, id).run();
  const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first();
  return c.json(invoice);
});

invoices.delete('/:id', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const id = c.req.param('id');

  const existing = await db.prepare(
    'SELECT id, customer_id, supplier_id, file_id FROM invoices WHERE id = ? AND user_id = ?'
  ).bind(id, tenantId).first<{ id: string; customer_id: string | null; supplier_id: string | null; file_id: string | null }>();
  if (!existing) return c.json({ error: 'Invoice not found' }, 404);

  // Break circular FK: NULL out any linked_invoice_id references to this invoice
  await db.prepare('UPDATE invoices SET linked_invoice_id = NULL WHERE linked_invoice_id = ?').bind(id).run();

  // Delete the invoice (invoice_items cascade via FK)
  await db.prepare('DELETE FROM invoices WHERE id = ? AND user_id = ?').bind(id, tenantId).run();

  // Also remove the linked file from File Storage so it doesn't linger after discard
  if (existing.file_id) {
    await db.prepare('DELETE FROM file_records WHERE id = ? AND user_id = ?')
      .bind(existing.file_id, tenantId).run();
  }

  // Clean up orphaned customer — delete only if no other invoices reference this customer
  if (existing.customer_id) {
    const otherInvoices = await db.prepare(
      'SELECT COUNT(*) as cnt FROM invoices WHERE user_id = ? AND customer_id = ?'
    ).bind(tenantId, existing.customer_id).first<{ cnt: number }>();
    if ((otherInvoices?.cnt || 0) === 0) {
      await db.prepare('DELETE FROM customers WHERE id = ? AND user_id = ?')
        .bind(existing.customer_id, tenantId).run();
    }
  }

  // Clean up orphaned supplier — delete only if no other invoices reference this supplier
  if (existing.supplier_id) {
    const otherInvoices = await db.prepare(
      'SELECT COUNT(*) as cnt FROM invoices WHERE user_id = ? AND supplier_id = ?'
    ).bind(tenantId, existing.supplier_id).first<{ cnt: number }>();
    if ((otherInvoices?.cnt || 0) === 0) {
      await db.prepare('DELETE FROM suppliers WHERE id = ? AND user_id = ?')
        .bind(existing.supplier_id, tenantId).run();
    }
  }

  return c.json({ success: true });
});

export { invoices as invoiceRoutes };
