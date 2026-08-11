import { Hono } from 'hono';
import { Bindings, Variables } from '../types';
import { authMiddleware } from '../middleware/auth';

const dashboard = new Hono<{ Bindings: Bindings; Variables: Variables }>();
dashboard.use('*', authMiddleware);

dashboard.get('/', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const today = new Date().toISOString().split('T')[0];
  const reqStart = c.req.query('start_date') || '';
  const reqEnd = c.req.query('end_date') || '';
  const periodStart = reqStart || today.slice(0, 7) + '-01';
  const periodEnd = reqEnd || today;

  // A journal entry generated from a bank transaction is "orphaned" if that transaction
  // has since been soft-deleted (e.g. its parent bank statement was moved to the recycle
  // bin) but the entry itself wasn't cleaned up. Exclude those live, in addition to the
  // status != 'stale' check above — this also self-heals any data that was orphaned
  // before this check existed, without needing a backfill.
  const notOrphaned = `(je.reference_type != 'bank_transaction' OR EXISTS (
    SELECT 1 FROM bank_transactions bt2 WHERE bt2.id = je.reference_id AND bt2.deleted_at IS NULL
  ))`;

  // Cash balance from GL (journal entries against 111xx bank accounts)
  const cashFromGL = await db.prepare(
    `SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) as balance
     FROM journal_lines jl JOIN journal_entries je ON jl.entry_id = je.id
     WHERE je.user_id = ? AND jl.account_code LIKE '111%' AND je.status != 'stale' AND ${notOrphaned}`
  ).bind(tenantId).first<{ balance: number }>();

  // Cash balance — use latest confirmed closing balance per bank account (correct accounting approach)
  // Lily test N02/P1: dashboard was showing movement-based sum instead of latest closing balance
  const cashFromBank = await db.prepare(
    `SELECT COALESCE(SUM(latest_closing), 0) as balance FROM (
       SELECT bs.closing_balance as latest_closing
       FROM bank_statements bs
       INNER JOIN (
         SELECT account_number, currency, MAX(period_end) as max_period
         FROM bank_statements
         WHERE user_id = ? AND deleted_at IS NULL
         AND closing_balance IS NOT NULL AND closing_balance != 0
         GROUP BY account_number, currency
       ) latest ON bs.account_number = latest.account_number
         AND bs.currency = latest.currency
         AND bs.period_end = latest.max_period
       WHERE bs.user_id = ? AND bs.deleted_at IS NULL
     )`
  ).bind(tenantId, tenantId).first<{ balance: number }>();

  // Accounts Receivable from GL
  const arBalance = await db.prepare(
    `SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) as balance
     FROM journal_lines jl JOIN journal_entries je ON jl.entry_id = je.id
     WHERE je.user_id = ? AND jl.account_code LIKE '112%' AND je.status != 'stale' AND ${notOrphaned}`
  ).bind(tenantId).first<{ balance: number }>();

  // Accounts Payable from GL
  const apBalance = await db.prepare(
    `SELECT COALESCE(SUM(jl.credit) - SUM(jl.debit), 0) as balance
     FROM journal_lines jl JOIN journal_entries je ON jl.entry_id = je.id
     WHERE je.user_id = ? AND jl.account_code LIKE '211%' AND je.status != 'stale' AND ${notOrphaned}`
  ).bind(tenantId).first<{ balance: number }>();

  // Revenue MTD from GL
  const revFromGL = await db.prepare(
    `SELECT COALESCE(SUM(jl.credit) - SUM(jl.debit), 0) as amount FROM journal_lines jl
     JOIN journal_entries je ON jl.entry_id = je.id
     JOIN accounts a ON jl.account_code = a.account_code AND je.user_id = a.user_id
     WHERE je.user_id = ? AND je.entry_date >= ? AND je.entry_date <= ? AND a.account_type = 'revenue' AND je.status != 'stale' AND ${notOrphaned}`
  ).bind(tenantId, periodStart, periodEnd).first<{ amount: number }>();

  // Expenses MTD from GL
  const expFromGL = await db.prepare(
    `SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) as amount FROM journal_lines jl
     JOIN journal_entries je ON jl.entry_id = je.id
     JOIN accounts a ON jl.account_code = a.account_code AND je.user_id = a.user_id
     WHERE je.user_id = ? AND je.entry_date >= ? AND je.entry_date <= ? AND a.account_type = 'expense' AND je.status != 'stale' AND ${notOrphaned}`
  ).bind(tenantId, periodStart, periodEnd).first<{ amount: number }>();

  // Revenue MTD from bank (deposits this month)
  const revFromBank = await db.prepare(
    `SELECT COALESCE(SUM(deposit_amount), 0) as amount
     FROM bank_transactions WHERE user_id = ? AND transaction_date >= ? AND transaction_date <= ? AND deleted_at IS NULL`
  ).bind(tenantId, periodStart, periodEnd).first<{ amount: number }>();

  // Expenses MTD from bank (withdrawals this month)
  const expFromBank = await db.prepare(
    `SELECT COALESCE(SUM(withdrawal_amount), 0) as amount
     FROM bank_transactions WHERE user_id = ? AND transaction_date >= ? AND transaction_date <= ? AND deleted_at IS NULL`
  ).bind(tenantId, periodStart, periodEnd).first<{ amount: number }>();

  // Unmatched bank transactions count
  const unmatchedCount = await db.prepare(
    "SELECT COUNT(*) as cnt FROM bank_transactions WHERE user_id = ? AND match_status = 'unmatched' AND deleted_at IS NULL"
  ).bind(tenantId).first<{ cnt: number }>();

  // Review queue total (same 4 queries as review-queue.ts /count)
  const reviewBank = await db.prepare(
    "SELECT COUNT(*) as cnt FROM bank_statements WHERE user_id = ? AND deleted_at IS NULL AND status = 'draft'"
  ).bind(tenantId).first<{ cnt: number }>();
  const reviewCard = await db.prepare(
    "SELECT COUNT(*) as cnt FROM card_statements WHERE user_id = ? AND deleted_at IS NULL AND status = 'draft'"
  ).bind(tenantId).first<{ cnt: number }>();
  const reviewInv = await db.prepare(
    "SELECT COUNT(*) as cnt FROM invoices WHERE user_id = ? AND (status = 'pending_review' OR (needs_review IS NOT NULL AND needs_review != ''))"
  ).bind(tenantId).first<{ cnt: number }>();
  const reviewJE = await db.prepare(
    "SELECT COUNT(*) as cnt FROM journal_entries WHERE user_id = ? AND status IN ('draft', 'stale')"
  ).bind(tenantId).first<{ cnt: number }>();
  const reviewQueueTotal = (reviewBank?.cnt || 0) + (reviewCard?.cnt || 0) + (reviewInv?.cnt || 0) + (reviewJE?.cnt || 0);

  // Recent journal entries
  const recentEntries = await db.prepare(
    `SELECT je.id, je.entry_number, je.entry_date, je.description, je.status,
     SUM(jl.debit) as total_debit, SUM(jl.credit) as total_credit
     FROM journal_entries je LEFT JOIN journal_lines jl ON je.id = jl.entry_id
     WHERE je.user_id = ? GROUP BY je.id ORDER BY je.created_at DESC LIMIT 5`
  ).bind(tenantId).all();

  // Compliance deadlines (next 30 days)
  const upcomingCompliance = await db.prepare(
    `SELECT mc.status, ct.title_zh, ct.title_en, cd.date_value
     FROM member_compliance mc
     JOIN compliance_templates ct ON mc.template_id = ct.id
     LEFT JOIN compliance_dates cd ON cd.user_id = mc.user_id AND cd.date_type = ct.deadline_field
     WHERE mc.user_id = ? AND mc.status = 'pending'
     ORDER BY cd.date_value LIMIT 5`
  ).bind(tenantId).all();

  // Fixed assets summary
  const assetSummary = await db.prepare(
    `SELECT COUNT(*) as count, COALESCE(SUM(cost),0) as total_cost,
     COALESCE(SUM(accumulated_depreciation),0) as total_acc_depn, COALESCE(SUM(net_book_value),0) as total_nbv
     FROM fixed_assets WHERE user_id = ? AND is_active = 1`
  ).bind(tenantId).first<{ count: number; total_cost: number; total_acc_depn: number; total_nbv: number }>();

  // Decide source: use GL figures if they exist (non-zero), otherwise fall back to bank transactions.
  // This handles the common case where bank statements are imported but GL journals haven't been posted yet.
  const glCash = cashFromGL?.balance || 0;
  const bankCash = cashFromBank?.balance || 0;
  const glRevenue = revFromGL?.amount || 0;
  const bankRevenue = revFromBank?.amount || 0;
  const glExpenses = expFromGL?.amount || 0;
  const bankExpenses = expFromBank?.amount || 0;

  const useGL = glCash !== 0 || glRevenue !== 0 || glExpenses !== 0;
  const source = useGL ? 'journal' : 'bank';

  const cashBal    = useGL ? glCash    : bankCash;
  const revenueMTD = useGL ? glRevenue : bankRevenue;
  const expensesMTD = useGL ? glExpenses : bankExpenses;
  const netIncomeMTD = revenueMTD - expensesMTD;

  return c.json({
    cash_balance: cashBal,
    ar_balance: arBalance?.balance || 0,
    ap_balance: apBalance?.balance || 0,
    revenue_mtd: revenueMTD,
    expenses_mtd: expensesMTD,
    net_income_mtd: netIncomeMTD,
    unmatched_transactions: unmatchedCount?.cnt || 0,
    review_queue_total: reviewQueueTotal,
    fixed_assets: assetSummary,
    recent_entries: recentEntries.results,
    upcoming_compliance: upcomingCompliance.results,
    as_of: today,
    source,
  });
});

// ── Link coverage stats (for dashboard percentage cards) ──
dashboard.get('/link-stats', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;

  // Bank transactions: total + linked to invoice
  const bankStats = await db.prepare(
    `SELECT COUNT(*) as total,
     COALESCE(SUM(CASE WHEN invoice_id IS NOT NULL THEN 1 ELSE 0 END), 0) as linked
     FROM bank_transactions WHERE user_id = ? AND deleted_at IS NULL`
  ).bind(tenantId).first<{ total: number; linked: number }>();

  // Invoices (non-receipt): total + linked to a receipt via linked_invoice_id
  const invStats = await db.prepare(
    `SELECT COUNT(*) as total,
     COALESCE(SUM(CASE WHEN linked_invoice_id IS NOT NULL THEN 1 ELSE 0 END), 0) as linked_receipts
     FROM invoices WHERE user_id = ? AND receipt_number IS NULL AND deleted_at IS NULL`
  ).bind(tenantId).first<{ total: number; linked_receipts: number }>();

  // Full chain: bank transaction → invoice → receipt
  const chainStats = await db.prepare(
    `SELECT COUNT(*) as full_chain
     FROM bank_transactions bt
     WHERE bt.user_id = ? AND bt.deleted_at IS NULL
     AND bt.invoice_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM invoices r
       WHERE r.linked_invoice_id = bt.invoice_id
       AND r.receipt_number IS NOT NULL AND r.deleted_at IS NULL
     )`
  ).bind(tenantId).first<{ full_chain: number }>();

  const bankTotal = bankStats?.total || 0;
  const bankLinked = bankStats?.linked || 0;
  const invTotal = invStats?.total || 0;
  const invLinked = invStats?.linked_receipts || 0;
  const chainCount = chainStats?.full_chain || 0;

  const pct = (n: number, d: number) => d > 0 ? Math.round(n / d * 1000) / 10 : 0;

  return c.json({
    bank: { total: bankTotal, linked: bankLinked, pct: pct(bankLinked, bankTotal) },
    invoices: { total: invTotal, linked_receipts: invLinked, pct: pct(invLinked, invTotal) },
    full_chain: { count: chainCount, pct: pct(chainCount, bankTotal) },
  });
});

export { dashboard as dashboardRoutes };
