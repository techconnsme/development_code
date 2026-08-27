/**
 * Invoice Direction Resolver
 *
 * Decides incoming (AP) vs outgoing (AR) for an invoice using:
 *   1. The parsed vendor_name / customer_name fuzzy-matched against our
 *      own company name(s) (legacy behavior, kept).
 *   2. The bank "A/C Name" printed in the PAYMENT METHOD section —
 *      in this business context the A/C Name holder is the invoice
 *      ISSUER (the party being paid). Verified against Pastel (incoming),
 *      VEII (outgoing) and EHSIA (incoming) invoice families 2026-08-18.
 *   3. A thin-parse guard: a direction decided from partial evidence
 *      (e.g. only one party extracted, no A/C Name) must be flagged for
 *      review instead of silently accepted.
 *
 * Pure module — no Cloudflare bindings, unit-testable standalone.
 */

import { fuzzyMatchCompany, normalizeCompanyName } from './company-matcher';

export interface DirectionInput {
  vendorName: string | null;
  customerName: string | null;
  ocrText: string;
  ownCompanyCandidates: string[];
}

export interface DirectionResult {
  isIncoming: boolean;
  counterpartyName: string | null;
  needsDirectionReview: boolean;
  companyNotDetected: boolean;
  swapped: boolean;
  acName: string | null;
}

const MATCH_MIN = 70;

/**
 * Person names like "Joseph Lin" are extracted by the AI when a bill-to
 * block is a person + company pair. A person is not an invoice party —
 * treat it as absent so it can't silently satisfy the "both parties
 * extracted" checks and mask a thin parse. Heuristic: exactly two
 * title-case words, letters only, no company keywords.
 */
function isLikelyPersonName(name: string): boolean {
  const t = name.trim();
  if (!/^[A-Z][a-z]+\s+[A-Z][a-z]+$/.test(t)) return false;
  if (t.length > 22) return false;
  return !/(limited|ltd|company|corp|inc|tech|group|holdings|trading|consult)/i.test(t);
}

/**
 * Extract the bank account holder name from the PAYMENT METHOD block.
 * Handles flat OCR (no newlines — name bounded by SWIFT:/bank keywords)
 * and newline-preserving OCR. Never matches "A/C Number".
 */
export function extractAcName(ocrText: string): string | null {
  if (!ocrText) return null;
  const up = ocrText.toUpperCase();
  // "A/C NAME" label, then a company-like run bounded by SWIFT:, a bank
  // keyword, or end of input.
  const m = up.match(
    /A\/C\s*NAME\s*[:：]?\s*([A-Z][A-Z0-9\s&'.\-]*?)(?=\s*(?:SWIFT\s*[:：]|\bBANK\b|THANK|PAYMENT|DIRECT)|$)/,
  );
  if (!m) return null;
  let name = m[1].trim().replace(/[\s&'.\-]+$/, '');
  if (name.length < 3 || name.length > 60 || !/[A-Z]/.test(name)) return null;
  return name;
}

export function resolveDirection(input: DirectionInput): DirectionResult {
  const own = (input.ownCompanyCandidates || [])
    .map((s) => s?.trim())
    .filter((s): s is string => s.length > 0);

  const ownNorm = normalizeCompanyName(own[0] || '');
  const ownKnown = ownNorm.length > 3;

  const rawVendor = input.vendorName?.trim() || null;
  const rawCustomer = input.customerName?.trim() || null;
  // Drop person names (e.g. "Joseph Lin") — they are not invoice parties.
  const vendor = rawVendor && !isLikelyPersonName(rawVendor) ? rawVendor : null;
  const customer = rawCustomer && !isLikelyPersonName(rawCustomer) ? rawCustomer : null;
  const acName = extractAcName(input.ocrText);

  const scoreAgainst = (a: string | null, b: string | null): number => {
    if (!a || !b) return 0;
    return fuzzyMatchCompany(a, [b], { topN: 1, minScore: 50 })?.best?.score ?? 0;
  };
  const scoreVsOwn = (a: string | null): number => {
    if (!a || !ownKnown) return 0;
    return fuzzyMatchCompany(a, own, { topN: 1, minScore: 50 })?.best?.score ?? 0;
  };

  const acIsOurs = ownKnown && scoreVsOwn(acName) >= MATCH_MIN;
  const acIsVendor = !!acName && scoreAgainst(acName, vendor) >= MATCH_MIN;
  const acIsCustomer = !!acName && scoreAgainst(acName, customer) >= MATCH_MIN;

  // ── Swap detection: A/C Name proves which party is the issuer ───────────
  // The A/C Name holder is the issuer. If the A/C Name matches what the AI
  // labeled the CUSTOMER (and not the vendor), the AI had the roles backwards.
  let swapped = false;
  let effVendor = vendor;
  let effCustomer = customer;
  if (acName && acIsCustomer && !acIsVendor) {
    swapped = true;
    effVendor = customer;
    effCustomer = vendor;
  }

  const hasV = !!effVendor;
  const hasC = !!effCustomer;
  const vOurs = ownKnown && scoreVsOwn(effVendor) >= MATCH_MIN;
  const cOurs = ownKnown && scoreVsOwn(effCustomer) >= MATCH_MIN;

  // ── Positional letterhead cross-check (used only when no A/C Name) ───────
  // On letterhead documents the ISSUER's name prints first (top of page) and
  // the billed party appears later in the Bill-To block. When both parties are
  // extracted but nothing corroborates the AI's role assignment, first-
  // appearance order catches AI vendor/customer swaps — e.g. LTE25-I-000175F
  // (Smart City → EHSIA) stored as outgoing on 2026-08-26 because the doc has
  // no A/C Name block. Full alphanumeric normalization also defeats spaced
  // pdf-text OCR ("L i m i te d") that breaks the letterhead regex upstream.
  const positionalOwnFirst = ((): boolean | null => {
    if (!ownKnown || !hasV || !hasC || acName) return null;
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const nt = norm(input.ocrText || '');
    if (!nt) return null;
    const other = vOurs ? effCustomer : effVendor;
    if (!other) return null;
    const ownPos = Math.min(
      ...own.map((o) => { const i = nt.indexOf(norm(o)); return i === -1 ? Infinity : i; }),
    );
    const otherPos = nt.indexOf(norm(other));
    if (!isFinite(ownPos) || otherPos === -1 || ownPos === otherPos) return null;
    return ownPos < otherPos;
  })();

  let isIncoming = false;
  let counterparty: string | null = null;
  let review = false;
  let notDetected = false;

  if (!ownKnown) {
    // Legacy fallback: no own company name configured → can't place parties.
    review = true;
    notDetected = true;
    isIncoming = hasV || !hasC;
    counterparty = effCustomer || effVendor;
  } else if (cOurs) {
    // We are the billed party → incoming. (Also covers post-swap cases.)
    isIncoming = true;
    counterparty = effVendor;
    review = false;
    notDetected = false;
    if (positionalOwnFirst === true) {
      // Letterhead shows OUR name first → we are the issuer; the AI had the
      // roles backwards. Flip to outgoing (counterparty = the billed party).
      isIncoming = false;
      counterparty = effVendor;
      swapped = true;
    } else if (positionalOwnFirst === null) {
      // Role assignment uncorroborated (no A/C Name, no positional signal).
      review = true;
    }
  } else if (vOurs) {
    // We are the issuer → outgoing, UNLESS the A/C Name says otherwise.
    isIncoming = false;
    counterparty = effCustomer;
    if (acName && !acIsOurs && !acIsCustomer && !acIsVendor && !hasC) {
      // Rule 6: third-party A/C Name + we are the only extracted party →
      // someone else is actually receiving payment → they billed US.
      isIncoming = true;
      counterparty = acName;
      review = false;
      notDetected = false;
    } else if (acName && !acIsOurs && !hasC) {
      // Thin parse with an A/C Name that is neither ours nor any party —
      // can't corroborate the outgoing conclusion.
      review = true;
      notDetected = false;
    } else if (!acName && !hasC) {
      // Thin-parse guard: only one party extracted and nothing corroborates
      // the outgoing conclusion → flag instead of silently accepting.
      review = true;
      notDetected = false;
    } else if (acName && !acIsOurs) {
      // A/C Name contradicts the parse (payment goes to an unrelated third
      // party while we're listed as issuer) → flag for review.
      review = true;
      notDetected = false;
    } else if (!acName) {
      // Both parties extracted, no A/C Name: the AI's role assignment stands
      // alone. Trust it only when the letterhead position agrees; flip when
      // it contradicts; flag when positional evidence is unavailable.
      if (positionalOwnFirst === false) {
        isIncoming = true;
        counterparty = effCustomer;
        swapped = true;
        review = false;
      } else if (positionalOwnFirst === null) {
        review = true;
      } else {
        review = false;
      }
      notDetected = false;
    } else {
      review = false;
      notDetected = false;
    }
  } else if (acName && !acIsOurs) {
    // Neither parsed party is ours, but the A/C Name identifies the issuer.
    if (acIsVendor) {
      isIncoming = true;
      counterparty = effVendor;
      review = false;
      notDetected = true;
    } else {
      // Third-party A/C Name with unidentifiable parties → the issuer is the
      // A/C Name holder; assume incoming (they billed us) but flag our
      // company as not detected.
      isIncoming = true;
      counterparty = acName;
      review = false;
      notDetected = true;
    }
  } else if (acName && acIsOurs) {
    // A/C Name says WE are the issuer, though neither parsed party is us.
    isIncoming = false;
    counterparty = effCustomer || effVendor;
    review = true;
    notDetected = false;
  } else if (hasV && hasC) {
    // Legacy: two third-party names, neither is us.
    isIncoming = true;
    counterparty = effVendor;
    review = true;
    notDetected = true;
  } else {
    // Legacy heuristic fallback for incomplete parses.
    review = true;
    notDetected = true;
    isIncoming = hasV;
    counterparty = effCustomer || effVendor;
  }

  return {
    isIncoming,
    counterpartyName: counterparty,
    needsDirectionReview: review,
    companyNotDetected: notDetected,
    swapped,
    acName,
  };
}
