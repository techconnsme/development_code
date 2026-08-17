import { Hono } from 'hono';
import { Bindings, Variables } from '../types';
import { authMiddleware } from '../middleware/auth';

const rq = new Hono<{ Bindings: Bindings; Variables: Variables }>();
rq.use('*', authMiddleware);

// ── Aggregate pending items across all document types ──
rq.get('/', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const limit = Math.min(parseInt(c.req.query('limit') || '100'), 200);
  const startDate = c.req.query('start_date') || null;
  const endDate = c.req.query('end_date') || null;

  // Date filter fragments (applied to each table's relevant date column)
  const bsDateFilter = startDate && endDate ? 'AND period_end >= ? AND period_end <= ?' : '';
  const csDateFilter = startDate && endDate ? 'AND period_end >= ? AND period_end <= ?' : '';
  const invDateFilter = startDate && endDate ? 'AND issue_date >= ? AND issue_date <= ?' : '';
  const jeDateFilter = startDate && endDate ? 'AND entry_date >= ? AND entry_date <= ?' : '';

  const dateParams = startDate && endDate ? [startDate, endDate] : [];

  // Bank statement drafts
  const bankDrafts = await db.prepare(
    `SELECT id, bank_name, account_number, period_start, period_end,
     balance_status, created_at
     FROM bank_statements
     WHERE user_id = ? AND deleted_at IS NULL AND status = 'draft' ${bsDateFilter}
     ORDER BY created_at DESC LIMIT ?`
  ).bind(tenantId, ...dateParams, limit).all();

  // Card statement drafts
  const cardDrafts = await db.prepare(
    `SELECT id, card_issuer, card_number_last4, statement_year, statement_month,
     closing_balance, created_at
     FROM card_statements
     WHERE user_id = ? AND deleted_at IS NULL AND status = 'draft' ${csDateFilter}
     ORDER BY created_at DESC LIMIT ?`
  ).bind(tenantId, ...dateParams, limit).all();

  // Invoices pending review
  const invoicePending = await db.prepare(
    `SELECT id, invoice_number, receipt_number, vendor_name, direction,
     needs_review, issue_date, total, created_at
     FROM invoices
     WHERE user_id = ? AND deleted_at IS NULL AND (status = 'pending_review' OR (needs_review IS NOT NULL AND needs_review != '')) ${invDateFilter}
     ORDER BY created_at DESC LIMIT ?`
  ).bind(tenantId, ...dateParams, limit).all();

  // Journal entries (draft or stale)
  const journalPending = await db.prepare(
    `SELECT id, entry_number, entry_date, description, reference_type, reference_id, status, created_at
     FROM journal_entries
     WHERE user_id = ? AND status IN ('draft', 'stale') ${jeDateFilter}
     ORDER BY created_at DESC LIMIT ?`
  ).bind(tenantId, ...dateParams, limit).all();

  // Counts (also date-filtered)
  const bankCount = await db.prepare(
    `SELECT COUNT(*) as cnt FROM bank_statements
     WHERE user_id = ? AND deleted_at IS NULL AND status = 'draft' ${bsDateFilter}`
  ).bind(tenantId, ...dateParams).first<{ cnt: number }>();
  const cardCount = await db.prepare(
    `SELECT COUNT(*) as cnt FROM card_statements
     WHERE user_id = ? AND deleted_at IS NULL AND status = 'draft' ${csDateFilter}`
  ).bind(tenantId, ...dateParams).first<{ cnt: number }>();
  const invoiceCount = await db.prepare(
    `SELECT COUNT(*) as cnt FROM invoices
     WHERE user_id = ? AND deleted_at IS NULL AND (status = 'pending_review' OR (needs_review IS NOT NULL AND needs_review != '')) ${invDateFilter}`
  ).bind(tenantId, ...dateParams).first<{ cnt: number }>();
  const journalCount = await db.prepare(
    `SELECT COUNT(*) as cnt FROM journal_entries
     WHERE user_id = ? AND status IN ('draft', 'stale') ${jeDateFilter}`
  ).bind(tenantId, ...dateParams).first<{ cnt: number }>();

  const counts = {
    bank_statements: bankCount?.cnt || 0,
    card_statements: cardCount?.cnt || 0,
    invoices: invoiceCount?.cnt || 0,
    journal_entries: journalCount?.cnt || 0,
  };

  // Build unified item list
  const items: any[] = [];

  for (const row of bankDrafts.results as any[]) {
    const reason = row.balance_status === 'mismatch' ? 'balance_mismatch' : 'draft';
    items.push({
      type: 'bank_statement',
      id: row.id,
      title: row.bank_name || 'Bank Statement',
      subtitle: [row.account_number, row.period_start && row.period_end ? `${row.period_start} → ${row.period_end}` : ''].filter(Boolean).join(' · ') || undefined,
      date: row.created_at?.slice(0, 10),
      reason,
      reviewUrl: `/bank-statements/review/${row.id}`,
    });
  }

  for (const row of cardDrafts.results as any[]) {
    items.push({
      type: 'card_statement',
      id: row.id,
      title: row.card_issuer || 'Card Statement',
      subtitle: [
        row.card_number_last4 ? `··${row.card_number_last4}` : '',
        row.statement_year ? `${row.statement_year}-${String(row.statement_month || 1).padStart(2, '0')}` : '',
      ].filter(Boolean).join(' · ') || undefined,
      date: row.created_at?.slice(0, 10),
      reason: 'draft',
      reviewUrl: `/card-statements/review/${row.id}`,
    });
  }

  for (const row of invoicePending.results as any[]) {
    const flags = (row.needs_review || '').split(',').filter(Boolean);
    const reason = flags.length > 0 ? flags.join(',') : 'pending_review';
    // Translate flags to review page query params
    const qs: string[] = [];
    if (flags.includes('direction')) qs.push('review_direction=1');
    if (flags.includes('company_not_detected')) qs.push('company_not_detected=1');
    if (flags.includes('duplicate')) qs.push('is_duplicate=1');
    const isReceipt = !!row.receipt_number;
    items.push({
      type: isReceipt ? 'receipt' : 'invoice',
      id: row.id,
      title: row.invoice_number || row.receipt_number || (isReceipt ? 'Receipt' : 'Invoice'),
      subtitle: [row.vendor_name, row.direction].filter(Boolean).join(' · ') || undefined,
      date: row.issue_date || row.created_at?.slice(0, 10),
      reason,
      flags: qs.join('&'),
      reviewUrl: `/invoices/review/${row.id}${qs.length > 0 ? '?' + qs.join('&') : ''}`,
    });
  }

  for (const row of journalPending.results as any[]) {
    const reason = row.status === 'stale' ? 'stale' : 'draft';
    items.push({
      type: 'journal_entry',
      id: row.id,
      title: row.entry_number || 'Journal Entry',
      subtitle: row.description?.slice(0, 80) || undefined,
      date: row.entry_date || row.created_at?.slice(0, 10),
      reason,
      reviewUrl: reason === 'stale' ? '/bank-statements' : `/GJE?entry=${row.id}`,
    });
  }

  // Sort by date descending
  items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const total = counts.bank_statements + counts.card_statements + counts.invoices + counts.journal_entries;
  return c.json({ total, counts, items: items.slice(0, limit) });
});

// ── Lightweight count-only endpoint for sidebar badge ──
rq.get('/count', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const startDate = c.req.query('start_date') || null;
  const endDate = c.req.query('end_date') || null;

  const bsDateFilter = startDate && endDate ? 'AND period_end >= ? AND period_end <= ?' : '';
  const csDateFilter = startDate && endDate ? 'AND period_end >= ? AND period_end <= ?' : '';
  const invDateFilter = startDate && endDate ? 'AND issue_date >= ? AND issue_date <= ?' : '';
  const jeDateFilter = startDate && endDate ? 'AND entry_date >= ? AND entry_date <= ?' : '';
  const dateParams = startDate && endDate ? [startDate, endDate] : [];

  const bankCount = await db.prepare(
    `SELECT COUNT(*) as cnt FROM bank_statements
     WHERE user_id = ? AND deleted_at IS NULL AND status = 'draft' ${bsDateFilter}`
  ).bind(tenantId, ...dateParams).first<{ cnt: number }>();
  const cardCount = await db.prepare(
    `SELECT COUNT(*) as cnt FROM card_statements
     WHERE user_id = ? AND deleted_at IS NULL AND status = 'draft' ${csDateFilter}`
  ).bind(tenantId, ...dateParams).first<{ cnt: number }>();
  const invoiceCount = await db.prepare(
    `SELECT COUNT(*) as cnt FROM invoices
     WHERE user_id = ? AND deleted_at IS NULL AND (status = 'pending_review' OR (needs_review IS NOT NULL AND needs_review != '')) ${invDateFilter}`
  ).bind(tenantId, ...dateParams).first<{ cnt: number }>();
  const journalCount = await db.prepare(
    `SELECT COUNT(*) as cnt FROM journal_entries
     WHERE user_id = ? AND status IN ('draft', 'stale') ${jeDateFilter}`
  ).bind(tenantId, ...dateParams).first<{ cnt: number }>();

  return c.json({
    total: (bankCount?.cnt || 0) + (cardCount?.cnt || 0) + (invoiceCount?.cnt || 0) + (journalCount?.cnt || 0),
    counts: {
      bank_statements: bankCount?.cnt || 0,
      card_statements: cardCount?.cnt || 0,
      invoices: invoiceCount?.cnt || 0,
      journal_entries: journalCount?.cnt || 0,
    },
  });
});

export { rq as reviewQueueRoutes };
