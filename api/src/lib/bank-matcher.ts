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
  tier?: number; // 1 narration · 2 exact · 3 near · 4 name — pipeline ordering (see route phase logic)
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
    return { invoice: inv, confidence: 'high', tier: 1, reason: `Invoice ${inv.invoice_number} referenced in bank narration` };
  }

  const delta = Math.abs(tx.amount - inv.total);

  // Tier 2 — exact amount + plausible payment window
  if (delta < 0.01) {
    const duePlus7 = new Date(dueBase.getTime() + 7 * DAY);
    if (txDate >= issueDate && txDate <= duePlus7) {
      return { invoice: inv, confidence: 'medium', tier: 2, reason: `Exact amount ${tx.amount.toFixed(2)} within payment window` };
    }
    // Exact amount but outside window — weak signal only
    return { invoice: inv, confidence: 'low', tier: 2, reason: `Exact amount ${tx.amount.toFixed(2)} but date outside expected window` };
  }

  const nearTolerance = Math.max(10, Math.abs(inv.total) * 0.005);
  if (delta <= nearTolerance && delta > 0.01) {
    const duePlus30 = new Date(dueBase.getTime() + 30 * DAY);
    const issueMinus7 = new Date(issueDate.getTime() - 7 * DAY);
    if (txDate >= issueMinus7 && txDate <= duePlus30) {
      return {
        invoice: inv,
        confidence: 'low',
        tier: 3,
        reason: `Amount within ${(delta).toFixed(2)} of invoice total (${Math.abs(delta / (inv.total || 1) * 100).toFixed(1)}% — fees/partial?)`,
      };
    }
    // fall through to name tier — do not discard a good counterparty signal
  }

  // Tier 4 — counterparty name similarity + generous date window.
  // Amount must be same order of magnitude (≤3× / ≥⅓) so a huge unrelated
  // payment never latches onto a small bill by name alone.
  if (inv.counterparty_name
      && tx.amount > 0 && inv.total > 0
      && tx.amount <= inv.total * 3 && tx.amount >= inv.total / 3) {
    const score = fuzzyMatchCompany(tx.description || '', [inv.counterparty_name]);
    if (score.best && score.best.score >= 80) {
      const duePlus45 = new Date(dueBase.getTime() + 45 * DAY);
      const issueMinus15 = new Date(issueDate.getTime() - 15 * DAY);
      if (txDate >= issueMinus15 && txDate <= duePlus45) {
        return {
          invoice: inv,
          confidence: 'low',
          tier: 4,
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
    if (!best || TIER_RANK[r.confidence] < TIER_RANK[best.confidence]
        || (r.confidence === best.confidence && (r.tier ?? 4) < (best.tier ?? 4))) {
      best = r;
      if (r.confidence === 'high') break;
    }
  }
  return best;
}

export interface InvoiceGroupMatch {
  invoices: MatchableInvoice[]; // members, sorted total desc
  confidence: MatchConfidence; // 'high' (narration) | 'medium' (exact sum)
  reason: string;
}

const GROUP_SUM_TOLERANCE = 0.01;
const GROUP_MAX_MEMBERS = 4;
const GROUP_POOL_CAP = 30;

const fmtMoney = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function subsetSumExact(
  sortedDesc: MatchableInvoice[], size: number, startIdx: number,
  target: number, acc: MatchableInvoice[]
): MatchableInvoice[] | null {
  if (acc.length === size) {
    const sum = acc.reduce((s, i) => s + i.total, 0);
    return Math.abs(sum - target) < GROUP_SUM_TOLERANCE ? acc.slice() : null;
  }
  let partial = acc.reduce((s, i) => s + i.total, 0);
  for (let idx = startIdx; idx < sortedDesc.length; idx++) {
    const next = partial + sortedDesc[idx].total;
    if (next - target > GROUP_SUM_TOLERANCE) continue; // sorted desc: try a smaller member
    acc.push(sortedDesc[idx]);
    const hit = subsetSumExact(sortedDesc, size, idx + 1, target, acc);
    if (hit) return hit;
    acc.pop();
  }
  return null;
}

/**
 * Combined-payment detection: one tx settling 2..4 invoices exactly, never
 * mixing counterparties. Pipeline, in execution order:
 *  1. Parse tx date (invalid -> null); build narration = description + reference.
 *  2. Group the pool by counterparty_name, dropping excluded ids, other-currency
 *     rows, invoices without a counterparty_name, and non-positive totals.
 *  3. Per party (insertion order):
 *     - Pool-size gate: skip parties with <2 or >30 eligible invoices.
 *     - Sort that party's pool by total desc.
 *     - Narration fast-path runs BEFORE the party gate: if >=2 of its invoice
 *       numbers (>=4 chars) appear verbatim in the narration, return them
 *       immediately at confidence 'high' — no fuzzy-party, sum, or date checks.
 *     - Party gate: fuzzyMatchCompany(tx.description, [party]) must score >=80,
 *       else the whole party is skipped.
 *     - Smallest-size-first subset search over sizes 2..min(4, pool size),
 *       accepting subsets whose totals sum within ±0.01 of the tx amount.
 *     - Date gate per found subset: tx date must fall between the oldest issue
 *       −15d and the newest due +120d, else keep searching.
 *     - Hit -> confidence 'medium', members returned sorted total desc.
 *  4. No party yields a match -> null.
 */
export function findInvoiceGroupMatch(
  tx: MatchableTx,
  invoices: MatchableInvoice[],
  excludeIds: Set<string> = new Set()
): InvoiceGroupMatch | null {
  const txCurrency = tx.currency || 'HKD';
  const txDate = parseDate(tx.transaction_date);
  if (!txDate || !isFinite(txDate.getTime())) return null;
  const narration = `${tx.description || ''}\n${tx.reference || ''}`.toUpperCase();

  const byParty = new Map<string, MatchableInvoice[]>();
  for (const inv of invoices) {
    if (excludeIds.has(inv.id)) continue;
    if ((inv.currency || 'HKD') !== txCurrency) continue;
    if (!inv.counterparty_name || !(inv.total > 0)) continue;
    const arr = byParty.get(inv.counterparty_name);
    if (arr) arr.push(inv); else byParty.set(inv.counterparty_name, [inv]);
  }

  for (const [party, pool] of byParty) {
    if (pool.length < 2 || pool.length > GROUP_POOL_CAP) continue;

    const usable = [...pool].sort((a, b) => b.total - a.total);

    // Fast path — 2+ pool invoice numbers appear verbatim in the narration
    const narrated = usable.filter(i => {
      const n = (i.invoice_number || '').toUpperCase();
      return n.length >= 4 && narration.includes(n);
    });
    if (narrated.length >= 2) {
      return {
        invoices: narrated,
        confidence: 'high',
        reason: `${narrated.length} invoice numbers referenced in bank narration`,
      };
    }

    const score = fuzzyMatchCompany(tx.description || '', [party]);
    if (!score.best || score.best.score < 80) continue;

    for (let size = 2; size <= Math.min(GROUP_MAX_MEMBERS, usable.length); size++) {
      const found = subsetSumExact(usable, size, 0, tx.amount, []);
      if (!found) continue;

      const times = found.map(i => ({
        issue: parseDate(i.issue_date)?.getTime(),
        due: (parseDate(i.due_date) || parseDate(i.issue_date))?.getTime(),
      }));
      if (times.some(t => !t.issue || !t.due)) continue;
      const gateStart = Math.min(...times.map(t => t.issue!)) - 15 * DAY;
      const gateEnd = Math.max(...times.map(t => t.due!)) + 120 * DAY;
      if (txDate.getTime() < gateStart || txDate.getTime() > gateEnd) continue;

      return {
        invoices: found.sort((a, b) => b.total - a.total),
        confidence: 'medium',
        reason: `Combined payment: ${[...found].sort((a, b) => (a.invoice_number || '').localeCompare(b.invoice_number || '')).map(i => fmtMoney(i.total)).join(' + ')} = ${fmtMoney(tx.amount)}`,
      };
    }
  }
  return null;
}
