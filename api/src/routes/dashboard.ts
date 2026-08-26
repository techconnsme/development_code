import { Hono } from 'hono';
import { Bindings, Variables } from '../types';
import { authMiddleware } from '../middleware/auth';
import { jePosted, jeLive, jeDraft } from '../lib/journal-filters';

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
  // jePosted() check on each query — this also self-heals any data that was orphaned
  // before this check existed, without needing a backfill.
  const notOrphaned = `(je.reference_type != 'bank_transaction' OR EXISTS (
    SELECT 1 FROM bank_transactions bt2 WHERE bt2.id = je.reference_id AND bt2.deleted_at IS NULL
  ))`;

  // Cash balance from GL (journal entries against 111xx bank accounts)
  const cashFromGL = await db.prepare(
    `SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) as balance
     FROM journal_lines jl JOIN journal_entries je ON jl.entry_id = je.id
     WHERE je.user_id = ? AND jl.account_code LIKE '111%' AND ${jePosted()} AND ${notOrphaned}`
  ).bind(tenantId).first() as any;

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
  ).bind(tenantId, tenantId).first() as any;

  // Accounts Receivable from GL
  const arBalance = await db.prepare(
    `SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) as balance
     FROM journal_lines jl JOIN journal_entries je ON jl.entry_id = je.id
     WHERE je.user_id = ? AND jl.account_code LIKE '112%' AND ${jePosted()} AND ${notOrphaned}`
  ).bind(tenantId).first() as any;

  // Accounts Payable from GL
  const apBalance = await db.prepare(
    `SELECT COALESCE(SUM(jl.credit) - SUM(jl.debit), 0) as balance
     FROM journal_lines jl JOIN journal_entries je ON jl.entry_id = je.id
     WHERE je.user_id = ? AND jl.account_code LIKE '211%' AND ${jePosted()} AND ${notOrphaned}`
  ).bind(tenantId).first() as any;

  // AR/AP from unpaid invoices (fallback when no GL entries exist)
  const arFromInvoices = await db.prepare(
    `SELECT COALESCE(SUM(total), 0) as balance FROM invoices
     WHERE user_id = ? AND direction = 'outgoing' AND status NOT IN ('paid','cancelled','void','draft') AND deleted_at IS NULL`
  ).bind(tenantId).first() as any;
  const apFromInvoices = await db.prepare(
    `SELECT COALESCE(SUM(total), 0) as balance FROM invoices
     WHERE user_id = ? AND direction = 'incoming' AND status NOT IN ('paid','cancelled','void','draft') AND deleted_at IS NULL`
  ).bind(tenantId).first() as any;

  // Use GL balances when available, otherwise fall back to unpaid invoice totals
  const finalAR = (arBalance?.balance || 0) !== 0 ? (arBalance?.balance || 0) : (arFromInvoices?.balance || 0);
  const finalAP = (apBalance?.balance || 0) !== 0 ? (apBalance?.balance || 0) : (apFromInvoices?.balance || 0);

  // Revenue MTD from GL
  const revFromGL = await db.prepare(
    `SELECT COALESCE(SUM(jl.credit) - SUM(jl.debit), 0) as amount FROM journal_lines jl
     JOIN journal_entries je ON jl.entry_id = je.id
     JOIN accounts a ON jl.account_code = a.account_code AND je.user_id = a.user_id
     WHERE je.user_id = ? AND je.entry_date >= ? AND je.entry_date <= ? AND a.account_type = 'revenue' AND ${jePosted()} AND ${notOrphaned}`
  ).bind(tenantId, periodStart, periodEnd).first() as any;

  // Expenses MTD from GL
  const expFromGL = await db.prepare(
    `SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) as amount FROM journal_lines jl
     JOIN journal_entries je ON jl.entry_id = je.id
     JOIN accounts a ON jl.account_code = a.account_code AND je.user_id = a.user_id
     WHERE je.user_id = ? AND je.entry_date >= ? AND je.entry_date <= ? AND a.account_type IN ('expense', 'cost') AND ${jePosted()} AND ${notOrphaned}`
  ).bind(tenantId, periodStart, periodEnd).first() as any;

  // Revenue MTD from bank (deposits this month)
  const revFromBank = await db.prepare(
    `SELECT COALESCE(SUM(deposit_amount), 0) as amount
     FROM bank_transactions WHERE user_id = ? AND transaction_date >= ? AND transaction_date <= ? AND deleted_at IS NULL`
  ).bind(tenantId, periodStart, periodEnd).first() as any;

  // Expenses MTD from bank (withdrawals this month)
  const expFromBank = await db.prepare(
    `SELECT COALESCE(SUM(withdrawal_amount), 0) as amount
     FROM bank_transactions WHERE user_id = ? AND transaction_date >= ? AND transaction_date <= ? AND deleted_at IS NULL`
  ).bind(tenantId, periodStart, periodEnd).first() as any;

  // Unmatched bank transactions count
  const unmatchedCount = await db.prepare(
    "SELECT COUNT(*) as cnt FROM bank_transactions WHERE user_id = ? AND match_status = 'unmatched' AND deleted_at IS NULL"
  ).bind(tenantId).first() as any;

  // Review queue total (same 4 queries as review-queue.ts /count)
  const reviewBank = await db.prepare(
    "SELECT COUNT(*) as cnt FROM bank_statements WHERE user_id = ? AND deleted_at IS NULL AND status = 'draft'"
  ).bind(tenantId).first() as any;
  const reviewCard = await db.prepare(
    "SELECT COUNT(*) as cnt FROM card_statements WHERE user_id = ? AND deleted_at IS NULL AND status = 'draft'"
  ).bind(tenantId).first() as any;
  const reviewInv = await db.prepare(
    "SELECT COUNT(*) as cnt FROM invoices WHERE user_id = ? AND deleted_at IS NULL AND (status = 'pending_review' OR (needs_review IS NOT NULL AND needs_review != ''))"
  ).bind(tenantId).first() as any;
  const reviewJE = await db.prepare(
    `SELECT COUNT(*) as cnt FROM journal_entries WHERE user_id = ? AND ${jeDraft('journal_entries')}`
  ).bind(tenantId).first() as any;
  const reviewQueueTotal = (reviewBank?.cnt || 0) + (reviewCard?.cnt || 0) + (reviewInv?.cnt || 0) + (reviewJE?.cnt || 0);

  // Recent journal entries. jeLive (not jePosted) — this is an activity feed, so
  // drafts belong here; deleted entries do not. Previously unfiltered, which let
  // tombstoned entries surface in the dashboard's Recent Activity list.
  const recentEntries = await db.prepare(
    `SELECT je.id, je.entry_number, je.entry_date, je.description, je.status,
     SUM(jl.debit) as total_debit, SUM(jl.credit) as total_credit
     FROM journal_entries je LEFT JOIN journal_lines jl ON je.id = jl.entry_id
     WHERE je.user_id = ? AND ${jeLive()} GROUP BY je.id ORDER BY je.created_at DESC LIMIT 5`
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
  ).bind(tenantId).first() as any;

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

  // ── Period comparison: current FY + 2 previous ──
  const periodComparison: any[] = [];
  if (periodStart && periodEnd) {
    const startDate = new Date(periodStart);
    const endDate = new Date(periodEnd);
    const periodLength = endDate.getTime() - startDate.getTime(); // ms in one FY

    for (let offset = 0; offset < 3; offset++) {
      const pStart = new Date(startDate.getTime() - offset * periodLength);
      const pEnd = new Date(endDate.getTime() - offset * periodLength);
      const ps = pStart.toISOString().split('T')[0];
      const pe = pEnd.toISOString().split('T')[0];

      // Label: "FY 2025-26" or "FY 2024-25"
      const sy = pStart.getFullYear();
      const ey = pEnd.getFullYear();
      const label = `FY ${sy}-${String(ey).slice(2)}`;

      // Revenue for this period
      const pRev = useGL
        ? ((await db.prepare(
            `SELECT COALESCE(SUM(jl.credit) - SUM(jl.debit), 0) as amount FROM journal_lines jl
             JOIN journal_entries je ON jl.entry_id = je.id
             JOIN accounts a ON jl.account_code = a.account_code AND je.user_id = a.user_id
             WHERE je.user_id = ? AND je.entry_date >= ? AND je.entry_date <= ? AND a.account_type = 'revenue' AND ${jePosted()} AND ${notOrphaned}`
          ).bind(tenantId, ps, pe).first() as any)?.amount || 0)
        : ((await db.prepare(
            `SELECT COALESCE(SUM(deposit_amount), 0) as amount FROM bank_transactions
             WHERE user_id = ? AND transaction_date >= ? AND transaction_date <= ? AND deleted_at IS NULL`
          ).bind(tenantId, ps, pe).first() as any)?.amount || 0);

      // Expenses for this period
      const pExp = useGL
        ? ((await db.prepare(
            `SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) as amount FROM journal_lines jl
             JOIN journal_entries je ON jl.entry_id = je.id
             JOIN accounts a ON jl.account_code = a.account_code AND je.user_id = a.user_id
             WHERE je.user_id = ? AND je.entry_date >= ? AND je.entry_date <= ? AND a.account_type IN ('expense', 'cost') AND ${jePosted()} AND ${notOrphaned}`
          ).bind(tenantId, ps, pe).first() as any)?.amount || 0)
        : ((await db.prepare(
            `SELECT COALESCE(SUM(withdrawal_amount), 0) as amount FROM bank_transactions
             WHERE user_id = ? AND transaction_date >= ? AND transaction_date <= ? AND deleted_at IS NULL`
          ).bind(tenantId, ps, pe).first() as any)?.amount || 0);

      // Review count for this period (run 4 separate counts, simpler than UNION)
      const pRevBank = (await db.prepare(
        `SELECT COUNT(*) as cnt FROM bank_statements WHERE user_id=? AND deleted_at IS NULL AND status='draft' AND period_end>=? AND period_end<=?`
      ).bind(tenantId, ps, pe).first()) as any;
      const pRevCard = (await db.prepare(
        `SELECT COUNT(*) as cnt FROM card_statements WHERE user_id=? AND deleted_at IS NULL AND status='draft' AND period_end>=? AND period_end<=?`
      ).bind(tenantId, ps, pe).first()) as any;
      const pRevInv = (await db.prepare(
        `SELECT COUNT(*) as cnt FROM invoices WHERE user_id=? AND deleted_at IS NULL AND (status='pending_review' OR (needs_review IS NOT NULL AND needs_review!='')) AND issue_date>=? AND issue_date<=?`
      ).bind(tenantId, ps, pe).first()) as any;
      const pRevJE = (await db.prepare(
        `SELECT COUNT(*) as cnt FROM journal_entries WHERE user_id=? AND ${jeDraft('journal_entries')} AND entry_date>=? AND entry_date<=?`
      ).bind(tenantId, ps, pe).first()) as any;
      const pReview = (pRevBank?.cnt || 0) + (pRevCard?.cnt || 0) + (pRevInv?.cnt || 0) + (pRevJE?.cnt || 0);

      // Unmatched bank txns in this period
      const pUnmatched = ((await db.prepare(
        `SELECT COUNT(*) as cnt FROM bank_transactions
         WHERE user_id = ? AND match_status = 'unmatched' AND deleted_at IS NULL
         AND transaction_date >= ? AND transaction_date <= ?`
      ).bind(tenantId, ps, pe).first() as any)?.cnt || 0);

      // Link stats for this period
      const pBankTotal = (await db.prepare(
        `SELECT COUNT(*) as cnt FROM bank_transactions WHERE user_id=? AND deleted_at IS NULL AND transaction_date>=? AND transaction_date<=?`
      ).bind(tenantId, ps, pe).first() as any)?.cnt || 0;
      const pBankLinked = (await db.prepare(
        `SELECT COUNT(*) as cnt FROM bank_transactions bt WHERE bt.user_id=? AND bt.deleted_at IS NULL AND bt.transaction_date>=? AND bt.transaction_date<=?
         AND (bt.invoice_id IS NOT NULL OR EXISTS (SELECT 1 FROM bank_transaction_invoice_links l WHERE l.transaction_id=bt.id AND l.user_id=bt.user_id))`
      ).bind(tenantId, ps, pe).first() as any)?.cnt || 0;
      const pInvTotal = (await db.prepare(
        `SELECT COUNT(*) as cnt FROM invoices WHERE user_id=? AND deleted_at IS NULL AND receipt_number IS NULL AND issue_date>=? AND issue_date<=?`
      ).bind(tenantId, ps, pe).first() as any)?.cnt || 0;
      const pInvLinked = (await db.prepare(
        `SELECT COUNT(*) as cnt FROM invoices WHERE user_id=? AND deleted_at IS NULL AND receipt_number IS NULL AND linked_invoice_id IS NOT NULL AND issue_date>=? AND issue_date<=?`
      ).bind(tenantId, ps, pe).first() as any)?.cnt || 0;
      const pChainCount = (await db.prepare(
        `SELECT COUNT(DISTINCT bt.id) as cnt FROM bank_transactions bt
         WHERE bt.user_id=? AND bt.deleted_at IS NULL AND bt.transaction_date>=? AND bt.transaction_date<=?
         AND EXISTS (
           SELECT 1 FROM invoices i_direct
           WHERE i_direct.id = bt.invoice_id AND i_direct.deleted_at IS NULL
           AND EXISTS (SELECT 1 FROM invoices r1 WHERE r1.id=i_direct.linked_invoice_id AND r1.receipt_number IS NOT NULL AND r1.deleted_at IS NULL)
           UNION ALL
           SELECT 1 FROM bank_transaction_invoice_links l
           JOIN invoices i_link ON i_link.id=l.invoice_id
           WHERE l.transaction_id=bt.id AND l.user_id=bt.user_id AND i_link.deleted_at IS NULL
           AND EXISTS (SELECT 1 FROM invoices r2 WHERE r2.id=i_link.linked_invoice_id AND r2.receipt_number IS NOT NULL AND r2.deleted_at IS NULL)
         )`
      ).bind(tenantId, ps, pe).first() as any)?.cnt || 0;

      const pPct = (n: number, d: number) => d > 0 ? Math.round(n / d * 1000) / 10 : 0;

      periodComparison.push({
        label,
        start_date: ps,
        end_date: pe,
        revenue: Math.round(pRev * 100) / 100,
        expenses: Math.round(pExp * 100) / 100,
        net_income: Math.round((pRev - pExp) * 100) / 100,
        review_count: pReview,
        unmatched_count: pUnmatched,
        bank_total: pBankTotal,
        bank_linked: pBankLinked,
        bank_pct: pPct(pBankLinked, pBankTotal),
        invoice_total: pInvTotal,
        invoice_linked: pInvLinked,
        invoice_pct: pPct(pInvLinked, pInvTotal),
        chain_count: pChainCount,
        chain_pct: pPct(pChainCount, pBankTotal),
      });
    }
  }

  return c.json({
    cash_balance: cashBal,
    ar_balance: finalAR,
    ap_balance: finalAP,
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
    period_comparison: periodComparison,
  });
});

// ── Link coverage stats (for dashboard percentage cards) ──
dashboard.get('/link-stats', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;

  // Bank transactions: total + linked to invoice (direct OR via junction table)
  const bankStats = await db.prepare(
    `SELECT COUNT(*) as total,
     COALESCE(SUM(CASE WHEN invoice_id IS NOT NULL THEN 1
       WHEN EXISTS (SELECT 1 FROM bank_transaction_invoice_links l WHERE l.transaction_id = bt.id AND l.user_id = bt.user_id) THEN 1
       ELSE 0 END), 0) as linked
     FROM bank_transactions bt WHERE bt.user_id = ? AND bt.deleted_at IS NULL`
  ).bind(tenantId).first() as any;

  // Invoices (non-receipt): total + linked to a receipt via linked_invoice_id
  const invStats = await db.prepare(
    `SELECT COUNT(*) as total,
     COALESCE(SUM(CASE WHEN linked_invoice_id IS NOT NULL THEN 1 ELSE 0 END), 0) as linked_receipts
     FROM invoices WHERE user_id = ? AND receipt_number IS NULL AND deleted_at IS NULL`
  ).bind(tenantId).first() as any;

  // Full chain: bank transaction → invoice → receipt (direct OR junction-linked)
  const chainStats = await db.prepare(
    `SELECT COUNT(DISTINCT bt.id) as full_chain
     FROM bank_transactions bt
     WHERE bt.user_id = ? AND bt.deleted_at IS NULL
     AND EXISTS (
       -- Path A: bt.invoice_id set directly
       SELECT 1 FROM invoices i_direct
       WHERE i_direct.id = bt.invoice_id AND i_direct.deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM invoices r1
         WHERE r1.id = i_direct.linked_invoice_id
         AND r1.receipt_number IS NOT NULL AND r1.deleted_at IS NULL
       )
       UNION ALL
       -- Path B: linked via junction table (group match)
       SELECT 1 FROM bank_transaction_invoice_links l
       JOIN invoices i_link ON i_link.id = l.invoice_id
       WHERE l.transaction_id = bt.id AND l.user_id = bt.user_id
       AND i_link.deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM invoices r2
         WHERE r2.id = i_link.linked_invoice_id
         AND r2.receipt_number IS NOT NULL AND r2.deleted_at IS NULL
       )
     )`
  ).bind(tenantId).first() as any;

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
