/**
 * Company Name Fuzzy Matcher
 *
 * Dependency-free utility for normalizing and fuzzy-matching company names,
 * including HK bank alias resolution. Works in Cloudflare Workers (no Node APIs).
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type MatchType = 'exact' | 'substring' | 'fuzzy';

export interface MatchCandidate {
  id?: string;
  name: string;
}

export interface MatchSuggestion extends MatchCandidate {
  score: number;      // 0–100
  matchType: MatchType;
}

export interface CompanyMatch {
  best: MatchSuggestion | null;
  suggestions: MatchSuggestion[];   // top N, sorted desc
  level: 'high' | 'medium' | 'low';  // ≥90 / ≥70 / <70
}

export interface FuzzyMatchOptions {
  minScore?: number;   // default 50
  topN?: number;       // default 3
}

export interface BankAlias {
  canonical: string;   // display name stored in DB
  aliases: string[];   // normalized aliases (lowercase, no punct)
}

// ── Levenshtein Distance ───────────────────────────────────────────────────

/**
 * Two-row DP Levenshtein distance.
 * Operates on Array.from for correct CJK/surrogate handling.
 * O(m·n) time, O(min(m,n)) memory.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const aa = Array.from(a);
  const bb = Array.from(b);
  if (aa.length < bb.length) return levenshtein(b, a); // ensure aa is longer

  let prev = Array.from({ length: bb.length + 1 }, (_, i) => i);
  let curr = new Array<number>(bb.length + 1);

  for (let i = 1; i <= aa.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= bb.length; j++) {
      const cost = aa[i - 1] === bb[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,       // deletion
        curr[j - 1] + 1,   // insertion
        prev[j - 1] + cost // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bb.length];
}

// ── Normalization ──────────────────────────────────────────────────────────

const LEGAL_SUFFIXES = [
  'limited', 'ltd', 'incorporated', 'inc', 'llc', 'llp',
  'company', 'co', 'corp', 'gmbh', 'holdings',
  'group', 'sa', 'ag', 'pte', 'sdn', 'bhd',
  'intl', 'international', 'hk',
  'china', 'trading', 'enterprises', 'enterprise', 'services',
];
// NOTE: 'corporation' intentionally excluded — often part of the trading
// name (e.g. "Banking Corporation"). 'corp' covers the short form.
// Bank full legal names are resolved via HK_BANK_ALIASES instead.

const STOPWORDS = new Set(['and', 'the', 'of', 'for', 'to', 'in', 'on', 'at', 'by']);

/**
 * Normalize a company name for comparison.
 * - Full-width → half-width
 * - Lowercase
 * - & → and
 * - Strip legal suffixes (repeated until fixpoint)
 * - Strip all non-letter/digit characters (preserves CJK via \p{L})
 */
export function normalizeCompanyName(name: string | null | undefined): string {
  if (!name) return '';
  let s = name.trim();
  if (!s) return '';

  // Full-width to half-width (U+FF01–U+FF5E → U+0021–U+007E)
  s = s.replace(/[！-～]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
  );

  s = s.toLowerCase();

  // & → and
  s = s.replace(/\s*&\s*/g, ' and ');

  // Strip legal suffixes repeatedly
  let prev = '';
  while (prev !== s) {
    prev = s;
    for (const suffix of LEGAL_SUFFIXES) {
      // Suffix with optional trailing dot, word boundary
      const re = new RegExp(`\\b${suffix.replace(/\./g, '\\.')}\\.?\\b`, 'gi');
      s = s.replace(re, ' ').replace(/\s{2,}/g, ' ');
    }
  }

  // Strip punctuation and whitespace (keep letters + digits including CJK)
  s = s.replace(/[^\p{L}\p{N}]/gu, '');

  return s.trim();
}

/**
 * Tokenize a normalized name for token-level comparison.
 * Drops stopwords.
 */
function tokenize(normalized: string): string[] {
  // Split on non-letter/digit boundaries within CJK strings is tricky;
  // use a simple approach: split on script transitions + known separators
  const tokens: string[] = [];
  let current = '';
  for (const ch of Array.from(normalized)) {
    if (/[\p{L}\p{N}]/u.test(ch)) {
      current += ch;
    } else if (current) {
      tokens.push(current);
      current = '';
    }
  }
  if (current) tokens.push(current);
  return tokens.filter(t => t.length > 0 && !STOPWORDS.has(t));
}

// ── Fuzzy Matching ─────────────────────────────────────────────────────────

/**
 * Match an input company name against a list of candidates.
 * Returns best match + sorted suggestions above minScore.
 */
export function fuzzyMatchCompany(
  input: string | null | undefined,
  candidates: Array<string | MatchCandidate>,
  options: FuzzyMatchOptions = {},
): CompanyMatch {
  const minScore = options.minScore ?? 50;
  const topN = options.topN ?? 3;

  const normInput = normalizeCompanyName(input);
  if (!normInput || normInput.length < 2) {
    return { best: null, suggestions: [], level: 'low' };
  }

  // Normalize candidates
  const normCandidates = candidates.map(c => {
    const mc: MatchCandidate = typeof c === 'string' ? { name: c } : c;
    return { ...mc, normalized: normalizeCompanyName(mc.name) };
  }).filter(c => c.normalized.length >= 2);

  const inputTokens = tokenize(normInput);
  const inputLen = normInput.length;

  // Score each candidate
  const scored: MatchSuggestion[] = [];
  for (const c of normCandidates) {
    const score = computeScore(normInput, inputTokens, inputLen, c.normalized, tokenize(c.normalized));
    if (score > 0) {
      scored.push({ id: c.id, name: c.name, score, matchType: getMatchType(score) });
    }
  }

  // Sort descending by score
  scored.sort((a, b) => b.score - a.score);

  const suggestions = scored.filter(s => s.score >= minScore).slice(0, topN);
  const best = suggestions.length > 0 ? suggestions[0] : null;
  const level: 'high' | 'medium' | 'low' =
    best ? (best.score >= 90 ? 'high' : best.score >= 70 ? 'medium' : 'low') : 'low';

  return { best, suggestions, level };
}

function getMatchType(score: number): MatchType {
  if (score >= 100) return 'exact';
  if (score >= 85) return 'substring';
  return 'fuzzy';
}

function computeScore(
  normInput: string,
  inputTokens: string[],
  inputLen: number,
  normCandidate: string,
  candidateTokens: string[],
): number {
  // Stage 1: Exact match
  if (normInput === normCandidate) return 100;

  // Stage 2: Token containment
  const containsResult = checkTokenContainment(inputTokens, candidateTokens, inputLen, normCandidate.length);
  if (containsResult !== null) return containsResult;

  // Stage 3: Fuzzy
  return computeFuzzyScore(normInput, inputTokens, normCandidate, candidateTokens);
}

function checkTokenContainment(
  inputTokens: string[],
  candidateTokens: string[],
  inputLen: number,
  candidateLen: number,
): number | null {
  if (inputTokens.length === 0 || candidateTokens.length === 0) return null;

  const smaller = inputTokens.length <= candidateTokens.length ? inputTokens : candidateTokens;
  const larger = inputTokens.length <= candidateTokens.length ? candidateTokens : inputTokens;

  // Check if all smaller tokens are substrings of some larger token (or vice versa)
  let matched = 0;
  for (const st of smaller) {
    for (const lt of larger) {
      if (lt.includes(st) || st.includes(lt)) {
        matched++;
        break;
      }
    }
  }

  if (smaller.length === 0 || matched === 0) return null;

  const ratio = matched / smaller.length;
  if (ratio >= 0.75) {
    const sizePenalty = Math.min(inputLen, candidateLen) / Math.max(inputLen, candidateLen);
    return Math.round(85 + 13 * ratio * sizePenalty); // 85–98 range
  }

  return null;
}

function computeFuzzyScore(
  normInput: string,
  inputTokens: string[],
  normCandidate: string,
  candidateTokens: string[],
): number {
  // Guards
  if (normInput[0] !== normCandidate[0]) return 0; // first-char rule
  if (Math.max(normInput.length, normCandidate.length) < 6) return 0; // short-name guard

  // Token-level similarity (greedy pairing)
  const tokenSim = greedyTokenSimilarity(
    inputTokens.length <= candidateTokens.length ? inputTokens : candidateTokens,
    inputTokens.length <= candidateTokens.length ? candidateTokens : inputTokens,
  );

  // Character-level similarity
  const maxLen = Math.max(normInput.length, normCandidate.length);
  const charSim = 1 - levenshtein(normInput, normCandidate) / maxLen;

  const score = Math.round(100 * (0.6 * tokenSim + 0.4 * charSim));
  return Math.min(score, 84); // fuzzy never beats substring
}

function greedyTokenSimilarity(smaller: string[], larger: string[]): number {
  if (smaller.length === 0) return 0;
  const used = new Set<number>();
  let totalSim = 0;

  // Sort smaller by length desc for best-match-first
  const sorted = [...smaller].sort((a, b) => b.length - a.length);

  for (const st of sorted) {
    let bestSim = 0;
    let bestIdx = -1;
    for (let i = 0; i < larger.length; i++) {
      if (used.has(i)) continue;
      const maxLen = Math.max(st.length, larger[i].length);
      const sim = 1 - levenshtein(st, larger[i]) / maxLen;
      if (sim > bestSim) { bestSim = sim; bestIdx = i; }
    }
    if (bestIdx >= 0) {
      used.add(bestIdx);
      totalSim += bestSim;
    }
  }

  return totalSim / smaller.length;
}

// ── HK Bank Aliases ────────────────────────────────────────────────────────

/**
 * Canonical HK bank names with aliases (English acronyms, full legal names, Chinese).
 * All aliases are pre-normalized (lowercase, no punctuation, no suffixes).
 */
export const HK_BANK_ALIASES: Record<string, BankAlias> = {
  'HSBC': {
    canonical: 'HSBC',
    aliases: [
      'hsbc', 'thehongkongandshanghaibankingcorporationlimited',
      'hongkongandshanghaibankingcorporationlimited', 'hongkongandshanghaibankingcorporation',
      'hongkongshanghaibank', 'hongkongandshanghaibank',
      // eStatement product banner — AI parsers often extract this instead of 'HSBC'
      'hsbcbusinessdirect', 'hsbchongkong',
      '匯豐銀行', '汇丰银行', '匯豐', '汇丰', '香港上海匯豐銀行', '香港上海汇丰银行',
    ],
  },
  'Standard Chartered': {
    canonical: 'Standard Chartered',
    aliases: [
      'standardchartered', 'standardcharteredbank', 'scb',
      'standardcharteredbankhongkonglimited',
      '渣打銀行', '渣打银行', '渣打',
    ],
  },
  'Hang Seng Bank': {
    canonical: 'Hang Seng Bank',
    aliases: [
      'hangseng', 'hangsengbank', 'hangsengbanklimited',
      '恆生銀行', '恒生银行', '恒生銀行', '恒生', '恆生',
    ],
  },
  'Bank of China (HK)': {
    canonical: 'Bank of China (HK)',
    aliases: [
      'boc', 'bankofchina', 'bankofchinahongkong', 'bochk',
      'bankofchinalimited', 'bochongkong',
      // 'Bank of China (Hong Kong)' normalizes to 'bankofhongkong' because
      // 'china' is stripped as a legal suffix — keep it resolvable anyway
      'bankofhongkong',
      '中國銀行', '中国银行', '中銀', '中银', '中銀香港', '中银香港', '中國銀行香港',
    ],
  },
  'Citibank': {
    canonical: 'Citibank',
    aliases: ['citibank', 'citi', 'citibankhongkong', '花旗銀行', '花旗银行', '花旗'],
  },
  'DBS': {
    canonical: 'DBS',
    aliases: ['dbs', 'dbsbank', 'dbsbankhongkong', '星展銀行', '星展银行', '星展'],
  },
  'China CITIC Bank': {
    canonical: 'China CITIC Bank',
    aliases: ['citic', 'citicbank', 'chinaciticbank', 'citicbankinternational',
      '中信銀行', '中信银行', '中信'],
  },
  'Dah Sing Bank': {
    canonical: 'Dah Sing Bank',
    aliases: ['dahsing', 'dahsingbank', '大新銀行', '大新银行', '大新'],
  },
  'Bank of East Asia': {
    canonical: 'Bank of East Asia',
    aliases: ['bea', 'bankofeastasia', '東亞銀行', '东亚银行'],
  },
  'OCBC': {
    canonical: 'OCBC',
    aliases: ['ocbc', 'overseachinesebankingcorporation', 'ocbcwinghang',
      'overseachinesebankingcorporationlimited', '華僑銀行', '华侨银行', '華僑永亨銀行'],
  },
  'China Construction Bank': {
    canonical: 'China Construction Bank',
    aliases: ['ccb', 'chinaconstructionbank', 'ccbasia', '建設銀行', '建设银行', '中国建设银行'],
  },
};

const SHORT_BANK_ALIASES = new Set(['hsbc', 'boc', 'dbs', 'citi', 'citic', 'bea', 'ccb', 'scb']);

/**
 * Match an input string against HK bank aliases.
 * Returns canonical bank name or null.
 */
export function matchBankName(input: string | null | undefined): string | null {
  if (!input) return null;
  const normalized = normalizeCompanyName(input);
  if (!normalized || normalized.length < 2) return null;

  // For short inputs, only check exact alias matches (not substring scan)
  const isShortInput = normalized.length < 5;

  for (const [_key, { canonical, aliases }] of Object.entries(HK_BANK_ALIASES)) {
    for (const alias of aliases) {
      if (normalized === alias) return canonical;

      if (!isShortInput) {
        // Substring scan: alias in input, or input in alias
        if (normalized.includes(alias) || alias.includes(normalized)) {
          // Short aliases need token boundary check
          if (SHORT_BANK_ALIASES.has(alias) && alias.length < 5) {
            // Require word-boundary-like separation
            if (isTokenMatch(normalized, alias)) return canonical;
          } else {
            return canonical;
          }
        }
      }
    }
  }

  // Fuzzy fallback for longer inputs
  if (normalized.length >= 6) {
    for (const [_key, { canonical, aliases }] of Object.entries(HK_BANK_ALIASES)) {
      for (const alias of aliases) {
        if (alias.length < 4) continue;
        if (normalized[0] !== alias[0]) continue;
        const maxLen = Math.max(normalized.length, alias.length);
        const sim = 1 - levenshtein(normalized, alias) / maxLen;
        if (sim >= 0.85) return canonical;
      }
    }
  }

  return null;
}

/**
 * Canonicalize a bank name supplied by AI parsing or user input.
 * Returns the canonical HK bank name, or null if unknown/empty — callers
 * decide whether to keep the raw value.
 */
export function canonicalizeBankName(input: string | null | undefined): string | null {
  if (!input || !input.trim()) return null;
  return matchBankName(input);
}

/**
 * Bank name to STORE on a bank_statement: canonical for known HK banks,
 * raw (trimmed) value for unknown banks. All statements of the same account
 * thus share one name, differing only by the year-month prefix.
 */
export function normalizeBankNameForStorage(input: string | null | undefined): string | null {
  if (!input || !input.trim()) return null;
  return matchBankName(input) || input.trim();
}

/**
 * Resolve bank_name for a statement import, in priority order:
 *   1. AI/client-supplied name — canonicalized, unknown banks kept verbatim
 *   2. OCR text — canonical match only
 *   3. file name — canonical match only
 */
export function resolveStatementBankName(
  suppliedName: string | null | undefined,
  ocrText?: string | null,
  fileName?: string | null,
): string | null {
  if (suppliedName && suppliedName.trim()) return normalizeBankNameForStorage(suppliedName);
  return matchBankName(ocrText || '') || matchBankName(fileName || '') || null;
}

/**
 * Check if a short token appears as a distinct token within a longer string.
 * E.g. "boc" matches "boc e statement" but not "block".
 */
function isTokenMatch(text: string, token: string): boolean {
  // Find all occurrences and check surrounding chars
  let idx = 0;
  while ((idx = text.indexOf(token, idx)) !== -1) {
    const before = idx === 0 || !/[a-z0-9]/i.test(text[idx - 1]);
    const after = idx + token.length >= text.length || !/[a-z0-9]/i.test(text[idx + token.length]);
    if (before && after) return true;
    idx += token.length;
  }
  return false;
}
