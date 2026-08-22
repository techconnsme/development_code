import { getJwtSecret } from '../middleware/auth';
import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { verify as jwtVerify } from 'jsonwebtoken';
import { Bindings, Variables } from '../types';
import { authMiddleware, requireHigherTier } from '../middleware/auth';
import { postPaymentToGl } from '../lib/post-payment';
import { jePosted, jeLive, jeDeleted, jeNotOrphaned } from '../lib/journal-filters';
import { categorizeTransaction, resolveBankAccountCode } from '../lib/transaction-categorizer';
import { restoreInvoiceJournal, purgeInvoiceJournal } from '../lib/invoice-journal';

const bank = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Audit log helper
async function auditLog(db: any, userId: string, action: string, entityType: string, entityId: string | null, changes?: object) {
  const id = `al-${uuidv4().slice(0, 8)}`;
  try {
    await db.prepare(
      'INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, changes) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(id, userId, action, entityType, entityId, changes ? JSON.stringify(changes) : null).run();
  } catch { /* audit log table may not exist yet */ }
}

// Helper to extract JWT from cookie, header, or query param
function extractJwt(c: any, secret: string): string | null {
  // 1. httpOnly cookie (XSS-safe)
  const cookieHeader = c.req.header('Cookie') || '';
  const cookieMatch = cookieHeader.match(/(?:^|;\s*)token=([^;]+)/);
  if (cookieMatch) return cookieMatch[1];
  // 2. Authorization header
  const auth = c.req.header('Authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  // 3. Query param (legacy)
  const qt = c.req.query('token');
  if (qt) return qt;
  return null;
}

// ── Download file (token-protected) ──
bank.get('/:id/file', async (c) => {
  let userId: string | null = null;
  const token = extractJwt(c, getJwtSecret(c.env));
  if (token) {
    try {
      const payload = jwtVerify(token, getJwtSecret(c.env)) as { id: string };
      userId = payload.id;
    } catch {}
  }
  if (!userId) return c.json({ error: 'Authentication required' }, 401);

  const row = await c.env.DB.prepare(
    'SELECT file_data, r2_key, file_type, file_name, user_id FROM bank_statements WHERE id = ? AND deleted_at IS NULL'
  ).bind(c.req.param('id')).first<{ file_data: string; r2_key: string | null; file_type: string; file_name: string; user_id: string }>();
  if (!row) return c.json({ error: 'Not found' }, 404);

  // Allow direct owner OR firm admin who has this user as an active client
  let hasAccess = row.user_id === userId;
  if (!hasAccess) {
    const link = await c.env.DB.prepare(
      `SELECT 1 FROM firm_clients fc
       JOIN firm_members fm ON fm.firm_id = fc.firm_id
       WHERE fc.client_user_id = ? AND fm.user_id = ? AND fc.status = 'active' AND fm.is_active = 1`
    ).bind(row.user_id, userId).first();
    hasAccess = !!link;
  }
  if (!hasAccess) return c.json({ error: 'Not found' }, 404);

  if (row.r2_key && c.env.FILE_BUCKET) {
    const obj = await c.env.FILE_BUCKET.get(row.r2_key);
    if (obj) {
      return new Response(obj.body, {
        headers: {
          'Content-Type': row.file_type || 'application/pdf',
          'Content-Disposition': `inline; filename="${row.file_name || 'statement'}"`,
        },
      });
    }
  }

  if (row.file_data) {
    const base64 = row.file_data.replace(/^data:.*?;base64,/, '');
    const binary = Uint8Array.from(atob(base64), ch => ch.charCodeAt(0));
    return new Response(binary, {
      headers: {
        'Content-Type': row.file_type || 'application/pdf',
        'Content-Disposition': `inline; filename="${row.file_name || 'statement'}"`,
      },
    });
  }

  return c.json({ error: 'File data not available' }, 404);
});

// ── Export CSV (before auth middleware, supports cookie + token auth) ──
bank.get('/:id/export-csv', async (c) => {
  let userId: string | null = null;
  try { userId = (c.get('user') as any)?.id; } catch {}
  if (!userId) {
    const token = extractJwt(c, getJwtSecret(c.env));
    if (token) {
      try {
        const payload = jwtVerify(token, getJwtSecret(c.env)) as { id: string };
        userId = payload.id;
      } catch {}
    }
  }
  if (!userId) return c.json({ error: 'Authentication required' }, 401);

  const stmt = await c.env.DB.prepare('SELECT id, file_name FROM bank_statements WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .bind(c.req.param('id'), userId).first<{ id: string; file_name: string | null }>();
  if (!stmt) return c.json({ error: 'Not found' }, 404);

  const txs = await c.env.DB.prepare(
    'SELECT transaction_date, description, deposit_amount, withdrawal_amount, balance, account_type, account_code, reference FROM bank_transactions WHERE bank_statement_id = ? AND deleted_at IS NULL ORDER BY sort_order'
  ).bind(c.req.param('id')).all();

  let csv = 'Date,Description,Deposit,Withdrawal,Balance,Account Type,Account Code,Reference\n';
  for (const tx of txs.results as any[]) {
    const desc = (tx.description || '').replace(/"/g, '""');
    csv += `"${tx.transaction_date}","${desc}",${tx.deposit_amount},${tx.withdrawal_amount},${tx.balance || ''},"${tx.account_type || ''}","${tx.account_code || ''}","${(tx.reference || '').replace(/"/g, '""')}"\n`;
  }

  return c.text(csv, 200, {
    'Content-Type': 'text/csv',
    'Content-Disposition': `attachment; filename="${stmt.file_name?.replace('.pdf','') || 'statement'}.csv"`,
  });
});

bank.use('*', authMiddleware);

// ── List ──
bank.get('/', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const year = c.req.query('year') || '';
  const startDate = c.req.query('start_date') || '';
  const endDate = c.req.query('end_date') || '';
  const showDrafts = c.req.query('show_drafts') === '1';
  const onlyDrafts = c.req.query('only_drafts') === '1';
  let q = `SELECT bs.id, bs.file_name, bs.bank_name, bs.account_number, bs.branch, bs.currency, bs.account_type,
           bs.statement_year, bs.statement_month, bs.period_start, bs.period_end,
           bs.opening_balance, bs.closing_balance, bs.page_count, bs.ocr_text, bs.status,
           bs.balance_status, bs.balance_check, bs.created_at,
           (SELECT COUNT(*) FROM bank_transactions bt
            WHERE bt.bank_statement_id = bs.id AND bt.deleted_at IS NULL
            AND bt.invoice_id IS NULL AND bt.card_statement_id IS NULL
            AND (bt.match_status IS NULL OR bt.match_status NOT IN ('skipped','suggested'))) as unlinked_count,
           (SELECT COUNT(*) FROM bank_transactions bt
            WHERE bt.bank_statement_id = bs.id AND bt.deleted_at IS NULL) as tx_count
           FROM bank_statements bs WHERE bs.user_id = ? AND bs.deleted_at IS NULL`;
  const p: any[] = [tenantId];
  if (onlyDrafts) {
    q += " AND status = 'draft'";
  } else if (!showDrafts) {
    q += " AND (status IS NULL OR status != 'draft')";
  }
  if (year) { q += ' AND statement_year = ?'; p.push(parseInt(year)); }
  // Filter by period_end within fiscal year range (handles cross-year FY like Apr-Mar).
  // Fall back to the statement's month end when period_end is missing, so records with
  // NULL period_end never silently disappear from date-filtered lists.
  const periodEndExpr = "COALESCE(bs.period_end, date(printf('%04d-%02d-01', bs.statement_year, bs.statement_month), '+1 month', '-1 day'))";
  if (startDate) { q += ` AND ${periodEndExpr} >= ?`; p.push(startDate); }
  if (endDate) { q += ` AND ${periodEndExpr} <= ?`; p.push(endDate); }
  q += ' ORDER BY statement_year DESC, statement_month DESC';
  const rows = await c.env.DB.prepare(q).bind(...p).all();
  return c.json({ data: rows.results });
});

// ── Confirm draft → active (Step 4 of review-before-save flow) ──
bank.post('/:id/confirm', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare(
    'SELECT id, status FROM bank_statements WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(id, tenantId).first<{ id: string; status: string }>();
  if (!existing) return c.json({ error: 'Not found' }, 404);
  // Idempotent: if already confirmed, just return success
  if (existing.status !== 'draft' && existing.status !== 'pending_review') {
    if (existing.status === 'active') return c.json({ success: true, id, status: 'active', already_confirmed: true });
    return c.json({ error: `Cannot confirm — status is already "${existing.status}"`, status: existing.status }, 400);
  }
  // Detect duplicate: if another active statement shares the same r2_key, skip journal entries
  let journalSkipped = false;
  const existingR2 = await c.env.DB.prepare(
    'SELECT r2_key FROM bank_statements WHERE id = ? AND deleted_at IS NULL'
  ).bind(id).first<{ r2_key: string | null }>();
  if (existingR2?.r2_key) {
    const duplicate = await c.env.DB.prepare(
      `SELECT bs.id FROM bank_statements bs
       JOIN journal_entries je ON je.reference_id = bs.id AND je.reference_type = 'bank_transaction'
       WHERE bs.user_id = ? AND bs.r2_key = ? AND bs.id != ? AND bs.deleted_at IS NULL LIMIT 1`
    ).bind(tenantId, existingR2.r2_key, id).first();
    if (duplicate) journalSkipped = true;
  }

  const body = await c.req.json().catch(() => ({}));
  const balanceStatus = body.balance_status || 'unchecked';
  const balanceCheck = body.balance_check ? JSON.stringify(body.balance_check) : null;
  await c.env.DB.prepare(
    "UPDATE bank_statements SET status = 'active', balance_status = ?, balance_check = ?, updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL"
  ).bind(balanceStatus, balanceCheck, id).run();

  // Auto-detect matching invoices in background (suggested badges only — user confirms later)
  c.executionCtx.waitUntil((async () => {
    try {
      const stmtCurrency = (await c.env.DB.prepare(
        'SELECT currency FROM bank_statements WHERE id = ? AND user_id = ?'
      ).bind(id, tenantId).first<{ currency: string | null }>())?.currency || 'HKD';

      const txns = await c.env.DB.prepare(
        `SELECT id, deposit_amount, withdrawal_amount, description, reference, transaction_date
         FROM bank_transactions WHERE user_id = ? AND bank_statement_id = ? AND deleted_at IS NULL AND match_status = 'unmatched'`
      ).bind(tenantId, id).all();

      const invoices = await c.env.DB.prepare(
        `SELECT id, invoice_number, total, issue_date, due_date, direction, currency
         FROM invoices WHERE user_id = ? AND status NOT IN ('paid','cancelled') AND total > 0 AND deleted_at IS NULL`
      ).bind(tenantId).all();

      const usedInvoiceIds = new Set<string>();
      for (const tx of (txns.results as any[])) {
        const amt = tx.deposit_amount || tx.withdrawal_amount || 0;
        const isDeposit = tx.deposit_amount > 0;
        for (const inv of (invoices.results as any[])) {
          if (usedInvoiceIds.has(inv.id)) continue;
          if ((inv.currency || 'HKD') !== stmtCurrency) continue;
          const invIsIncoming = inv.direction === 'incoming';
          if (isDeposit && invIsIncoming) continue;    // deposits → AR only
          if (!isDeposit && !invIsIncoming) continue;  // withdrawals → AP only
          if (Math.abs(amt - inv.total) < 0.02) {
            await c.env.DB.prepare(
              "UPDATE bank_transactions SET match_status = 'suggested', invoice_id = ?, match_confidence = 'auto' WHERE id = ? AND user_id = ?"
            ).bind(inv.id, tx.id, tenantId).run();
            usedInvoiceIds.add(inv.id);
            break;
          }
        }
      }
    } catch (e: any) { console.log('[AUTO-MATCH] background error:', e?.message); }
  })());

  return c.json({ success: true, id, status: 'active', journal_skipped: journalSkipped });
});

// ── Edit statement header fields (used during review) ──
bank.patch('/:id', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const id = c.req.param('id');
  const body = await c.req.json();

  const existing = await c.env.DB.prepare(
    'SELECT id FROM bank_statements WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(id, tenantId).first();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const allowed = ['bank_name', 'account_number', 'branch', 'currency', 'account_type',
    'statement_year', 'statement_month', 'period_start', 'period_end',
    'opening_balance', 'closing_balance', 'file_name'];
  const sets: string[] = [];
  const params: any[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (allowed.includes(k)) {
      sets.push(`${k} = ?`);
      params.push(v);
    }
  }
  if (sets.length === 0) return c.json({ error: 'No valid fields' }, 400);
  sets.push("updated_at = datetime('now')");
  params.push(id, tenantId);
  await c.env.DB.prepare(
    `UPDATE bank_statements SET ${sets.join(', ')} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
  ).bind(...params).run();
  return c.json({ success: true });
});

// ── Auto-match bank transactions to invoices (deposits→AR, withdrawals→AP) ──
// SUGGEST-ONLY (unified 2026-08-17): returns candidate pairs, writes NOTHING.
// The user reviews each pair and confirms via PATCH /transactions/:id/match,
// which performs all writes (link + pay + GL + file payment_status).
// ?direction=incoming → AP only (withdrawals↔incoming), outgoing → AR only (deposits↔outgoing).
bank.post('/auto-match', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const direction = c.req.query('direction') || '';
  const wantAR = direction !== 'incoming';
  const wantAP = direction !== 'outgoing';

  // Fetch unmatched deposits and withdrawals (statement currency included for matching)
  const deposits = wantAR ? await db.prepare(
    `SELECT bt.id, bt.transaction_date, bt.description, bt.deposit_amount, bt.reference,
            COALESCE(bs.currency, 'HKD') as currency
     FROM bank_transactions bt LEFT JOIN bank_statements bs ON bt.bank_statement_id = bs.id
     WHERE bt.user_id = ? AND bt.deleted_at IS NULL AND bs.deleted_at IS NULL
     AND bt.deposit_amount > 0 AND bt.match_status = 'unmatched'
     ORDER BY bt.transaction_date`
  ).bind(tenantId).all() : { results: [] as any[] };

  const withdrawals = wantAP ? await db.prepare(
    `SELECT bt.id, bt.transaction_date, bt.description, bt.withdrawal_amount, bt.reference,
            COALESCE(bs.currency, 'HKD') as currency
     FROM bank_transactions bt LEFT JOIN bank_statements bs ON bt.bank_statement_id = bs.id
     WHERE bt.user_id = ? AND bt.deleted_at IS NULL AND bs.deleted_at IS NULL
     AND bt.withdrawal_amount > 0 AND bt.match_status = 'unmatched'
     AND bt.card_statement_id IS NULL
     ORDER BY bt.transaction_date`
  ).bind(tenantId).all() : { results: [] as any[] };

  // Fetch unpaid invoices with direction
  const allInvoices = await db.prepare(
    `SELECT id, invoice_number, total, currency, issue_date, due_date, direction, file_id
     FROM invoices
     WHERE user_id = ? AND status NOT IN ('paid', 'cancelled') AND deleted_at IS NULL`
  ).bind(tenantId).all();

  // Split by direction
  const arInvoices = (allInvoices.results as any[]).filter(i => i.direction !== 'incoming');  // outgoing or null → AR
  const apInvoices = (allInvoices.results as any[]).filter(i => i.direction === 'incoming');   // incoming → AP

  const matched: any[] = [];
  const usedInvoiceIds = new Set<string>();

  // Helper: match transactions to invoices (currency must agree — HKD default for legacy rows)
  function findBestMatch(tx: any, invoices: any[], amountKey: string): { bestMatch: any; bestConfidence: string } | null {
    let bestMatch: any = null;
    let bestConfidence = '';
    const txAmount = tx[amountKey];
    const txCurrency = tx.currency || 'HKD';

    for (const inv of invoices.filter(i => !usedInvoiceIds.has(i.id))) {
      if ((inv.currency || 'HKD') !== txCurrency) continue;
      const amountMatch = Math.abs(txAmount - inv.total) < 0.01;
      if (!amountMatch) continue;

      const descHasInv = (tx.description || '').toUpperCase().includes((inv.invoice_number || '').toUpperCase())
        || ((tx.reference || '').toUpperCase().includes((inv.invoice_number || '').toUpperCase()));

      if (descHasInv) { bestMatch = inv; bestConfidence = 'high'; break; }

      const txDate = new Date(tx.transaction_date);
      const issueDate = new Date(inv.issue_date);
      const dueDate = new Date(inv.due_date || inv.issue_date);
      dueDate.setDate(dueDate.getDate() + 7);

      if (txDate >= issueDate && txDate <= dueDate) {
        if (!bestMatch || bestConfidence !== 'high') { bestMatch = inv; bestConfidence = 'medium'; }
      } else if (!bestMatch) {
        bestMatch = inv; bestConfidence = 'low';
      }
    }
    return bestMatch ? { bestMatch, bestConfidence } : null;
  }

  // Match deposits → AR invoices
  for (const tx of deposits.results as any[]) {
    const result = findBestMatch(tx, arInvoices, 'deposit_amount');
    if (result) {
      const { bestMatch, bestConfidence } = result;
      const reason = bestConfidence === 'high'
        ? `Deposit $${tx.deposit_amount} matches invoice ${bestMatch.invoice_number} in description`
        : bestConfidence === 'medium'
        ? `Deposit $${tx.deposit_amount} matches invoice amount + date range`
        : `Deposit $${tx.deposit_amount} matches invoice amount`;

      const stmt = await db.prepare('SELECT id, r2_key FROM bank_statements WHERE id = (SELECT bank_statement_id FROM bank_transactions WHERE id = ?)').bind(tx.id).first() as any;
      const stmtFile = stmt?.r2_key ? await db.prepare('SELECT id FROM file_records WHERE r2_key = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1').bind(stmt.r2_key, tenantId).first() as any : null;
      matched.push({ transaction_id: tx.id, invoice_id: bestMatch.id,
        invoice_number: bestMatch.invoice_number, amount: tx.deposit_amount,
        confidence: bestConfidence, reason, direction: 'deposit→AR',
        invoice_file_id: bestMatch.file_id || null,
        stmt_file_id: stmtFile?.id || null });
      usedInvoiceIds.add(bestMatch.id);
    }
  }

  // Match withdrawals → AP invoices
  for (const tx of withdrawals.results as any[]) {
    const result = findBestMatch(tx, apInvoices, 'withdrawal_amount');
    if (result) {
      const { bestMatch, bestConfidence } = result;
      const reason = bestConfidence === 'high'
        ? `Withdrawal $${tx.withdrawal_amount} matches invoice ${bestMatch.invoice_number} in description`
        : bestConfidence === 'medium'
        ? `Withdrawal $${tx.withdrawal_amount} matches invoice amount + date range`
        : `Withdrawal $${tx.withdrawal_amount} matches invoice amount`;

      const stmt2 = await db.prepare('SELECT id, r2_key FROM bank_statements WHERE id = (SELECT bank_statement_id FROM bank_transactions WHERE id = ?)').bind(tx.id).first() as any;
      const stmtFile2 = stmt2?.r2_key ? await db.prepare('SELECT id FROM file_records WHERE r2_key = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1').bind(stmt2.r2_key, tenantId).first() as any : null;
      matched.push({ transaction_id: tx.id, invoice_id: bestMatch.id,
        invoice_number: bestMatch.invoice_number, amount: tx.withdrawal_amount,
        confidence: bestConfidence, reason, direction: 'withdrawal→AP',
        invoice_file_id: bestMatch.file_id || null,
        stmt_file_id: stmtFile2?.id || null });
      usedInvoiceIds.add(bestMatch.id);
    }
  }

  const totalUnmatched = (deposits.results as any[]).length + (withdrawals.results as any[]).length;
  const unmatchedCount = totalUnmatched - matched.length;
  return c.json({ matched, unmatched_count: unmatchedCount });
});

// ── Auto-match bank withdrawals to card statements ──
bank.post('/auto-match-cards', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;

  // Find bank withdrawals that could be credit card payments
  const withdrawals = await db.prepare(
    `SELECT id, transaction_date, description, withdrawal_amount
     FROM bank_transactions
     WHERE user_id = ? AND deleted_at IS NULL AND withdrawal_amount > 0
     AND card_statement_id IS NULL
     ORDER BY transaction_date`
  ).bind(tenantId).all();

  // Find card statements with known closing balance / minimum payment
  const cardStmts = await db.prepare(
    `SELECT id, card_issuer, card_number_last4, statement_year, statement_month,
     closing_balance, minimum_payment, payment_due_date, period_end
     FROM card_statements
     WHERE user_id = ? AND deleted_at IS NULL
     ORDER BY statement_year DESC, statement_month DESC`
  ).bind(tenantId).all();

  const matched: any[] = [];
  const usedCardIds = new Set<string>();

  for (const tx of withdrawals.results as any[]) {
    let bestMatch: any = null;
    let bestConfidence = '';

    for (const cs of (cardStmts.results as any[]).filter(c => !usedCardIds.has(c.id))) {
      const desc = (tx.description || '').toUpperCase();
      const issuer = (cs.card_issuer || '').toUpperCase();

      // Check if description mentions the card issuer
      const descHasIssuer = issuer && desc.includes(issuer);
      // Check if amount matches closing balance or minimum payment
      const matchesClosing = cs.closing_balance && Math.abs(tx.withdrawal_amount - cs.closing_balance) < 0.01;
      const matchesMinPayment = cs.minimum_payment && Math.abs(tx.withdrawal_amount - cs.minimum_payment) < 0.01;

      if (descHasIssuer && (matchesClosing || matchesMinPayment)) {
        bestMatch = cs;
        bestConfidence = matchesClosing ? 'high' : 'medium';
        break;
      }

      if (matchesClosing && !bestMatch) {
        bestMatch = cs;
        bestConfidence = 'low';
      } else if (matchesMinPayment && !bestMatch) {
        bestMatch = cs;
        bestConfidence = 'low';
      }
    }

    if (bestMatch) {
      await db.prepare(
        `UPDATE bank_transactions SET card_statement_id = ?, match_status = 'suggested'
         WHERE id = ? AND deleted_at IS NULL`
      ).bind(bestMatch.id, tx.id).run();

      matched.push({
        transaction_id: tx.id,
        card_statement_id: bestMatch.id,
        card_issuer: bestMatch.card_issuer,
        withdrawal_amount: tx.withdrawal_amount,
        confidence: bestConfidence,
        reason: bestConfidence === 'high'
          ? `Card issuer "${bestMatch.card_issuer}" found in description + amount matches closing balance`
          : bestConfidence === 'medium'
          ? `Card issuer "${bestMatch.card_issuer}" found in description + amount matches minimum payment`
          : `Amount matches card closing balance`,
      });
      usedCardIds.add(bestMatch.id);
    }
  }

  const unmatchedCount = (withdrawals.results as any[]).length - matched.length;
  return c.json({ matched, unmatched_count: unmatchedCount });
});

// ── Manual link/unlink bank transaction to card statement ──
bank.patch('/transactions/:id/card-link', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const txId = c.req.param('id');
  const body = await c.req.json();
  const { action, card_statement_id } = body;

  const tx = await db.prepare(
    'SELECT id, withdrawal_amount, card_statement_id FROM bank_transactions WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(txId, tenantId).first<{ id: string; withdrawal_amount: number; card_statement_id: string | null }>();
  if (!tx) return c.json({ error: 'Transaction not found' }, 404);

  if (action === 'link' && card_statement_id) {
    const cs = await db.prepare(
      'SELECT id FROM card_statements WHERE id = ? AND user_id = ?'
    ).bind(card_statement_id, tenantId).first();
    if (!cs) return c.json({ error: 'Card statement not found' }, 404);

    await db.prepare(
      `UPDATE bank_transactions SET card_statement_id = ?, match_status = 'confirmed'
       WHERE id = ? AND deleted_at IS NULL`
    ).bind(card_statement_id, txId).run();

    await auditLog(db, user.id, 'link_card', 'bank_transaction', txId, { card_statement_id, action: 'link' });
    return c.json({ success: true, card_statement_id });
  }

  if (action === 'unlink') {
    await db.prepare(
      `UPDATE bank_transactions SET card_statement_id = NULL, match_status = 'unmatched'
       WHERE id = ? AND deleted_at IS NULL`
    ).bind(txId).run();
    await auditLog(db, user.id, 'unlink_card', 'bank_transaction', txId, { action: 'unlink' });
    return c.json({ success: true });
  }

  return c.json({ error: 'action must be link or unlink' }, 400);
});

// ── Toggle "no link needed" on a transaction ──
bank.patch('/transactions/:id/skip-link', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const txId = c.req.param('id');

  const tx = await db.prepare(
    'SELECT id, match_status FROM bank_transactions WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(txId, tenantId).first<{ id: string; match_status: string | null }>();
  if (!tx) return c.json({ error: 'Transaction not found' }, 404);

  const newStatus = tx.match_status === 'skipped' ? 'unmatched' : 'skipped';
  await db.prepare(
    'UPDATE bank_transactions SET match_status = ? WHERE id = ? AND deleted_at IS NULL'
  ).bind(newStatus, txId).run();

  await auditLog(db, user.id, newStatus === 'skipped' ? 'skip_link' : 'unskip_link', 'bank_transaction', txId, {});
  return c.json({ success: true, match_status: newStatus });
});

// ── List match suggestions ──
bank.get('/match-suggestions', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const rows = await c.env.DB.prepare(
    `SELECT bt.id, bt.transaction_date, bt.description, bt.deposit_amount, bt.match_confidence,
     i.id as invoice_id, i.invoice_number, i.total as invoice_total, i.status as invoice_status
     FROM bank_transactions bt
     JOIN invoices i ON bt.invoice_id = i.id
      WHERE bt.user_id = ? AND bt.deleted_at IS NULL AND bt.match_status = 'suggested'
     ORDER BY bt.transaction_date`
  ).bind(tenantId).all();
  return c.json({ data: rows.results });
});

// ── Update transaction fields (inline edit) ──
bank.patch('/transactions/:id', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const txId = c.req.param('id');
  const body = await c.req.json();

  const tx = await db.prepare('SELECT id FROM bank_transactions WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .bind(txId, tenantId).first();
  if (!tx) return c.json({ error: 'Transaction not found' }, 404);

  const allowedFields = ['transaction_date', 'description', 'deposit_amount', 'withdrawal_amount', 'balance', 'reference', 'account_code', 'account_type'];
  const sets: string[] = [];
  const params: any[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (allowedFields.includes(k)) {
      sets.push(`${k} = ?`);
      params.push(v);
    }
  }
  if (sets.length === 0) return c.json({ error: 'No valid fields' }, 400);

  params.push(txId, tenantId);
  await db.prepare(`UPDATE bank_transactions SET ${sets.join(', ')}, is_edited = 1 WHERE id = ? AND user_id = ? AND deleted_at IS NULL`)
    .bind(...params).run();

  await auditLog(db, user.id, 'update', 'bank_transaction', txId, body);

  // Auto-regenerate linked journal entry if transaction was modified
  if (body.account_code !== undefined || body.deposit_amount !== undefined || body.withdrawal_amount !== undefined || body.description !== undefined) {
    // Delete existing journal entry (CASCADE handles lines)
    await db.prepare(
      `DELETE FROM journal_entries WHERE reference_type = 'bank_transaction' AND reference_id = ?
       AND status != 'reconciled' AND ${jeLive('journal_entries')}`
    ).bind(txId).run();

    // Regenerate fresh journal entry from updated transaction
    const fullTx = await db.prepare(
      `SELECT bt.*, bs.bank_name, bs.account_number, bs.account_code AS stmt_account_code
       FROM bank_transactions bt
       LEFT JOIN bank_statements bs ON bt.bank_statement_id = bs.id
       WHERE bt.id = ? AND bt.user_id = ? AND bt.deleted_at IS NULL`
    ).bind(txId, tenantId).first<any>();

    if (fullTx) {
      const desc = fullTx.description || '';
      const isDirector = (d: string) => /JOSEPH|LIN PUI|LAI KIN|RAYMOND|SZETO/i.test(d);
      const entryId = `je-${uuidv4().slice(0, 8)}`;
      const bankCode = (fullTx.bank_name || 'BANK').replace(/[^A-Z0-9]/gi, '').slice(0, 6).toUpperCase() || 'BANK';
      const txDate = fullTx.transaction_date || new Date().toISOString().split('T')[0];

      // Generate voucher number
      const ym = txDate.slice(0, 7).replace(/-/g, '');
      const like = `B-${bankCode}-${ym}-%`;
      const lastRow = await db.prepare(
        `SELECT entry_number FROM journal_entries WHERE user_id = ? AND entry_number LIKE ? ORDER BY entry_number DESC LIMIT 1`
      ).bind(tenantId, like).first<{ entry_number: string }>();
      let seq = 1;
      if (lastRow?.entry_number) {
        const parts = lastRow.entry_number.split('-');
        const lastSeq = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(lastSeq)) seq = lastSeq + 1;
      }
      const entryNum = `B-${bankCode}-${ym}-${String(seq).padStart(3, '0')}`;

      // Pre-load accounts for code lookup
      const allAccounts = await db.prepare(
        'SELECT account_code, account_name, account_type FROM accounts WHERE user_id = ? AND is_active = 1'
      ).bind(tenantId).all();
      const accountMap = new Map<string, { name: string; type: string }>();
      for (const a of allAccounts.results as any[]) {
        accountMap.set(a.account_code, { name: a.account_name, type: a.account_type });
      }

      const lines: { code: string; name: string; debit: number; credit: number }[] = [];

      // Real bank account as contra (falls back HSBC→11102 / other→11103)
      const stmtBankCode: string = fullTx.stmt_account_code || resolveBankAccountCode(fullTx.bank_name);
      // Engine-first categorization; explicit user assignment (account_code) wins
      const cat = categorizeTransaction(desc, fullTx.deposit_amount > 0 ? 'deposit' : 'withdrawal');
      const nameOf = (code: string) => accountMap.get(code)?.name || code;

      if (fullTx.deposit_amount > 0) {
        if (desc.includes('OUTCLEARING') || desc.includes('RETURN') || desc.includes('退票')) {
          lines.push({ code: '21201', name: 'Director Loan', debit: fullTx.deposit_amount, credit: 0 });
        } else {
          let contraCode: string | null = null;
          if (fullTx.account_code && fullTx.account_code !== stmtBankCode) contraCode = fullTx.account_code;
          else if (cat?.code && cat.code !== stmtBankCode) contraCode = cat.code;
          else if (isDirector(desc)) contraCode = '21201';
          else contraCode = '41101';
          lines.push({ code: contraCode, name: nameOf(contraCode), debit: 0, credit: fullTx.deposit_amount });
        }
        lines.push({ code: stmtBankCode, name: nameOf(stmtBankCode), debit: fullTx.deposit_amount, credit: 0 });
      }
      if (fullTx.withdrawal_amount > 0) {
        if (desc.includes('OUTCLEARING') || desc.includes('RETURN') || desc.includes('退票')) {
          lines.push({ code: '21201', name: 'Director Loan', debit: fullTx.withdrawal_amount, credit: 0 });
        } else {
          let expCode: string;
          if (fullTx.account_code && fullTx.account_code !== stmtBankCode) expCode = fullTx.account_code;
          else if (cat?.code && cat.code !== stmtBankCode) expCode = cat.code;
          else expCode = '62303';
          lines.push({ code: expCode, name: nameOf(expCode), debit: fullTx.withdrawal_amount, credit: 0 });
        }
        lines.push({ code: stmtBankCode, name: nameOf(stmtBankCode), debit: 0, credit: fullTx.withdrawal_amount });
      }

      if (lines.length > 0) {
        await db.prepare(
          'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(entryId, tenantId, entryNum, txDate, desc, 'bank_transaction', fullTx.id, 'draft').run();

        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          await db.prepare(
            'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(`jl-${uuidv4().slice(0, 8)}`, entryId, l.code, l.name, desc, l.debit, l.credit, i).run();
        }
      }
    }
  }

  const row = await db.prepare('SELECT * FROM bank_transactions WHERE id = ? AND deleted_at IS NULL').bind(txId).first();
  return c.json(row);
});

// ── Delete a single transaction (used during review) ──
bank.delete('/transactions/:id', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const txId = c.req.param('id');
  const tx = await db.prepare('SELECT id FROM bank_transactions WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .bind(txId, tenantId).first();
  if (!tx) return c.json({ error: 'Transaction not found' }, 404);
  await db.prepare('DELETE FROM bank_transactions WHERE id = ? AND user_id = ? AND deleted_at IS NULL').bind(txId, tenantId).run();
  await auditLog(db, user.id, 'delete', 'bank_transaction', txId, {});
  return c.json({ success: true });
});

// ── Confirm or unlink a match (unified engine, 2026-08-17) ──
// confirm validates direction/amount/currency/already-paid/idempotency, then in one
// place: links the tx, marks the invoice paid, syncs file_records.payment_status,
// and posts the GL payment entry (server-side — all UIs get the same end state).
// unlink/reject reverts: resets the tx, un-pays the invoice, deletes the payment JE,
// and resets the file's payment_status.
bank.patch('/transactions/:id/match', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const txId = c.req.param('id');
  const body = await c.req.json();
  const { action } = body;
  let { invoice_id } = body;

  const tx = await db.prepare(
    `SELECT bt.id, bt.transaction_date, bt.deposit_amount, bt.withdrawal_amount,
            bt.invoice_id as current_invoice_id, bt.match_status,
            COALESCE(bs.currency, 'HKD') as currency
     FROM bank_transactions bt LEFT JOIN bank_statements bs ON bt.bank_statement_id = bs.id
     WHERE bt.id = ? AND bt.user_id = ? AND bt.deleted_at IS NULL`
  ).bind(txId, tenantId).first<{ id: string; transaction_date: string; deposit_amount: number; withdrawal_amount: number; current_invoice_id: string | null; match_status: string; currency: string }>();
  if (!tx) return c.json({ error: 'Transaction not found' }, 404);

  // For 'confirm': if no invoice_id passed, use the one already set on the tx (from suggestion badges)
  if (action === 'confirm' && !invoice_id) invoice_id = tx.current_invoice_id || undefined;
  // For 'link': alias for confirm with an explicit invoice_id (manual linking)
  const effectiveAction = action === 'link' ? 'confirm' : action;

  if (effectiveAction === 'confirm' && invoice_id) {
    const inv = await db.prepare(
      'SELECT id, status, total, direction, currency, file_id FROM invoices WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    ).bind(invoice_id, tenantId).first<{ id: string; status: string; total: number; direction: string; currency: string | null; file_id: string | null }>();
    if (!inv) return c.json({ error: 'Invoice not found' }, 404);

    // Idempotency: transaction already confirmed
    if (tx.match_status === 'confirmed') {
      if (tx.current_invoice_id === invoice_id) return c.json({ error: 'Transaction already matched to this invoice' }, 409);
      return c.json({ error: 'Transaction already matched to another invoice — unlink first' }, 409);
    }
    if (inv.status === 'paid') return c.json({ error: 'Invoice already paid' }, 409);

    // Direction: deposits pay AR (outgoing), withdrawals pay AP (incoming)
    const isDeposit = tx.deposit_amount > 0;
    const invIsIncoming = inv.direction === 'incoming';
    if (isDeposit && invIsIncoming) return c.json({ error: 'A deposit cannot pay an incoming (AP) invoice' }, 400);
    if (!isDeposit && !invIsIncoming) return c.json({ error: 'A withdrawal cannot pay an outgoing (AR) invoice' }, 400);

    // Amount within tolerance
    const txAmount = isDeposit ? tx.deposit_amount : tx.withdrawal_amount;
    if (Math.abs(txAmount - inv.total) >= 0.02) return c.json({ error: `Amount mismatch: transaction ${txAmount} vs invoice ${inv.total}` }, 409);

    // Currency
    if ((inv.currency || 'HKD') !== tx.currency) return c.json({ error: `Currency mismatch: ${tx.currency} vs ${inv.currency || 'HKD'}` }, 409);

    await db.prepare(
      `UPDATE bank_transactions SET invoice_id = ?, match_confidence = 'manual', match_status = 'confirmed' WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
    ).bind(invoice_id, txId, tenantId).run();

    await db.prepare(
      `UPDATE invoices SET status = 'paid', paid_date = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`
    ).bind(tx.transaction_date, invoice_id, tenantId).run();

    // Sync the file manager's payment status
    if (inv.file_id) {
      await db.prepare(
        "UPDATE file_records SET payment_status = 'matched', updated_at = datetime('now') WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
      ).bind(inv.file_id, tenantId).run();
    }

    // Post the payment to the GL (idempotent)
    const gl = await postPaymentToGl(db, tenantId, txId);

    await auditLog(db, user.id, 'confirm_match', 'bank_transaction', txId, { invoice_id, action: 'confirm', gl_entry: gl.entry_id || gl.error });
    return c.json({ success: true, invoice_status: 'paid', paid_date: tx.transaction_date, gl_entry_id: gl.entry_id || null, gl_error: gl.error || null });
  }

  // reject/unlink: revert everything this match wrote
  if (effectiveAction === 'reject' || effectiveAction === 'unlink') {
    const linkedInvoiceId = tx.current_invoice_id;

    // Reset the transaction
    await db.prepare(
      `UPDATE bank_transactions SET invoice_id = NULL, match_confidence = NULL, match_status = 'unmatched' WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
    ).bind(txId, tenantId).run();

    if (linkedInvoiceId) {
      // Un-pay the invoice (it was paid by this confirm)
      await db.prepare(
        `UPDATE invoices SET status = 'sent', paid_date = NULL, updated_at = datetime('now') WHERE id = ? AND user_id = ? AND status = 'paid'`
      ).bind(linkedInvoiceId, tenantId).run();

      // Reset the file's payment status
      const invFile = await db.prepare(
        'SELECT file_id FROM invoices WHERE id = ? AND user_id = ?'
      ).bind(linkedInvoiceId, tenantId).first<{ file_id: string | null }>();
      if (invFile?.file_id) {
        await db.prepare(
          "UPDATE file_records SET payment_status = 'unmatched', updated_at = datetime('now') WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
        ).bind(invFile.file_id, tenantId).run();
      }
    }

    // Delete the posted payment JE (journal_lines cascade via FK)
    const jeDel = await db.prepare(
      "DELETE FROM journal_entries WHERE reference_type = 'payment' AND reference_id = ? AND user_id = ?"
    ).bind(txId, tenantId).run();

    await auditLog(db, user.id, 'unlink_match', 'bank_transaction', txId, { action: effectiveAction, gl_entries_deleted: jeDel.meta?.changes || 0 });
    return c.json({ success: true });
  }

  return c.json({ error: 'action must be confirm, link, reject, or unlink' }, 400);
});

// ── Flat transactions list (all transactions for tenant, for reconciliation view) ──
bank.get('/transactions', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const rows = await c.env.DB.prepare(
    `SELECT id, bank_statement_id, transaction_date, description, deposit_amount, withdrawal_amount,
            balance, account_type, account_code, reference, invoice_id, match_status, match_confidence
     FROM bank_transactions WHERE user_id = ? AND deleted_at IS NULL
     AND UPPER(description) NOT LIKE '%B/F BALANCE%'
     AND UPPER(description) NOT LIKE '%C/F BALANCE%'
     AND UPPER(description) NOT LIKE '%OPENING BALANCE%'
     AND UPPER(description) NOT LIKE '%CLOSING BALANCE%'
     AND UPPER(description) NOT LIKE 'B/F%'
     AND UPPER(description) NOT LIKE 'C/F%'
     ORDER BY transaction_date DESC, sort_order DESC`
  ).bind(tenantId).all();
  return c.json({ data: rows.results });
});

// ── Continuity Chain Analysis ──────────────────────────────────────────────
// Groups confirmed statements by (account_number, currency), sorts by period,
// and checks for gaps, overlaps, duplicates, and balance mismatches.
bank.get('/continuity', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;

  const rows = await c.env.DB.prepare(
    `SELECT id, bank_name, account_number, branch, currency,
            statement_year, statement_month, period_start, period_end,
            opening_balance, closing_balance, status
     FROM bank_statements
     WHERE user_id = ? AND deleted_at IS NULL AND (status IS NULL OR status != 'draft')
     ORDER BY account_number, currency, statement_year ASC, statement_month ASC`
  ).bind(tenantId).all();

  const stmts = (rows.results || []) as any[];
  // Filter out rows with no year/month (incomplete uploads)
  const validStmts = stmts.filter((s: any) => s.statement_year && s.statement_month);
  if (validStmts.length === 0) return c.json({ groups: [] });

  // Normalize account numbers (strip spaces, dashes for grouping)
  const normAcct = (s: string) => (s || 'unknown').replace(/[\s\-]/g, '');

  // Group by (normalized account_number, currency)
  const groupMap = new Map<string, any[]>();
  for (const s of validStmts) {
    const key = `${normAcct(s.account_number)}||${s.currency || 'HKD'}`;
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key)!.push(s);
  }

  const groups: any[] = [];

  for (const [key, items] of groupMap.entries()) {
    const [accountNumber, currency] = key.split('||');
    const bankName = items[0]?.bank_name || null;

    // Build chain: for each consecutive pair, compute link status
    const chain: any[] = [];
    for (let i = 0; i < items.length; i++) {
      const curr = items[i];
      const entry: any = {
        id: curr.id,
        statement_year: curr.statement_year,
        statement_month: curr.statement_month,
        period_start: curr.period_start,
        period_end: curr.period_end,
        opening_balance: curr.opening_balance,
        closing_balance: curr.closing_balance,
        issues: [] as string[],
      };

      if (i > 0) {
        const prev = items[i - 1];
        const prevYear = prev.statement_year;
        const prevMonth = prev.statement_month;
        const currYear = curr.statement_year;
        const currMonth = curr.statement_month;

        // Check for duplicate period
        if (prevYear === currYear && prevMonth === currMonth) {
          entry.issues.push('duplicate');
        } else {
          // Check gap: expect consecutive months
          const prevTotal = prevYear * 12 + prevMonth;
          const currTotal = currYear * 12 + currMonth;
          const diff = currTotal - prevTotal;

          if (diff > 1) {
            // There's a gap — list missing months
            const missing: string[] = [];
            for (let m = 1; m < diff; m++) {
              const totalMonth = prevTotal + m;
              const y = Math.floor((totalMonth - 1) / 12);
              const mo = ((totalMonth - 1) % 12) + 1;
              missing.push(`${y}-${String(mo).padStart(2, '0')}`);
            }
            entry.issues.push('gap');
            entry.missing_months = missing;
          } else if (diff < 1) {
            entry.issues.push('overlap');
          }

          // Also check by period_end / period_start dates if available
          if (prev.period_end && curr.period_start) {
            const prevEnd = new Date(prev.period_end);
            const currStart = new Date(curr.period_start);
            const daysDiff = (currStart.getTime() - prevEnd.getTime()) / 86400000;
            if (daysDiff < 0) {
              if (!entry.issues.includes('overlap')) entry.issues.push('date_overlap');
            }
          }
        }

        // Check balance continuity: prev closing should equal curr opening
        if (prev.closing_balance != null && curr.opening_balance != null) {
          if (Math.abs(prev.closing_balance - curr.opening_balance) > 0.005) {
            entry.issues.push('balance_mismatch');
            entry.expected_opening = prev.closing_balance;
            entry.actual_opening = curr.opening_balance;
            entry.mismatch_amount = curr.opening_balance - prev.closing_balance;
          }
        }

        // If no issues, it's matched
        if (entry.issues.length === 0) {
          entry.issues.push('matched');
        }
      } else {
        // First statement in group: no predecessor to compare
        entry.issues.push('first');
      }

      chain.push(entry);
    }

    // Overall group status
    const hasGap = chain.some((c: any) => c.issues.includes('gap'));
    const hasMismatch = chain.some((c: any) => c.issues.includes('balance_mismatch'));
    const hasDuplicate = chain.some((c: any) => c.issues.includes('duplicate'));
    const hasOverlap = chain.some((c: any) => c.issues.includes('overlap') || c.issues.includes('date_overlap'));
    const allMatched = chain.every((c: any) => c.issues.includes('matched') || c.issues.includes('first'));

    groups.push({
      account_number: accountNumber,
      currency,
      bank_name: bankName,
      statement_count: items.length,
      status: allMatched ? 'complete' : hasGap ? 'has_gaps' : hasMismatch ? 'has_mismatches' : hasDuplicate ? 'has_duplicates' : hasOverlap ? 'has_overlaps' : 'issues',
      chain,
    });
  }

  return c.json({ groups });
});

// ── Get single (with transactions) ──
bank.get('/:id', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const stmt = await c.env.DB.prepare(
    `SELECT id, file_name, bank_name, account_number, branch, currency, account_type,
     statement_year, statement_month, period_start, period_end,
     opening_balance, closing_balance, page_count, ocr_text, ocr_source, status,
     balance_status, balance_check, created_at
     FROM bank_statements WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
  ).bind(c.req.param('id'), tenantId).first();
  if (!stmt) return c.json({ error: 'Not found' }, 404);

  const txs = await c.env.DB.prepare(
    `SELECT bt.id, bt.transaction_date, bt.description, bt.deposit_amount, bt.withdrawal_amount,
     bt.balance, bt.account_type, bt.account_code, bt.reference, bt.sort_order,
     bt.invoice_id, bt.match_confidence, bt.match_status, bt.is_edited,
     bt.card_statement_id,
     i.invoice_number, i.total as invoice_total, i.status as invoice_status,
     cs.card_issuer, cs.statement_year as cs_statement_year, cs.statement_month as cs_statement_month,
     cs.closing_balance as cs_closing_balance,
     je.entry_number as voucher_number
     FROM bank_transactions bt
     LEFT JOIN invoices i ON bt.invoice_id = i.id
     LEFT JOIN card_statements cs ON bt.card_statement_id = cs.id
     LEFT JOIN journal_entries je ON je.reference_id = bt.id AND je.reference_type = 'bank_transaction'
      WHERE bt.bank_statement_id = ? AND bt.deleted_at IS NULL
      ORDER BY bt.sort_order`
  ).bind(c.req.param('id')).all();

  // True reconciliation flag: a bank_reconciliations row exists for this statement.
  // (balance_status='ok' only means the balance math checked out at import — the
  // frontend must NOT treat it as reconciled/locked. 2026-08-17)
  const recon = await c.env.DB.prepare(
    'SELECT COUNT(*) as n FROM bank_reconciliations WHERE bank_statement_id = ? AND user_id = ?'
  ).bind(c.req.param('id'), tenantId).first<{ n: number }>();

  return c.json({ ...stmt, transactions: txs.results, is_reconciled: (recon?.n || 0) > 0 });
});

// ── Import (parsed data + transactions) ──
bank.post('/import', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const body = await c.req.json();
  const {
    r2_key, file_name, bank_name, account_number, branch, currency, account_type,
    statement_year, statement_month, period_start, period_end,
    opening_balance, closing_balance, page_count, ocr_text,
    transactions
  } = body;

  if (!r2_key) return c.json({ error: 'r2_key required' }, 400);

  // Dedup: check by r2_key OR by same year/month/account
  let existing = await db.prepare(
    'SELECT id FROM bank_statements WHERE user_id = ? AND r2_key = ? AND deleted_at IS NULL'
  ).bind(tenantId, r2_key).first();
  if (!existing && statement_year && statement_month) {
    existing = await db.prepare(
      'SELECT id FROM bank_statements WHERE user_id = ? AND statement_year = ? AND statement_month = ? AND account_number = ? AND deleted_at IS NULL LIMIT 1'
    ).bind(tenantId, statement_year, statement_month, account_number || null).first();
  }
  if (existing) return c.json({ error: 'Statement already imported for this period', id: (existing as any).id }, 409);

  const id = `bs-${uuidv4().slice(0, 8)}`;
  const fileName = file_name || r2_key.split('/').pop() || 'statement.pdf';

  await db.prepare(
    `INSERT INTO bank_statements (id, user_id, file_name, file_type, file_data, r2_key,
     bank_name, account_number, branch, currency, account_type,
     statement_year, statement_month, period_start, period_end,
     opening_balance, closing_balance, page_count, ocr_text)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, tenantId, fileName, 'application/pdf', '', r2_key,
    bank_name || null, account_number || null, branch || null,
    currency || 'HKD', account_type || null,
    statement_year || null, statement_month || null,
    period_start || null, period_end || null,
    opening_balance ?? null, closing_balance ?? null,
    page_count || null, ocr_text || ''
  ).run();

  let txCount = 0;
  if (transactions && transactions.length > 0) {
    for (const tx of transactions) {
      const txId = `bt-${uuidv4().slice(0, 8)}`;
      await db.prepare(
        `INSERT INTO bank_transactions (id, bank_statement_id, user_id, transaction_date, description,
         deposit_amount, withdrawal_amount, balance, account_type, reference, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(txId, id, tenantId, tx.transaction_date, tx.description,
        tx.deposit_amount || 0, tx.withdrawal_amount || 0, tx.balance ?? 0,
        tx.account_type || account_type || null, tx.reference || null,
        tx.sort_order || txCount
      ).run();
      txCount++;
    }
  }

  await auditLog(db, user.id, 'import', 'bank_statement', id, { file_name: fileName, transactions: txCount });
  return c.json({ id, file_name: fileName, transactions_count: txCount }, 201);
});

// ── Upload (legacy base64) ──
bank.post('/upload', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const body = await c.req.json();
  const { file_name, file_type, file_data, r2_key, bank_name, account_number, branch, currency, statement_year, statement_month } = body;

  if (!file_data && !r2_key) return c.json({ error: 'file_data or r2_key required' }, 400);

  const id = `bs-${uuidv4().slice(0, 8)}`;
  let ocrText = '';
  let openingBalance: number | null = null;
  let closingBalance: number | null = null;

  if (file_data && c.env.AI) {
    try {
      const cleanBase64 = file_data.replace(/^data:.*?;base64,/, '');
      const aiResponse = await c.env.AI.run('@cf/unum/uform-gen2-qwen-500m', {
        prompt: 'Extract all text from this bank statement. Return: Bank Name, Account Number, Statement Period, Opening Balance, Closing Balance, and list of transactions with dates and amounts.',
        image: cleanBase64,
      });
      ocrText = (aiResponse as any)?.description || '';
      const openingMatch = ocrText.match(/(?:Opening|開戶|期初)[^\d]*(\d[\d,]*\.?\d*)/i);
      if (openingMatch) openingBalance = parseFloat(openingMatch[1].replace(/,/g, ''));
      const closingMatch = ocrText.match(/(?:Closing|結餘|期末)[^\d]*(\d[\d,]*\.?\d*)/i);
      if (closingMatch) closingBalance = parseFloat(closingMatch[1].replace(/,/g, ''));
    } catch { /* OCR unavailable */ }
  }

  if (!ocrText && file_name) {
    ocrText = `File: ${file_name} | Bank: ${bank_name || 'N/A'} | ${statement_year}-${String(statement_month || 1).padStart(2, '0')}`;
  }

  await db.prepare(
    `INSERT INTO bank_statements (id, user_id, file_name, file_type, file_data, r2_key,
     bank_name, account_number, branch, currency,
     statement_year, statement_month, opening_balance, closing_balance, ocr_text)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, tenantId, file_name || null, file_type || 'application/pdf',
    file_data || '', r2_key || null,
    bank_name || null, account_number || null, branch || null,
    currency || 'HKD',
    statement_year || null, statement_month || null,
    openingBalance, closingBalance, ocrText).run();

  const row = await db.prepare(
    `SELECT id, file_name, bank_name, account_number, branch, currency,
     statement_year, statement_month, period_start, period_end,
     opening_balance, closing_balance, ocr_text, status, created_at
      FROM bank_statements WHERE id = ? AND deleted_at IS NULL`
  ).bind(id).first();
  return c.json({ ...row, ocr_used: c.env.AI ? !!ocrText && ocrText.length > 20 : false }, 201);
});

// ── Delete (SOFT DELETE — sets deleted_at) ──
// Requires 'higher' permission tier. Cascades soft-delete to child transactions + linked file.
// Items can be restored within 30 days via /recycle/:id/restore, then purged automatically.
bank.delete('/:id', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const stmtId = c.req.param('id');

  // Permission gate: only 'higher' tier can delete
  if (!await requireHigherTier(c)) {
    return c.json({
      error: 'Only account owner or boss-level users can delete records',
      hint: 'Ask your admin to grant you higher permission, or ask them to perform the delete.',
    }, 403);
  }

  console.log(`[DELETE-BANK] looking for id=${stmtId} user_id=${tenantId}`);
  const existing = await db.prepare(
    'SELECT id, file_name, r2_key FROM bank_statements WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(stmtId, tenantId).first<{ id: string; file_name: string; r2_key: string | null }>();
  console.log(`[DELETE-BANK] found=${!!existing} id=${stmtId}`);
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const now = new Date().toISOString();

  // 1) Soft-delete all transactions belonging to this statement
  const txDel = await db.prepare(
    'UPDATE bank_transactions SET deleted_at = ? WHERE bank_statement_id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(now, stmtId, tenantId).run();

  // 1b) Tombstone any journal entries auto-generated from those transactions, so they
  // stop being counted on the dashboard/ledger. They aren't deleted outright so a restore
  // (within the 30-day recycle window) can bring them back — and because deleted_at is
  // separate from status, each entry keeps its own lifecycle value across the round trip.
  const jeStaled = await db.prepare(
    `UPDATE journal_entries SET deleted_at = ?, updated_at = ?
     WHERE user_id = ? AND reference_type = 'bank_transaction' AND ${jeLive('journal_entries')}
     AND reference_id IN (SELECT id FROM bank_transactions WHERE bank_statement_id = ? AND user_id = ?)`
  ).bind(now, now, tenantId, stmtId, tenantId).run();

  // 2) Soft-delete the linked file_record row
  let fileDel = false;
  if (existing.r2_key) {
    const fRes = await db.prepare(
      "UPDATE file_records SET deleted_at = ?, deleted_by = ? WHERE r2_key = ? AND user_id = ? AND deleted_at IS NULL"
    ).bind(now, user.id, existing.r2_key, tenantId).run();
    fileDel = (fRes.meta?.changes || 0) > 0;
  }

  // 3) Soft-delete the statement itself
  await db.prepare(
    'UPDATE bank_statements SET deleted_at = ?, deleted_by = ? WHERE id = ? AND user_id = ?'
  ).bind(now, user.id, stmtId, tenantId).run();

  await auditLog(c.env.DB, user.id, 'soft_delete', 'bank_statement', stmtId, {
    transactions_deleted: txDel.meta?.changes || 0,
    journal_entries_staled: jeStaled.meta?.changes || 0,
    file_deleted: fileDel,
    restorable_until: new Date(Date.now() + 30 * 86400_000).toISOString(),
  });
  return c.json({
    success: true,
    transactions_deleted: txDel.meta?.changes || 0,
    file_deleted: fileDel,
    restorable_until: new Date(Date.now() + 30 * 86400_000).toISOString(),
  });
});

// ── Auto-categorize transactions by description patterns ──
bank.post('/:id/auto-categorize', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const stmtId = c.req.param('id');

  const stmt = await db.prepare(
    'SELECT id, bank_name, account_number, account_code, statement_year, statement_month FROM bank_statements WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(stmtId, tenantId).first<{ id: string; bank_name: string | null; account_number: string | null; account_code: string | null; statement_year: number | null; statement_month: number | null }>();
  if (!stmt) return c.json({ error: 'Statement not found' }, 404);

  // Persist this statement's COA bank account if not yet resolved
  try {
    const stmtBankCode = stmt.account_code || resolveBankAccountCode(stmt.bank_name);
    if (!stmt.account_code) {
      await db.prepare(
        "UPDATE bank_statements SET account_code = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
      ).bind(stmtBankCode, stmtId, tenantId).run();
    }
  } catch { /* non-critical */ }

  // Duplicate guard: if another active statement for the same bank+account+period
  // already has journal entries, skip auto-categorize to prevent double-counting
  if (stmt.bank_name && stmt.account_number && stmt.statement_year && stmt.statement_month) {
    const dup = await db.prepare(
      `SELECT bs.id FROM bank_statements bs
       JOIN bank_transactions bt ON bt.bank_statement_id = bs.id AND bt.deleted_at IS NULL
       JOIN journal_entries je ON je.reference_id = bt.id AND je.reference_type = 'bank_transaction'
       WHERE bs.user_id = ? AND bs.bank_name = ? AND bs.account_number = ?
       AND bs.statement_year = ? AND bs.statement_month = ? AND bs.id != ? AND bs.deleted_at IS NULL
       LIMIT 1`
    ).bind(tenantId, stmt.bank_name, stmt.account_number, stmt.statement_year, stmt.statement_month, stmtId).first();
    if (dup) {
      return c.json({ categorized: 0, skipped: 0, total: 0, journal_skipped: true, reason: 'A statement for this period already has journal entries. Skipping to prevent double-counting.' });
    }
  }

  // Categorize via the shared engine (single source of truth)
  const txs = await db.prepare(
    'SELECT id, description, deposit_amount, withdrawal_amount FROM bank_transactions WHERE bank_statement_id = ? AND deleted_at IS NULL AND account_code IS NULL ORDER BY sort_order'
  ).bind(stmtId).all();

  let categorized = 0;
  let skipped = 0;
  const results: string[] = [];
  const matchedCodes = new Set<string>();

  for (const tx of txs.results as any[]) {
    const desc = tx.description || '';
    const dir = (tx.deposit_amount > 0 ? 'deposit' : 'withdrawal') as 'deposit' | 'withdrawal';
    const r = categorizeTransaction(desc, dir);
    if (!r || r.code === '') { skipped++; continue; }

    await db.prepare('UPDATE bank_transactions SET account_code = ? WHERE id = ? AND deleted_at IS NULL')
      .bind(r.code, tx.id).run();
    matchedCodes.add(r.code);
    results.push(`${tx.transaction_date?.slice(0,10)} | ${r.code} | ${desc.slice(0,50)}`);
    categorized++;
  }

  // Auto-complete compliance items for government fees
  const complianceMap: Record<string, string> = { '63201': 'BR', '63202': 'NAR1' };
  let complianceUpdated = 0;
  for (const code of matchedCodes) {
    const tag = complianceMap[code];
    if (!tag) continue;
    const updated = await db.prepare(
      `UPDATE member_compliance SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
       WHERE user_id = ? AND status = 'pending' AND template_id IN
       (SELECT id FROM compliance_templates WHERE (title_en LIKE ? OR title_zh LIKE ?) AND is_required = 1)`
    ).bind(tenantId, `%${tag}%`, `%${tag}%`).run();
    complianceUpdated += (updated as any)?.changes || 0;
  }

  await auditLog(db, user.id, 'auto_categorize', 'bank_statement', stmtId, { categorized, skipped, compliance_updated: complianceUpdated });
  return c.json({ categorized, skipped, total: txs.results.length, results: results.slice(0, 20), compliance_updated: complianceUpdated });
});

// ── Import CSV (update transactions) ──
bank.post('/:id/import-csv', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;

  const stmt = await db.prepare('SELECT id FROM bank_statements WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .bind(c.req.param('id'), tenantId).first();
  if (!stmt) return c.json({ error: 'Not found' }, 404);

  const body = await c.req.json();
  const { csv } = body as { csv: string };
  if (!csv) return c.json({ error: 'csv required' }, 400);

  const lines = csv.trim().split('\n');
  if (lines.length < 2) return c.json({ error: 'CSV must have header + data rows' }, 400);

  let updated = 0;
  let created = 0;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 4) continue;
    const date = cols[0]?.replace(/"/g, '').trim();
    const desc = cols[1]?.replace(/"/g, '').trim();
    const dep = parseFloat(cols[2]?.replace(/"/g, '').trim()) || 0;
    const wit = parseFloat(cols[3]?.replace(/"/g, '').trim()) || 0;
    const bal = cols[4] ? (parseFloat(cols[4]?.replace(/"/g, '').trim()) || null) : null;
    const acctType = cols[5]?.replace(/"/g, '').trim() || '';
    const acctCode = cols[6]?.replace(/"/g, '').trim() || '';
    const ref = cols[7]?.replace(/"/g, '').trim() || '';

    // Try to match by date + amount
    const existing = await db.prepare(
      'SELECT id FROM bank_transactions WHERE bank_statement_id = ? AND transaction_date = ? AND ABS(deposit_amount + withdrawal_amount - ?) < 0.01 AND deleted_at IS NULL LIMIT 1'
    ).bind(c.req.param('id'), date, dep + wit).first<{ id: string }>();

    if (existing) {
      await db.prepare(
        'UPDATE bank_transactions SET description = ?, deposit_amount = ?, withdrawal_amount = ?, balance = ?, account_type = ?, account_code = ?, reference = ? WHERE id = ? AND deleted_at IS NULL'
      ).bind(desc, dep, wit, bal, acctType, acctCode || null, ref || null, existing.id).run();
      updated++;
    } else if (desc) {
      const txId = `bt-${uuidv4().slice(0, 8)}`;
      await db.prepare(
        'INSERT INTO bank_transactions (id, bank_statement_id, user_id, transaction_date, description, deposit_amount, withdrawal_amount, balance, account_type, account_code, reference, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(txId, c.req.param('id'), tenantId, date, desc, dep, wit, bal, acctType, acctCode || null, ref || null, i).run();
      created++;
    }
  }

  return c.json({ updated, created, total: lines.length - 1 });
});

// ── Bank Reconciliation ──

// Preview reconciliation for a statement
bank.post('/:id/reconcile', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const stmtId = c.req.param('id');

  const stmt = await db.prepare(
    'SELECT * FROM bank_statements WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(stmtId, tenantId).first<{ id: string; closing_balance: number; period_end: string; account_number: string; account_code: string | null }>();
  if (!stmt) return c.json({ error: 'Statement not found' }, 404);

  // Get GL bank balance as of statement period end for the specific bank account
  const glAccountCode = stmt.account_code || '11101';
  const glBalance = await db.prepare(
    `SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) as balance
     FROM journal_lines jl JOIN journal_entries je ON jl.entry_id = je.id
     WHERE je.user_id = ? AND je.entry_date <= ? AND jl.account_code = ? AND ${jePosted()} AND ${jeNotOrphaned()}`
  ).bind(tenantId, stmt.period_end || new Date().toISOString().split('T')[0], glAccountCode).first<{ balance: number }>();

  // Get outstanding (un-reconciled) transactions
  const outstandingTxs = await db.prepare(
    `SELECT id, transaction_date, description, deposit_amount, withdrawal_amount
     FROM bank_transactions
     WHERE bank_statement_id = ? AND deleted_at IS NULL AND match_status NOT IN ('confirmed')
     ORDER BY transaction_date`
  ).bind(stmtId).all();

  const glBal = glBalance?.balance || 0;
  const statementBal = stmt.closing_balance || 0;
  const difference = statementBal - glBal;

  return c.json({
    statement_id: stmtId,
    statement_balance: statementBal,
    gl_balance: glBal,
    difference,
    outstanding_transactions: outstandingTxs.results,
    matched: Math.abs(difference) < 0.01,
  });
});

// Save a completed reconciliation
bank.post('/:id/reconcile/save', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const stmtId = c.req.param('id');
  const body = await c.req.json();
  const { account_code, statement_balance, gl_balance, outstanding_deposits, outstanding_withdrawals, reconciled_balance, notes } = body;

  const stmt = await db.prepare(
    'SELECT id, period_end FROM bank_statements WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(stmtId, tenantId).first<{ id: string; period_end: string }>();
  if (!stmt) return c.json({ error: 'Statement not found' }, 404);

  const id = `br-${uuidv4().slice(0, 8)}`;
  const difference = (statement_balance || 0) - (reconciled_balance || 0);

  await db.prepare(
    `INSERT INTO bank_reconciliations (id, user_id, bank_statement_id, account_code,
     statement_date, statement_balance, gl_balance,
     outstanding_deposits, outstanding_withdrawals, reconciled_balance, difference, notes, reconciled_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, tenantId, stmtId, account_code || '11101',
    stmt.period_end || new Date().toISOString().split('T')[0],
    statement_balance || 0, gl_balance || 0,
    outstanding_deposits || 0, outstanding_withdrawals || 0,
    reconciled_balance || 0, difference, notes || null, user.id).run();

  return c.json({ id, difference, status: Math.abs(difference) < 0.01 ? 'balanced' : 'difference' }, 201);
});

// List reconciliations
bank.get('/reconciliations/list', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const rows = await c.env.DB.prepare(
    `SELECT br.*, bs.bank_name, bs.account_number, bs.statement_year, bs.statement_month
     FROM bank_reconciliations br
      JOIN bank_statements bs ON br.bank_statement_id = bs.id AND bs.deleted_at IS NULL
     WHERE br.user_id = ?
     ORDER BY br.created_at DESC`
  ).bind(tenantId).all();
  return c.json({ data: rows.results });
});

// ── RECYCLE BIN ──────────────────────────────────────────────────────
// GET /recycle — list soft-deleted items for tenant (30-day retention).
// POST /recycle/:type/:id/restore — restore a soft-deleted item.
// DELETE /recycle/:type/:id — permanently delete right now.
// All require 'higher' permission tier.

bank.get('/recycle/list', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  if (!await requireHigherTier(c)) return c.json({ error: 'Higher permission tier required' }, 403);
  const db = c.env.DB;
  const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
  // Statements
  const stmts = await db.prepare(
    `SELECT id, file_name, bank_name, account_number, statement_year, statement_month,
            opening_balance, closing_balance, deleted_at, deleted_by
     FROM bank_statements WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at > ?
     ORDER BY deleted_at DESC`
  ).bind(tenantId, cutoff).all();
  // Files
  const files = await db.prepare(
    `SELECT id, filename, original_name, folder, category, deleted_at, deleted_by
     FROM file_records WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at > ?
     ORDER BY deleted_at DESC`
  ).bind(tenantId, cutoff).all();
  // Invoices (soft-deleted, aligned with the bank statement flow)
  const invoices = await db.prepare(
    `SELECT id, invoice_number, receipt_number, vendor_name, direction, total, deleted_at, deleted_by
     FROM invoices WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at > ?
     ORDER BY deleted_at DESC`
  ).bind(tenantId, cutoff).all();
  return c.json({
    bank_statements: stmts.results,
    files: files.results,
    invoices: invoices.results,
    retention_days: 30,
  });
});

bank.post('/recycle/:type/:id/restore', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  if (!await requireHigherTier(c)) return c.json({ error: 'Higher permission tier required' }, 403);
  const db = c.env.DB;
  const type = c.req.param('type');
  const id = c.req.param('id');

  if (type === 'bank_statement') {
    const r = await db.prepare(
      'UPDATE bank_statements SET deleted_at = NULL, deleted_by = NULL WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL'
    ).bind(id, tenantId).run();
    if (!(r.meta?.changes)) return c.json({ error: 'Not found in recycle bin' }, 404);
    // Restore transactions too
    await db.prepare(
      'UPDATE bank_transactions SET deleted_at = NULL WHERE bank_statement_id = ? AND user_id = ?'
    ).bind(id, tenantId).run();
    // Un-tombstone the journal entries auto-generated from those transactions.
    // Only deleted_at is cleared — status is left alone, so an entry that was a
    // draft before the delete comes back as a draft rather than being promoted
    // to 'posted' (which the old status-based tombstone did).
    await db.prepare(
      `UPDATE journal_entries SET deleted_at = NULL, updated_at = ?
       WHERE user_id = ? AND reference_type = 'bank_transaction' AND ${jeDeleted('journal_entries')}
       AND reference_id IN (SELECT id FROM bank_transactions WHERE bank_statement_id = ? AND user_id = ?)`
    ).bind(new Date().toISOString(), tenantId, id, tenantId).run();
    // Restore linked file record too
    const stmt = await db.prepare(
      'SELECT r2_key FROM bank_statements WHERE id = ? AND user_id = ?'
    ).bind(id, tenantId).first<{ r2_key: string | null }>();
    if (stmt?.r2_key) {
      await db.prepare(
        'UPDATE file_records SET deleted_at = NULL, deleted_by = NULL WHERE r2_key = ? AND user_id = ?'
      ).bind(stmt.r2_key, tenantId).run();
    }
    await auditLog(db, user.id, 'restore', 'bank_statement', id);
    return c.json({ success: true });
  }

  if (type === 'file') {
    const r = await db.prepare(
      'UPDATE file_records SET deleted_at = NULL, deleted_by = NULL WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL'
    ).bind(id, tenantId).run();
    if (!(r.meta?.changes)) return c.json({ error: 'Not found in recycle bin' }, 404);
    await auditLog(db, user.id, 'restore', 'file_record', id);
    return c.json({ success: true });
  }

  if (type === 'invoice') {
    const r = await db.prepare(
      'UPDATE invoices SET deleted_at = NULL, deleted_by = NULL WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL'
    ).bind(id, tenantId).run();
    if (!(r.meta?.changes)) return c.json({ error: 'Not found in recycle bin' }, 404);
    // Revive the ledger entries tombstoned when the invoice was deleted. Payment
    // entries only come back if their bank transaction is still live — a payment
    // whose statement is also deleted stays tombstoned until that is restored too.
    const jeRestored = await restoreInvoiceJournal(db, tenantId, id);
    await auditLog(db, user.id, 'restore', 'invoice', id, { journal_entries_restored: jeRestored });
    return c.json({ success: true, journal_entries_restored: jeRestored });
  }

  return c.json({ error: 'Unknown type. Use bank_statement, file, or invoice.' }, 400);
});

bank.delete('/recycle/:type/:id', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  if (!await requireHigherTier(c)) return c.json({ error: 'Higher permission tier required' }, 403);
  const db = c.env.DB;
  const type = c.req.param('type');
  const id = c.req.param('id');

  if (type === 'bank_statement') {
    // Ensure it's actually in the bin
    const s = await db.prepare(
      'SELECT id, r2_key FROM bank_statements WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL'
    ).bind(id, tenantId).first<{ id: string; r2_key: string | null }>();
    if (!s) return c.json({ error: 'Not found in recycle bin' }, 404);
    // Hard delete: bank_transactions, bank_statement, file_record, R2 blob
    await db.prepare('DELETE FROM bank_transactions WHERE bank_statement_id = ? AND user_id = ?').bind(id, tenantId).run();
    if (s.r2_key) {
      await db.prepare('DELETE FROM file_records WHERE r2_key = ? AND user_id = ?').bind(s.r2_key, tenantId).run();
      try { await c.env.FILE_BUCKET.delete(s.r2_key); } catch {}
    }
    await db.prepare('DELETE FROM bank_statements WHERE id = ? AND user_id = ?').bind(id, tenantId).run();
    await auditLog(db, user.id, 'purge', 'bank_statement', id);
    return c.json({ success: true });
  }

  if (type === 'file') {
    const f = await db.prepare(
      'SELECT id, r2_key FROM file_records WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL'
    ).bind(id, tenantId).first<{ id: string; r2_key: string | null }>();
    if (!f) return c.json({ error: 'Not found in recycle bin' }, 404);
    // Hard-delete any invoices linked to this file (invoice_items cascade via FK)
    await db.prepare('DELETE FROM invoices WHERE file_id = ? AND user_id = ?').bind(id, tenantId).run();
    if (f.r2_key) { try { await c.env.FILE_BUCKET.delete(f.r2_key); } catch {} }
    await db.prepare('DELETE FROM file_records WHERE id = ? AND user_id = ?').bind(id, tenantId).run();
    await auditLog(db, user.id, 'purge', 'file_record', id);
    return c.json({ success: true });
  }

  if (type === 'invoice') {
    const inv = await db.prepare(
      'SELECT id FROM invoices WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL'
    ).bind(id, tenantId).first<{ id: string }>();
    if (!inv) return c.json({ error: 'Not found in recycle bin' }, 404);
    // Hard-delete the tombstoned ledger entries FIRST — the payment lookup joins
    // through bank_transactions.invoice_id, which stops resolving once the
    // invoice row is gone, and the entry would be orphaned beyond tracing.
    const jePurged = await purgeInvoiceJournal(db, tenantId, id);
    // Break receipt↔invoice links pointing at this row before the hard delete
    await db.prepare('UPDATE invoices SET linked_invoice_id = NULL WHERE linked_invoice_id = ? AND user_id = ?').bind(id, tenantId).run();
    // Hard delete (invoice_items cascade via FK). The linked file stays in File Storage.
    await db.prepare('DELETE FROM invoices WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL').bind(id, tenantId).run();
    await auditLog(db, user.id, 'purge', 'invoice', id, { journal_entries_purged: jePurged });
    return c.json({ success: true, journal_entries_purged: jePurged });
  }

  return c.json({ error: 'Unknown type. Use bank_statement, file, or invoice.' }, 400);
});

// Auto-purge items older than 30 days. Callable manually; can also be wired to a cron.
bank.post('/recycle/purge-old', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  if (!await requireHigherTier(c)) return c.json({ error: 'Higher permission tier required' }, 403);
  const db = c.env.DB;
  const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
  // Hard-delete invoices linked to files being purged (no deleted_at on invoices table)
  const deletedFileIds = await db.prepare(
    `SELECT id FROM file_records WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?`
  ).bind(tenantId, cutoff).all<{ id: string }>();
  for (const row of deletedFileIds.results) {
    await db.prepare('DELETE FROM invoices WHERE file_id = ? AND user_id = ?').bind(row.id, tenantId).run();
  }
  // Hard-delete stale journal entries tied to bank transactions about to be purged
  // (must run before the bank_transactions themselves are deleted, since the lookup
  // below joins on them; journal_lines cascade automatically via FK).
  const je = await db.prepare(
    `DELETE FROM journal_entries WHERE user_id = ? AND reference_type = 'bank_transaction' AND ${jeDeleted('journal_entries')}
     AND reference_id IN (SELECT id FROM bank_transactions WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?)`
  ).bind(tenantId, tenantId, cutoff).run();
  const s = await db.prepare(
    `DELETE FROM bank_statements WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?`
  ).bind(tenantId, cutoff).run();
  const t = await db.prepare(
    `DELETE FROM bank_transactions WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?`
  ).bind(tenantId, cutoff).run();
  const f = await db.prepare(
    `DELETE FROM file_records WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?`
  ).bind(tenantId, cutoff).run();
  // Soft-deleted invoices past retention: break receipt↔invoice links, then hard-delete
  await db.prepare(
    `UPDATE invoices SET linked_invoice_id = NULL WHERE user_id = ? AND linked_invoice_id IN
     (SELECT id FROM invoices WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?)`
  ).bind(tenantId, tenantId).run();
  const inv = await db.prepare(
    `DELETE FROM invoices WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?`
  ).bind(tenantId, cutoff).run();
  return c.json({
    success: true,
    purged: {
      statements: s.meta?.changes || 0,
      transactions: t.meta?.changes || 0,
      files: f.meta?.changes || 0,
      invoices: inv.meta?.changes || 0,
      journal_entries: je.meta?.changes || 0,
    },
    older_than: cutoff,
  });
});

// Create a new transaction on a statement (used by "Add Row" on the review page,
// especially when OCR failed and the user enters transactions manually).
bank.post('/:id/transactions', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const stmtId = c.req.param('id');
  const body = await c.req.json();

  const stmt = await c.env.DB.prepare(
    'SELECT id FROM bank_statements WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(stmtId, tenantId).first();
  if (!stmt) return c.json({ error: 'Statement not found' }, 404);

  // Determine next sort_order
  const cnt = await c.env.DB.prepare(
    'SELECT COUNT(*) as n FROM bank_transactions WHERE bank_statement_id = ? AND deleted_at IS NULL'
  ).bind(stmtId).first<{ n: number }>();
  const sortOrder = (cnt?.n || 0);

  const txId = `tx-${crypto.randomUUID().slice(0, 12)}`;
  await c.env.DB.prepare(
    `INSERT INTO bank_transactions (id, bank_statement_id, user_id, transaction_date, description,
     deposit_amount, withdrawal_amount, balance, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(
    txId, stmtId, tenantId,
    body.transaction_date || null,
    body.description || '',
    Number(body.deposit_amount) || 0,
    Number(body.withdrawal_amount) || 0,
    body.balance != null ? Number(body.balance) : null,
    sortOrder
  ).run();
  return c.json({ success: true, id: txId });
});

export { bank as bankStatementRoutes };
