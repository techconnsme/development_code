// Auto-generation of journal entries for a bank statement's transactions.
//
// Shared by:
//   - file-storage.ts importStatementFromFile (only when the statement lands ACTIVE)
//   - bank-statements.ts POST /:id/confirm    (drafts post here, on confirmation)
//
// Contra side = the statement's real bank account (stmtBankCode). Skips:
// already-posted refs (idempotent), invoice-matched rows (payment leg owns
// them), and engine-tagged ignore/internal_transfer rows.

import { v4 as uuidv4 } from 'uuid';
import { categorizeTransaction, resolveBankAccountCode } from './transaction-categorizer';
import { getTemporaryAccount } from './coa-temporary';
import { ensureMissingAccounts, HK_COA_NAMES } from './ensure-accounts';
import { jeLive } from './journal-filters';
import { isNumericCoaCode } from './account-guard';

export async function generateStatementJournalEntries(
  db: any,
  userId: string,
  stmtId: string,
): Promise<{ created: number; skippedTransfers: number }> {
  let skippedTransfers = 0;
  let created = 0;

  // Statement's real bank code (persisted at import, else inferred from bank name)
  const stmtRow = await db.prepare(
    'SELECT bank_name, account_code FROM bank_statements WHERE id = ? AND user_id = ?'
  ).bind(stmtId, userId).first<{ bank_name: string | null; account_code: string | null }>();
  const stmtBankCode = stmtRow?.account_code || resolveBankAccountCode(stmtRow?.bank_name);

  const usedCodes = await db.prepare(
    'SELECT DISTINCT account_code FROM bank_transactions WHERE bank_statement_id = ? AND account_code IS NOT NULL AND deleted_at IS NULL'
  ).bind(stmtId).all();
  const codeList = Array.from(new Set([
    ...((usedCodes.results as any[]).map((r: any) => r.account_code).filter(Boolean) as string[]),
    stmtBankCode,
  ]));
  if (codeList.length === 0) return { created: 0, skippedTransfers };

  // Ensure accounts exist with proper template names (never code-as-name placeholders)
  const createdCount: number[] = [0];
  await ensureMissingAccounts(db, userId, codeList, createdCount);

  // Load account map for line names
  const allAccts = await db.prepare(
    'SELECT account_code, account_name FROM accounts WHERE user_id = ? AND is_active = 1'
  ).bind(userId).all();
  const acctMap = new Map<string, string>();
  for (const r of allAccts.results as any[]) acctMap.set(r.account_code, r.account_name);
  const nameOf = (code: string) => acctMap.get(code) || HK_COA_NAMES[code]?.name || code;

  // Idempotency: skip transactions that already have a live JE
  const existingRefs = await db.prepare(
    `SELECT reference_id FROM journal_entries
     WHERE user_id = ? AND reference_type = 'bank_transaction' AND ${jeLive('journal_entries')}`
  ).bind(userId).all();
  const refSet = new Set((existingRefs.results as any[]).map(r => r.reference_id));

  const txs = await db.prepare(
    'SELECT * FROM bank_transactions WHERE bank_statement_id = ? AND deleted_at IS NULL ORDER BY transaction_date'
  ).bind(stmtId).all();

  for (const tx of txs.results as any[]) {
    if (refSet.has(tx.id)) continue;
    // Invoice-matched transactions are posted by the payment leg on match-confirm
    if (tx.invoice_id) continue;
    const desc = tx.description || '';
    const dir = (tx.deposit_amount > 0 ? 'deposit' : 'withdrawal') as 'deposit' | 'withdrawal';
    const cat = categorizeTransaction(desc, dir);
    if (cat && cat.code === '') {
      // Engine says never post (B/F noise, internal transfers between own accounts)
      if (cat.tag === 'internal_transfer') skippedTransfers++;
      continue;
    }
    let contraCode: string | null = tx.account_code || cat?.code || null;
    if (!contraCode) {
      // Unmapped by user + engine: park in Temporary Revenue/Expenses per direction
      const temp = await getTemporaryAccount(db, userId, dir === 'deposit' ? 'revenue' : 'expense');
      contraCode = temp?.code ?? (dir === 'deposit' ? '41101' : '62303');
    }
    if (contraCode === stmtBankCode) { skippedTransfers++; continue; }
    const entryId = `je-${uuidv4().slice(0, 8)}`;
    const entryNum = `JE-AUTO-${String(Date.now()).slice(-6)}-${uuidv4().slice(0, 4)}`;
    const lines: { code: string; name: string; debit: number; credit: number }[] = [];

    if (tx.deposit_amount > 0) {
      lines.push({ code: stmtBankCode, name: nameOf(stmtBankCode), debit: tx.deposit_amount, credit: 0 });
      lines.push({ code: contraCode, name: nameOf(contraCode), debit: 0, credit: tx.deposit_amount });
    } else if (tx.withdrawal_amount > 0) {
      lines.push({ code: contraCode, name: nameOf(contraCode), debit: tx.withdrawal_amount, credit: 0 });
      lines.push({ code: stmtBankCode, name: nameOf(stmtBankCode), debit: 0, credit: tx.withdrawal_amount });
    }

    if (lines.length > 0) {
      await db.prepare(
        'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id, entry_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(entryId, userId, entryNum, tx.transaction_date, desc, 'bank_transaction', tx.id, 'auto').run();
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        await db.prepare(
          'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(`jl-${uuidv4().slice(0, 8)}`, entryId, l.code, l.name, desc, l.debit, l.credit, i).run();
      }
      created++;
    }
  }

  return { created, skippedTransfers };
}

// ── Multi-account posting support (PUT /transactions/:id/posting) ──

export interface PostingLineInput { account_code: string; amount: number }
export type PostingValidation =
  | { ok: true; lines: PostingLineInput[] }
  | { ok: false; error: string };

/**
 * Pure validation for a contra-side allocation. Bank line is added by the
 * caller, so `lines` must sum to the transaction's movement amount.
 */
export function validatePostingLines(raw: unknown, expectedTotal: number): PostingValidation {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'At least one posting line is required' };
  if (raw.length > 50) return { ok: false, error: 'Too many posting lines (max 50)' };
  const lines: PostingLineInput[] = [];
  let sum = 0;
  for (const item of raw) {
    const code = (item as any)?.account_code;
    const amt = (item as any)?.amount;
    if (typeof code !== 'string' || !isNumericCoaCode(code)) {
      return { ok: false, error: `Invalid account code: ${String(code)}` };
    }
    if (typeof amt !== 'number' || !isFinite(amt)) {
      return { ok: false, error: `Invalid amount for account ${code}` };
    }
    const rounded = Math.round(amt * 100) / 100;
    if (rounded <= 0) return { ok: false, error: `Amount must be positive for account ${code}` };
    lines.push({ account_code: code, amount: rounded });
    sum += rounded;
  }
  sum = Math.round(sum * 100) / 100;
  const expected = Math.round(expectedTotal * 100) / 100;
  if (Math.abs(sum - expected) > 0.01) {
    return { ok: false, error: `Allocated total ${sum.toFixed(2)} must equal transaction amount ${expected.toFixed(2)}` };
  }
  return { ok: true, lines };
}

export interface StatementPosting {
  entry_id: string;
  entry_number: string;
  entry_source: string;
  lines: { id: string; account_code: string; account_name: string; debit: number; credit: number }[];
}

/** Live journal postings for every bank/card transaction of one statement, keyed by tx id. */
export async function getStatementPostings(
  db: any,
  userId: string,
  stmtId: string,
  opts: { table: 'bank_transactions' | 'card_transactions'; refType: 'bank_transaction' | 'card_transaction' } = { table: 'bank_transactions', refType: 'bank_transaction' },
): Promise<Map<string, StatementPosting>> {
  const stmtCol = opts.table === 'bank_transactions' ? 'bank_statement_id' : 'card_statement_id';
  const rows = await db.prepare(
    `SELECT je.id AS entry_id, je.entry_number, je.entry_source,
            je.reference_id AS tx_id,
            jl.id, jl.account_code, jl.account_name, jl.debit, jl.credit
     FROM journal_entries je
     JOIN journal_lines jl ON jl.entry_id = je.id
     JOIN ${opts.table} t ON t.id = je.reference_id
     WHERE je.user_id = ? AND je.reference_type = ? AND ${jeLive('je')}
       AND t.${stmtCol} = ?
     ORDER BY je.created_at, jl.sort_order`
  ).bind(userId, opts.refType, stmtId).all();

  // Group rows per transaction; a tx should have one live entry, but if legacy
  // data left several, the newest (last in created_at order) wins wholesale.
  const rebuilt = new Map<string, StatementPosting>();
  for (const r of rows.results as any[]) {
    let p = rebuilt.get(r.tx_id);
    if (!p || p.entry_id !== r.entry_id) {
      p = { entry_id: r.entry_id, entry_number: r.entry_number, entry_source: r.entry_source || 'auto', lines: [] };
      rebuilt.set(r.tx_id, p);
    }
    p.lines.push({ id: r.id, account_code: r.account_code, account_name: r.account_name, debit: r.debit || 0, credit: r.credit || 0 });
  }
  return rebuilt;
}

async function statementBankCode(db: any, userId: string, stmtId: string): Promise<string> {
  const row = await db.prepare(
    'SELECT bank_name, account_code FROM bank_statements WHERE id = ? AND user_id = ?'
  ).bind(stmtId, userId).first<{ bank_name: string | null; account_code: string | null }>();
  return row?.account_code || resolveBankAccountCode(row?.bank_name);
}

/**
 * Replace a transaction's live journal entry with a user-built multi-line
 * posting. Contra lines only — the fixed side (bank line, or Cash on Hand for
 * cards) is derived here so the double-entry always balances. Marks
 * entry_source='manual' and syncs the tx's single account code field to the
 * largest contra line.
 */
export async function replaceTransactionPosting(
  db: any,
  userId: string,
  txId: string,
  contraLines: PostingLineInput[],
  kind: 'bank' | 'card' = 'bank',
): Promise<{ entry_id: string; entry_number: string }> {
  const isBank = kind === 'bank';

  const tx = await db.prepare(
    isBank
      ? 'SELECT id, bank_statement_id AS stmt_id, transaction_date, description, deposit_amount, withdrawal_amount FROM bank_transactions WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
      : 'SELECT id, card_statement_id AS stmt_id, transaction_date, posting_date, description, amount FROM card_transactions WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(txId, userId).first<any>();
  if (!tx) throw new Error('Transaction not found');

  let stmtBankCode: string;
  let isDeposit: boolean;
  let entryDate: string | null;
  let desc: string;

  if (isBank) {
    stmtBankCode = await statementBankCode(db, userId, tx.stmt_id);
    isDeposit = (tx.deposit_amount || 0) > 0;
    entryDate = tx.transaction_date;
    desc = tx.description || '';
  } else {
    // Card postings: Dr expense(s), Cr Cash on Hand (11101) — fixed credit side
    stmtBankCode = '11101';
    isDeposit = false;
    entryDate = tx.transaction_date || tx.posting_date;
    desc = tx.description || 'Card Transaction';
  }

  // Tombstone ALL live entries referencing this transaction
  await db.prepare(
    `UPDATE journal_entries SET deleted_at = datetime('now'), updated_at = datetime('now')
     WHERE user_id = ? AND reference_type = ? AND reference_id = ? AND ${jeLive('journal_entries')}`
  ).bind(userId, isBank ? 'bank_transaction' : 'card_transaction', txId).run();

  const entryId = `je-${uuidv4().slice(0, 8)}`;
  const entryNum = `${isBank ? 'JE-MANUAL' : 'C-MANUAL'}-${String(Date.now()).slice(-6)}-${uuidv4().slice(0, 4)}`;
  await db.prepare(
    'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id, entry_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(entryId, userId, entryNum, entryDate, desc, isBank ? 'bank_transaction' : 'card_transaction', txId, 'manual').run();

  // Ensure all referenced accounts exist with proper template names
  const createdCount: number[] = [0];
  await ensureMissingAccounts(db, userId, [stmtBankCode, ...contraLines.map(l => l.account_code)], createdCount);

  const acctRows = await db.prepare(
    'SELECT account_code, account_name FROM accounts WHERE user_id = ? AND is_active = 1'
  ).bind(userId).all();
  const acctMap = new Map<string, string>();
  for (const r of acctRows.results as any[]) acctMap.set(r.account_code, r.account_name);
  const nameOf = (code: string) => acctMap.get(code) || HK_COA_NAMES[code]?.name || code;

  const sorted = [...contraLines].sort((a, b) => b.amount - a.amount);
  const total = Math.round(sorted.reduce((s, l) => s + l.amount, 0) * 100) / 100;

  interface Jl { code: string; name: string; debit: number; credit: number }
  const jlLines: Jl[] = [];
  if (isDeposit) {
    jlLines.push({ code: stmtBankCode, name: nameOf(stmtBankCode), debit: total, credit: 0 });
    for (const l of sorted) jlLines.push({ code: l.account_code, name: nameOf(l.account_code), debit: 0, credit: l.amount });
  } else {
    for (const l of sorted) jlLines.push({ code: l.account_code, name: nameOf(l.account_code), debit: l.amount, credit: 0 });
    jlLines.push({ code: stmtBankCode, name: nameOf(stmtBankCode), debit: 0, credit: total });
  }

  for (let i = 0; i < jlLines.length; i++) {
    const l = jlLines[i];
    await db.prepare(
      'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(`jl-${uuidv4().slice(0, 8)}`, entryId, l.code, l.name, tx.description || '', l.debit, l.credit, i).run();
  }

  // Backward compat: single field keeps the largest contra code
  if (isBank) {
    await db.prepare(
      'UPDATE bank_transactions SET account_code = ?, updated_at = datetime(\'now\') WHERE id = ? AND user_id = ?'
    ).bind(sorted[0].account_code, txId, userId).run();
  } else {
    // card_transactions has no updated_at column
    await db.prepare(
      'UPDATE card_transactions SET expense_account_code = ? WHERE id = ? AND user_id = ?'
    ).bind(sorted[0].account_code, txId, userId).run();
  }

  return { entry_id: entryId, entry_number: entryNum };
}

/** Remove manual control: tombstone the custom JE, re-run engine generation for the parent statement. */
export async function resetTransactionToAuto(db: any, userId: string, txId: string): Promise<{ created: number; skippedTransfers: number }> {
  const tx = await db.prepare(
    'SELECT id, bank_statement_id FROM bank_transactions WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(txId, userId).first<any>();
  if (!tx) throw new Error('Transaction not found');

  await db.prepare(
    `UPDATE journal_entries SET deleted_at = datetime('now'), updated_at = datetime('now')
     WHERE user_id = ? AND reference_type = 'bank_transaction' AND reference_id = ? AND ${jeLive('journal_entries')}`
  ).bind(userId, txId).run();

  return generateStatementJournalEntries(db, userId, tx.bank_statement_id);
}
