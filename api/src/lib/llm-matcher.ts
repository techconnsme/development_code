/**
 * LLM-powered document matcher — groups unmatched items by counterparty,
 * sends candidates to LLM for 1-to-many relationship analysis.
 *
 * Flow: rules first (1-to-1 exact) → group remainder → LLM per group.
 */

import { llmKeysFromEnv, hasLlmKey, llmCompleteJson } from './llm-parse';
import { fuzzyMatchCompany } from './company-matcher';

export interface LlmMatchParams {
  userId: string;
  db: D1Database;
  env: any;
  type: 'bank-invoice' | 'receipt-invoice';
  direction?: 'incoming' | 'outgoing';
  onProgress?: (event: { phase: 'rules' | 'llm' | 'done'; current: number; total: number; message: string }) => void;
  onTokens?: (usage: { prompt: number; completion: number; total: number }) => void;
  signal?: AbortSignal;
}

export interface MatchSuggestion {
  transaction_id?: string;
  receipt_id?: string;
  invoice_id?: string;
  invoice_ids?: string[];
  invoice_number?: string;
  invoice_numbers?: string[];
  amount?: number;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  type: 'exact' | 'combined' | 'partial' | 'overpayment';
  direction?: string;
  invoice_file_id?: string | null;
  stmt_file_id?: string | null;
}

interface GroupedCandidates {
  counterparty: string;
  transactions: any[];
  invoices: any[];
}

export function groupByCounterparty(
  transactions: any[],
  invoices: any[],
): GroupedCandidates[] {
  const groups = new Map<string, GroupedCandidates>();

  for (const tx of transactions) {
    const name = tx.counterparty_name || tx.description || 'Unknown';
    let bestMatch = name;
    let bestScore = 0;
    for (const inv of invoices) {
      const invName = inv.counterparty_name || '';
      if (!invName) continue;
      const score = fuzzyMatchCompany(name, [invName], { topN: 1, minScore: 50 })?.best?.score ?? 0;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = invName;
      }
    }
    const key = bestScore >= 60 ? bestMatch : name;
    if (!groups.has(key)) {
      groups.set(key, { counterparty: key, transactions: [], invoices: [] });
    }
    groups.get(key)!.transactions.push(tx);
  }

  groups.forEach((group, key) => {
    group.invoices = invoices.filter(inv => {
      const invName = inv.counterparty_name || '';
      if (!invName) return false;
      const score = fuzzyMatchCompany(key, [invName], { topN: 1, minScore: 50 })?.best?.score ?? 0;
      return score >= 60;
    });
  });

  return Array.from(groups.values()).filter(g => g.transactions.length > 0 && g.invoices.length > 0);
}

export function buildBankInvoicePrompt(transactions: any[], invoices: any[]): string {
  const txList = transactions.map(tx =>
    `- id: ${tx.id}, date: ${tx.transaction_date}, amount: ${tx.amount}, narration: ${tx.description || ''}, reference: ${tx.reference || ''}`
  ).join('\n');

  const invList = invoices.map(inv =>
    `- id: ${inv.id}, number: ${inv.invoice_number}, amount: ${inv.total}, issue_date: ${inv.issue_date}, due_date: ${inv.due_date || 'N/A'}`
  ).join('\n');

  return `You are an accounting document matcher. Analyze these bank transactions and invoices to find linkages.

BANK TRANSACTIONS:
${txList}

CANDIDATE INVOICES:
${invList}

RULES:
- 1-to-1: amount matches exactly (within $0.01), date within reasonable window
- 1-to-many: one bank transaction paying multiple invoices (sum of invoices must equal transaction amount)
- Partial payments: transaction amount < invoice amount (partial settlement)
- Overpayments: transaction amount > invoice amount (overpayment)
- Consider narration/reference text for invoice number mentions
- Consider date proximity (payment should be near issue_date to due_date+30)

Return a JSON array of matches. Each match:
{
  "transaction_id": "string (bank transaction id)",
  "invoice_ids": ["string"] (array of invoice ids, single or multiple),
  "confidence": "high" | "medium" | "low",
  "reason": "string explaining the linkage",
  "type": "exact" | "combined" | "partial" | "overpayment"
}

Only return matches you are confident about. Return empty array [] if no good matches found.
Return ONLY the JSON array, no other text.`;
}

export function buildReceiptInvoicePrompt(receipts: any[], invoices: any[]): string {
  const rcptList = receipts.map(r =>
    `- id: ${r.id}, number: ${r.receipt_number || r.invoice_number}, amount: ${r.total}, date: ${r.paid_date || 'N/A'}, vendor: ${r.vendor_name || r.customer_name || ''}`
  ).join('\n');

  const invList = invoices.map(inv =>
    `- id: ${inv.id}, number: ${inv.invoice_number}, amount: ${inv.total}, issue_date: ${inv.issue_date}, vendor: ${inv.supplier_name || inv.customer_name || ''}`
  ).join('\n');

  return `You are an accounting document matcher. Analyze these receipts and invoices to find linkages.

RECEIPTS:
${rcptList}

CANDIDATE INVOICES:
${invList}

RULES:
- 1-to-1: receipt amount matches invoice amount exactly (within $0.02)
- 1-to-many: one receipt paying multiple invoices (sum of invoices must equal receipt amount)
- Partial payments: receipt amount < invoice amount
- Consider vendor/counterparty name matching
- Consider date proximity

Return a JSON array of matches. Each match:
{
  "receipt_id": "string",
  "invoice_ids": ["string"],
  "confidence": "high" | "medium" | "low",
  "reason": "string explaining the linkage",
  "type": "exact" | "combined" | "partial"
}

Only return matches you are confident about. Return empty array [] if no good matches found.
Return ONLY the JSON array, no other text.`;
}

export function parseLLMResponse(response: any): MatchSuggestion[] {
  if (!response?.parsed) return [];
  const arr = Array.isArray(response.parsed) ? response.parsed :
              (response.parsed.matches ? response.parsed.matches : [response.parsed]);
  return arr.filter((m: any) => m && (m.transaction_id || m.receipt_id) && m.invoice_ids?.length > 0);
}

export async function runLLMMatching(params: LlmMatchParams): Promise<MatchSuggestion[]> {
  const { userId, db, env, type, direction, onProgress, onTokens, signal } = params;
  const keys = llmKeysFromEnv(env);

  if (!hasLlmKey(keys)) {
    throw new Error('No LLM API keys configured');
  }

  const suggestions: MatchSuggestion[] = [];

  if (type === 'bank-invoice') {
    const transactions = await fetchUnmatchedTransactions(db, userId, direction);
    const invoices = await fetchUnmatchedInvoices(db, userId, direction);

    onProgress?.({ phase: 'rules', current: 0, total: transactions.length, message: `Found ${transactions.length} unmatched transactions, ${invoices.length} unpaid invoices` });

    const groups = groupByCounterparty(transactions, invoices);

    onProgress?.({ phase: 'llm', current: 0, total: groups.length, message: `Analyzing ${groups.length} groups with AI...` });

    let processed = 0;
    for (const group of groups) {
      if (signal?.aborted) throw new Error('Cancelled');

      const prompt = buildBankInvoicePrompt(group.transactions, group.invoices);
      const result = await llmCompleteJson(keys, prompt, 'llm-match-bank-invoice', { maxTokens: 4000 });

      if (result.parsed) {
        const parsed = parseLLMResponse(result);
        // Enrich with file IDs
        for (const s of parsed) {
          if (s.transaction_id) {
            s.stmt_file_id = await stmtFileIdFor(db, userId, s.transaction_id);
          }
          if (s.invoice_ids?.[0]) {
            s.invoice_file_id = await invoiceFileIdFor(db, userId, s.invoice_ids[0]);
          }
        }
        suggestions.push(...parsed);
      }

      processed++;
      onProgress?.({ phase: 'llm', current: processed, total: groups.length, message: `Analyzed group ${processed}/${groups.length}: ${group.counterparty}` });
    }
  } else if (type === 'receipt-invoice') {
    const receipts = await fetchUnmatchedReceipts(db, userId, direction);
    const invoices = await fetchUnpaidInvoices(db, userId, direction);

    onProgress?.({ phase: 'rules', current: 0, total: receipts.length, message: `Found ${receipts.length} unmatched receipts, ${invoices.length} unpaid invoices` });

    const groups = groupByCounterparty(receipts, invoices);

    onProgress?.({ phase: 'llm', current: 0, total: groups.length, message: `Analyzing ${groups.length} groups with AI...` });

    let processed = 0;
    for (const group of groups) {
      if (signal?.aborted) throw new Error('Cancelled');

      const prompt = buildReceiptInvoicePrompt(group.transactions, group.invoices);
      const result = await llmCompleteJson(keys, prompt, 'llm-match-receipt-invoice', { maxTokens: 4000 });

      if (result.parsed) {
        const parsed = parseLLMResponse(result);
        suggestions.push(...parsed);
      }

      processed++;
      onProgress?.({ phase: 'llm', current: processed, total: groups.length, message: `Analyzed group ${processed}/${groups.length}: ${group.counterparty}` });
    }
  }

  onProgress?.({ phase: 'done', current: 1, total: 1, message: `Found ${suggestions.length} suggested matches` });

  return suggestions;
}

// ── DB helpers ─────────────────────────────────────────────────────────────

async function fetchUnmatchedTransactions(db: D1Database, userId: string, direction?: string) {
  const statusFilter = "(bt.match_status IS NULL OR bt.match_status = 'unmatched')";
  const wantAR = direction !== 'incoming';
  const wantAP = direction !== 'outgoing';
  const results: any[] = [];

  if (wantAR) {
    const deposits = await db.prepare(
      `SELECT bt.id, bt.transaction_date, bt.description, bt.deposit_amount as amount, bt.reference,
              COALESCE(bs.currency, 'HKD') as currency, bt.description as counterparty_name
       FROM bank_transactions bt LEFT JOIN bank_statements bs ON bt.bank_statement_id = bs.id
       WHERE bt.user_id = ? AND bt.deleted_at IS NULL AND bs.deleted_at IS NULL
       AND bt.deposit_amount > 0 AND ${statusFilter}
       ORDER BY bt.transaction_date`
    ).bind(userId).all();
    results.push(...(deposits.results || []));
  }

  if (wantAP) {
    const withdrawals = await db.prepare(
      `SELECT bt.id, bt.transaction_date, bt.description, bt.withdrawal_amount as amount, bt.reference,
              COALESCE(bs.currency, 'HKD') as currency, bt.description as counterparty_name
       FROM bank_transactions bt LEFT JOIN bank_statements bs ON bt.bank_statement_id = bs.id
       WHERE bt.user_id = ? AND bt.deleted_at IS NULL AND bs.deleted_at IS NULL
       AND bt.withdrawal_amount > 0 AND ${statusFilter} AND bt.card_statement_id IS NULL
       ORDER BY bt.transaction_date`
    ).bind(userId).all();
    results.push(...(withdrawals.results || []));
  }

  return results;
}

async function fetchUnmatchedInvoices(db: D1Database, userId: string, direction?: string) {
  const targetDirection = direction === 'outgoing' ? 'outgoing' : direction === 'incoming' ? 'incoming' : null;
  const dirFilter = targetDirection ? `AND i.direction = '${targetDirection}'` : '';

  const result = await db.prepare(
    `SELECT i.id, i.invoice_number, i.total, i.issue_date, i.due_date, i.file_id,
            COALESCE(supp.name, cust.name) as counterparty_name
     FROM invoices i
     LEFT JOIN customers cust ON i.customer_id = cust.id
     LEFT JOIN suppliers supp ON i.supplier_id = supp.id
     WHERE i.user_id = ? AND i.status != 'cancelled' AND i.receipt_number IS NULL
     AND i.invoice_number NOT LIKE 'REC-%' AND i.deleted_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM bank_transactions b2
       LEFT JOIN bank_transaction_invoice_links l2 ON l2.transaction_id = b2.id
       WHERE b2.deleted_at IS NULL AND b2.match_status = 'confirmed'
         AND (b2.invoice_id = i.id OR l2.invoice_id = i.id)
     ) ${dirFilter}
     ORDER BY i.created_at DESC`
  ).bind(userId).all();

  return result.results || [];
}

async function fetchUnmatchedReceipts(db: D1Database, userId: string, _direction?: string) {
  const result = await db.prepare(
    `SELECT id, invoice_number, receipt_number, total, vendor_name, customer_name, payer_name, paid_date, direction
     FROM invoices WHERE user_id = ? AND receipt_number IS NOT NULL
     AND linked_invoice_id IS NULL AND total > 0 AND deleted_at IS NULL`
  ).bind(userId).all();

  return result.results || [];
}

async function fetchUnpaidInvoices(db: D1Database, userId: string, direction?: string) {
  const targetDirection = direction === 'outgoing' ? 'outgoing' : 'incoming';

  const result = await db.prepare(
    `SELECT i.id, i.invoice_number, i.total, i.issue_date, i.file_id,
            COALESCE(supp.name, cust.name) as counterparty_name
     FROM invoices i
     LEFT JOIN customers cust ON i.customer_id = cust.id
     LEFT JOIN suppliers supp ON i.supplier_id = supp.id
     WHERE i.user_id = ? AND i.direction = ?
     AND i.receipt_number IS NULL AND i.linked_invoice_id IS NULL
     AND i.status != 'cancelled' AND i.total > 0 AND i.deleted_at IS NULL`
  ).bind(userId, targetDirection).all();

  return result.results || [];
}

async function stmtFileIdFor(db: D1Database, userId: string, txId: string): Promise<string | null> {
  const f = await db.prepare(
    `SELECT f.id AS file_id
     FROM bank_transactions bt
     JOIN bank_statements bs ON bt.bank_statement_id = bs.id
     JOIN file_records f ON f.r2_key = bs.r2_key
     WHERE bt.id = ? AND bt.user_id = ? AND f.user_id = ? AND f.deleted_at IS NULL
     LIMIT 1`
  ).bind(txId, userId, userId).first<any>();
  return f?.file_id || null;
}

async function invoiceFileIdFor(db: D1Database, userId: string, invoiceId: string): Promise<string | null> {
  const f = await db.prepare(
    `SELECT file_id FROM invoices WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
  ).bind(invoiceId, userId).first<any>();
  return f?.file_id || null;
}
