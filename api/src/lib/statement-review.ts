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

import { CategorizeResult } from './transaction-categorizer';

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
