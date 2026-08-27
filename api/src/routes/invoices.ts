import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { v4 as uuidv4 } from 'uuid';
import { Bindings, Variables } from '../types';
import { authMiddleware } from '../middleware/auth';
import { ensureProducts } from '../lib/auto-product';
import { generateInvoiceNumber, generateReceiptNumber } from '../lib/numbering';
import { tryPostInvoiceToGl, postInvoiceToGl } from '../lib/post-invoice';
import { jeLive } from '../lib/journal-filters';
import { tombstoneInvoiceJournal } from '../lib/invoice-journal';
import { findParentAccountError } from '../lib/account-guard';
import { checkPeriodOpen } from '../lib/period-guard';
import { postPaymentToGl, resolveInvoiceHoldingAccount } from '../lib/post-payment';
import { fuzzyMatchCompany } from '../lib/company-matcher';

// 1 when the invoice already has a live GL entry, else NULL. Lets the UI offer a
// persistent "Post to GL" control for anything still unposted, instead of the
// old button that only appeared for a moment after saving a review.
const POSTED_TO_GL_SELECT = `(SELECT 1 FROM journal_entries je
  WHERE je.reference_type = 'invoice' AND je.reference_id = i.id AND ${jeLive()} LIMIT 1) AS posted_to_gl`;

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
  const expenseCategory = c.req.query('expense_category') || ''; // 'cash' | 'reimburse' | 'director' | ''
  const startDate = c.req.query('start_date') || '';
  const endDate = c.req.query('end_date') || '';
  const highlightId = c.req.query('highlight_id') || '';

  // Default: exclude pending_review unless explicitly requested
  const showPendingReview = status === 'pending_review';
  let query = `SELECT i.*, c.name as customer_name, c.company_name as customer_company, s.name as supplier_name, ${POSTED_TO_GL_SELECT} FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id LEFT JOIN suppliers s ON i.supplier_id = s.id WHERE i.user_id = ? AND i.deleted_at IS NULL`;
  if (!showPendingReview) query += " AND i.status != 'pending_review'";
  const params: any[] = [tenantId];
  if (status) { const statuses = status.split(',').filter(Boolean); query += ` AND i.status IN (${statuses.map(() => '?').join(',')})`; params.push(...statuses); }
  if (search) { query += ' AND (i.invoice_number LIKE ? OR c.name LIKE ? OR s.name LIKE ? OR i.vendor_name LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
  // doc_type filter: receipt = has receipt_number, invoice = no receipt_number
  if (docType === 'receipt') { query += ' AND i.receipt_number IS NOT NULL'; }
  else if (docType === 'invoice') { query += ' AND i.receipt_number IS NULL'; }
  if (direction === 'incoming') { query += " AND i.direction = 'incoming'"; }
  else if (direction === 'outgoing') { query += " AND i.direction = 'outgoing'"; }
  if (expenseCategory) { query += ' AND i.expense_category = ?'; params.push(expenseCategory); }
  if (startDate) { query += ' AND i.issue_date >= ?'; params.push(startDate); }
  if (endDate) { query += ' AND i.issue_date <= ?'; params.push(endDate); }
  query += ' ORDER BY i.created_at DESC, i.id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = await db.prepare(query).bind(...params).all();
  // Build count query with same filters (minus LIMIT/OFFSET)
  let countQuery = `SELECT COUNT(*) as count FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id LEFT JOIN suppliers s ON i.supplier_id = s.id WHERE i.user_id = ? AND i.deleted_at IS NULL` +
    (showPendingReview ? '' : " AND i.status != 'pending_review'") +
    (status ? ` AND i.status IN (${status.split(',').filter(Boolean).map(() => '?').join(',')})` : '') +
    (search ? ' AND (i.invoice_number LIKE ? OR c.name LIKE ? OR s.name LIKE ? OR i.vendor_name LIKE ?)' : '') +
    (docType === 'receipt' ? ' AND i.receipt_number IS NOT NULL' : docType === 'invoice' ? ' AND i.receipt_number IS NULL' : '') +
    (direction === 'incoming' ? " AND i.direction = 'incoming'" : direction === 'outgoing' ? " AND i.direction = 'outgoing'" : '') +
    (expenseCategory ? ' AND i.expense_category = ?' : '') +
    (startDate ? ' AND i.issue_date >= ?' : '') +
    (endDate ? ' AND i.issue_date <= ?' : '');
  const countParams = params.slice(0, -2); // remove LIMIT/OFFSET
  const countRow = await db.prepare(countQuery).bind(...countParams).first<{ count: number }>();
  let highlight_page: number | null = null;
  if (highlightId) {
    const target = await db.prepare(
      'SELECT id, created_at FROM invoices WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    ).bind(highlightId, tenantId).first<{ id: string; created_at: string }>();
    if (target) {
      let hlQuery = 'SELECT COUNT(*) as cnt FROM invoices i WHERE i.user_id = ? AND i.deleted_at IS NULL' +
        " AND i.status != 'pending_review'" +
        (docType === 'receipt' ? ' AND i.receipt_number IS NOT NULL' : docType === 'invoice' ? ' AND i.receipt_number IS NULL' : '') +
        (direction === 'incoming' ? " AND i.direction = 'incoming'" : direction === 'outgoing' ? " AND i.direction = 'outgoing'" : '') +
        ' AND (i.created_at > ? OR (i.created_at = ? AND i.id > ?))';
      const hlParams: unknown[] = [tenantId, target.created_at, target.created_at, target.id];
      const hlRow = await db.prepare(hlQuery).bind(...hlParams).first<{ cnt: number }>();
      if (hlRow) highlight_page = Math.floor((hlRow.cnt || 0) / limit) + 1;
    }
  }

  return c.json({ data: rows.results, total: countRow?.count || 0, page, limit, highlight_page });
});

// Review endpoint — returns invoice + items + customer + file_id for the review page PDF
invoices.get('/:id/review', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const id = c.req.param('id');
  const invoice = await db.prepare(
    `SELECT i.*, c.name as customer_name, c.email as customer_email, c.address as customer_address,
     f.original_name as file_original_name, f.file_type as file_mime_type,
     ${POSTED_TO_GL_SELECT}
     FROM invoices i
     LEFT JOIN customers c ON i.customer_id = c.id
     LEFT JOIN file_records f ON i.file_id = f.id
     WHERE i.id = ? AND i.user_id = ? AND i.deleted_at IS NULL`
  ).bind(id, tenantId).first();
  if (!invoice) return c.json({ error: 'Invoice not found' }, 404);
  const items = await db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order').bind(id).all();
  // Also return available customers list for the name dropdown
  const customers = await db.prepare('SELECT id, name, email, address, phone FROM customers WHERE user_id = ? ORDER BY name LIMIT 200').bind(tenantId).all();
  return c.json({ ...invoice, items: items.results, customers: customers.results });
});

async function invoiceDetailPayload(db: any, tenantId: string, id: string) {
  const invoice = await db.prepare(
    'SELECT i.*, c.name as customer_name, c.email as customer_email, c.address as customer_address FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id WHERE i.id = ? AND i.user_id = ? AND i.deleted_at IS NULL'
  ).bind(id, tenantId).first();
  if (!invoice) return null;
  const items = await db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order').bind(id).all();

  // Linked bank transactions — both link paths:
  //   direct: bank_transactions.invoice_id = this invoice (classic 1:1 match)
  //   group:  bank_transaction_invoice_links junction row (1:N combined payment slice)
  const links = await db.prepare(
    `SELECT bt.id, bt.transaction_date, bt.description, bt.deposit_amount, bt.withdrawal_amount,
            bt.match_status, bt.match_confidence, bs.bank_name,
            NULL AS allocated_amount, 'direct' AS link_type
     FROM bank_transactions bt
     LEFT JOIN bank_statements bs ON bt.bank_statement_id = bs.id
     WHERE bt.invoice_id = ? AND bt.user_id = ? AND bt.deleted_at IS NULL
     UNION ALL
     SELECT bt.id, bt.transaction_date, bt.description, bt.deposit_amount, bt.withdrawal_amount,
            bt.match_status, bt.match_confidence, bs.bank_name,
            btil.allocated_amount, 'group' AS link_type
     FROM bank_transaction_invoice_links btil
     JOIN bank_transactions bt ON btil.transaction_id = bt.id
     LEFT JOIN bank_statements bs ON bt.bank_statement_id = bs.id
     WHERE btil.invoice_id = ? AND bt.user_id = ? AND bt.deleted_at IS NULL`
  ).bind(id, tenantId, id, tenantId).all();

  const txIds: string[] = links.results.map((r: any) => r.id);

  // Payment voucher numbers: the payment-leg JE per settling transaction
  const paymentVouchers: Record<string, string> = {};
  if (txIds.length > 0) {
    const ph = txIds.map(() => '?').join(',');
    const jes = await db.prepare(
      `SELECT reference_id, entry_number FROM journal_entries
       WHERE user_id = ? AND deleted_at IS NULL AND reference_type = 'payment' AND reference_id IN (${ph})`
    ).bind(tenantId, ...txIds).all();
    for (const je of jes.results as any[]) paymentVouchers[je.reference_id] = je.entry_number;
  }

  const linked_transactions = links.results.map((r: any) => ({
    id: r.id,
    transaction_date: r.transaction_date,
    description: r.description,
    bank_name: r.bank_name,
    amount: r.deposit_amount > 0 ? r.deposit_amount : Math.abs(r.withdrawal_amount || 0),
    allocated_amount: r.allocated_amount,
    match_status: r.match_status,
    match_confidence: r.match_confidence,
    link_type: r.link_type,
    payment_voucher_no: paymentVouchers[r.id] || null,
  }));

  // Live journal entries touching this invoice:
  //   invoice leg: reference_type='invoice' AND reference_id=<invoice id>
  //   payment leg: reference_type='payment' AND reference_id IN <linked tx ids>
  const invoiceLegs = await db.prepare(
    `SELECT id, entry_number, entry_date, description, reference_type, reference_id, status, entry_source
     FROM journal_entries WHERE user_id = ? AND deleted_at IS NULL AND reference_type = 'invoice' AND reference_id = ?`
  ).bind(tenantId, id).all();
  let paymentLegs: any[] = [];
  if (txIds.length > 0) {
    const phTx = txIds.map(() => '?').join(',');
    const res = await db.prepare(
      `SELECT id, entry_number, entry_date, description, reference_type, reference_id, status, entry_source
       FROM journal_entries WHERE user_id = ? AND deleted_at IS NULL AND reference_type = 'payment' AND reference_id IN (${phTx})`
    ).bind(tenantId, ...txIds).all();
    paymentLegs = res.results as any[];
  }
  const entries = [...(invoiceLegs.results as any[]), ...paymentLegs];

  let journal_entries: any[] = [];
  if (entries.length > 0) {
    const ePh = entries.map(() => '?').join(',');
    const linesRes = await db.prepare(
      `SELECT jl.entry_id, jl.account_code, jl.account_name, jl.debit, jl.credit,
              a.account_type AS account_type
       FROM journal_lines jl
       LEFT JOIN accounts a ON a.account_code = jl.account_code AND a.user_id = ?
       WHERE jl.entry_id IN (${ePh})
       ORDER BY jl.sort_order`
    ).bind(tenantId, ...entries.map(e => e.id)).all();
    const byEntry: Record<string, any[]> = {};
    for (const l of linesRes.results as any[]) {
      if (!byEntry[l.entry_id]) byEntry[l.entry_id] = [];
      byEntry[l.entry_id].push(l);
    }
    journal_entries = entries.map(e => ({ ...e, lines: byEntry[e.id] || [] }));
  }

  // Receipt link: linked_invoice_id points at a receipt row (binary link, no status)
  let linked_receipt: { id: string; invoice_number: string; total: number; issue_date: string } | null = null;
  if (invoice.linked_invoice_id) {
    const rid = String(invoice.linked_invoice_id).split(',')[0].trim();
    const r = await db.prepare(
      `SELECT id, invoice_number, total, issue_date FROM invoices
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL
         AND (receipt_number IS NOT NULL OR invoice_number LIKE 'REC-%')`
    ).bind(rid, tenantId).first() as { id: string; invoice_number: string; total: number; issue_date: string } | null;
    if (r) linked_receipt = r;
  }

  return { ...invoice, items: items.results, linked_transactions, journal_entries, linked_receipt };
}

invoices.get('/:id', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const payload = await invoiceDetailPayload(c.env.DB, tenantId, c.req.param('id'));
  if (!payload || (payload as any).error === 'Invoice not found') return c.json({ error: 'Invoice not found' }, 404);
  return c.json(payload);
});

async function payingTransactionIds(db: any, tenantId: string, invoiceId: string): Promise<string[]> {
  const res = await db.prepare(
    `SELECT DISTINCT bt.id FROM bank_transactions bt
     LEFT JOIN bank_transaction_invoice_links l ON l.transaction_id = bt.id
     WHERE bt.user_id = ? AND bt.match_status = 'confirmed' AND bt.deleted_at IS NULL
       AND (bt.invoice_id = ? OR l.invoice_id = ?)`
  ).bind(tenantId, invoiceId, invoiceId).all();
  return (res.results as any[]).map(r => r.id);
}

/**
 * Regenerate confirmed payment legs after a holding-account change. Every
 * confirmed payer of this invoice is rebuilt. Reuses the idempotent posters:
 * tombstone the live payment JE, then re-run postPaymentToGl.
 */
async function propagateHoldingChange(db: any, tenantId: string, invoiceId: string): Promise<void> {
  const txIds = await payingTransactionIds(db, tenantId, invoiceId);
  for (const txId of txIds) {
    const je = await db.prepare(
      `SELECT je.id FROM journal_entries je
       WHERE je.reference_type = 'payment' AND je.reference_id = ? AND je.user_id = ? AND ${jeLive('je')}`
    ).bind(txId, tenantId).first() as { id: string } | null;
    if (je) {
      await db.prepare(
        `UPDATE journal_entries SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND user_id = ?`
      ).bind(je.id, tenantId).run();
    }
    const repost = await postPaymentToGl(db, tenantId, txId);
    if (repost.error) console.error(`[invoice-posting] failed to rebuild payment leg for tx ${txId}: ${repost.error}`);
  }
}

// PUT /invoices/:id/posting — rewrite the live invoice JE's label+holding pair
// (entry_source='manual'), propagating holding changes to confirmed payment legs.
invoices.put('/:id/posting', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({})) as any;

  const inv = await db.prepare(
    'SELECT * FROM invoices WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(id, tenantId).first<any>();
  if (!inv) return c.json({ error: 'Invoice not found' }, 404);

  // Current live invoice JE (must exist — editing implies posted)
  const live = await db.prepare(
    `SELECT id, entry_number, entry_date, description FROM journal_entries
     WHERE reference_type = 'invoice' AND reference_id = ? AND user_id = ? AND ${jeLive('journal_entries')}`
  ).bind(id, tenantId).first<{ id: string; entry_number: string; entry_date: string; description: string }>();
  if (!live) return c.json({ error: 'Invoice is not posted to GL yet' }, 409);

  if (!(await checkPeriodOpen(db, tenantId, live.entry_date))) {
    return c.json({ error: 'Cannot change posting in a closed period' }, 409);
  }

  if (body.reset_to_auto === true) {
    // Pre-validate EVERY confirmed paying transaction's parent statement BEFORE writing anything.
    const resetTxIds = await payingTransactionIds(db, tenantId, id);
    for (const txId of resetTxIds) {
      const st = await db.prepare(
        `SELECT bs.status FROM bank_transactions bt JOIN bank_statements bs ON bt.bank_statement_id = bs.id WHERE bt.id = ?`
      ).bind(txId).first<{ status: string }>();
      if (st && st.status !== 'active') {
        return c.json({ error: 'A settling statement is reconciled — reopen reconciliation before resetting this posting' }, 409);
      }
    }
    await db.prepare(
      `UPDATE journal_entries SET deleted_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`
    ).bind(live.id, tenantId).run();
    const repost = await postInvoiceToGl(db, tenantId, id);
    if (repost.error || repost.not_postable || repost.already_posted) {
      return c.json({ error: repost.error || `Cannot re-post (status ${repost.not_postable})` }, 409);
    }
    await propagateHoldingChange(db, tenantId, id);
    await db.prepare('INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, changes) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(`al-${uuidv4().slice(0, 8)}`, user.id, 'reset_posting', 'invoice', id, JSON.stringify({ previous_entry: live.entry_number })).run();
    return c.json({ ok: true });
  }

  const labelCode = String(body.label_account_code ?? '');
  const holdingCode = String(body.holding_account_code ?? '');
  if (!labelCode || !holdingCode) return c.json({ error: 'Both label and holding accounts are required' }, 400);
  if (labelCode === holdingCode) return c.json({ error: 'Label and holding accounts must differ' }, 400);

  const acctRows = await db.prepare(
    `SELECT account_code, account_name, account_type FROM accounts
     WHERE user_id = ? AND account_code IN (?, ?) AND is_active = 1`
  ).bind(tenantId, labelCode, holdingCode).all();
  const byCode = new Map((acctRows.results as any[]).map(r => [r.account_code, r]));
  const label = byCode.get(labelCode);
  const holding = byCode.get(holdingCode);
  if (!label) return c.json({ error: `Label account ${labelCode} not found` }, 400);
  if (!holding) return c.json({ error: `Holding account ${holdingCode} not found` }, 400);
  if (!(label.account_type === 'revenue' || label.account_type === 'expense')) {
    return c.json({ error: 'Label account must be a revenue or expense account' }, 400);
  }
  if (!(holding.account_type === 'asset' || holding.account_type === 'liability')) {
    return c.json({ error: 'Holding account must be an asset or liability account' }, 400);
  }
  const leafErr = (await findParentAccountError(db, tenantId, labelCode))
    || (await findParentAccountError(db, tenantId, holdingCode));
  if (leafErr) return c.json({ error: leafErr }, 400);

  const prevHolding = await resolveInvoiceHoldingAccount(db, tenantId, id);
  const prevLabelRow = await db.prepare(
    `SELECT jl.account_code FROM journal_lines jl
     JOIN accounts a ON a.user_id = ? AND a.account_code = jl.account_code
     WHERE jl.entry_id = ? AND a.account_type IN ('revenue','expense')
     ORDER BY (CASE WHEN jl.debit > 0 THEN jl.debit ELSE jl.credit END) DESC LIMIT 1`
  ).bind(tenantId, live.id).first<{ account_code: string }>();
  const prevLabelCodeValue = prevLabelRow?.account_code || null;
  const holdingChanged = prevHolding.code !== holdingCode;

  // Pre-validate EVERY confirmed paying transaction's parent statement BEFORE writing anything.
  const payTxIds = await payingTransactionIds(db, tenantId, id);
  if (holdingChanged && payTxIds.length > 0) {
    for (const txId of payTxIds) {
      const st = await db.prepare(
        `SELECT bs.status FROM bank_transactions bt JOIN bank_statements bs ON bt.bank_statement_id = bs.id WHERE bt.id = ?`
      ).bind(txId).first<{ status: string }>();
      if (st && st.status !== 'active') {
        return c.json({ error: 'A settling statement is reconciled — reopen reconciliation before changing the holding account' }, 409);
      }
    }
  }

  // Fresh manual JE (new -R suffix: UNIQUE(user_id, entry_number) holds for tombstoned rows)
  const baseNum = `JE-INV-${inv.invoice_number}`;
  const numRows = await db.prepare(
    `SELECT entry_number FROM journal_entries WHERE user_id = ? AND entry_number LIKE ?`
  ).bind(tenantId, `${baseNum}-R%`).all();
  let maxR = 1;
  for (const r of numRows.results as any[]) {
    const m = /-R(\d+)$/.exec(r.entry_number);
    if (m) maxR = Math.max(maxR, parseInt(m[1], 10));
  }
  const jeId = `je-${uuidv4().slice(0, 8)}`;
  const jeNum = `${baseNum}-R${maxR + 1}`;
  const lineIns = 'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?,?,?,?,?,?,?,?)';
  const isIncoming = inv.direction === 'incoming';
  // One D1 batch = tombstone + entry + both lines land atomically
  await db.batch([
    db.prepare(
      `UPDATE journal_entries SET deleted_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
    ).bind(live.id, tenantId),
    db.prepare(
      'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id, entry_source) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(jeId, tenantId, jeNum, live.entry_date, live.description || '', 'invoice', id, 'manual'),
    isIncoming
      ? db.prepare(lineIns).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, labelCode, label.account_name, inv.invoice_number, inv.total, 0, 0)
      : db.prepare(lineIns).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, holdingCode, holding.account_name, inv.invoice_number, inv.total, 0, 0),
    isIncoming
      ? db.prepare(lineIns).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, holdingCode, holding.account_name, inv.invoice_number, 0, inv.total, 1)
      : db.prepare(lineIns).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, labelCode, label.account_name, inv.invoice_number, 0, inv.total, 1),
  ]);

  if (holdingChanged) await propagateHoldingChange(db, tenantId, id);

  await db.prepare('INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, changes) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(`al-${uuidv4().slice(0, 8)}`, user.id, 'update_posting', 'invoice', id, JSON.stringify({
      previous_entry: live.entry_number, new_entry: jeNum,
      label: { from: prevLabelCodeValue, to: labelCode },
      holding: { from: prevHolding.code, to: holdingCode },
    })).run();

  return c.json(await invoiceDetailPayload(db, tenantId, id));
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
  expense_category: z.enum(['cash', 'reimburse', 'director']).optional(),
  file_id: z.string().optional(),
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
    `INSERT INTO invoices (id, user_id, invoice_number, customer_id, supplier_id, status, issue_date, due_date, subtotal, tax_rate, tax_amount, discount_amount, total, currency, notes, terms, receipt_number, paid_date, direction, expense_category, file_id, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, tenantId, invoice_number, data.customer_id, data.supplier_id || null, data.status || 'draft', data.issue_date, data.due_date, subtotal, taxRate, taxAmount, discount, total, data.currency || 'HKD', data.notes || null, data.terms || null, data.receipt_number || null, data.paid_date || null, data.direction || 'outgoing', data.expense_category || null, data.file_id || null, data.file_id ? 'manual' : null).run();

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
  const existing = await db.prepare('SELECT id FROM invoices WHERE id = ? AND user_id = ? AND deleted_at IS NULL').bind(id, tenantId).first();
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

  const existing = await db.prepare('SELECT id, status, invoice_number, receipt_number FROM invoices WHERE id = ? AND user_id = ? AND deleted_at IS NULL').bind(id, tenantId).first<{ id: string; status: string; invoice_number: string; receipt_number: string | null }>();
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

  // Build dynamic SET clause.
  // Confirming a review finalises the invoice, so it becomes 'active' — the same
  // status a clean OCR import gets. It previously became 'draft', which left a
  // reviewed invoice marked un-issued and therefore ineligible for GL posting.
  const sets: string[] = ["status = 'active'", "updated_at = datetime('now')"];
  const params: any[] = [];
  const fieldMap: Record<string, any> = {
    expense_category: body.expense_category,
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

  // Post the invoice leg to the GL now that it is finalised. Without this the
  // ledger only ever receives the payment leg (posted on bank match-confirm),
  // which drives AR/AP negative. Idempotent and non-fatal — the manual
  // "Post to GL" control remains the recovery path if this fails.
  await tryPostInvoiceToGl(db, tenantId, id);

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
  const existing = await db.prepare('SELECT id FROM invoices WHERE id = ? AND user_id = ? AND deleted_at IS NULL').bind(id, tenantId).first();
  if (!existing) return c.json({ error: 'Invoice not found' }, 404);
  await db.prepare('UPDATE invoices SET status = ?, updated_at = datetime(\'now\') WHERE id = ? AND deleted_at IS NULL').bind(status, id).run();

  // Auto-post to the GL when the status becomes postable (draft→sent, sent→paid,
  // etc.). Mirrors the automatic posting on clean OCR import and review-confirm.
  // Idempotent and non-fatal — the manual "Post to GL" control remains the
  // recovery path if posting fails.
  if (['active', 'sent', 'paid', 'overdue'].includes(status)) {
    await tryPostInvoiceToGl(db, tenantId, id);
  }

  const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first();
  return c.json(invoice);
});

invoices.delete('/:id', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const id = c.req.param('id');

  const existing = await db.prepare(
    'SELECT id, file_id FROM invoices WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(id, tenantId).first<{ id: string; file_id: string | null }>();
  if (!existing) return c.json({ error: 'Invoice not found' }, 404);

  // SOFT DELETE — aligned with the bank statement flow (2026-08-17).
  // Both the invoice AND its linked file are soft-deleted (bank-statement style):
  // they disappear from the lists and appear in the Recycle Bin, restorable for
  // 30 days. Receipt↔invoice links are preserved for restore.
  const now = new Date().toISOString();
  await db.prepare(
    'UPDATE invoices SET deleted_at = ?, deleted_by = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(now, user.id, id, tenantId).run();

  // Tombstone the invoice's ledger entries too — its own entry and any payments
  // settling it. Without this the payment keeps debiting AP (or crediting AR)
  // with no invoice left to offset it, leaving the balance permanently wrong.
  // Mirrors what deleting a bank statement already does for its entries.
  const jeTombstoned = await tombstoneInvoiceJournal(db, tenantId, id, now);

  let fileDeleted = false;
  if (existing.file_id) {
    const fRes = await db.prepare(
      'UPDATE file_records SET deleted_at = ?, deleted_by = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    ).bind(now, user.id, existing.file_id, tenantId).run();
    fileDeleted = (fRes.meta?.changes || 0) > 0;
  }

  await db.prepare('INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, changes) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(`al-${uuidv4().slice(0, 8)}`, user.id, 'soft_delete', 'invoice', id, JSON.stringify({ file_deleted: fileDeleted, journal_entries_tombstoned: jeTombstoned, restorable_until: new Date(Date.now() + 30 * 86400_000).toISOString() })).run();

  return c.json({ success: true, file_deleted: fileDeleted, journal_entries_tombstoned: jeTombstoned, restorable_until: new Date(Date.now() + 30 * 86400_000).toISOString() });
});

// ── Receipt ↔ invoice matching helpers (hardened 2026-08-26) ───────────────
// The pre-fix matcher was amount-only: no direction, no counterparty, no
// guards on confirm — equal amounts cross-linked (ground-truth §4.3 lists
// coincidences that are NOT links) and confirm accepted any two invoice ids.

async function ownCompanyNames(db: D1Database, tenantId: string): Promise<string[]> {
  const row = await db.prepare(
    'SELECT name, legal_name, short_name FROM company_settings WHERE user_id = ?'
  ).bind(tenantId).first<{ name: string | null; legal_name: string | null; short_name: string | null }>();
  const names = [row?.name, row?.legal_name, row?.short_name].filter((s): s is string => !!s?.trim());
  if (names.length === 0) {
    const u = await db.prepare('SELECT company_name FROM users WHERE id = ?').bind(tenantId).first<{ company_name: string | null }>();
    if (u?.company_name?.trim()) names.push(u.company_name);
  }
  return names;
}

/** Preferred invoice direction for a receipt (same cascade as the import
 *  auto-link): payer≈own → incoming; issuer≈own → outgoing; neither≈own →
 *  incoming (a third party's receipt in our books is one they issued to us). */
function receiptPrefDirection(
  payerName: string | null,
  issuerName: string | null,
  ownNames: string[],
): 'incoming' | 'outgoing' | null {
  const score = (n: string | null) =>
    n && ownNames.length > 0 ? (fuzzyMatchCompany(n, ownNames, { topN: 1, minScore: 50 })?.best?.score ?? 0) : 0;
  if (score(payerName) >= 70) return 'incoming';
  if (score(issuerName) >= 70) return 'outgoing';
  if (issuerName || payerName) return 'incoming';
  return null;
}

/** The non-own name on a receipt — the counterparty to rank candidates against. */
function receiptCounterpartyName(
  payerName: string | null,
  issuerName: string | null,
  ownNames: string[],
): string | null {
  const score = (n: string | null) =>
    n && ownNames.length > 0 ? (fuzzyMatchCompany(n, ownNames, { topN: 1, minScore: 50 })?.best?.score ?? 0) : 0;
  if (score(payerName) >= 70) return issuerName;
  if (score(issuerName) >= 70) return payerName;
  return issuerName || payerName;
}

/** Exact-sum subset over same-direction unpaid invoices (combined-payment
 *  receipts covering 2-3 invoices). Mirrors bank-matcher's subset search. */
function receiptSubsetSum(
  pool: { id: string; invoice_number: string; total: number }[],
  size: number,
  start: number,
  target: number,
  acc: { id: string; invoice_number: string; total: number }[],
): { id: string; invoice_number: string; total: number }[] | null {
  if (acc.length === size) {
    const sum = acc.reduce((s, i) => s + i.total, 0);
    return Math.abs(sum - target) < 0.01 ? acc.slice() : null;
  }
  const partial = acc.reduce((s, i) => s + i.total, 0);
  for (let i = start; i < pool.length; i++) {
    if (partial + pool[i].total - target > 0.01) continue; // sorted desc
    acc.push(pool[i]);
    const hit = receiptSubsetSum(pool, size, i + 1, target, acc);
    if (hit) return hit;
    acc.pop();
  }
  return null;
}

// ── Auto-match receipts to invoices (returns suggestions, does NOT link) ──
// ?direction=incoming (AP: receipt proves you paid a supplier bill)
// ?direction=outgoing (AR: receipt proves customer paid you)
// A receipt appears in AT MOST one direction run (payer-name preference),
// which also fixes the old duplicate-row bug in MatchSuggestionsModal.
invoices.post('/auto-match-receipts', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const direction = c.req.query('direction') || 'incoming';

  const receipts = await db.prepare(
    `SELECT id, invoice_number, receipt_number, total, vendor_name, customer_name, payer_name, paid_date, direction
     FROM invoices WHERE user_id = ? AND receipt_number IS NOT NULL
     AND linked_invoice_id IS NULL AND total > 0 AND deleted_at IS NULL`
  ).bind(tenantId).all();

  const targetDirection = direction === 'outgoing' ? 'outgoing' : 'incoming';
  const unpaidInvoices = await db.prepare(
    `SELECT i.id, i.invoice_number, i.total, i.vendor_name, i.status, i.issue_date,
            cust.name AS customer_name, supp.name AS supplier_name
     FROM invoices i
     LEFT JOIN customers cust ON i.customer_id = cust.id
     LEFT JOIN suppliers supp ON i.supplier_id = supp.id
     WHERE i.user_id = ? AND i.direction = ?
     AND i.receipt_number IS NULL AND i.linked_invoice_id IS NULL AND i.status != 'cancelled'
     AND i.total > 0 AND i.deleted_at IS NULL`
  ).bind(tenantId, targetDirection).all();

  const ownNames = await ownCompanyNames(db, tenantId);
  const matched: any[] = [];
  const usedInvoiceIds = new Set<string>();

  for (const receipt of (receipts.results as any[])) {
    const payer = receipt.payer_name || null;
    const issuer = receipt.vendor_name || receipt.customer_name || null;
    const pref = receiptPrefDirection(payer, issuer, ownNames);
    if (pref && pref !== targetDirection) continue; // this receipt belongs to the other run
    const counterpartyR = receiptCounterpartyName(payer, issuer, ownNames);

    const cands = (unpaidInvoices.results as any[])
      .filter((inv) => !usedInvoiceIds.has(inv.id) && Math.abs(receipt.total - inv.total) < 0.02)
      .map((inv) => {
        const invParty = targetDirection === 'outgoing' ? (inv.customer_name || inv.supplier_name) : (inv.supplier_name || inv.customer_name);
        return {
          inv,
          nameScore: counterpartyR && invParty
            ? (fuzzyMatchCompany(counterpartyR, [invParty], { topN: 1, minScore: 50 })?.best?.score ?? 0)
            : 0,
        };
      })
      .sort((a, b) => b.nameScore - a.nameScore || (b.inv.issue_date || '').localeCompare(a.inv.issue_date || ''));

    const base = {
      receipt_id: receipt.id,
      receipt_number: receipt.receipt_number || receipt.invoice_number,
      receipt_total: receipt.total,
      receipt_vendor: issuer || payer || '',
      direction: targetDirection,
    };

    if (cands.length === 1 || (cands.length > 1 && cands[0].nameScore >= 70)) {
      // Unambiguous single match (unique amount, or counterparty corroborated)
      usedInvoiceIds.add(cands[0].inv.id);
      matched.push({
        ...base,
        invoice_id: cands[0].inv.id,
        invoice_number: cands[0].inv.invoice_number,
        invoice_total: cands[0].inv.total,
        invoice_vendor: cands[0].inv.customer_name || cands[0].inv.supplier_name || '',
        reason: cands[0].nameScore >= 70 ? `Amount + counterparty "${payer}" match` : 'Unique equal amount in this direction',
      });
      continue;
    }
    if (cands.length > 1) continue; // equal amounts, no corroborating signal → leave to manual review

    // Combined-payment receipt: exact sum of 2-3 same-direction invoices
    const pool = (unpaidInvoices.results as any[])
      .filter((inv) => !usedInvoiceIds.has(inv.id) && inv.total > 0 && inv.total <= receipt.total)
      .sort((a, b) => b.total - a.total)
      .slice(0, 12);
    let group: { id: string; invoice_number: string; total: number }[] | null = null;
    for (let size = 2; size <= Math.min(3, pool.length) && !group; size++) {
      group = receiptSubsetSum(pool, size, 0, receipt.total, []);
    }
    if (group) {
      for (const g of group) usedInvoiceIds.add(g.id);
      matched.push({
        ...base,
        invoice_ids: group.map((g) => g.id),
        invoices: group.map((g) => ({ invoice_id: g.id, invoice_number: g.invoice_number, total: g.total })),
        invoice_total: group.reduce((s, g) => s + g.total, 0),
        reason: `Combined payment: ${group.map((g) => g.total.toLocaleString()).join(' + ')} = ${receipt.total.toLocaleString()}`,
      });
    }
  }

  return c.json({
    matched,
    total_receipts: (receipts.results as any[]).length,
    total_invoices: (unpaidInvoices.results as any[]).length,
  });
});

// ── Confirm a receipt-to-invoice match (fully guarded since 2026-08-26) ──
// Accepts { receipt_id, invoice_id } or { receipt_id, invoice_ids: [] } for
// combined payments. Validates receipt-ness, tenant, statuses, direction
// consistency and amounts — the pre-fix endpoint accepted any two ids.
invoices.post('/confirm-receipt-match', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const receiptId = body?.receipt_id;
  const ids: string[] = Array.isArray(body?.invoice_ids)
    ? body.invoice_ids
    : (body?.invoice_id ? [body.invoice_id] : []);

  if (!receiptId || ids.length === 0) {
    return c.json({ error: 'receipt_id and invoice_id (or invoice_ids) are required' }, 400);
  }
  if (new Set(ids).size !== ids.length) {
    return c.json({ error: 'Duplicate invoice ids' }, 400);
  }

  const receipt = await db.prepare(
    'SELECT id, total, issue_date, vendor_name, customer_name, payer_name, linked_invoice_id, receipt_number, invoice_number FROM invoices WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(receiptId, tenantId).first<any>();
  if (!receipt) return c.json({ error: 'Receipt not found' }, 404);
  const isReceiptRow = receipt.receipt_number != null || /^REC/i.test(receipt.invoice_number || '');
  if (!isReceiptRow) return c.json({ error: 'receipt_id does not refer to a receipt' }, 400);
  if (receipt.linked_invoice_id) return c.json({ error: 'Receipt already linked — unlink first' }, 409);

  const ph = ids.map(() => '?').join(',');
  const invRes = await db.prepare(
    `SELECT id, total, direction, status, receipt_number, linked_invoice_id, invoice_number FROM invoices WHERE id IN (${ph}) AND user_id = ? AND deleted_at IS NULL`
  ).bind(...ids, tenantId).all<any>();
  const invs = invRes.results as any[];
  if (invs.length !== ids.length) return c.json({ error: 'One or more invoices not found' }, 404);

  const ownNames = await ownCompanyNames(db, tenantId);
  const pref = receiptPrefDirection(receipt.payer_name || null, receipt.vendor_name || receipt.customer_name || null, ownNames);

  for (const inv of invs) {
    if (inv.receipt_number != null) return c.json({ error: `Invoice ${inv.id} is itself a receipt` }, 400);
    if (inv.status === 'cancelled') return c.json({ error: 'Invoice is cancelled' }, 409);
    if (inv.linked_invoice_id) return c.json({ error: `Invoice ${inv.invoice_number} already has a linked receipt` }, 409);
    if (pref && inv.direction !== pref) {
      return c.json({ error: `Direction mismatch: receipt payer suggests ${pref} invoices, target is ${inv.direction}` }, 400);
    }
  }

  const sum = invs.reduce((s, i) => s + i.total, 0);
  if (Math.abs(sum - receipt.total) >= 0.02) {
    return c.json({ error: `Amount mismatch: receipt ${receipt.total} vs invoices ${sum}` }, 409);
  }

  const paidDate = receipt.issue_date || new Date().toISOString().split('T')[0];
  const stmts = [
    ...invs.map((inv) => inv.status === 'paid'
      ? db.prepare("UPDATE invoices SET linked_invoice_id = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ? AND deleted_at IS NULL")
          .bind(receiptId, inv.id, tenantId)
      : db.prepare("UPDATE invoices SET status = 'paid', paid_date = ?, linked_invoice_id = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL")
          .bind(paidDate, receiptId, inv.id, tenantId)),
    db.prepare('UPDATE invoices SET linked_invoice_id = ? WHERE id = ? AND user_id = ?')
      .bind(ids[0], receiptId, tenantId),
  ];
  await db.batch(stmts);

  return c.json({ success: true, receipt_id: receiptId, invoice_id: ids[0], invoice_ids: ids });
});

export { invoices as invoiceRoutes };
