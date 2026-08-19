import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { verify as jwtVerify } from 'jsonwebtoken';
import { Bindings, Variables } from '../types';
import { authMiddleware, requireHigherTier } from '../middleware/auth';
import { getJwtSecret } from '../middleware/auth';
import { jeLive } from '../lib/journal-filters';
const card = new Hono<{ Bindings: Bindings; Variables: Variables }>();
// Audit log helper
async function auditLog(db: any, userId: string, action: string, entityType: string, entityId: string | null, changes?: object) {
  const id = `al-${uuidv4().slice(0, 8)}`;
  try {
    await db.prepare(
      'INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, changes) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(id, userId, action, entityType, entityId, changes ? JSON.stringify(changes) : null).run();
  } catch { /* audit log table may not exist */ }
}
// Extract JWT from cookie, header, or query param (for file downloads)
function extractJwt(c: any, secret: string): string | null {
  const cookieHeader = c.req.header('Cookie') || '';
  const cookieMatch = cookieHeader.match(/(?:^|;\s*)token=([^;]+)/);
  if (cookieMatch) return cookieMatch[1];
  const auth = c.req.header('Authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  const qt = c.req.query('token');
  if (qt) return qt;
  return null;
}
// ── Download file (token-protected) ──
card.get('/:id/file', async (c) => {
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
    'SELECT file_data, r2_key, file_type, file_name, user_id FROM card_statements WHERE id = ? AND deleted_at IS NULL'
  ).bind(c.req.param('id')).first<{ file_data: string; r2_key: string | null; file_type: string; file_name: string; user_id: string }>();
  if (!row) return c.json({ error: 'Not found' }, 404);
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
    return c.json({ data: row.file_data, file_type: row.file_type }, 200);
  }
  return c.json({ error: 'File not available' }, 404);
});
// ── Export CSV ──
card.get('/:id/export-csv', async (c) => {
  let userId: string | null = null;
  const token = extractJwt(c, getJwtSecret(c.env));
  if (token) {
    try { const payload = jwtVerify(token, getJwtSecret(c.env)) as { id: string }; userId = payload.id; } catch {}
  }
  if (!userId) return c.json({ error: 'Authentication required' }, 401);
  const rows = await c.env.DB.prepare(
    `SELECT transaction_date, description, amount, transaction_type, category, expense_account_code, reference
     FROM card_transactions WHERE card_statement_id = ? AND user_id = ? AND deleted_at IS NULL ORDER BY sort_order`
  ).bind(c.req.param('id'), userId).all();
  const csv = ['Date,Description,Amount,Type,Category,Account Code,Reference'];
  for (const r of rows.results as any[]) {
    csv.push([r.transaction_date, `"${(r.description || '').replace(/"/g, '""')}"`, r.amount, r.transaction_type || '', r.category || '', r.expense_account_code || '', r.reference || ''].join(','));
  }
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="card-statement-${c.req.param('id')}.csv"`);
  return c.text(csv.join('\n'));
});
// ── Apply auth to all remaining routes ──
card.use('*', authMiddleware);
// ── List statements ──
card.get('/', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const year = c.req.query('year') || '';
  const showDrafts = c.req.query('show_drafts') === '1';
  const onlyDrafts = c.req.query('only_drafts') === '1';
  let q = `SELECT id, file_name, card_issuer, card_network, card_number_last4, cardholder_name, currency,
           statement_year, statement_month, period_start, period_end,
           credit_limit, opening_balance, closing_balance, minimum_payment, payment_due_date,
           status, balance_status, balance_check, created_at
           FROM card_statements WHERE user_id = ? AND deleted_at IS NULL`;
  const p: any[] = [tenantId];
  if (onlyDrafts) {
    q += " AND status = 'draft'";
  } else if (!showDrafts) {
    q += " AND (status IS NULL OR status != 'draft')";
  }
  if (year) { q += ' AND statement_year = ?'; p.push(parseInt(year)); }
  q += ' ORDER BY statement_year DESC, statement_month DESC';
  const rows = await c.env.DB.prepare(q).bind(...p).all();
  return c.json({ data: rows.results });
});
// ── Continuity chain check (moved before /:id) ──
card.get('/continuity', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;

  const rows = await c.env.DB.prepare(
    `SELECT id, card_issuer, card_network, card_number_last4, currency,
            statement_year, statement_month, period_start, period_end,
            opening_balance, closing_balance, status
     FROM card_statements
     WHERE user_id = ? AND deleted_at IS NULL AND (status IS NULL OR status != 'draft')
     ORDER BY card_number_last4, currency, statement_year ASC, statement_month ASC`
  ).bind(tenantId).all();

  const stmts = (rows.results || []) as any[];
  const validStmts = stmts.filter((s: any) => s.statement_year && s.statement_month);
  if (validStmts.length === 0) return c.json({ groups: [] });

  const normCard = (s: string) => (s || 'unknown').replace(/[\s\-]/g, '');

  // Group by (normalized card number, currency)
  const groupMap = new Map<string, any[]>();
  for (const s of validStmts) {
    const key = `${normCard(s.card_number_last4)}||${s.currency || 'HKD'}`;
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key)!.push(s);
  }

  const groups: any[] = [];
  for (const [key, items] of groupMap.entries()) {
    const [cardNumber, currency] = key.split('||');
    const cardIssuer = items[0]?.card_issuer || null;
    const cardNetwork = items[0]?.card_network || null;

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

        if (prevYear === currYear && prevMonth === currMonth) {
          entry.issues.push('duplicate');
        } else {
          const prevTotal = prevYear * 12 + prevMonth;
          const currTotal = currYear * 12 + currMonth;
          const diff = currTotal - prevTotal;
          if (diff > 1) {
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

          if (prev.period_end && curr.period_start) {
            const prevEnd = new Date(prev.period_end);
            const currStart = new Date(curr.period_start);
            const daysDiff = (currStart.getTime() - prevEnd.getTime()) / 86400000;
            if (daysDiff < 0 && !entry.issues.includes('overlap')) entry.issues.push('date_overlap');
          }
        }

        // Balance continuity (only if both values present)
        if (prev.closing_balance != null && curr.opening_balance != null) {
          if (Math.abs(prev.closing_balance - curr.opening_balance) > 0.005) {
            entry.issues.push('balance_mismatch');
            entry.expected_opening = prev.closing_balance;
            entry.actual_opening = curr.opening_balance;
            entry.mismatch_amount = curr.opening_balance - prev.closing_balance;
          }
        }

        if (entry.issues.length === 0) entry.issues.push('matched');
      } else {
        entry.issues.push('first');
      }
      chain.push(entry);
    }

    const hasGap = chain.some((c: any) => c.issues.includes('gap'));
    const hasMismatch = chain.some((c: any) => c.issues.includes('balance_mismatch'));
    const hasDuplicate = chain.some((c: any) => c.issues.includes('duplicate'));
    const hasOverlap = chain.some((c: any) => c.issues.includes('overlap') || c.issues.includes('date_overlap'));
    const allMatched = chain.every((c: any) => c.issues.includes('matched') || c.issues.includes('first'));

    groups.push({
      card_number: cardNumber === 'unknown' ? null : cardNumber,
      card_issuer: cardIssuer,
      card_network: cardNetwork,
      currency,
      statement_count: items.length,
      status: allMatched ? 'complete' : hasGap ? 'has_gaps' : hasMismatch ? 'has_mismatches' : hasDuplicate ? 'has_duplicates' : hasOverlap ? 'has_overlaps' : 'issues',
      chain,
    });
  }

  return c.json({ groups });
});

// ── Soft-delete statement (with cascade) ──
card.post('/import', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const body = await c.req.json();
  const { card_issuer, card_network, card_number_last4, cardholder_name, currency,
          statement_year, statement_month, period_start, period_end,
          credit_limit, opening_balance, closing_balance, minimum_payment, payment_due_date,
          ocr_text, file_name, file_type, file_data, r2_key,
          transactions } = body as any;
  // Duplicate check by r2_key
  if (r2_key) {
    const dup = await c.env.DB.prepare(
      'SELECT id FROM card_statements WHERE r2_key = ? AND user_id = ? AND deleted_at IS NULL'
    ).bind(r2_key, tenantId).first();
    if (dup) return c.json({ error: 'Duplicate file', duplicate_id: dup.id }, 409);
  }
  // Duplicate check by period + card
  if (statement_year && statement_month && card_number_last4) {
    const dup = await c.env.DB.prepare(
      'SELECT id FROM card_statements WHERE statement_year = ? AND statement_month = ? AND card_number_last4 = ? AND user_id = ? AND deleted_at IS NULL'
    ).bind(statement_year, statement_month, card_number_last4, tenantId).first();
    if (dup) return c.json({ error: 'Statement already imported for this period and card', duplicate_id: dup.id }, 409);
  }
  const id = `cs-${uuidv4().slice(0, 8)}`;
  await c.env.DB.prepare(
    `INSERT INTO card_statements (id, user_id, file_name, file_type, file_data, r2_key,
     card_issuer, card_network, card_number_last4, cardholder_name, currency,
     statement_year, statement_month, period_start, period_end,
     credit_limit, opening_balance, closing_balance, minimum_payment, payment_due_date,
     ocr_text, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`
  ).bind(id, tenantId, file_name || null, file_type || 'application/pdf', file_data || '', r2_key || null,
    card_issuer || null, card_network || null, card_number_last4 || null, cardholder_name || null,
    currency || 'HKD', statement_year || null, statement_month || null,
    period_start || null, period_end || null,
    credit_limit ?? null, opening_balance ?? null, closing_balance ?? null,
    minimum_payment ?? null, payment_due_date || null, ocr_text || null).run();
  if (transactions && Array.isArray(transactions)) {
    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i];
      await c.env.DB.prepare(
        `INSERT INTO card_transactions (id, card_statement_id, user_id, transaction_date, posting_date,
         description, amount, transaction_type, foreign_currency, foreign_amount, category, reference, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(`ct-${uuidv4().slice(0, 8)}`, id, tenantId,
        tx.transaction_date, tx.posting_date || null, tx.description,
        tx.amount || 0, tx.transaction_type || null, tx.foreign_currency || null,
        tx.foreign_amount || null, tx.category || null, tx.reference || null, i).run();
    }
  }
  await auditLog(c.env.DB, tenantId, 'import', 'card_statement', id, { card_issuer, statement_year, statement_month });
  return c.json({ id, status: 'draft', transactions_count: transactions?.length || 0 }, 201);
});
// ── Confirm draft → active ──
card.post('/:id/confirm', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare(
    'SELECT id, status FROM card_statements WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(id, tenantId).first<{ id: string; status: string }>();
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (existing.status !== 'draft') return c.json({ error: 'Already confirmed', status: existing.status }, 400);
  const body = await c.req.json().catch(() => ({}));
  const balanceStatus = body.balance_status || 'unchecked';
  const balanceCheck = body.balance_check ? JSON.stringify(body.balance_check) : null;
  await c.env.DB.prepare(
    "UPDATE card_statements SET status = 'active', balance_status = ?, balance_check = ?, updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL"
  ).bind(balanceStatus, balanceCheck, id).run();
  await auditLog(c.env.DB, tenantId, 'confirm', 'card_statement', id);
  return c.json({ success: true, id, status: 'active' });
});
// ── Edit statement header ──
card.patch('/:id', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const id = c.req.param('id');
  const body = await c.req.json();
  const existing = await c.env.DB.prepare(
    'SELECT id FROM card_statements WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(id, tenantId).first();
  if (!existing) return c.json({ error: 'Not found' }, 404);
  const allowed = ['card_issuer', 'card_network', 'card_number_last4', 'cardholder_name', 'currency',
    'statement_year', 'statement_month', 'period_start', 'period_end',
    'credit_limit', 'opening_balance', 'closing_balance', 'minimum_payment', 'payment_due_date', 'file_name'];
  const sets: string[] = [];
  const params: any[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (allowed.includes(k)) { sets.push(`${k} = ?`); params.push(v); }
  }
  if (sets.length === 0) return c.json({ error: 'No valid fields' }, 400);
  sets.push("updated_at = datetime('now')");
  params.push(id, tenantId);
  await c.env.DB.prepare(
    `UPDATE card_statements SET ${sets.join(', ')} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
  ).bind(...params).run();
  return c.json({ success: true });
});
// ── Update single transaction ──
card.patch('/transactions/:id', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const id = c.req.param('id');
  const body = await c.req.json();
  const existing = await c.env.DB.prepare(
    'SELECT id FROM card_transactions WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(id, tenantId).first();
  if (!existing) return c.json({ error: 'Not found' }, 404);
  const allowed = ['transaction_date', 'posting_date', 'description', 'amount',
    'transaction_type', 'foreign_currency', 'foreign_amount', 'category', 'reference',
    'expense_account_code', 'match_status'];
  const sets: string[] = [];
  const params: any[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (allowed.includes(k)) { sets.push(`${k} = ?`); params.push(v); }
  }
  if (sets.length === 0) return c.json({ error: 'No valid fields' }, 400);
  params.push(id, tenantId);
  await c.env.DB.prepare(
    `UPDATE card_transactions SET ${sets.join(', ')}, is_edited = 1 WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
  ).bind(...params).run();
  return c.json({ success: true });
});
// ── Add transaction ──
card.post('/:id/transactions', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const stmtId = c.req.param('id');
  const body = await c.req.json();
  const maxOrder = await c.env.DB.prepare(
    'SELECT MAX(sort_order) as mx FROM card_transactions WHERE card_statement_id = ? AND deleted_at IS NULL'
  ).bind(stmtId).first<{ mx: number | null }>();
  const sortOrder = (maxOrder?.mx ?? -1) + 1;
  const id = `ct-${uuidv4().slice(0, 8)}`;
  await c.env.DB.prepare(
    `INSERT INTO card_transactions (id, card_statement_id, user_id, transaction_date, posting_date,
     description, amount, transaction_type, foreign_currency, foreign_amount, category, reference, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, stmtId, tenantId,
    body.transaction_date, body.posting_date || null, body.description,
    body.amount || 0, body.transaction_type || null, body.foreign_currency || null,
    body.foreign_amount || null, body.category || null, body.reference || null, sortOrder).run();
  return c.json({ id, sort_order: sortOrder }, 201);
});
// ── Delete transaction ──
card.delete('/transactions/:id', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare(
    'SELECT id FROM card_transactions WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(id, tenantId).first();
  if (!existing) return c.json({ error: 'Not found' }, 404);
  await c.env.DB.prepare('DELETE FROM card_transactions WHERE id = ?').bind(id).run();
  return c.json({ success: true });
});
// ── Auto-categorize: map transaction descriptions to COA expense accounts ──
card.post('/:id/auto-categorize', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const stmtId = c.req.param('id');
  const db = c.env.DB;
  const txs = await db.prepare(
    `SELECT id, description, amount FROM card_transactions
     WHERE card_statement_id = ? AND user_id = ? AND expense_account_code IS NULL AND deleted_at IS NULL`
  ).bind(stmtId, tenantId).all();
  const rules: { pattern: RegExp; code: string; name: string }[] = [
    { pattern: /RENT|租金|租/, code: '62101', name: 'Rent' },
    { pattern: /SALARY|PAYROLL|WAGE|薪金|工資|工资/, code: '61201', name: 'Salaries' },
    { pattern: /OFFICE|OFFICE SUPPLIES|文具|辦公|办公/, code: '62301', name: 'Office Supplies' },
    { pattern: /ELECTRICITY|CLP|HK ELECTRIC|電費|电费/, code: '62201', name: 'Electricity' },
    { pattern: /WATER|水費|水费/, code: '62202', name: 'Water' },
    { pattern: /TELECOM|PHONE|MOBILE|BROADBAND|電訊|電信|通讯/, code: '62302', name: 'Telecom' },
    { pattern: /SOFTWARE|SUBSCRIPTION|CLOUD|AWS|GOOGLE|MICROSOFT|ADOBE/, code: '62303', name: 'Software Subscriptions' },
    { pattern: /PASTEL\s*TECH|SUBCONTRACT|SUB-CONTRACT|OUTSOURC|外判|顧問費/, code: '51101', name: 'Subcontractor Fees' },
    { pattern: /INSURANCE|保險|保险/, code: '63101', name: 'Insurance' },
    { pattern: /TRANSPORT|TAXI|UBER|MTR|BUS|交通/, code: '64101', name: 'Transport' },
    { pattern: /MEAL|RESTAURANT|DINING|餐飲|餐饮|餐廳|餐厅/, code: '64201', name: 'Meals & Entertainment' },
    { pattern: /TRAVEL|HOTEL|機票|机票|FLIGHT/, code: '64202', name: 'Travel' },
    { pattern: /ADVERTISING|MARKETING|廣告|广告|推廣|推广/, code: '65101', name: 'Advertising' },
    { pattern: /BANK.*CHARGE|BANK.*FEE|SERVICE CHARGE|手續費|手续费/, code: '65102', name: 'Bank Charges' },
    { pattern: /INTEREST|利息/, code: '66101', name: 'Interest Expense' },
    { pattern: /PARKNSHOP|WELLCOME|AEON|SUPERMARKET|超市|百佳|惠康/, code: '62401', name: 'Sundry Purchases' },
    { pattern: /PETROL|SHELL|CALTEX|汽油/, code: '64102', name: 'Motor Expenses' },
    { pattern: /COURIER|POSTAGE|郵費|邮费|SF EXPRESS|順豐|顺丰/, code: '64103', name: 'Postage & Courier' },
    { pattern: /PRINTING|印刷/, code: '62304', name: 'Printing & Stationery' },
    { pattern: /REPAIR|MAINTENANCE|維修|维修/, code: '62203', name: 'Repairs & Maintenance' },
    { pattern: /PROFESSIONAL.*FEE|CONSULTING|LEGAL|AUDIT|顧問|顧問費/, code: '65201', name: 'Professional Fees' },
  ];
  let categorized = 0;
  for (const tx of txs.results as any[]) {
    const desc = (tx.description || '').toUpperCase();
    for (const rule of rules) {
      if (rule.pattern.test(desc)) {
        await db.prepare(
          "UPDATE card_transactions SET expense_account_code = ?, match_status = 'categorized' WHERE id = ? AND deleted_at IS NULL"
        ).bind(rule.code, tx.id).run();
        categorized++;
        break;
      }
    }
  }
  return c.json({ success: true, categorized, total: txs.results.length });
});

// ── Post card transactions to GL ──
card.post('/:id/post-to-gl', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const statementId = c.req.param('id');

  // Verify statement exists and belongs to tenant
  const stmt = await db.prepare(
    'SELECT id, card_issuer, statement_year, statement_month FROM card_statements WHERE id = ? AND user_id = ?'
  ).bind(statementId, tenantId).first<{ id: string; card_issuer: string; statement_year: number; statement_month: number }>();
  if (!stmt) return c.json({ error: 'Statement not found' }, 404);

  // Get categorized transactions without existing journal entries
  const txs = await db.prepare(
    `SELECT ct.* FROM card_transactions ct
     LEFT JOIN journal_entries je ON je.reference_id = ct.id AND je.reference_type = 'card_transaction'
       AND ${jeLive()}
     WHERE ct.card_statement_id = ? AND ct.user_id = ?
     AND ct.expense_account_code IS NOT NULL
     AND ct.deleted_at IS NULL
     AND je.id IS NULL`
  ).bind(statementId, tenantId).all();

  const rows = txs.results as any[];
  if (rows.length === 0) return c.json({ posted: 0, message: 'No uncategorized or already-posted transactions' });

  // Ensure required COA accounts exist
  const codes = new Set<string>();
  for (const tx of rows) codes.add(tx.expense_account_code);
  codes.add('11101'); // Cash on Hand
  for (const code of codes) {
    const exists = await db.prepare('SELECT id FROM accounts WHERE user_id = ? AND account_code = ?').bind(tenantId, code).first();
    if (!exists) {
      const type = code.startsWith('1') ? 'asset' : code.startsWith('2') ? 'liability' : code.startsWith('3') ? 'equity' : code.startsWith('4') ? 'revenue' : code.startsWith('5') ? 'cost' : 'expense';
      await db.prepare('INSERT OR IGNORE INTO accounts (id, user_id, account_code, account_name, account_type, is_active) VALUES (?, ?, ?, ?, ?, 1)')
        .bind(`ac-${Date.now()}-${code}`, tenantId, code, `Card auto-created ${code}`, type).run();
    }
  }

  let posted = 0;
  const ym = `${stmt.statement_year}${String(stmt.statement_month).padStart(2, '0')}`;
  const issuer = (stmt.card_issuer || 'CARD').replace(/[^A-Z0-9]/gi, '').slice(0, 6).toUpperCase();

  for (const tx of rows) {
    const entryId = `je-${Date.now().toString(36)}-${posted}`;
    const voucherNum = `C-${issuer}-${ym}-${String(posted + 1).padStart(3, '0')}`;
    const amount = Math.abs(tx.amount || 0);
    if (amount < 0.01) continue;

    await db.prepare(
      'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(entryId, tenantId, voucherNum, tx.transaction_date || tx.posting_date, tx.description || 'Card Transaction', 'card_transaction', tx.id).run();

    // Dr expense account, Cr Cash on Hand (11101)
    await db.prepare(
      'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
    ).bind(`jl-${Date.now().toString(36)}-${posted}-0`, entryId, tx.expense_account_code, 'Card Expense', tx.description || '', amount, 0).run();

    await db.prepare(
      'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, 1)'
    ).bind(`jl-${Date.now().toString(36)}-${posted}-1`, entryId, '11101', 'Cash on Hand', `Card payment: ${tx.description || ''}`, 0, amount).run();

    posted++;
  }

  return c.json({ success: true, posted, total: rows.length });
});

// ── Get single statement with transactions ──
card.get('/:id', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const id = c.req.param('id');
  const stmt = await c.env.DB.prepare(
    `SELECT id, file_name, card_issuer, card_network, card_number_last4, cardholder_name, currency,
            statement_year, statement_month, period_start, period_end,
            credit_limit, opening_balance, closing_balance, minimum_payment, payment_due_date,
            ocr_text, ocr_source, status, balance_status, balance_check, created_at
     FROM card_statements WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
  ).bind(id, tenantId).first();
  if (!stmt) return c.json({ error: 'Not found' }, 404);

  const tx = await c.env.DB.prepare(
    `SELECT id, transaction_date, posting_date, description, amount, transaction_type,
            foreign_currency, foreign_amount, category, reference, sort_order,
            expense_account_code, match_status, is_edited
     FROM card_transactions WHERE card_statement_id = ? AND deleted_at IS NULL ORDER BY sort_order`
  ).bind(id).all();
  return c.json({ ...stmt, transactions: tx.results });
});

// ── Create import (from file-storage OCR result) ──
card.delete('/:id', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare(
    'SELECT id, r2_key FROM card_statements WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(id, tenantId).first<{ id: string; r2_key: string | null }>();
  if (!existing) return c.json({ error: 'Not found' }, 404);
  await c.env.DB.prepare(
    "UPDATE card_statements SET deleted_at = datetime('now'), deleted_by = ? WHERE id = ?"
  ).bind(tenantId, id).run();
  await c.env.DB.prepare(
    "UPDATE card_transactions SET deleted_at = datetime('now') WHERE card_statement_id = ? AND deleted_at IS NULL"
  ).bind(id).run();
  // Also soft-delete the linked file record
  if (existing.r2_key) {
    await c.env.DB.prepare(
      "UPDATE file_records SET deleted_at = datetime('now'), deleted_by = ? WHERE r2_key = ?"
    ).bind(tenantId, existing.r2_key).run();
  }
  await auditLog(c.env.DB, tenantId, 'soft_delete', 'card_statement', id);
  return c.json({ success: true, id });
});
export { card as cardStatementRoutes };
