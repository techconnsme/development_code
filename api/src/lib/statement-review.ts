/**
 * Statement "Review vs Ledger" engine.
 *
 * Pure decomposition + rule-template logic for POST /bank-statements/:id/review.
 * Read-only by design: nothing here touches the database for writing.
 *
 * Gap semantics (difference = statement_balance − gl_balance):
 *   Each suggestion contributes (debit − credit) on its GL bank-account line;
 *   projected_difference = difference − Σ contributions. Green at |x| < 0.01.
 */

import { CategorizeResult, categorizeTransaction } from './transaction-categorizer';
import { findBestInvoiceMatch } from './bank-matcher';
import { jePosted, jeNotOrphaned } from './journal-filters';

export const REVIEW_EPS = 0.01;

export interface JePrefillLine {
  account_code: string;
  account_name: string;
  debit: number;
  credit: number;
}

export type ReviewItemKind = 'adjusting_je' | 'invoice_match' | 'coa_posting' | 'info';
export type ReviewSource = 'rule' | 'ai';
export type ReviewConfidence = 'high' | 'medium' | 'low';

export interface ReviewItem {
  id: string;
  kind: ReviewItemKind;
  source: ReviewSource;
  transaction_id?: string;
  explanation: string;
  confidence: ReviewConfidence;
  prefill?: {
    lines?: JePrefillLine[];
    description?: string;
    invoice_id?: string;
    invoice_number?: string;
    account_code?: string;
  };
}

export interface GapDecomposition {
  projected_difference: number;
  unexplained_residual: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function decomposeGap(
  difference: number,
  items: ReviewItem[],
  bankCode: string,
): GapDecomposition {
  let bankEffectSum = 0;
  for (const it of items) {
    if (it.kind === 'info' || !it.prefill?.lines) continue;
    const bankLine = it.prefill.lines.find(l => l.account_code === bankCode);
    if (bankLine) bankEffectSum += round2(bankLine.debit - bankLine.credit);
  }
  const projected = round2(difference - bankEffectSum);
  return {
    projected_difference: Math.abs(projected) < REVIEW_EPS ? 0 : projected,
    unexplained_residual:
      Math.abs(projected) < REVIEW_EPS ? 0 : round2(Math.abs(projected)),
  };
}

let seq = 0;
const nextId = () => `rv-${Date.now().toString(36)}-${seq++}`;

/**
 * Map one categorizer result onto a review suggestion.
 * Returns null for uncategorized rows (AI-pass candidates).
 * internal_transfer (code '') becomes an advisory info item: the contra bank
 * account is unknowable from the statement alone.
 */
export function ruleSuggestionFor(
  cat: CategorizeResult | null,
  dir: 'deposit' | 'withdrawal',
  amount: number,
  txId: string,
  bankCode: string,
  nameOf: (code: string) => string,
): ReviewItem | null {
  if (!cat || !cat.tag) return null;

  // Advisory-only tags: no deterministic double-entry exists.
  if (cat.code === '' || cat.tag === 'internal_transfer' || cat.tag === 'ignore') {
    return {
      id: nextId(), kind: 'info', source: 'rule', transaction_id: txId,
      confidence: cat.tag === 'internal_transfer' ? 'medium' : 'high',
      explanation:
        cat.tag === 'internal_transfer'
          ? 'Looks like an inter-bank transfer — assign the contra bank account manually.'
          : 'Flagged as non-posting by the categorizer.',
    };
  }

  const bank = (d: number, c: number): JePrefillLine =>
    ({ account_code: bankCode, account_name: nameOf(bankCode), debit: d, credit: c });
  const contra = (code: string, d: number, c: number): JePrefillLine =>
    ({ account_code: code, account_name: nameOf(code), debit: d, credit: c });

  // Deposit ⇒ money arrived not yet in books ⇒ contra is a credit.
  // Withdrawal ⇒ money left ⇒ contra is a debit.
  const lines: JePrefillLine[] =
    dir === 'deposit'
      ? [bank(amount, 0), contra(cat.code, 0, amount)]
      : [contra(cat.code, amount, 0), bank(0, amount)];

  return {
    id: nextId(), kind: 'adjusting_je', source: 'rule', transaction_id: txId,
    confidence: cat.confidence === 'exact' ? 'high' : 'medium',
    explanation: `Uncategorized ${dir} matched rule tag "${cat.tag}" → suggest posting to ${cat.code} (${nameOf(cat.code)}).`,
    prefill: { lines, description: `${dir === 'deposit' ? 'Deposit' : 'Withdrawal'} → ${cat.code}` },
  };
}

// ─────────────────────────────────────────────────────────────
// Pipeline: assemble the full review from the database (read-only).
// DB access goes through a minimal interface so the pipeline is
// unit-testable with a fake (whose run() throws — enforcing the
// zero-writes guarantee).
// ─────────────────────────────────────────────────────────────

export interface DbLike {
  prepare(sql: string): {
    bind(...args: any[]): {
      all(): Promise<{ results: any[] }>;
      first<T = any>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
}

export interface StatementReviewResult {
  statement_id: string;
  is_locked: boolean;
  balance_summary: { statement_balance: number; gl_balance: number; difference: number };
  projected_difference: number;
  items: ReviewItem[];
}

export interface BuildReviewOpts {
  llmFn?: any;                 // Task 3: LlmReviewFn
  env?: any;
  llmKeys?: any;               // Task 3: LlmKeys
}

export async function buildStatementReview(
  db: DbLike,
  tenantId: string,
  stmtId: string,
  _opts?: BuildReviewOpts,
): Promise<StatementReviewResult> {
  // 1. Statement + lock state
  const stmt = await db.prepare(
    'SELECT id, closing_balance, period_end, account_code FROM bank_statements WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(stmtId, tenantId).first<{ id: string; closing_balance: number | null; period_end: string | null; account_code: string | null }>();
  if (!stmt) throw new Error('statement not found');

  const reconRow = await db.prepare(
    'SELECT COUNT(*) AS n FROM bank_reconciliations WHERE bank_statement_id = ? AND user_id = ?'
  ).bind(stmtId, tenantId).first<{ n: number }>();
  const is_locked = (reconRow?.n || 0) > 0;

  // 2. GL balance for the statement's bank account up to period end (posted, live entries)
  const bankCode = stmt.account_code || '11101';
  const glRow = await db.prepare(
    `SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) as balance
     FROM journal_lines jl JOIN journal_entries je ON jl.entry_id = je.id
     WHERE je.user_id = ? AND je.entry_date <= ? AND jl.account_code = ?
       AND ${jePosted('je')} AND ${jeNotOrphaned('je')}`
  ).bind(tenantId, stmt.period_end || new Date().toISOString().split('T')[0], bankCode).first<{ balance: number }>();

  const statement_balance = round2(stmt.closing_balance || 0);
  const gl_balance = round2(glRow?.balance || 0);
  const difference = round2(statement_balance - gl_balance);

  // 3. Transactions, unpaid invoices (+counterparty names), account names
  const txs = await db.prepare(
    `SELECT * FROM bank_transactions WHERE bank_statement_id = ? AND user_id = ? AND deleted_at IS NULL ORDER BY transaction_date`
  ).bind(stmtId, tenantId).all();
  const txRows = txs.results as any[];

  const invRows = (await db.prepare(
    `SELECT i.id, i.invoice_number, i.total, i.currency, i.issue_date, i.due_date, c.name AS counterparty_name
     FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
     WHERE i.user_id = ? AND i.status NOT IN ('paid','cancelled') AND i.deleted_at IS NULL AND i.total > 0`
  ).bind(tenantId).all()).results as any[];

  const acctRows = (await db.prepare(
    'SELECT account_code, account_name FROM accounts WHERE user_id = ? AND is_active = 1'
  ).bind(tenantId).all()).results as any[];
  const nameOf = (code: string) => {
    const hit = acctRows.find(a => a.account_code === code);
    return hit?.account_name || code;
  };

  // 4. Suggestions
  const items: ReviewItem[] = [];
  const excludeIds = new Set<string>();

  for (const tx of txRows) {
    const invoiceLinked = !!tx.invoice_id || tx.match_status === 'confirmed';
    const dir: 'deposit' | 'withdrawal' = (tx.deposit_amount > 0 ? 'deposit' : 'withdrawal');
    const amount = Math.abs(round2(tx.deposit_amount > 0 ? tx.deposit_amount : tx.withdrawal_amount));
    if (!(amount > 0)) continue;

    if (!invoiceLinked && !is_locked) {
      // Rules pass
      const cat = categorizeTransaction(tx.description || '', dir);
      const ruleItem = ruleSuggestionFor(cat, dir, amount, tx.id, bankCode, nameOf);
      if (ruleItem && ruleItem.kind !== 'info' && !(cat && cat.code === '')) {
        items.push(ruleItem);
        continue;
      }
      if (ruleItem) { items.push(ruleItem); continue; }

      // Invoice-match pass (suggest-only)
      const m = findBestInvoiceMatch(
        { id: tx.id, transaction_date: tx.transaction_date, description: tx.description, reference: tx.reference ?? undefined, amount, currency: tx.currency },
        invRows.map(i => ({ id: i.id, invoice_number: i.invoice_number, total: i.total, currency: i.currency, issue_date: i.issue_date, due_date: i.due_date, counterparty_name: i.counterparty_name })),
        excludeIds,
      );
      if (m) {
        excludeIds.add(m.invoice.id);
        items.push({
          id: nextId(), kind: 'invoice_match', source: 'rule', transaction_id: tx.id,
          confidence: m.confidence,
          explanation: `${m.reason} — suggests settling ${m.invoice.invoice_number}.`,
          prefill: { invoice_id: m.invoice.id, invoice_number: m.invoice.invoice_number },
        });
        // Synthetic bank-side line so decomposition counts it:
        // confirming payment posts Dr bank (deposit received) / Cr bank (bill paid).
        (items[items.length - 1].prefill as any).lines =
          dir === 'deposit'
            ? [{ account_code: bankCode, account_name: nameOf(bankCode), debit: Math.min(amount, m.invoice.total), credit: 0 }]
            : [{ account_code: bankCode, account_name: nameOf(bankCode), debit: 0, credit: Math.min(amount, m.invoice.total) }];
      }
    }
  }

  // 5. Decompose; surface unexplained residual (AI pass hooks in later)
  const { projected_difference, unexplained_residual } = decomposeGap(difference, items, bankCode);
  if (unexplained_residual >= REVIEW_EPS) {
    items.push({
      id: nextId(), kind: 'info', source: 'rule',
      confidence: 'high',
      explanation: `Residual HKD ${unexplained_residual.toFixed(2)} remains unexplained.`,
    });
  }

  return {
    statement_id: stmt.id,
    is_locked,
    balance_summary: { statement_balance, gl_balance, difference },
    projected_difference,
    items,
  };
}
