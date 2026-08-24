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
        'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(entryId, userId, entryNum, tx.transaction_date, desc, 'bank_transaction', tx.id).run();
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
