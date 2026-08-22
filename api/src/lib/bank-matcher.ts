/**
 * Bank ↔ Invoice suggestion matcher.
 *
 * Extracted from routes/bank-statements.ts auto-match so it can be unit
 * tested. Pure function — no DB access.
 *
 * Graduated confidence tiers (first matching tier wins):
 *  - high:   invoice number appears in the transaction narration/reference
 *  - medium: exact amount (±0.01) AND payment date inside issue→due+7
 *  - medium: NEAR amount (fee tolerance ≤ max(HK$10, 0.5% of total)) AND date
 *            inside issue−7→due+30 (HSBC customers often pay net of charges)
 *  - low:    counterparty name fuzzy-scores ≥80 against the narration AND date
 *            inside issue−15→due+45
 *
 * Currency must agree exactly. Returns the best candidate or null.
 */

import { fuzzyMatchCompany } from './company-matcher';

export interface MatchableTx {
  id: string;
  transaction_date: string;
  description: string;
  reference?: string | null;
  amount: number;
  currency?: string | null;
}

export interface MatchableInvoice {
  id: string;
  invoice_number: string;
  total: number;
  currency?: string | null;
  issue_date: string;
  due_date?: string | null;
  counterparty_name?: string | null;
}

export type MatchConfidence = 'high' | 'medium' | 'low';

export interface InvoiceMatch {
  invoice: MatchableInvoice;
  confidence: MatchConfidence;
  reason: string;
}

const DAY = 24 * 60 * 60 * 1000;

function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** Tier result for one invoice; lower rank wins. */
function evaluateInvoice(tx: MatchableTx, inv: MatchableInvoice): InvoiceMatch | null {
  const txDate = parseDate(tx.transaction_date);
  const issueDate = parseDate(inv.issue_date);
  const dueBase = parseDate(inv.due_date) || issueDate;
  if (!txDate || !issueDate || !dueBase) return null;

  const narration = `${tx.description || ''}\n${tx.reference || ''}`.toUpperCase();
  const invNum = (inv.invoice_number || '').toUpperCase();

  // Tier 1 — explicit invoice number in narration/reference
  if (invNum.length >= 4 && narration.includes(invNum)) {
    return { invoice: inv, confidence: 'high', reason: `Invoice ${inv.invoice_number} referenced in bank narration` };
  }

  const delta = Math.abs(tx.amount - inv.total);

  // Tier 2 — exact amount + plausible payment window
  if (delta < 0.01) {
    const duePlus7 = new Date(dueBase.getTime() + 7 * DAY);
    if (txDate >= issueDate && txDate <= duePlus7) {
      return { invoice: inv, confidence: 'medium', reason: `Exact amount ${tx.amount.toFixed(2)} within payment window` };
    }
    // Exact amount but outside window — weak signal only
    return { invoice: inv, confidence: 'low', reason: `Exact amount ${tx.amount.toFixed(2)} but date outside expected window` };
  }

  const nearTolerance = Math.max(10, Math.abs(inv.total) * 0.005);
  if (delta <= nearTolerance && delta > 0.01) {
    const duePlus30 = new Date(dueBase.getTime() + 30 * DAY);
    const issueMinus7 = new Date(issueDate.getTime() - 7 * DAY);
    if (txDate >= issueMinus7 && txDate <= duePlus30) {
      return {
        invoice: inv,
        confidence: 'low',
        reason: `Amount within ${(delta).toFixed(2)} of invoice total (${Math.abs(delta / (inv.total || 1) * 100).toFixed(1)}% — fees/partial?)`,
      };
    }
    return null;
  }

  // Tier 4 — counterparty name similarity + generous date window
  if (inv.counterparty_name) {
    const score = fuzzyMatchCompany(tx.description || '', [inv.counterparty_name]);
    if (score.best && score.best.score >= 80) {
      const duePlus45 = new Date(dueBase.getTime() + 45 * DAY);
      const issueMinus15 = new Date(issueDate.getTime() - 15 * DAY);
      if (txDate >= issueMinus15 && txDate <= duePlus45) {
        return {
          invoice: inv,
          confidence: 'low',
          reason: `Counterparty "${score.best.name}" scores ${score.best.score} vs invoice party`,
        };
      }
    }
  }

  return null;
}

const TIER_RANK: Record<MatchConfidence, number> = { high: 0, medium: 1, low: 2 };

/**
 * Pick the best invoice for a transaction. Excludes already-used ids.
 */
export function findBestInvoiceMatch(
  tx: MatchableTx,
  invoices: MatchableInvoice[],
  excludeIds: Set<string> = new Set()
): InvoiceMatch | null {
  const txCurrency = tx.currency || 'HKD';
  let best: InvoiceMatch | null = null;

  for (const inv of invoices) {
    if (excludeIds.has(inv.id)) continue;
    if ((inv.currency || 'HKD') !== txCurrency) continue;
    const r = evaluateInvoice(tx, inv);
    if (!r) continue;
    if (!best || TIER_RANK[r.confidence] < TIER_RANK[best.confidence]) {
      best = r;
      if (r.confidence === 'high') break;
    }
  }
  return best;
}
