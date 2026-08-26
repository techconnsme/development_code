import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { v4 as uuidv4 } from 'uuid';
import { Bindings, Variables } from '../types';
import { authMiddleware, auditorMiddleware, bookkeeperMiddleware } from '../middleware/auth';
import { getCoaTemplate, INDUSTRIES, type CoaMode } from '../lib/coa-templates';
import { postPaymentToGl } from '../lib/post-payment';
import { postInvoiceToGl } from '../lib/post-invoice';
import { jePosted, jeLive, jeDeleted, jeNotOrphaned } from '../lib/journal-filters';
import { HK_COA_NAMES, getCodeType, ensureMissingAccounts } from '../lib/ensure-accounts';
import { categorizeTransaction, resolveBankAccountCode } from '../lib/transaction-categorizer';
import { findParentAccountError } from '../lib/account-guard';
import { getTemporaryAccount } from '../lib/coa-temporary';
import { checkPeriodOpen } from '../lib/period-guard';
import { createSnapshot, getLatestSnapshot, getSnapshots } from '../lib/journal-snapshots';

// Re-exported for backward compatibility with anything importing them from here.
export { HK_COA_NAMES, getCodeType };

const bookkeeping = new Hono<{ Bindings: Bindings; Variables: Variables }>();
bookkeeping.use('*', authMiddleware);

function getParentCandidates(code: string): string[] {
  const parents: string[] = [];
  // Mid-level parent: first 3 digits + '00' (e.g., 31201 → 31200)
  if (code.length >= 5) {
    const mid = code.slice(0, 3) + '00';
    if (mid !== code) parents.push(mid); // skip self (e.g., 31200 → 31200)
  }
  // Root-level parent: first digit + '0000' (e.g., 31201 → 30000)
  if (code.length >= 5) {
    const root = code[0] + '0000';
    if (root !== code) parents.push(root);
  }
  // Also include the template-defined parent from HK_COA_NAMES (e.g., 31200 parent is 31000)
  const tmpl = HK_COA_NAMES[code];
  if (tmpl?.parent && !parents.includes(tmpl.parent)) {
    parents.push(tmpl.parent);
  }
  return parents;
}

async function collectTransactionCodes(db: any, tenantId: string): Promise<string[]> {
  const codeSet = new Set<string>();

  // Collect from bank_transactions
  const btRows = await db.prepare(
    `SELECT DISTINCT account_code FROM bank_transactions WHERE user_id = ? AND account_code IS NOT NULL AND account_code != '' AND deleted_at IS NULL`
  ).bind(tenantId).all();
  for (const r of btRows.results as any[]) codeSet.add(r.account_code);

  // Collect from journal_lines
  const jlRows = await db.prepare(
    `SELECT DISTINCT jl.account_code FROM journal_lines jl
     JOIN journal_entries je ON jl.entry_id = je.id
     WHERE je.user_id = ? AND ${jeLive()}`
  ).bind(tenantId).all();
  for (const r of jlRows.results as any[]) codeSet.add(r.account_code);

  // Also include hierarchy parents
  const fullSet = new Set(codeSet);
  for (const code of codeSet) {
    for (const parent of getParentCandidates(code)) {
      if (HK_COA_NAMES[parent]) fullSet.add(parent);
    }
  }

  // Add the essential accounts if not already present
  const essentials = ['11101', '11102', '11103', '21201', '21301', '41101', '42101', '51101', '62303', '65101', '65102'];
  for (const e of essentials) fullSet.add(e);

  return Array.from(fullSet).filter(Boolean).sort();
}

// Audit log helper
async function auditLog(db: any, userId: string, action: string, entityType: string, entityId: string | null | undefined, changes?: object) {
  const id = `al-${uuidv4().slice(0, 8)}`;
  await db.prepare(
    'INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, changes) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, userId, action, entityType, entityId, changes ? JSON.stringify(changes) : null).run();
}

async function resolveLinks(db: any, entry: any): Promise<any> {
  if (!entry.reference_type || !entry.reference_id) return null;

  switch (entry.reference_type) {
    case 'bank_transaction': {
      const tx = await db.prepare(
        `SELECT bt.id, bt.description, bt.deposit_amount, bt.withdrawal_amount, bt.match_status, bt.bank_statement_id,
                bs.statement_number, bs.file_name
         FROM bank_transactions bt
         LEFT JOIN bank_statements bs ON bt.bank_statement_id = bs.id
         WHERE bt.id = ?`
      ).bind(entry.reference_id).first();
      if (!tx) return { bank_transaction: { id: entry.reference_id, description: '(deleted)', amount: 0, match_status: 'deleted', statement_id: null, statement_number: null, file_name: null } };
      return {
        bank_statement: tx.bank_statement_id ? { id: (tx as any).bank_statement_id, statement_number: (tx as any).statement_number, file_name: (tx as any).file_name } : null,
        bank_transaction: { id: (tx as any).id, description: (tx as any).description, amount: (tx as any).deposit_amount || (tx as any).withdrawal_amount, match_status: (tx as any).match_status, statement_id: (tx as any).bank_statement_id },
      };
    }
    case 'invoice': {
      const inv = await db.prepare(
        `SELECT id, invoice_number, direction, total, vendor_name, customer_name FROM invoices WHERE id = ?`
      ).bind(entry.reference_id).first();
      if (!inv) return { invoice: { id: entry.reference_id, invoice_number: '(deleted)', direction: 'incoming', total: 0, vendor_or_customer: '(deleted)' } };
      return {
        invoice: {
          id: (inv as any).id,
          invoice_number: (inv as any).invoice_number,
          direction: (inv as any).direction,
          total: (inv as any).total,
          vendor_or_customer: (inv as any).vendor_name || (inv as any).customer_name || '',
        },
      };
    }
    case 'payment': {
      const tx = await db.prepare(
        `SELECT bt.id, bt.description, bt.deposit_amount, bt.withdrawal_amount, bt.match_status, bt.bank_statement_id,
                bs.statement_number, bs.file_name
         FROM bank_transactions bt
         LEFT JOIN bank_statements bs ON bt.bank_statement_id = bs.id
         WHERE bt.id = ?`
      ).bind(entry.reference_id).first();
      const linkedInvoices = await db.prepare(
        `SELECT btil.invoice_id, btil.allocated_amount, i.invoice_number
         FROM bank_transaction_invoice_links btil
         LEFT JOIN invoices i ON btil.invoice_id = i.id
         WHERE btil.transaction_id = ?`
      ).bind(entry.reference_id).all();
      const result: any = {
        bank_statement: tx?.bank_statement_id ? { id: (tx as any).bank_statement_id, statement_number: (tx as any).statement_number, file_name: (tx as any).file_name } : null,
        bank_transaction: tx ? { id: (tx as any).id, description: (tx as any).description, amount: (tx as any).deposit_amount || (tx as any).withdrawal_amount, match_status: (tx as any).match_status, statement_id: (tx as any).bank_statement_id } : null,
      };
      if (linkedInvoices.results.length > 0) {
        result.linked_invoices = (linkedInvoices.results as any[]).map(li => ({
          id: li.invoice_id,
          invoice_number: li.invoice_number || '(deleted)',
          allocated_amount: li.allocated_amount,
        }));
      }
      return result;
    }
    case 'journal': {
      const rev = await db.prepare(
        'SELECT id, entry_number, entry_date FROM journal_entries WHERE id = ?'
      ).bind(entry.reference_id).first();
      if (!rev) return { reversal: { id: entry.reference_id, entry_number: '(deleted)', entry_date: '' } };
      return { reversal: { id: (rev as any).id, entry_number: (rev as any).entry_number, entry_date: (rev as any).entry_date } };
    }
    default:
      return null;
  }
}

bookkeeping.get('/entries', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = (page - 1) * limit;
  const startDate = c.req.query('start_date');
  const endDate = c.req.query('end_date');

  let query = `SELECT je.*, SUM(jl.debit) as total_debit, SUM(jl.credit) as total_credit
    FROM journal_entries je LEFT JOIN journal_lines jl ON je.id = jl.entry_id
    WHERE je.user_id = ? AND ${jeLive()}`;
  const params: any[] = [tenantId];
  if (startDate) { query += ' AND je.entry_date >= ?'; params.push(startDate); }
  if (endDate) { query += ' AND je.entry_date <= ?'; params.push(endDate); }
  query += ' GROUP BY je.id ORDER BY je.entry_date DESC, je.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = await db.prepare(query).bind(...params).all();

  const entriesWithLinks = await Promise.all(
    (rows.results as any[]).map(async (entry) => {
      try {
        const resolved_links = await resolveLinks(db, entry);
        return { ...entry, resolved_links };
      } catch (err) {
        console.error('resolveLinks failed for entry', entry.id, err);
        return { ...entry, resolved_links: null };
      }
    })
  );

  return c.json({ data: entriesWithLinks, page, limit });
});

bookkeeping.get('/entries/:id', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const entry = await db.prepare('SELECT * FROM journal_entries WHERE id = ? AND user_id = ?').bind(c.req.param('id'), tenantId).first();
  if (!entry) return c.json({ error: 'Entry not found' }, 404);
  const lines = await db.prepare('SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY sort_order').bind(c.req.param('id')).all();
  return c.json({ ...entry, lines: lines.results });
});

bookkeeping.get('/entries/:id/audit-trail', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const entryId = c.req.param('id');

  // Verify entry exists and belongs to tenant
  const entry = await db.prepare(
    'SELECT id FROM journal_entries WHERE id = ? AND user_id = ?'
  ).bind(entryId, tenantId).first();
  if (!entry) return c.json({ error: 'Entry not found' }, 404);

  const auditTrail = await getSnapshots(db, entryId);
  return c.json(auditTrail);
});

const lineSchema = z.object({
  account_code: z.string().min(1).max(20), account_name: z.string().min(1).max(200),
  description: z.string().max(500).optional(), debit: z.number().min(0).max(999999999).optional(), credit: z.number().min(0).max(999999999).optional(),
  project: z.string().max(200).optional(),
});

const entrySchema = z.object({
  entry_number: z.string().min(1).max(50), entry_date: z.string().max(10), description: z.string().min(1).max(500),
  reference_type: z.string().max(50).optional(), reference_id: z.string().max(50).optional(), lines: z.array(lineSchema).min(2).max(200),
});

bookkeeping.post('/entries', bookkeeperMiddleware, zValidator('json', entrySchema), async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const data = c.req.valid('json');
  const id = `je-${uuidv4().slice(0, 8)}`;

  const totalDebit = data.lines.reduce((sum, l) => sum + (l.debit || 0), 0);
  const totalCredit = data.lines.reduce((sum, l) => sum + (l.credit || 0), 0);
  if (Math.abs(totalDebit - totalCredit) > 0.001) return c.json({ error: 'Debits must equal credits' }, 400);

  // Validate all account codes exist in COA
  const codes = [...new Set(data.lines.map(l => l.account_code))];
  const existingAccounts = await db.prepare(
    `SELECT account_code FROM accounts WHERE user_id = ? AND is_active = 1 AND account_code IN (${codes.map(() => '?').join(',')})`
  ).bind(tenantId, ...codes).all();
  const existingCodes = new Set((existingAccounts.results as any[]).map(a => a.account_code));
  const missingCodes = codes.filter(c => !existingCodes.has(c));
  if (missingCodes.length > 0) {
    return c.json({ error: `Account code(s) not found: ${missingCodes.join(', ')}` }, 400);
  }
  // Leaf-only guard: journal lines must never post to a parent/group account
  for (const cde of codes) {
    const guardError = await findParentAccountError(db, tenantId, cde);
    if (guardError) return c.json({ error: guardError }, 400);
  }

  if (!(await checkPeriodOpen(db, tenantId, data.entry_date)))
    return c.json({ error: 'Cannot create entry in a closed period' }, 400);

  await db.prepare(
    'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, tenantId, data.entry_number, data.entry_date, data.description, data.reference_type || null, data.reference_id || null).run();

  for (let i = 0; i < data.lines.length; i++) {
    const line = data.lines[i];
    await db.prepare(
      'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, project, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(`jl-${uuidv4().slice(0, 8)}`, id, line.account_code, line.account_name, line.description || null, line.debit || 0, line.credit || 0, line.project || null, i).run();
  }

  const entry = await db.prepare('SELECT * FROM journal_entries WHERE id = ?').bind(id).first();
  const lines = await db.prepare('SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY sort_order').bind(id).all();
  await auditLog(db, user.id, 'create', 'journal_entry', id, { entry_number: data.entry_number, description: data.description, lines: data.lines.length });
  await createSnapshot(db, tenantId, id, 'create');
  return c.json({ ...entry, lines: lines.results }, 201);
});

// Update entry status (draft → posted, etc.)
bookkeeping.patch('/entries/:id/status', bookkeeperMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const body = await c.req.json();
  const { status } = body;
  if (!status || !['draft', 'posted', 'reconciled'].includes(status)) {
    return c.json({ error: 'status must be draft, posted, or reconciled' }, 400);
  }
  const entry = await db.prepare('SELECT * FROM journal_entries WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), tenantId).first();
  if (!entry) return c.json({ error: 'Entry not found' }, 404);

  await db.prepare("UPDATE journal_entries SET status = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .bind(status, c.req.param('id'), tenantId).run();
  await auditLog(db, user.id, 'update_status', 'journal_entry', c.req.param('id'), { status });
  const entryId = c.req.param('id')!;
  const prevSnap = await getLatestSnapshot(db, entryId);
  await createSnapshot(db, tenantId, entryId, 'status_change', prevSnap);
  return c.json({ success: true, status });
});

// Delete a journal entry (hard delete, cascades to journal_lines)
bookkeeping.delete('/entries/:id', bookkeeperMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const id = c.req.param('id');

  const entry = await db.prepare('SELECT * FROM journal_entries WHERE id = ? AND user_id = ?')
    .bind(id, tenantId).first();
  if (!entry) return c.json({ error: 'Entry not found' }, 404);

  // Check if period is closed
  const closed = await db.prepare(
    "SELECT id FROM closed_periods WHERE user_id = ? AND ? >= period_start AND ? <= period_end"
  ).bind(tenantId, (entry as any).entry_date, (entry as any).entry_date).first();
  if (closed) return c.json({ error: 'Cannot delete entry in a closed period' }, 400);

  await db.prepare('DELETE FROM journal_entries WHERE id = ? AND user_id = ?')
    .bind(id, tenantId).run();
  await auditLog(db, user.id, 'delete', 'journal_entry', id, { entry_number: (entry as any).entry_number });
  const entryId = id!;
  const prevSnap = await getLatestSnapshot(db, entryId);
  await createSnapshot(db, tenantId, entryId, 'delete', prevSnap);
  return c.json({ success: true });
});

// Reverse a journal entry (creates opposite entry)
bookkeeping.post('/entries/:id/reverse', bookkeeperMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const originalId = c.req.param('id');

  const entry = await db.prepare('SELECT * FROM journal_entries WHERE id = ? AND user_id = ?')
    .bind(originalId, tenantId).first<{ id: string; entry_number: string; entry_date: string; description: string; user_id: string }>();
  if (!entry) return c.json({ error: 'Entry not found' }, 404);

  const lines = await db.prepare('SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY sort_order')
    .bind(originalId).all();

  const revId = `je-${uuidv4().slice(0, 8)}`;
  const revNumber = `${entry.entry_number}-REV`;

  await db.prepare(
    'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(revId, tenantId, revNumber, new Date().toISOString().split('T')[0],
    `Reversal: ${entry.description}`, 'journal', originalId).run();

  for (let i = 0; i < (lines.results as any[]).length; i++) {
    const line = (lines.results as any[])[i];
    await db.prepare(
      'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, project, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(`jl-${uuidv4().slice(0, 8)}`, revId, line.account_code, line.account_name,
      `Reversal: ${line.description || ''}`, line.credit, line.debit, line.project || null, i).run();
  }

  const revEntry = await db.prepare('SELECT * FROM journal_entries WHERE id = ?').bind(revId).first();
  const revLines = await db.prepare('SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY sort_order').bind(revId).all();
  await auditLog(db, user.id, 'reverse', 'journal_entry', originalId, { reversal_id: revId, reversal_number: revNumber });
  await createSnapshot(db, tenantId, revId, 'create');
  return c.json({ ...revEntry, lines: revLines.results }, 201);
});

bookkeeping.get('/accounts', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const asOf = c.req.query('as_of');
  const includeInactive = c.req.query('include_inactive') === 'true';

  // Self-heal placeholder account names and missing parents (see repairCOA)
  await repairCOA(db, tenantId);

  const rows = await db.prepare(
    `SELECT * FROM accounts WHERE user_id = ? ${includeInactive ? '' : 'AND is_active = 1'} ORDER BY account_code`
  ).bind(tenantId).all();

  // Compute current_balance for each account if as_of is provided
  if (asOf) {
    const balanceRows = await db.prepare(
      `SELECT jl.account_code,
              COALESCE(SUM(jl.debit), 0) as total_debit,
              COALESCE(SUM(jl.credit), 0) as total_credit
       FROM journal_lines jl
       JOIN journal_entries je ON jl.entry_id = je.id
       WHERE je.user_id = ? AND je.entry_date <= ? AND ${jePosted()} AND ${jeNotOrphaned()}
       GROUP BY jl.account_code`
    ).bind(tenantId, asOf).all();
    const balanceMap = new Map<string, { debit: number; credit: number }>();
    for (const r of balanceRows.results as any[]) {
      balanceMap.set(r.account_code, { debit: r.total_debit, credit: r.total_credit });
    }

    const data = (rows.results as any[]).map(a => {
      const b = balanceMap.get(a.account_code);
      const opening = a.opening_balance || 0;
      const debit = b?.debit || 0;
      const credit = b?.credit || 0;
      const code = a.account_code || '';
      const name = (a.account_name || '').toLowerCase();
      const isContra = code.startsWith('123') || name.includes('accumulated depreciation')
        || name.includes('累計折舊') || name.includes('allowance') || name.includes('減值');
      const isDebitNatural = !isContra && (a.account_type === 'asset' || a.account_type === 'cost' || a.account_type === 'expense');
      const currentBalance = isDebitNatural ? opening + debit - credit : opening + credit - debit;
      return { ...a, total_debit: debit, total_credit: credit, current_balance: Math.round(currentBalance * 100) / 100 };
    });

    // Aggregate child balances into parent accounts (bottom-up)
    const balByCode = new Map<string, number>();
    for (const a of data) {
      balByCode.set(a.account_code, a.current_balance);
    }

    // Build children lookup
    const childrenMap = new Map<string, string[]>();
    for (const a of data) {
      if (a.parent_code) {
        const list = childrenMap.get(a.parent_code) || [];
        list.push(a.account_code);
        childrenMap.set(a.parent_code, list);
      }
    }

    // Compute max depth per code for bottom-up processing
    const depthCache = new Map<string, number>();
    function maxDepth(code: string): number {
      if (depthCache.has(code)) return depthCache.get(code)!;
      const kids = childrenMap.get(code) || [];
      let max = 0;
      for (const c of kids) max = Math.max(max, maxDepth(c) + 1);
      depthCache.set(code, max);
      return max;
    }

    // Process deepest first — children aggregate into parents
    const sortedByDepth = [...data].sort((a, b) => maxDepth(b.account_code) - maxDepth(a.account_code));
    for (const a of sortedByDepth) {
      if (a.parent_code && balByCode.has(a.account_code)) {
        const childBal = balByCode.get(a.account_code) || 0;
        balByCode.set(a.parent_code, (balByCode.get(a.parent_code) || 0) + childBal);
      }
    }

    // Apply aggregated balances to parent accounts
    for (const a of data) {
      if (a.account_code.endsWith('00')) {
        a.current_balance = Math.round((balByCode.get(a.account_code) || 0) * 100) / 100;
      }
    }

    return c.json({ data, as_of: asOf });
  }

  return c.json({ data: rows.results });
});

// Search accounts by code or name
bookkeeping.get('/accounts/search', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const q = c.req.query('q') || '';
  if (!q || q.length < 1) return c.json({ data: [] });
  const rows = await c.env.DB.prepare(
    `SELECT * FROM accounts WHERE user_id = ? AND is_active = 1
     AND (account_code LIKE ? OR account_name LIKE ?)
     ORDER BY account_code LIMIT 20`
  ).bind(tenantId, `%${q}%`, `%${q}%`).all();
  return c.json({ data: rows.results });
});

// Seed COA with HK industry template
// ── COA Template Preview ─────────────────────────────────────────────────
// GET /bookkeeping/accounts/template?industry=manufacturing&mode=industry|manual
// Returns the template accounts for preview before client creation.
// Mode defaults to 'manual' for safety.
bookkeeping.get('/accounts/template', async (c) => {
  const industry = c.req.query('industry') || 'general';
  const mode: CoaMode = c.req.query('mode') === 'industry' ? 'industry' : 'manual';
  const validIndustry = INDUSTRIES.includes(industry as any) ? industry : 'general';
  const accounts = getCoaTemplate(validIndustry, mode);
  return c.json({ data: accounts, industry: validIndustry, mode, total: accounts.length });
});

bookkeeping.post('/accounts/seed', bookkeeperMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;

  // HK 5-digit COA template — sourced from coa-templates.ts
  const template = getCoaTemplate('general', 'industry');

  let created = 0;
  for (const { account_code, account_name, account_type, parent_code } of template) {
    const id = `acc-${uuidv4().slice(0, 8)}`;
    await db.prepare(
      'INSERT OR IGNORE INTO accounts (id, user_id, account_code, account_name, account_type, parent_code) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(id, tenantId, account_code, account_name, account_type, parent_code).run();
    created++;
  }

  await auditLog(db, user.id, 'seed_coa', 'account', null, { template: 'hk-5digit', accounts_created: created });
  return c.json({ success: true, accounts_created: created }, 201);
});

// GET /accounts/missing-codes — detect transaction codes not yet in COA
bookkeeping.get('/accounts/missing-codes', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;

  const codes = await collectTransactionCodes(db, tenantId);
  const existingRows = await db.prepare(
    `SELECT account_code FROM accounts WHERE user_id = ?`
  ).bind(tenantId).all();
  const existingSet = new Set((existingRows.results as any[]).map(r => r.account_code));
  const missing = codes.filter(c => !existingSet.has(c)).map(code => ({
    code,
    name: HK_COA_NAMES[code]?.name || null,
    type: HK_COA_NAMES[code]?.type || getCodeType(code),
  }));
  return c.json({ missing, total_existing: existingSet.size, total_expected: codes.length });
});

// GET /accounts/missing-codes/details — extended: includes transactions referencing each missing code
bookkeeping.get('/accounts/missing-codes/details', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;

  const codes = await collectTransactionCodes(db, tenantId);
  const existingRows = await db.prepare(
    `SELECT account_code FROM accounts WHERE user_id = ?`
  ).bind(tenantId).all();
  const existingSet = new Set((existingRows.results as any[]).map(r => r.account_code));
  const missingCodes = codes.filter(c => !existingSet.has(c));

  const missing: any[] = [];
  for (const code of missingCodes) {
    // Find bank transactions using this code
    const btRows = await db.prepare(
      `SELECT id, transaction_date, description, deposit_amount, withdrawal_amount
       FROM bank_transactions
       WHERE user_id = ? AND account_code = ? AND deleted_at IS NULL
       ORDER BY transaction_date DESC LIMIT 20`
    ).bind(tenantId, code).all();

    // Find journal lines using this code
    const jlRows = await db.prepare(
      `SELECT jl.id, je.id as entry_id, je.entry_number, je.entry_date, jl.description, jl.debit, jl.credit
       FROM journal_lines jl
       JOIN journal_entries je ON jl.entry_id = je.id
       WHERE je.user_id = ? AND jl.account_code = ? AND ${jeLive()}
       ORDER BY je.entry_date DESC LIMIT 20`
    ).bind(tenantId, code).all();

    const transactions: any[] = [];
    for (const bt of btRows.results as any[]) {
      transactions.push({
        source: 'bank_transaction',
        id: bt.id,
        date: bt.transaction_date,
        description: bt.description,
        deposit_amount: bt.deposit_amount,
        withdrawal_amount: bt.withdrawal_amount,
      });
    }
    for (const jl of jlRows.results as any[]) {
      transactions.push({
        source: 'journal_line',
        id: jl.id,
        entry_id: jl.entry_id,
        entry_number: jl.entry_number,
        date: jl.entry_date,
        description: jl.description,
        debit: jl.debit,
        credit: jl.credit,
      });
    }

    missing.push({
      code,
      name: HK_COA_NAMES[code]?.name || null,
      type: HK_COA_NAMES[code]?.type || getCodeType(code),
      transactions: transactions.slice(0, 20),
    });
  }

  return c.json({ missing, total_existing: existingSet.size, total_expected: codes.length });
});

// Helper: recursively find missing parent codes for an account code
function getMissingParentChain(code: string, existingSet: Set<string>, visited: Set<string> = new Set()): string[] {
  if (visited.has(code)) return []; // guard against infinite recursion (parent == self for XX000 codes)
  visited.add(code);
  const missing: string[] = [];
  const candidates = getParentCandidates(code);
  for (const pc of candidates) {
    if (pc === code) continue; // skip self-reference (e.g., 31200 → getParentCandidates returns ['31200', ...])
    if (!HK_COA_NAMES[pc]) continue;
    if (!existingSet.has(pc)) {
      missing.push(pc);
      // Recurse: check this parent's parents too
      const grandParents = getMissingParentChain(pc, existingSet, visited);
      for (const gp of grandParents) {
        if (!missing.includes(gp)) missing.push(gp);
      }
    }
  }
  return missing;
}

// Self-heal: repair placeholder accounts (account_name == account_code) created by older
// auto-create paths that stored the code as the name and skipped parent accounts.
// Also ensures every account's parent chain exists. Runs on COA read so the page
// fixes itself on next load without a manual migration.
async function repairCOA(db: any, tenantId: string) {
  const rows = await db.prepare(
    'SELECT account_code, account_name, account_type, parent_code FROM accounts WHERE user_id = ?'
  ).bind(tenantId).all();
  const accts = (rows.results as any[]);
  if (accts.length === 0) return;

  const existingSet = new Set(accts.map(a => a.account_code));
  const toCreate = new Map<string, { name: string; type: string; parent: string | null }>();

  for (const a of accts) {
    // 0. Normalize account_type for 5xxxxx codes (auto-create paths may type them 'expense')
    if (a.account_code?.startsWith('5') && a.account_type === 'expense') {
      await db.prepare(
        'UPDATE accounts SET account_type = ? WHERE user_id = ? AND account_code = ?'
      ).bind('cost', tenantId, a.account_code).run();
      a.account_type = 'cost';
    }
    // 1. Fix placeholder name + parent (e.g., account_name == "31201")
    if (a.account_name === a.account_code) {
      const info = HK_COA_NAMES[a.account_code];
      if (info) {
        await db.prepare(
          'UPDATE accounts SET account_name = ?, parent_code = ? WHERE user_id = ? AND account_code = ?'
        ).bind(info.name, info.parent, tenantId, a.account_code).run();
      }
    }
    // 2. Collect any missing parent chain
    for (const pc of getMissingParentChain(a.account_code, existingSet)) {
      const info = HK_COA_NAMES[pc];
      if (info && !toCreate.has(pc)) toCreate.set(pc, info);
    }
  }

  // Create missing parents (root-level first so parent_code references resolve)
  const sorted = Array.from(toCreate.keys()).sort((a, b) => a.length - b.length || a.localeCompare(b));
  for (const pc of sorted) {
    if (existingSet.has(pc)) continue;
    const info = toCreate.get(pc)!;
    await db.prepare(
      'INSERT INTO accounts (id, user_id, account_code, account_name, account_type, parent_code) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(`acc-${uuidv4().slice(0, 8)}`, tenantId, pc, info.name, info.type, info.parent).run();
    existingSet.add(pc);
  }
}

// POST /accounts/ensure — create a specific account + any missing parent accounts recursively
bookkeeping.post('/accounts/ensure', bookkeeperMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const body = await c.req.json();
  const code = body.code as string;
  if (!code) return c.json({ error: 'code required' }, 400);

  const existingRows = await db.prepare(
    `SELECT account_code FROM accounts WHERE user_id = ?`
  ).bind(tenantId).all();
  const existingSet = new Set((existingRows.results as any[]).map(r => r.account_code));

  const created: string[] = [];
  const skipped: string[] = [];

  // Find and create missing parents first (bottom-up: deepest parent first)
  const missingParents = getMissingParentChain(code, existingSet);
  // Sort so that root-level parents are created first
  missingParents.sort((a, b) => a.length - b.length || a.localeCompare(b));

  for (const pc of missingParents) {
    if (existingSet.has(pc)) { skipped.push(pc); continue; }
    const info = HK_COA_NAMES[pc];
    const name = (body.name && pc === code) ? body.name : (info?.name || `${pc} (${getCodeType(pc)})`);
    const type = (body.type && pc === code) ? body.type : (info?.type || getCodeType(pc));
    const grandParent = info?.parent || null;
    try {
      await db.prepare(
        'INSERT INTO accounts (id, user_id, account_code, account_name, account_type, parent_code) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(`acc-${uuidv4().slice(0, 8)}`, tenantId, pc, name, type, grandParent).run();
      created.push(pc);
      existingSet.add(pc);
    } catch { skipped.push(pc); }
  }

  // Now create the target account if not already created
  if (!existingSet.has(code) && !created.includes(code)) {
    const info = HK_COA_NAMES[code];
    const name = body.name || info?.name || `${code} (${getCodeType(code)})`;
    const type = body.type || info?.type || getCodeType(code);
    const parent = info?.parent || null;
    try {
      await db.prepare(
        'INSERT INTO accounts (id, user_id, account_code, account_name, account_type, parent_code) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(`acc-${uuidv4().slice(0, 8)}`, tenantId, code, name, type, parent).run();
      created.push(code);
    } catch { skipped.push(code); }
  } else if (!created.includes(code)) {
    skipped.push(code);
  }

  await auditLog(db, user.id, 'ensure_accounts', 'account', code, { created, skipped });
  return c.json({ created, skipped }, created.length > 0 ? 201 : 200);
});

// Create a single account manually
const createAccountSchema = z.object({
  account_code: z.string().min(1).max(20),
  account_name: z.string().min(1).max(200),
  account_type: z.enum(['asset', 'liability', 'equity', 'revenue', 'cost', 'expense']),
  parent_code: z.string().max(20).optional(),
  opening_balance: z.number().optional(),
});

bookkeeping.post('/accounts', bookkeeperMiddleware, zValidator('json', createAccountSchema), async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const data = c.req.valid('json');

  // Auto-resolve bare-code names from HK COA template
  let accountName = data.account_name;
  if (accountName === data.account_code || !accountName || accountName.trim() === '') {
    const resolved = HK_COA_NAMES[data.account_code];
    if (resolved?.name) accountName = resolved.name;
  }

  // Check for duplicate code
  const existing = await db.prepare('SELECT id FROM accounts WHERE user_id = ? AND account_code = ?')
    .bind(tenantId, data.account_code).first();
  if (existing) return c.json({ error: 'Account code already exists' }, 409);

  // Check for duplicate name
  const existingName = await db.prepare('SELECT id FROM accounts WHERE user_id = ? AND account_name = ?')
    .bind(tenantId, accountName).first();
  if (existingName) return c.json({ error: 'Account name already exists' }, 409);

  // Auto-create missing parent accounts up the chain
  const allExistingRows = await db.prepare(
    `SELECT account_code FROM accounts WHERE user_id = ?`
  ).bind(tenantId).all();
  const existingSet = new Set((allExistingRows.results as any[]).map(r => r.account_code));
  const missingParents = getMissingParentChain(data.account_code, existingSet);
  missingParents.sort((a, b) => a.length - b.length || a.localeCompare(b));
  for (const pc of missingParents) {
    if (existingSet.has(pc)) continue;
    const info = HK_COA_NAMES[pc];
    const pName = info?.name || `${pc} (${getCodeType(pc)})`;
    const pType = info?.type || getCodeType(pc);
    const pParent = info?.parent || null;
    await db.prepare(
      'INSERT INTO accounts (id, user_id, account_code, account_name, account_type, parent_code) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(`acc-${uuidv4().slice(0, 8)}`, tenantId, pc, pName, pType, pParent).run();
    existingSet.add(pc);
  }

  const id = `acc-${uuidv4().slice(0, 8)}`;
  await db.prepare(
    'INSERT INTO accounts (id, user_id, account_code, account_name, account_type, parent_code, opening_balance) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, tenantId, data.account_code, accountName, data.account_type, data.parent_code || null, data.opening_balance || 0).run();

  await auditLog(db, user.id, 'create', 'account', data.account_code, { account_name: accountName, account_type: data.account_type });
  const account = await db.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first();
  return c.json(account, 201);
});

// Get transaction history for a specific account with running balance
bookkeeping.get('/accounts/:code/transactions', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const code = c.req.param('code');
  const startDate = c.req.query('start_date');
  const endDate = c.req.query('end_date');

  // Get account info
  const account = await db.prepare('SELECT * FROM accounts WHERE user_id = ? AND account_code = ?')
    .bind(tenantId, code).first();
  if (!account) return c.json({ error: 'Account not found' }, 404);

  const sDate = startDate || '2000-01-01';
  const eDate = endDate || '2099-12-31';

  // Get journal lines for this account
  const rows = await db.prepare(
    `SELECT jl.account_code, jl.account_name, jl.description as line_description,
            jl.debit, jl.credit, jl.sort_order,
            je.entry_date, je.description as entry_description, je.entry_number,
            je.reference_type, je.reference_id, je.id as entry_id
     FROM journal_lines jl
     JOIN journal_entries je ON jl.entry_id = je.id
     WHERE jl.account_code = ? AND je.user_id = ?
       AND je.entry_date >= ? AND je.entry_date <= ?
       AND ${jePosted()} AND ${jeNotOrphaned()}
     ORDER BY je.entry_date, jl.sort_order`
  ).bind(code, tenantId, sDate, eDate).all();

  const opening = (account as any).opening_balance || 0;
  const acctCode = (account as any).account_code || '';
  const acctName = ((account as any).account_name || '').toLowerCase();
  const isContra = acctCode.startsWith('123') || acctName.includes('accumulated depreciation')
    || acctName.includes('累計折舊') || acctName.includes('allowance') || acctName.includes('減值');
  const isDebitNatural = !isContra && ((account as any).account_type === 'asset' || (account as any).account_type === 'cost' || (account as any).account_type === 'expense');

  const transactions: any[] = [];
  let runningBalance = opening;
  for (const r of rows.results as any[]) {
    const change = isDebitNatural ? (r.debit - r.credit) : (r.credit - r.debit);
    runningBalance += change;
    transactions.push({
      entry_date: r.entry_date,
      description: r.line_description || r.entry_description,
      debit: r.debit,
      credit: r.credit,
      running_balance: Math.round(runningBalance * 100) / 100,
      entry_number: r.entry_number,
      reference_type: r.reference_type,
      reference_id: r.reference_id,
      entry_id: r.entry_id,
    });
  }

  return c.json({
    account: { ...account, opening_balance: opening },
    transactions,
    period: { start: sDate, end: eDate },
  });
});

// PATCH account fields (opening_balance, is_active) — at least one required
bookkeeping.patch('/accounts/:code', authMiddleware, bookkeeperMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const code = c.req.param('code');
  const body = await c.req.json();

  const sets: string[] = [];
  const params: any[] = [];
  const changes: Record<string, unknown> = {};

  if (body.opening_balance !== undefined) {
    // Parent/group accounts roll up their children — a B/F balance there would
    // double-count. Opening balances belong on leaf accounts only.
    const guardError = await findParentAccountError(db, tenantId, code);
    if (guardError) {
      return c.json({ error: `Cannot set B/F balance on ${code}: is a parent/group account — set it on its sub-accounts` }, 400);
    }
    sets.push('opening_balance = ?'); params.push(body.opening_balance);
    changes.opening_balance = body.opening_balance;
  }
  if (body.is_active !== undefined) {
    if (body.is_active !== 0 && body.is_active !== 1)
      return c.json({ error: 'is_active must be 0 or 1' }, 400);
    sets.push('is_active = ?'); params.push(body.is_active);
    changes.is_active = body.is_active;
  }
  if (sets.length === 0) return c.json({ error: 'No fields to update' }, 400);

  params.push(tenantId, code);
  await c.env.DB.prepare(
    `UPDATE accounts SET ${sets.join(', ')} WHERE user_id = ? AND account_code = ?`
  ).bind(...params).run();
  await auditLog(c.env.DB, user.id, 'update', 'account', code, changes);
  return c.json({ success: true });
});

// GET/PATCH fiscal period
bookkeeping.get('/fiscal-period', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const row = await c.env.DB.prepare('SELECT fiscal_year_start, fiscal_year_end FROM company_settings WHERE user_id = ?')
    .bind(tenantId).first<{ fiscal_year_start: string; fiscal_year_end: string }>();
  return c.json({ fiscal_year_start: row?.fiscal_year_start || null, fiscal_year_end: row?.fiscal_year_end || '03-31' });
});

bookkeeping.patch('/fiscal-period', authMiddleware, bookkeeperMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const body = await c.req.json();
  const sets: string[] = [];
  const params: any[] = [];
  if (body.fiscal_year_start) { sets.push('fiscal_year_start = ?'); params.push(body.fiscal_year_start); }
  if (body.fiscal_year_end) { sets.push('fiscal_year_end = ?'); params.push(body.fiscal_year_end); }
  if (sets.length === 0) return c.json({ error: 'No fields' }, 400);
  sets.push("updated_at = datetime('now')");
  params.push(tenantId);
  await c.env.DB.prepare(`UPDATE company_settings SET ${sets.join(', ')} WHERE user_id = ?`).bind(...params).run();
  return c.json({ success: true });
});

// Close an accounting period (prevent further modifications)
bookkeeping.post('/close-period', bookkeeperMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const body = await c.req.json();
  const { period_start, period_end, notes } = body;
  if (!period_start || !period_end) return c.json({ error: 'period_start and period_end required' }, 400);

  const id = `cp-${uuidv4().slice(0, 8)}`;
  await db.prepare(
    'INSERT INTO closed_periods (id, user_id, period_start, period_end, closed_by, notes) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, tenantId, period_start, period_end, user.id, notes || null).run();

  await auditLog(db, user.id, 'close_period', 'accounting_period', id, { period_start, period_end });
  return c.json({ id, period_start, period_end, closed: true }, 201);
});

// Reopen a closed period
bookkeeping.delete('/close-period/:id', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;

  const period = await db.prepare('SELECT * FROM closed_periods WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), tenantId).first();
  if (!period) return c.json({ error: 'Closed period not found' }, 404);

  await db.prepare('DELETE FROM closed_periods WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), tenantId).run();
  return c.json({ success: true });
});

// List closed periods
bookkeeping.get('/closed-periods', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const rows = await c.env.DB.prepare(
    'SELECT * FROM closed_periods WHERE user_id = ? ORDER BY period_start DESC'
  ).bind(tenantId).all();
  return c.json({ data: rows.results });
});

bookkeeping.get('/trial-balance', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const asOf = c.req.query('as_of') || new Date().toISOString().split('T')[0];

  // Get journal line totals
  const rows = await db.prepare(
    `SELECT jl.account_code, jl.account_name, a.account_type, a.opening_balance, SUM(jl.debit) as total_debit, SUM(jl.credit) as total_credit
     FROM journal_lines jl JOIN journal_entries je ON jl.entry_id = je.id
     LEFT JOIN accounts a ON jl.account_code = a.account_code AND je.user_id = a.user_id
     WHERE je.user_id = ? AND je.entry_date <= ? AND ${jePosted()} AND ${jeNotOrphaned()} GROUP BY jl.account_code, jl.account_name ORDER BY jl.account_code`
  ).bind(tenantId, asOf).all();

  // Compute ending balances: opening + debit - credit (for assets/expenses) or opening + credit - debit (for liabilities/equity/revenue)
  // Contra-asset accounts (accumulated depreciation, allowances) are credit-normal
  const data = (rows.results as any[]).map(row => {
    const opening = row.opening_balance || 0;
    const type = (row.account_type || '').toLowerCase();
    const code = row.account_code || '';
    const name = (row.account_name || '').toLowerCase();
    const isContra = code.startsWith('123') || name.includes('accumulated depreciation')
      || name.includes('累計折舊') || name.includes('allowance') || name.includes('減值');
    const isDebitNatural = !isContra && (type === 'asset' || type === 'cost' || type === 'expense');
    const ending = isDebitNatural
      ? opening + row.total_debit - row.total_credit
      : opening + row.total_credit - row.total_debit;
    return { ...row, opening_balance: opening, ending_balance: ending };
  });

  // If journal entries exist, return them; otherwise fallback to bank transactions for consistency
  if (data.length > 0) {
    return c.json({ data, as_of: asOf, source: 'journal' });
  }

  // Fallback: build trial balance from bank transactions grouped by account_code
  const btRows = await db.prepare(
    `SELECT COALESCE(account_code, 'UNCAT') as account_code,
     'Uncategorized' as account_name, '' as account_type, 0 as opening_balance,
     SUM(deposit_amount) as total_debit, SUM(withdrawal_amount) as total_credit
     FROM bank_transactions WHERE user_id = ? AND transaction_date <= ? AND deleted_at IS NULL
     GROUP BY COALESCE(account_code, 'UNCAT') ORDER BY account_code`
  ).bind(tenantId, asOf).all();

  const btData = (btRows.results as any[]).map(row => ({
    ...row,
    ending_balance: (row.total_debit || 0) - (row.total_credit || 0),
    account_name: row.account_code === 'UNCAT' ? '未分類交易 Uncategorized' : row.account_name,
  }));

  return c.json({ data: btData, as_of: asOf, source: 'bank' });
});

bookkeeping.get('/export', authMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const startDate = c.req.query('start_date') || '2000-01-01';
  const endDate = c.req.query('end_date') || '2099-12-31';
  const format = c.req.query('format') || 'json';

  const entries = await db.prepare(
    `SELECT je.*, jl.account_code, jl.account_name, jl.description as line_description, jl.debit, jl.credit
     FROM journal_entries je JOIN journal_lines jl ON je.id = jl.entry_id
     WHERE je.user_id = ? AND je.entry_date >= ? AND je.entry_date <= ? AND ${jePosted()} AND ${jeNotOrphaned()}
     ORDER BY je.entry_date, je.entry_number, jl.sort_order`
  ).bind(tenantId, startDate, endDate).all();

  if (format === 'csv') {
    const esc = (v: any) => `"${String(v || '').replace(/"/g, '""')}"`;
    let csv = 'Entry Date,Entry Number,Description,Account Code,Account Name,Line Description,Debit,Credit\n';
    for (const row of entries.results as any[]) {
      csv += `${esc(row.entry_date)},${esc(row.entry_number)},${esc(row.description)},${esc(row.account_code)},${esc(row.account_name)},${esc(row.line_description)},${row.debit},${row.credit}\n`;
    }
    return c.text(csv, 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename=bookkeeping-export.csv' });
  }
  return c.json({ data: entries.results, period: { start: startDate, end: endDate } });
});

bookkeeping.get('/income-statement', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const startDate = c.req.query('start_date') || '2000-01-01';
  const endDate = c.req.query('end_date') || new Date().toISOString().split('T')[0];

  // Use account_type from COA to classify revenue and expenses
  const revenue = await db.prepare(
    `SELECT COALESCE(SUM(jl.credit) - SUM(jl.debit), 0) as amount FROM journal_lines jl
     JOIN journal_entries je ON jl.entry_id = je.id
     JOIN accounts a ON jl.account_code = a.account_code AND je.user_id = a.user_id
     WHERE je.user_id = ? AND je.entry_date >= ? AND je.entry_date <= ? AND a.account_type = 'revenue' AND ${jePosted()} AND ${jeNotOrphaned()}`
  ).bind(tenantId, startDate, endDate).first<{ amount: number }>();

  const expenses = await db.prepare(
    `SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) as amount FROM journal_lines jl
     JOIN journal_entries je ON jl.entry_id = je.id
     JOIN accounts a ON jl.account_code = a.account_code AND je.user_id = a.user_id
     WHERE je.user_id = ? AND je.entry_date >= ? AND je.entry_date <= ? AND a.account_type = 'expense' AND ${jePosted()} AND ${jeNotOrphaned()}`
  ).bind(tenantId, startDate, endDate).first<{ amount: number }>();

  const cost = await db.prepare(
    `SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) as amount FROM journal_lines jl
     JOIN journal_entries je ON jl.entry_id = je.id
     JOIN accounts a ON jl.account_code = a.account_code AND je.user_id = a.user_id
     WHERE je.user_id = ? AND je.entry_date >= ? AND je.entry_date <= ? AND a.account_type = 'cost' AND ${jePosted()} AND ${jeNotOrphaned()}`
  ).bind(tenantId, startDate, endDate).first<{ amount: number }>();

  // Account-level breakdown for drill-down (journal-based)
  const revenueAccounts = await db.prepare(
    `SELECT jl.account_code, a.account_name,
            COALESCE(SUM(jl.credit) - SUM(jl.debit), 0) as amount
     FROM journal_lines jl
     JOIN journal_entries je ON jl.entry_id = je.id
     JOIN accounts a ON jl.account_code = a.account_code AND je.user_id = a.user_id
     WHERE je.user_id = ? AND je.entry_date >= ? AND je.entry_date <= ?
       AND a.account_type = 'revenue' AND ${jePosted()} AND ${jeNotOrphaned()}
     GROUP BY jl.account_code, a.account_name
     HAVING amount != 0
     ORDER BY jl.account_code`
  ).bind(tenantId, startDate, endDate).all<{ account_code: string; account_name: string; amount: number }>();

  const expenseAccounts = await db.prepare(
    `SELECT jl.account_code, a.account_name,
            COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) as amount
     FROM journal_lines jl
     JOIN journal_entries je ON jl.entry_id = je.id
     JOIN accounts a ON jl.account_code = a.account_code AND je.user_id = a.user_id
     WHERE je.user_id = ? AND je.entry_date >= ? AND je.entry_date <= ?
       AND a.account_type = 'expense' AND ${jePosted()} AND ${jeNotOrphaned()}
     GROUP BY jl.account_code, a.account_name
     HAVING amount != 0
     ORDER BY jl.account_code`
  ).bind(tenantId, startDate, endDate).all<{ account_code: string; account_name: string; amount: number }>();

  const costAccounts = await db.prepare(
    `SELECT jl.account_code, a.account_name,
            COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) as amount
     FROM journal_lines jl
     JOIN journal_entries je ON jl.entry_id = je.id
     JOIN accounts a ON jl.account_code = a.account_code AND je.user_id = a.user_id
     WHERE je.user_id = ? AND je.entry_date >= ? AND je.entry_date <= ?
       AND a.account_type = 'cost' AND ${jePosted()} AND ${jeNotOrphaned()}
     GROUP BY jl.account_code, a.account_name
     HAVING amount != 0
     ORDER BY jl.account_code`
  ).bind(tenantId, startDate, endDate).all<{ account_code: string; account_name: string; amount: number }>();

  // If journal entries exist, use them
  if ((revenue?.amount || 0) > 0 || (cost?.amount || 0) > 0 || (expenses?.amount || 0) > 0) {
    const grossProfit = (revenue?.amount || 0) - (cost?.amount || 0);
    const netIncome = grossProfit - (expenses?.amount || 0);
    return c.json({
      revenue: revenue?.amount || 0,
      cost: cost?.amount || 0,
      gross_profit: grossProfit,
      expenses: expenses?.amount || 0,
      net_income: netIncome,
      source: 'journal',
      revenue_accounts: revenueAccounts?.results || [],
      cost_accounts: costAccounts?.results || [],
      expense_accounts: expenseAccounts?.results || [],
      period: { start: startDate, end: endDate },
    });
  }

  // Fallback: use bank transactions with account_code categorization
  // Revenue: 4xxxx codes, plus uncategorized deposits that look like client payments
  const bankRevenue = await db.prepare(
    `SELECT COALESCE(SUM(deposit_amount), 0) as amount FROM bank_transactions
     WHERE user_id = ? AND transaction_date >= ? AND transaction_date <= ? AND deleted_at IS NULL
     AND (account_code LIKE '4%' OR (account_code IS NULL AND deposit_amount > 0
       AND description NOT LIKE '%LOAN REPAYMENT%'
       AND description NOT LIKE '%B/F%'
       AND description NOT LIKE '%TRANSFER%FROM%'))
     AND NOT (account_code LIKE '3%' OR account_code LIKE '1%' OR account_code LIKE '2%')`
  ).bind(tenantId, startDate, endDate).first<{ amount: number }>();

  // Expenses: 6xxxx/8xxxx codes, plus uncategorized withdrawals
  const bankExpenses = await db.prepare(
    `SELECT COALESCE(SUM(withdrawal_amount), 0) as amount FROM bank_transactions
     WHERE user_id = ? AND transaction_date >= ? AND transaction_date <= ? AND deleted_at IS NULL
     AND (account_code LIKE '6%' OR account_code LIKE '8%' OR (account_code IS NULL AND withdrawal_amount > 0
       AND description NOT LIKE '%LOAN REPAYMENT%'
       AND description NOT LIKE '%TD DESIGNATED%'
       AND description NOT LIKE '%轉賬支出%'))
     AND NOT (account_code LIKE '3%' OR account_code LIKE '1%' OR account_code LIKE '2%')`
  ).bind(tenantId, startDate, endDate).first<{ amount: number }>();

  // Cost: 5xxxx codes only
  const bankCost = await db.prepare(
    `SELECT COALESCE(SUM(withdrawal_amount), 0) as amount FROM bank_transactions
     WHERE user_id = ? AND transaction_date >= ? AND transaction_date <= ? AND deleted_at IS NULL
     AND (account_code LIKE '5%')
     AND NOT (account_code LIKE '3%' OR account_code LIKE '1%' OR account_code LIKE '2%')`
  ).bind(tenantId, startDate, endDate).first<{ amount: number }>();

  // Also count categorized separately for transparency
  const catRevenue = await db.prepare(
    `SELECT COALESCE(SUM(deposit_amount), 0) as amount FROM bank_transactions
     WHERE user_id = ? AND transaction_date >= ? AND transaction_date <= ? AND account_code LIKE '4%' AND deleted_at IS NULL`
  ).bind(tenantId, startDate, endDate).first<{ amount: number }>();

  const catExpenses = await db.prepare(
    `SELECT COALESCE(SUM(withdrawal_amount), 0) as amount FROM bank_transactions
     WHERE user_id = ? AND transaction_date >= ? AND transaction_date <= ? AND (account_code LIKE '6%' OR account_code LIKE '8%') AND deleted_at IS NULL`
  ).bind(tenantId, startDate, endDate).first<{ amount: number }>();

  const uncategorized = await db.prepare(
    `SELECT COUNT(*) as cnt, COALESCE(SUM(withdrawal_amount),0) as wit, COALESCE(SUM(deposit_amount),0) as dep
     FROM bank_transactions WHERE user_id = ? AND account_code IS NULL AND deleted_at IS NULL`
  ).bind(tenantId).first<{ cnt: number; wit: number; dep: number }>();

  // Account-level breakdown for bank-based path
  const bankRevenueAccounts = await db.prepare(
    `SELECT COALESCE(account_code, 'uncategorized') as account_code,
            'Bank Deposit' as account_name,
            COALESCE(SUM(deposit_amount), 0) as amount
     FROM bank_transactions
     WHERE user_id = ? AND transaction_date >= ? AND transaction_date <= ?
       AND account_code LIKE '4%' AND deleted_at IS NULL
     GROUP BY account_code
     HAVING amount > 0
     ORDER BY account_code`
  ).bind(tenantId, startDate, endDate).all<{ account_code: string; account_name: string; amount: number }>();

  const bankExpenseAccounts = await db.prepare(
    `SELECT COALESCE(account_code, 'uncategorized') as account_code,
            'Bank Withdrawal' as account_name,
            COALESCE(SUM(withdrawal_amount), 0) as amount
     FROM bank_transactions
     WHERE user_id = ? AND transaction_date >= ? AND transaction_date <= ?
       AND (account_code LIKE '6%' OR account_code LIKE '8%')
       AND deleted_at IS NULL
     GROUP BY account_code
     HAVING amount > 0
     ORDER BY account_code`
  ).bind(tenantId, startDate, endDate).all<{ account_code: string; account_name: string; amount: number }>();

  const bankCostAccounts = await db.prepare(
    `SELECT COALESCE(account_code, 'uncategorized') as account_code,
            'Bank Withdrawal' as account_name,
            COALESCE(SUM(withdrawal_amount), 0) as amount
     FROM bank_transactions
     WHERE user_id = ? AND transaction_date >= ? AND transaction_date <= ?
       AND account_code LIKE '5%' AND deleted_at IS NULL
     GROUP BY account_code
     HAVING amount > 0
     ORDER BY account_code`
  ).bind(tenantId, startDate, endDate).all<{ account_code: string; account_name: string; amount: number }>();

  const grossProfit = (bankRevenue?.amount || 0) - (bankCost?.amount || 0);
  const netIncome = grossProfit - (bankExpenses?.amount || 0);
  return c.json({
    revenue: bankRevenue?.amount || 0,
    cost: bankCost?.amount || 0,
    gross_profit: grossProfit,
    expenses: bankExpenses?.amount || 0,
    net_income: netIncome,
    source: 'bank',
    revenue_accounts: bankRevenueAccounts?.results || [],
    cost_accounts: bankCostAccounts?.results || [],
    expense_accounts: bankExpenseAccounts?.results || [],
    breakdown: {
      categorized_revenue: catRevenue?.amount || 0,
      categorized_expenses: catExpenses?.amount || 0,
      uncategorized_count: uncategorized?.cnt || 0,
      uncategorized_deposits: uncategorized?.dep || 0,
      uncategorized_withdrawals: uncategorized?.wit || 0,
    },
    period: { start: startDate, end: endDate },
  });
});

// ── Drill-down: transactions for a single account code within a period ──
bookkeeping.get('/income-statement/:code/transactions', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const code = c.req.param('code');
  const startDate = c.req.query('start_date') || '2000-01-01';
  const endDate = c.req.query('end_date') || new Date().toISOString().split('T')[0];

  // Journal entries for this account in this period
  const entries = await db.prepare(
    `SELECT je.id as entry_id, je.entry_number, je.entry_date, je.description, je.status,
            jl.debit, jl.credit, jl.description as line_desc
     FROM journal_lines jl
     JOIN journal_entries je ON jl.entry_id = je.id
     WHERE je.user_id = ? AND jl.account_code = ? AND je.entry_date >= ? AND je.entry_date <= ? AND ${jePosted()} AND ${jeNotOrphaned()}
     ORDER BY je.entry_date, je.entry_number`
  ).bind(tenantId, code, startDate, endDate).all();

  // Bank transactions coded to this account in this period
  const bankTxns = await db.prepare(
    `SELECT id, bank_statement_id, transaction_date, description, deposit_amount, withdrawal_amount, match_status
     FROM bank_transactions
     WHERE user_id = ? AND account_code = ? AND transaction_date >= ? AND transaction_date <= ? AND deleted_at IS NULL
     ORDER BY transaction_date`
  ).bind(tenantId, code, startDate, endDate).all();

  return c.json({
    account_code: code,
    period: { start: startDate, end: endDate },
    journal_entries: entries.results || [],
    bank_transactions: bankTxns.results || [],
  });
});

// Balance Sheet — Assets, Liabilities, and Equity as of a date
bookkeeping.get('/balance-sheet', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const asOf = c.req.query('as_of') || new Date().toISOString().split('T')[0];

  // Get all journal lines up to as_of date
  const rows = await db.prepare(
    `SELECT jl.account_code, jl.account_name, a.account_type, SUM(jl.debit) as total_debit, SUM(jl.credit) as total_credit
     FROM journal_lines jl JOIN journal_entries je ON jl.entry_id = je.id
     LEFT JOIN accounts a ON jl.account_code = a.account_code AND je.user_id = a.user_id
     WHERE je.user_id = ? AND je.entry_date <= ? AND ${jePosted()} AND ${jeNotOrphaned()}
     GROUP BY jl.account_code, jl.account_name
     ORDER BY jl.account_code`
  ).bind(tenantId, asOf).all();

  const jeCount = await db.prepare(
    `SELECT COUNT(*) as cnt FROM journal_entries WHERE user_id = ? AND entry_date <= ? AND ${jePosted('journal_entries')} AND ${jeNotOrphaned('journal_entries')}`
  ).bind(tenantId, asOf).first<{ cnt: number }>();

  if ((jeCount?.cnt || 0) > 0 && (rows.results || []).length > 0) {
    // Calculate balances: Assets/Expenses = debit - credit, Liabilities/Equity/Revenue = credit - debit.
    // Contra-asset accounts (accumulated depreciation etc.) intentionally use the SAME debit - credit
    // formula so they come out negative and net against assets. Flipping them to credit - debit breaks
    // the accounting identity: every journal line must contribute (debit - credit) to Assets - (Liab + Equity),
    // otherwise the check is off by exactly -2 x (debit - credit) of the contra lines.
    const calcBalance = (row: any) => {
      const type = (row.account_type || '').toLowerCase();
      const code = (row.account_code || '');
      // Assets (1xxx) and Expenses (5xxx/6xxx/8xxx): debit balance
      if (type === 'asset' || type === 'cost' || type === 'expense' || code.startsWith('1') || code.startsWith('5') || code.startsWith('6') || code.startsWith('8')) {
        return row.total_debit - row.total_credit;
      }
      // Liabilities (2xxx), Equity (3xxx), Revenue (4xxx): credit balance
      return row.total_credit - row.total_debit;
    };

    const assets: { code: string; name: string; balance: number }[] = [];
    const liabilities: { code: string; name: string; balance: number }[] = [];
    const equity: { code: string; name: string; balance: number }[] = [];
    let totalRevenue = 0;
    let totalExpenses = 0;

    // Get opening balances for balance sheet accounts
    const openingRows = await db.prepare(
      "SELECT account_code, account_name, account_type, COALESCE(opening_balance, 0) as opening_balance FROM accounts WHERE user_id = ? AND is_active = 1"
    ).bind(tenantId).all();

    for (const row of rows.results as any[]) {
      const balance = calcBalance(row);
      const accountType = (row.account_type || '').toLowerCase();
      if (row.account_code?.startsWith('1') || accountType === 'asset') {
        assets.push({ code: row.account_code, name: row.account_name, balance });
      } else if (row.account_code?.startsWith('2') || accountType === 'liability') {
        liabilities.push({ code: row.account_code, name: row.account_name, balance });
      } else if (row.account_code?.startsWith('3') || accountType === 'equity') {
        equity.push({ code: row.account_code, name: row.account_name, balance });
      } else if (row.account_code?.startsWith('4') || accountType === 'revenue') {
        totalRevenue += balance;
      } else if (row.account_code?.startsWith('5') || row.account_code?.startsWith('6') || row.account_code?.startsWith('8') || accountType === 'cost' || accountType === 'expense') {
        totalExpenses += balance;
      }
    }

    // Add opening balances to assets, liabilities, and equity
    for (const row of openingRows.results as any[]) {
      if (!row.opening_balance || row.opening_balance === 0) continue;
      const type = (row.account_type || '').toLowerCase();
      const code = row.account_code || '';
      // Only apply opening balances to balance sheet accounts (not P&L)
      if (code.startsWith('1') || type === 'asset') {
        const existing = assets.find(a => a.code === code);
        if (existing) existing.balance += row.opening_balance;
        else assets.push({ code, name: row.account_name, balance: row.opening_balance });
      } else if (code.startsWith('2') || type === 'liability') {
        const existing = liabilities.find(l => l.code === code);
        if (existing) existing.balance += row.opening_balance;
        else liabilities.push({ code, name: row.account_name, balance: row.opening_balance });
      } else if (code.startsWith('3') || type === 'equity') {
        const existing = equity.find(e => e.code === code);
        if (existing) existing.balance += row.opening_balance;
        else equity.push({ code, name: row.account_name, balance: row.opening_balance });
      }
    }

    const currentYearPL = totalRevenue - totalExpenses;
    if (Math.abs(currentYearPL) > 0.01) {
      equity.push({ code: '32200', name: 'Current Year P&L (本年度損益)', balance: currentYearPL });
    }

    const totalAssets = assets.reduce((s, a) => s + a.balance, 0);
    const totalLiabilities = liabilities.reduce((s, l) => s + l.balance, 0);
    const totalEquity = equity.reduce((s, e) => s + e.balance, 0);

    return c.json({
      assets, liabilities, equity,
      total_assets: totalAssets,
      total_liabilities: totalLiabilities,
      total_equity: totalEquity,
      current_year_pl: currentYearPL,
      total_revenue: totalRevenue,
      total_expenses: totalExpenses,
      check: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
      as_of: asOf,
      source: 'journal',
    });
  }

  // Fallback: estimate from bank transactions
  const bankDeposits = await db.prepare(
    `SELECT COALESCE(SUM(deposit_amount), 0) as amount FROM bank_transactions WHERE user_id = ? AND transaction_date <= ? AND deleted_at IS NULL`
  ).bind(tenantId, asOf).first<{ amount: number }>();
  const bankWithdrawals = await db.prepare(
    `SELECT COALESCE(SUM(withdrawal_amount), 0) as amount FROM bank_transactions WHERE user_id = ? AND transaction_date <= ? AND deleted_at IS NULL`
  ).bind(tenantId, asOf).first<{ amount: number }>();

  const cashBalance = (bankDeposits?.amount || 0) - (bankWithdrawals?.amount || 0);
  const netCash = Math.max(cashBalance, 0);
  const netDeficit = Math.max(-cashBalance, 0);

  return c.json({
    assets: [
      { code: '11101', name: 'Cash (銀行現金估算)', balance: netCash },
    ],
    liabilities: netDeficit > 0.01 ? [
      { code: '21201', name: 'Director Loan (估算)', balance: netDeficit },
    ] : [],
    equity: [
      { code: '3xxx', name: 'Retained Earnings (估算)', balance: netCash - netDeficit },
    ],
    total_assets: netCash,
    total_liabilities: netDeficit,
    total_equity: netCash - netDeficit,
    current_year_pl: netCash - netDeficit,
    total_revenue: bankDeposits?.amount || 0,
    total_expenses: bankWithdrawals?.amount || 0,
    check: true,
    as_of: asOf,
    source: 'bank',
  });
});

// General Ledger — grouped by account with running balances
bookkeeping.get('/ledger', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const startDate = c.req.query('start_date') || '2000-01-01';
  const endDate = c.req.query('end_date') || '2099-12-31';
  const filterAccount = c.req.query('account_code');

  // Check if journal entries exist
  const jeCount = await db.prepare(
    `SELECT COUNT(*) as cnt FROM journal_entries WHERE user_id = ? AND entry_date >= ? AND entry_date <= ? AND ${jePosted('journal_entries')} AND ${jeNotOrphaned('journal_entries')}`
  ).bind(tenantId, startDate, endDate).first<{ cnt: number }>();

  if ((jeCount?.cnt || 0) > 0) {
    // Use journal entries
    let query = `SELECT jl.account_code, jl.account_name, a.account_type, je.entry_date as date, je.description, jl.debit, jl.credit
      FROM journal_lines jl JOIN journal_entries je ON jl.entry_id = je.id
      LEFT JOIN accounts a ON jl.account_code = a.account_code AND je.user_id = a.user_id
      WHERE je.user_id = ? AND je.entry_date >= ? AND je.entry_date <= ? AND ${jePosted()} AND ${jeNotOrphaned()}`;
    const params: any[] = [tenantId, startDate, endDate];
    if (filterAccount) { query += ' AND jl.account_code LIKE ?'; params.push(`${filterAccount}%`); }
    query += ' ORDER BY jl.account_code, je.entry_date, jl.sort_order';
    const rows = await db.prepare(query).bind(...params).all();

    // Pre-load opening balances for all accounts
    const openingBalances = await db.prepare(
      'SELECT account_code, COALESCE(opening_balance, 0) as ob FROM accounts WHERE user_id = ? AND is_active = 1'
    ).bind(tenantId).all();
    const obMap = new Map<string, number>();
    for (const row of openingBalances.results as any[]) { obMap.set(row.account_code, row.ob); }

    // Group by account and compute running balances (starting from opening_balance)
    const groups: Record<string, { account_code: string; account_name: string; account_type: string; opening_balance: number; entries: any[]; total_debit: number; total_credit: number }> = {};
    for (const row of rows.results as any[]) {
      const key = row.account_code;
      if (!groups[key]) {
        const ob = obMap.get(row.account_code) || 0;
        groups[key] = { account_code: row.account_code, account_name: row.account_name, account_type: row.account_type || '', opening_balance: ob, entries: [], total_debit: 0, total_credit: 0 };
      }
      const g = groups[key];
      const lastBalance = g.entries.length > 0 ? g.entries[g.entries.length - 1].balance : g.opening_balance;
      // Assets/Expenses: debit increases, credit decreases. Liabilities/Equity/Revenue: opposite.
      const isDebitNatural = row.account_type === 'asset' || row.account_type === 'cost' || row.account_type === 'expense';
      const change = isDebitNatural ? (row.debit - row.credit) : (row.credit - row.debit);
      const balance = lastBalance + change;
      g.entries.push({ date: row.date, description: row.description, debit: row.debit, credit: row.credit, balance });
      g.total_debit += row.debit;
      g.total_credit += row.credit;
    }
    return c.json({ accounts: Object.values(groups).map(g => ({ ...g, opening_balance: g.opening_balance })), source: 'journal', period: { start: startDate, end: endDate } });
  }

  // Fallback: bank_transactions
  const bankRows = await db.prepare(
    `SELECT bt.*, i.invoice_number, i.supplier_id, i.customer_id
     FROM bank_transactions bt LEFT JOIN invoices i ON bt.invoice_id = i.id
     WHERE bt.user_id = ? AND bt.transaction_date >= ? AND bt.transaction_date <= ? AND bt.deleted_at IS NULL
     ORDER BY bt.transaction_date`
  ).bind(tenantId, startDate, endDate).all();

  const isDirector = (desc: string) => /JOSEPH|LIN|RAYMOND|SZETO/i.test(desc);

  interface LedgerEntry { date: string; description: string; debit: number; credit: number; balance: number }
  interface AccountGroup { account_code: string; account_name: string; account_type: string; entries: LedgerEntry[]; total_debit: number; total_credit: number }
  const groups: Record<string, AccountGroup> = {};
  const ensure = (code: string, name: string, type: string) => {
    if (!groups[code]) groups[code] = { account_code: code, account_name: name, account_type: type, entries: [], total_debit: 0, total_credit: 0 };
    return groups[code];
  };
  const push = (g: AccountGroup, e: LedgerEntry) => { const last = g.entries.length > 0 ? g.entries[g.entries.length - 1].balance : 0; const isDebitNat = g.account_type === 'asset' || g.account_type === 'cost' || g.account_type === 'expense'; const change = isDebitNat ? (e.debit - e.credit) : (e.credit - e.debit); e.balance = last + change; g.entries.push(e); g.total_debit += e.debit; g.total_credit += e.credit; };

  for (const tx of bankRows.results as any[]) {
    const desc = tx.description || '';
    const invInfo = tx.invoice_number ? ` (${tx.invoice_number})` : '';
    if (tx.deposit_amount > 0) {
      // Debit Cash
      push(ensure('11101', 'Cash on Hand', 'asset'), { date: tx.transaction_date, description: desc + invInfo, debit: tx.deposit_amount, credit: 0, balance: 0 });
      // Credit revenue or Director Loan
      if (isDirector(desc)) {
        push(ensure('21201', 'Director Loan', 'liability'), { date: tx.transaction_date, description: desc, debit: 0, credit: tx.deposit_amount, balance: 0 });
      } else {
        push(ensure('41101', 'Professional Services', 'revenue'), { date: tx.transaction_date, description: desc + invInfo, debit: 0, credit: tx.deposit_amount, balance: 0 });
      }
    }
    if (tx.withdrawal_amount > 0) {
      const expCode = tx.supplier_id ? '51101' : '62303';
      const expName = tx.supplier_id ? 'Subcontractor Fees' : 'Software Subscriptions';
      push(ensure(expCode, expName, 'expense'), { date: tx.transaction_date, description: desc + invInfo, debit: tx.withdrawal_amount, credit: 0, balance: 0 });
      push(ensure('11101', 'Cash on Hand', 'asset'), { date: tx.transaction_date, description: desc + invInfo, debit: 0, credit: tx.withdrawal_amount, balance: 0 });
    }
  }

  if (filterAccount) {
    const filtered: Record<string, AccountGroup> = {};
    for (const [k, v] of Object.entries(groups)) {
      if (k.startsWith(filterAccount)) filtered[k] = v;
    }
    return c.json({ accounts: Object.values(filtered), source: 'bank', period: { start: startDate, end: endDate } });
  }

  return c.json({ accounts: Object.values(groups), source: 'bank', period: { start: startDate, end: endDate } });
});

// Standardized voucher number generator: {PREFIX}-{YYYYMM}-{SEQ3}
// e.g., B-HSBC-202607-001, B-HSBC-202607-002
async function generateVoucher(prefix: string, date: string, db: any, tenantId: string): Promise<string> {
  const ym = date.slice(0, 7).replace(/-/g, ''); // "2026-07-15" → "202607"
  const like = `${prefix}-${ym}-%`;
  const row = await db.prepare(
    `SELECT entry_number FROM journal_entries WHERE user_id = ? AND entry_number LIKE ? ORDER BY entry_number DESC LIMIT 1`
  ).bind(tenantId, like).first<{ entry_number: string }>();
  let seq = 1;
  if (row?.entry_number) {
    const parts = row.entry_number.split('-');
    const lastSeq = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(lastSeq)) seq = lastSeq + 1;
  }
  return `${prefix}-${ym}-${String(seq).padStart(3, '0')}`;
}

// Auto-generate journal entries from bank transactions
bookkeeping.post('/auto-generate-entries', bookkeeperMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;

  // Count and delete tombstoned entries so they can be regenerated
  const staleCount = await db.prepare(
    `SELECT COUNT(*) as cnt FROM journal_entries
     WHERE user_id = ? AND reference_type = 'bank_transaction' AND ${jeDeleted('journal_entries')}`
  ).bind(tenantId).first<{ cnt: number }>();
  if ((staleCount?.cnt || 0) > 0) {
    await db.prepare(
      `DELETE FROM journal_entries
       WHERE user_id = ? AND reference_type = 'bank_transaction' AND ${jeDeleted('journal_entries')}`
    ).bind(tenantId).run();
  }

  // Get bank transactions already converted (tombstoned ones were deleted above,
  // but filter explicitly rather than depending on that ordering)
  const existingRefs = await db.prepare(
    `SELECT reference_id FROM journal_entries
     WHERE user_id = ? AND reference_type = 'bank_transaction' AND ${jeLive('journal_entries')}`
  ).bind(tenantId).all();
  const refSet = new Set((existingRefs.results as any[]).map(r => r.reference_id));

  const txRows = await db.prepare(
    `SELECT bt.*, i.invoice_number, i.supplier_id, bs.bank_name, bs.account_number
     FROM bank_transactions bt
     LEFT JOIN invoices i ON bt.invoice_id = i.id
     LEFT JOIN bank_statements bs ON bt.bank_statement_id = bs.id
     WHERE bt.user_id = ?
     AND bt.deleted_at IS NULL
     AND bt.match_status != 'confirmed'
     AND bt.description NOT LIKE '%TRANSACTION SUMMARY%'
     AND bt.description NOT LIKE '%CARRIED FORWARD%'
     AND bt.description NOT LIKE '%今期結餘%'
     AND bt.description NOT LIKE '%進支摘要%'
     ORDER BY bt.transaction_date`
  ).bind(tenantId).all();

  // Dynamically ensure all transaction codes exist in COA
  const createdCount: number[] = [0];
  const codes = await collectTransactionCodes(db, tenantId);
  await ensureMissingAccounts(db, tenantId, codes, createdCount);

  const isDirector = (desc: string) => /JOSEPH|LIN PUI|LAI KIN|RAYMOND|SZETO/i.test(desc);

  // Pre-load COA lookup for resolving pre-assigned account codes
  const allAccounts = await db.prepare(
    'SELECT account_code, account_name, account_type FROM accounts WHERE user_id = ? AND is_active = 1'
  ).bind(tenantId).all();
  const accountMap = new Map<string, { name: string; type: string }>();
  for (const a of allAccounts.results as any[]) {
    accountMap.set(a.account_code, { name: a.account_name, type: a.account_type });
  }

  let created = 0;

  for (const tx of txRows.results as any[]) {
    if (refSet.has(tx.id)) continue;

    const desc = tx.description || '';
    const invInfo = tx.invoice_number ? ` (${tx.invoice_number})` : '';
    const dir = (tx.deposit_amount > 0 ? 'deposit' : 'withdrawal') as 'deposit' | 'withdrawal';
    // Shared engine first; legacy heuristics below remain as fallback
    const cat = categorizeTransaction(desc, dir);
    const stmtBankCode = await resolveBankAccountCode(db, tenantId, tx.bank_name);
    // Engine-tagged noise/internal transfers: never post unless user assigned a code
    if (cat && cat.code === '' && !tx.account_code) continue;

    const entryId = `je-${uuidv4().slice(0, 8)}`;
    // Generate standardized voucher: B-{BANK}-{YYYYMM}-{SEQ}
    const bankCode = (tx.bank_name || 'BANK').replace(/[^A-Z0-9]/gi, '').slice(0, 6).toUpperCase() || 'BANK';
    const txDate = tx.transaction_date || new Date().toISOString().split('T')[0];
    const entryNum = await generateVoucher(`B-${bankCode}`, txDate, db, tenantId);
    const nameOf = (code: string) => accountMap.get(code)?.name || HK_COA_NAMES[code]?.name || code;
    const lines: { code: string; name: string; debit: number; credit: number }[] = [];

    if (tx.deposit_amount > 0) {
      // OUTCLEARING/RETURN: deposit was reversed — contra entry
      if (desc.includes('OUTCLEARING') || desc.includes('RETURN') || desc.includes('退票')) {
        lines.push({ code: '21201', name: nameOf('21201'), debit: tx.deposit_amount, credit: 0 });
      } else {
        let contraCode: string | null = null;
        if (tx.account_code && tx.account_code !== stmtBankCode) contraCode = tx.account_code;
        else if (cat?.code && cat.code !== stmtBankCode) contraCode = cat.code;
        else if (isDirector(desc)) contraCode = '21201';
        else if (/VISA DEBIT.*- *CR|CREDIT.*VISA/i.test(desc)) contraCode = '62303';
        else if (desc.includes('INTEREST PAYMENT') || desc.includes('利息收入')) contraCode = '42101';
        else if (tx.deposit_amount >= 5000 && /DIRECT CREDIT|FPS|TRANSFER|CHEQUE/i.test(desc)) contraCode = '21201';
        else {
          // Unmapped deposit: Temporary Revenue (client-COA derived)
          const temp = await getTemporaryAccount(db, tenantId, 'revenue');
          contraCode = temp?.code ?? '41101';
        }
        lines.push({ code: contraCode, name: nameOf(contraCode), debit: 0, credit: tx.deposit_amount });
      }
      lines.push({ code: stmtBankCode, name: nameOf(stmtBankCode), debit: tx.deposit_amount, credit: 0 });
    }
    if (tx.withdrawal_amount > 0) {
      if (desc.includes('OUTCLEARING') || desc.includes('RETURN') || desc.includes('退票')) {
        lines.push({ code: '21201', name: nameOf('21201'), debit: tx.withdrawal_amount, credit: 0 });
      } else {
        let expCode: string | null = null;
        if (tx.account_code && tx.account_code !== stmtBankCode) expCode = tx.account_code;
        else if (cat?.code && cat.code !== stmtBankCode) expCode = cat.code;
        else if (tx.supplier_id) expCode = '51101';
        else {
          // Unmapped withdrawal: Temporary Expenses (client-COA derived)
          const temp = await getTemporaryAccount(db, tenantId, 'expense');
          expCode = temp?.code ?? '62303';
        }
        lines.push({ code: expCode, name: nameOf(expCode), debit: tx.withdrawal_amount, credit: 0 });
      }
      lines.push({ code: stmtBankCode, name: nameOf(stmtBankCode), debit: 0, credit: tx.withdrawal_amount });
    }

    if (lines.length === 0) continue;

    await db.prepare(
      'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(entryId, tenantId, entryNum, tx.transaction_date, desc + invInfo, 'bank_transaction', tx.id).run();

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      await db.prepare(
        'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(`jl-${uuidv4().slice(0, 8)}`, entryId, l.code, l.name, desc + invInfo, l.debit, l.credit, i).run();
    }
    created++;
  }

  if (created > 0) {
    await auditLog(db, user.id, 'auto_generate', 'journal_entry', null, { created, total: txRows.results.length, skipped: refSet.size });
  }
  return c.json({ created, total_transactions: txRows.results.length, skipped: refSet.size, stale_deleted: staleCount?.cnt || 0 });
});

// Post an invoice to GL — Dr AR / Cr Revenue (outgoing), or Dr Expense / Cr AP
// (incoming). Thin wrapper over the shared helper in lib/post-invoice.ts, which
// is also called automatically on invoice confirm and on clean OCR import.
bookkeeping.post('/post-invoice/:id', bookkeeperMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const invoiceId = c.req.param('id');
  if (!invoiceId) return c.json({ error: 'Invoice id required' }, 400);

  const r = await postInvoiceToGl(c.env.DB, tenantId, invoiceId);

  if (r.error) return c.json({ error: r.error }, r.error === 'Invoice not found' ? 404 : 400);
  if (r.already_posted) return c.json({ error: 'Invoice already posted to GL', entry_id: r.entry_id }, 409);
  if (r.not_postable) {
    return c.json({ error: `Invoice status is '${r.not_postable}' — only a finalised invoice can be posted to the GL.` }, 400);
  }

  await auditLog(c.env.DB, user.id, 'post_invoice', 'invoice', invoiceId, { entry_number: r.entry_number });
  return c.json({ entry_id: r.entry_id, entry_number: r.entry_number, invoice_id: invoiceId }, 201);
});

// When an invoice payment is matched, create the receipt/payment entry
// Deposit (AR): Dr Cash / Cr AR   |   Withdrawal (AP): Dr AP / Cr Cash
bookkeeping.post('/post-payment/:transactionId', bookkeeperMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const txId = c.req.param('transactionId');
  if (!txId) return c.json({ error: 'transactionId required' }, 400);

  // Shared helper (also used by the unified match-confirm flow).
  // Fixed 2026-08-17: the old inline INSERT referenced a non-existent
  // journal_lines.project column and silently 500'd on every call.
  const gl = await postPaymentToGl(db, tenantId, txId);
  if (gl.error) return c.json({ error: gl.error }, 404);
  if (gl.already_posted) return c.json({ error: 'Payment already posted to GL', entry_id: gl.entry_id }, 409);

  await auditLog(db, user.id, 'post_payment', 'payment', txId, {});
  return c.json({ entry_id: gl.entry_id, entry_number: gl.entry_number, transaction_id: txId }, 201);
});

// POST /post-transaction/:id — post a single bank transaction to GL as a simple journal entry
// Does NOT require a matched invoice. Uses the transaction's account_code as the counter-account.
bookkeeping.post('/post-transaction/:transactionId', bookkeeperMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const txId = c.req.param('transactionId');
  if (!txId) return c.json({ error: 'transactionId required' }, 400);

  const tx = await db.prepare(
    `SELECT bt.*, bs.bank_name, bs.account_number
     FROM bank_transactions bt
     LEFT JOIN bank_statements bs ON bt.bank_statement_id = bs.id
     WHERE bt.id = ? AND bt.user_id = ? AND bt.deleted_at IS NULL`
  ).bind(txId, tenantId).first<any>();
  if (!tx) return c.json({ error: 'Transaction not found' }, 404);

  // Check not already posted
  const existing = await db.prepare(
    `SELECT id FROM journal_entries
     WHERE reference_type = 'bank_transaction' AND reference_id = ? AND user_id = ?
     AND ${jeLive('journal_entries')}`
  ).bind(txId, tenantId).first();
  if (existing) return c.json({ error: 'Transaction already posted to GL', entry_id: (existing as any).id }, 409);

  const isDeposit = (tx.deposit_amount || 0) > 0;
  const amount = isDeposit ? tx.deposit_amount : tx.withdrawal_amount;
  const desc = tx.description || '';
  const acctCode = tx.account_code || (isDeposit ? '41101' : '62303');
  const bankCode = (tx.bank_name || 'BANK').replace(/[^A-Z0-9]/gi, '').slice(0, 6).toUpperCase() || 'BANK';
  const txDate = tx.transaction_date || new Date().toISOString().split('T')[0];

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
  const jeId = `je-${uuidv4().slice(0, 8)}`;

  // Load account name for the code
  const acctInfo = await db.prepare(
    'SELECT account_name FROM accounts WHERE user_id = ? AND account_code = ? AND is_active = 1'
  ).bind(tenantId, acctCode).first<{ account_name: string }>();
  const acctName = acctInfo?.account_name || acctCode;

  // Simple double-entry: Dr Cash / Cr [account] for deposits, Dr [account] / Cr Cash for withdrawals
  await db.prepare(
    'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id) VALUES (?,?,?,?,?,?,?)'
  ).bind(jeId, tenantId, entryNum, txDate, desc, 'bank_transaction', txId).run();

  if (isDeposit) {
    await db.prepare(
      'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, '11101', 'Cash on Hand', desc, amount, 0, 0).run();
    await db.prepare(
      'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, acctCode, acctName, desc, 0, amount, 1).run();
  } else {
    await db.prepare(
      'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, acctCode, acctName, desc, amount, 0, 0).run();
    await db.prepare(
      'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, '11101', 'Cash on Hand', desc, 0, amount, 1).run();
  }

  await auditLog(db, user.id, 'post_single_tx', 'bank_transaction', txId, { amount, account_code: acctCode });
  return c.json({ entry_id: jeId, entry_number: entryNum, transaction_id: txId, amount, account_code: acctCode }, 201);
});

// Year-End Close: transfer P&L to Retained Earnings and roll forward
bookkeeping.post('/year-end-close', bookkeeperMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const body = await c.req.json();
  const { fiscal_end_date } = body;
  if (!fiscal_end_date) return c.json({ error: 'fiscal_end_date required (e.g. 2026-03-31)' }, 400);

  // Get total revenue and expenses up to fiscal end date
  const revenue = await db.prepare(
    `SELECT COALESCE(SUM(jl.credit) - SUM(jl.debit), 0) as amount FROM journal_lines jl
     JOIN journal_entries je ON jl.entry_id = je.id
     JOIN accounts a ON jl.account_code = a.account_code AND je.user_id = a.user_id
     WHERE je.user_id = ? AND je.entry_date <= ? AND a.account_type = 'revenue' AND ${jePosted()} AND ${jeNotOrphaned()}`
  ).bind(tenantId, fiscal_end_date).first<{ amount: number }>();

  const expenses = await db.prepare(
    `SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) as amount FROM journal_lines jl
     JOIN journal_entries je ON jl.entry_id = je.id
     JOIN accounts a ON jl.account_code = a.account_code AND je.user_id = a.user_id
     WHERE je.user_id = ? AND je.entry_date <= ? AND a.account_type IN ('expense', 'cost') AND ${jePosted()} AND ${jeNotOrphaned()}`
  ).bind(tenantId, fiscal_end_date).first<{ amount: number }>();

  const netIncome = (revenue?.amount || 0) - (expenses?.amount || 0);

  // Create closing entry: Dr/Cr Revenue & Expense accounts, offset to Retained Earnings
  const jeId = `je-${uuidv4().slice(0, 8)}`;
  const jeNum = `JE-YEC-${fiscal_end_date.slice(0, 4)}`;
  await db.prepare(
    'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type) VALUES (?,?,?,?,?,?)'
  ).bind(jeId, tenantId, jeNum, fiscal_end_date, `Year-end close ${fiscal_end_date.slice(0,4)}`, 'year_end_close').run();

  let sortOrder = 0;

  // Close each Revenue account individually (Debit revenue to zero, Credit Retained Earnings)
  const revAccounts = await db.prepare(
    `SELECT jl.account_code, jl.account_name, SUM(jl.credit) - SUM(jl.debit) as balance
     FROM journal_lines jl JOIN journal_entries je ON jl.entry_id = je.id
     JOIN accounts a ON jl.account_code = a.account_code AND je.user_id = a.user_id
     WHERE je.user_id = ? AND je.entry_date <= ? AND a.account_type = 'revenue' AND ${jePosted()} AND ${jeNotOrphaned()}
     GROUP BY jl.account_code ORDER BY jl.account_code`
  ).bind(tenantId, fiscal_end_date).all();

  for (const row of revAccounts.results as any[]) {
    if (Math.abs(row.balance || 0) < 0.01) continue;
    await db.prepare(
      'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, project, sort_order) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, row.account_code, row.account_name, `Close to RE`, Math.abs(row.balance), 0, null, sortOrder++).run();
  }

  // Close each Expense account individually (Credit expense to zero, Debit Retained Earnings)
  const expAccounts = await db.prepare(
    `SELECT jl.account_code, jl.account_name, SUM(jl.debit) - SUM(jl.credit) as balance
     FROM journal_lines jl JOIN journal_entries je ON jl.entry_id = je.id
     JOIN accounts a ON jl.account_code = a.account_code AND je.user_id = a.user_id
     WHERE je.user_id = ? AND je.entry_date <= ? AND a.account_type IN ('expense', 'cost') AND ${jePosted()} AND ${jeNotOrphaned()}
     GROUP BY jl.account_code ORDER BY jl.account_code`
  ).bind(tenantId, fiscal_end_date).all();

  for (const row of expAccounts.results as any[]) {
    if (Math.abs(row.balance || 0) < 0.01) continue;
    await db.prepare(
      'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, project, sort_order) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, row.account_code, row.account_name, `Close to RE`, 0, Math.abs(row.balance), null, sortOrder++).run();
  }

  // Net to Retained Earnings (balancing entry)
  if (netIncome > 0) {
    await db.prepare(
      'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, project, sort_order) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, '32101', 'Retained Earnings b/f 上年度保留盈利', `Year ${fiscal_end_date.slice(0,4)} net income`, 0, netIncome, null, sortOrder++).run();
  } else if (netIncome < 0) {
    await db.prepare(
      'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, project, sort_order) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, '32101', 'Retained Earnings b/f 上年度保留盈利', `Year ${fiscal_end_date.slice(0,4)} net loss`, Math.abs(netIncome), 0, null, sortOrder++).run();
  }

  // Update opening balances for balance sheet accounts for new fiscal year
  const bsAccounts = await db.prepare(
    `SELECT a.account_code, COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) as journal_balance, a.opening_balance
     FROM accounts a LEFT JOIN journal_lines jl ON a.account_code = jl.account_code
     LEFT JOIN journal_entries je ON jl.entry_id = je.id AND je.entry_date <= ? AND ${jePosted()} AND ${jeNotOrphaned()}
     WHERE a.user_id = ? AND a.is_active = 1 AND a.account_type IN ('asset', 'liability', 'equity')
     GROUP BY a.account_code`
  ).bind(fiscal_end_date, tenantId).all();

  for (const row of bsAccounts.results as any[]) {
    const newOpening = (row.opening_balance || 0) + (row.journal_balance || 0);
    await db.prepare('UPDATE accounts SET opening_balance = ? WHERE user_id = ? AND account_code = ?')
      .bind(newOpening, tenantId, row.account_code).run();
  }

  await auditLog(db, user.id, 'year_end_close', 'fiscal_year', jeId, { fiscal_end_date, revenue: revenue?.amount, expenses: expenses?.amount, net_income: netIncome });
  return c.json({ entry_id: jeId, entry_number: jeNum, fiscal_end_date, revenue: revenue?.amount || 0, expenses: expenses?.amount || 0, net_income: netIncome }, 201);
});

// Profits Tax Provision: compute basic tax provision (16.5% of net income for HK companies)
bookkeeping.post('/profits-tax-provision', bookkeeperMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const body = await c.req.json();
  const { fiscal_end_date, tax_rate } = body;
  if (!fiscal_end_date) return c.json({ error: 'fiscal_end_date required' }, 400);
  const rate = tax_rate || 16.5; // HK standard Profits Tax rate (8.25% below $2M assessable profits)

  // Get net income from P&L
  const revenue = await db.prepare(
    `SELECT COALESCE(SUM(jl.credit) - SUM(jl.debit), 0) as amount FROM journal_lines jl
     JOIN journal_entries je ON jl.entry_id = je.id
     JOIN accounts a ON jl.account_code = a.account_code AND je.user_id = a.user_id
     WHERE je.user_id = ? AND je.entry_date <= ? AND a.account_type = 'revenue' AND ${jePosted()} AND ${jeNotOrphaned()}`
  ).bind(tenantId, fiscal_end_date).first<{ amount: number }>();

  const expenses = await db.prepare(
    `SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) as amount FROM journal_lines jl
     JOIN journal_entries je ON jl.entry_id = je.id
     JOIN accounts a ON jl.account_code = a.account_code AND je.user_id = a.user_id
     WHERE je.user_id = ? AND je.entry_date <= ? AND a.account_type IN ('expense', 'cost') AND ${jePosted()} AND ${jeNotOrphaned()}`
  ).bind(tenantId, fiscal_end_date).first<{ amount: number }>();

  const netIncome = (revenue?.amount || 0) - (expenses?.amount || 0);
  if (netIncome <= 0) return c.json({ message: 'No taxable profit. No provision needed.', net_income: netIncome }, 200);

  // Simple 2-tier rate: 8.25% on first $2M, 16.5% on remainder
  const tier1 = Math.min(netIncome, 2000000);
  const tier2 = Math.max(netIncome - 2000000, 0);
  const taxAmount = tier1 * 0.0825 + tier2 * (rate / 100);

  // Ensure tax accounts exist
  for (const [code, name, type] of [['81101', 'Current Year Profits Tax 本年度利得稅', 'expense'], ['21301', 'Profits Tax Payable 應付利得稅', 'liability']] as const) {
    const ex = await db.prepare('SELECT id FROM accounts WHERE user_id = ? AND account_code = ?').bind(tenantId, code).first();
    if (!ex) {
      await db.prepare('INSERT INTO accounts (id, user_id, account_code, account_name, account_type) VALUES (?,?,?,?,?)')
        .bind(`acc-${uuidv4().slice(0, 8)}`, tenantId, code, name, type).run();
    }
  }

  // Create tax provision journal entry: Dr Profits Tax Expense, Cr Profits Tax Payable
  const jeId = `je-${uuidv4().slice(0, 8)}`;
  const jeNum = `JE-TAX-${fiscal_end_date.slice(0, 4)}`;
  await db.prepare(
    'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type) VALUES (?,?,?,?,?,?)'
  ).bind(jeId, tenantId, jeNum, fiscal_end_date, `Profits Tax provision ${fiscal_end_date.slice(0,4)}`, 'tax_provision').run();

  await db.prepare(
    'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, project, sort_order) VALUES (?,?,?,?,?,?,?,?,?)'
  ).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, '81101', 'Current Year Profits Tax 本年度利得稅', `Tax provision @${rate}%`, Math.round(taxAmount * 100) / 100, 0, null, 0).run();

  await db.prepare(
    'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, project, sort_order) VALUES (?,?,?,?,?,?,?,?,?)'
  ).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, '21301', 'Profits Tax Payable 應付利得稅', `Tax provision @${rate}%`, 0, Math.round(taxAmount * 100) / 100, null, 1).run();

  await auditLog(db, user.id, 'tax_provision', 'tax', jeId, { fiscal_end_date, net_income: netIncome, tax_rate: rate, tax_amount: Math.round(taxAmount * 100) / 100 });

  return c.json({
    entry_id: jeId, entry_number: jeNum,
    net_income: netIncome,
    tax_rate_used: `8.25% on first $2M, ${rate}% on remainder`,
    tax_amount: Math.round(taxAmount * 100) / 100,
    tier1_amount: tier1 * 0.0825,
    tier2_amount: tier2 * (rate / 100),
  }, 201);
});

// ── Transaction-level drill-down for Income Statement ──
bookkeeping.get('/income-statement/:account_code/transactions', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const accountCode = c.req.param('account_code');
  const startDate = c.req.query('start_date') || '2000-01-01';
  const endDate = c.req.query('end_date') || new Date().toISOString().split('T')[0];

  // 1. Fetch journal lines for this account_code (excluding stale entries)
  const journalLines = await db.prepare(
    `SELECT jl.id as line_id, jl.entry_id, jl.account_code, jl.account_name,
            jl.debit, jl.credit, jl.description as line_description,
            je.entry_number, je.entry_date, je.description as entry_description,
            je.reference_type, je.reference_id
     FROM journal_lines jl
     JOIN journal_entries je ON jl.entry_id = je.id
     WHERE je.user_id = ? AND je.entry_date >= ? AND je.entry_date <= ?
       AND jl.account_code = ? AND je.status != 'stale'
     ORDER BY je.entry_date DESC, jl.sort_order`
  ).bind(tenantId, startDate, endDate, accountCode).all<{
    line_id: string; entry_id: string; account_code: string; account_name: string;
    debit: number; credit: number; line_description: string | null;
    entry_number: string; entry_date: string; entry_description: string;
    reference_type: string | null; reference_id: string | null;
  }>();

  // 2. Resolve linked documents for each journal entry
  //    reference_type can be 'invoice', 'bank_transaction', 'bill', 'expense', 'journal'
  const journalEntries: any[] = [];
  for (const jl of (journalLines?.results || [])) {
    const amount = jl.credit > 0 ? jl.credit : -jl.debit;
    const direction = jl.credit > 0 ? 'credit' : 'debit';
    const entry: any = {
      type: 'journal',
      line_id: jl.line_id,
      entry_id: jl.entry_id,
      entry_number: jl.entry_number,
      entry_date: jl.entry_date,
      description: jl.line_description || jl.entry_description,
      amount: Math.abs(amount),
      direction,
      reference_type: jl.reference_type,
      reference_id: jl.reference_id,
      linked_documents: [] as { type: string; id: string; label: string }[],
    };

    // Resolve invoice link
    if (jl.reference_type === 'invoice' && jl.reference_id) {
      const inv = await db.prepare(
        'SELECT id, invoice_number, total FROM invoices WHERE id = ? AND user_id = ?'
      ).bind(jl.reference_id, tenantId).first<{ id: string; invoice_number: string; total: number }>();
      if (inv) {
        entry.invoice_number = inv.invoice_number;
        entry.invoice_total = inv.total;
        entry.linked_documents.push({ type: 'invoice', id: inv.id, label: inv.invoice_number });
      }
    }

    // Resolve bank statement link (via bank_transactions reference or directly)
    if (jl.reference_type === 'bank_transaction' && jl.reference_id) {
      const bt = await db.prepare(
        `SELECT bt.id, bt.bank_statement_id, bs.statement_year, bs.statement_month, bs.bank_name
         FROM bank_transactions bt
         JOIN bank_statements bs ON bt.bank_statement_id = bs.id
         WHERE bt.id = ? AND bt.user_id = ?`
      ).bind(jl.reference_id, tenantId).first<{
        id: string; bank_statement_id: string;
        statement_year: number; statement_month: number; bank_name: string;
      }>();
      if (bt) {
        entry.bank_statement_id = bt.bank_statement_id;
        entry.bank_statement_period = `${bt.statement_year}-${String(bt.statement_month).padStart(2, '0')}`;
        entry.linked_documents.push({
          type: 'bank_statement', id: bt.bank_statement_id,
          label: `${bt.bank_statement_id} · ${bt.statement_year}-${String(bt.statement_month).padStart(2, '0')} · ${bt.bank_name}`,
        });
      }
    }

    journalEntries.push(entry);
  }

  // 3. Fetch unposted bank transactions (have account_code but NOT journalized)
  const unpostedBankTx = await db.prepare(
    `SELECT bt.id as transaction_id, bt.transaction_date, bt.description,
            CASE WHEN bt.deposit_amount > 0 THEN bt.deposit_amount ELSE bt.withdrawal_amount END as amount,
            CASE WHEN bt.deposit_amount > 0 THEN 'credit' ELSE 'debit' END as direction,
            bt.account_code, bt.bank_statement_id,
            bs.statement_year, bs.statement_month, bs.bank_name
     FROM bank_transactions bt
     JOIN bank_statements bs ON bt.bank_statement_id = bs.id
     LEFT JOIN journal_entries je ON je.reference_id = bt.id AND je.reference_type = 'bank_transaction' AND je.status != 'stale'
     WHERE bt.user_id = ? AND bt.transaction_date >= ? AND bt.transaction_date <= ?
       AND bt.account_code = ? AND bt.deleted_at IS NULL
       AND je.id IS NULL
     ORDER BY bt.transaction_date DESC`
  ).bind(tenantId, startDate, endDate, accountCode).all<{
    transaction_id: string; transaction_date: string; description: string;
    amount: number; direction: string; account_code: string;
    bank_statement_id: string; statement_year: number; statement_month: number; bank_name: string;
  }>();

  const unposted: any[] = (unpostedBankTx?.results || []).map(bt => ({
    type: 'bank',
    transaction_id: bt.transaction_id,
    transaction_date: bt.transaction_date,
    description: bt.description,
    amount: bt.amount,
    direction: bt.direction,
    account_code: bt.account_code,
    bank_statement_id: bt.bank_statement_id,
    bank_statement_period: `${bt.statement_year}-${String(bt.statement_month).padStart(2, '0')}`,
    has_voucher: false,
    linked_documents: [{
      type: 'bank_statement', id: bt.bank_statement_id,
      label: `${bt.bank_statement_id} · ${bt.statement_year}-${String(bt.statement_month).padStart(2, '0')} · ${bt.bank_name}`,
    }],
  }));

  // Get account name
  const acctInfo = await db.prepare(
    'SELECT account_name FROM accounts WHERE account_code = ? AND user_id = ? LIMIT 1'
  ).bind(accountCode, tenantId).first<{ account_name: string }>();

  const total = journalEntries.reduce((s, je) => s + je.amount, 0) +
                unposted.reduce((s, bt) => s + bt.amount, 0);

  return c.json({
    account_code: accountCode,
    account_name: acctInfo?.account_name || accountCode,
    total,
    journal_entries: journalEntries,
    unposted_bank_transactions: unposted,
    period: { start: startDate, end: endDate },
  });
});

export { bookkeeping as bookkeepingRoutes };
