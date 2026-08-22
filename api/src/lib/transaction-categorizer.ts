/**
 * Transaction Categorizer — single source of truth for mapping statement
 * transaction descriptions onto Chart of Accounts codes.
 *
 * Consumers: file-storage import, bank-statement auto-categorize,
 * card-statement auto-categorize, PATCH JE regeneration, and
 * bookkeeping auto-generate-entries. Replaces four divergent inline
 * rule copies.
 *
 * Grounded in real HSBC Business Direct descriptors
 * (test-sample-real/EHSIA/eStatement + test-sample-real/PNR/estatement)
 * plus generated-sample formats. Dependency-free; Workers-compatible
 * (reuses levenshtein from company-matcher.ts).
 *
 * Conventions:
 *  - `code === ''` in a result means "no COA posting" (ignore / internal_transfer).
 *  - `null` return means "uncategorized" — leave for user assignment.
 *  - Normalized text is UPPERCASE with punctuation collapsed to spaces;
 *    rule patterns must not contain '-', '/', '.' inside tokens.
 */

import { levenshtein } from './company-matcher';

// ── Types ──────────────────────────────────────────────────────────────────

export type RuleTag =
  | 'bank_charge'
  | 'fee_refund'
  | 'interest_income'
  | 'interest_expense'
  | 'income'
  | 'internal_transfer'
  | 'tax'
  | 'director'
  | 'expense'
  | 'ignore';

export interface CategorizeRule {
  pattern: RegExp;
  /** COA account code; '' means "no posting" (ignore / internal_transfer). */
  code: string;
  tag: RuleTag;
  direction?: 'deposit' | 'withdrawal';
}

export interface CategorizeResult {
  code: string;
  tag: RuleTag;
  confidence: 'exact' | 'fuzzy';
}

// ── Normalization ──────────────────────────────────────────────────────────

/**
 * Normalize an OCR'd description so rules can match across HSBC's two-line
 * layout: uppercase, collapse whitespace/newlines, then strip cheque refs
 * (HC125B0521391053), transfer refs (N61632566682 / NA0315859585),
 * REF:xxxx xxxx headers, bracketed/bare dates ((03NOV25) / 19MAR25),
 * remaining digit-bearing tokens (amounts, account numbers), and punctuation.
 */
export function normalizeDescription(raw: string): string {
  return (raw || '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/\bHC[0-9A-Z]{8,}\b/g, ' ')
    .replace(/\bN[A-Z]{0,2}\d{8,}\b/g, ' ')
    .replace(/REF:[A-Z0-9]{4}\s?\d{4}/g, ' ')
    .replace(/\(\d{2}[A-Z]{3}\d{2}\)/g, ' ')
    .replace(/\(\d{2}[A-Z]{3}\)/g, ' ')
    .replace(/\b\d{1,2}[A-Z]{3}\d{0,2}\b/g, ' ')
    // Split letter/digit boundaries so suffixes like FEE25 survive as FEE
    .replace(/([A-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Z])/g, '$1 $2')
    // Strip remaining pure-number tokens (amounts, account numbers)
    .replace(/\b\d+\b/g, ' ')
    .replace(/[^A-Z0-9&* \u4e00-\u9fff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Rule catalog (ordered — first match wins) ──────────────────────────────

export const CATEGORIZE_RULES: CategorizeRule[] = [
  // ── noise / non-posting ── (normalize removes '/', so B/F → BF or B F)
  { pattern: /\bBF BALANCE\b|\bB F BALANCE\b|\bB\/F BALANCE\b|承上結餘/, code: '', tag: 'ignore' },
  { pattern: /^承上結餘/, code: '', tag: 'ignore' },

  // ── fee refunds credit back to Bank Service Fee ──
  { pattern: /\bREFUND\b.*\bFEE\b|\bFEE REFUND\b|退回.*費用/, code: '65101', tag: 'fee_refund' },

  // ── interest expense (any direction — DEBIT INTEREST is never income) ──
  { pattern: /\bDEBIT INTEREST\b|\bOVERDRAWN\b|\bINTEREST CHARGE\b|透支利息/, code: '65102', tag: 'interest_expense' },

  // ── bank charges → 65101 Bank Service Fee ──
  // Bare CHARGES is THE dominant real-HSBC cheque-handling descriptor.
  { pattern: /^CHARGES?\b/, code: '65101', tag: 'bank_charge', direction: 'withdrawal' },
  { pattern: /\bBANK (SERVICE )?(CHARGES?|FEES?)\b|\bCREDIT CARD FEE\b|\bCARD FEES?\b|\bCARD CHARGE\b/, code: '65101', tag: 'bank_charge' },
  { pattern: /\bSERVICE (CHARGES?|FEES?)\b|手續費|銀行費|银行费/, code: '65101', tag: 'bank_charge' },
  { pattern: /\bMONTHLY SERVICE FEE\b|\bMONTHLY FEE\b|\bACCOUNT APPLICATION FEE\b|\bPAPER STATEMENT FEE\b|\bSTATEMENT FEE\b/, code: '65101', tag: 'bank_charge' },
  { pattern: /\bBLG CQBK\b|\bCQBK FEES?\b|\bCHEQUE (BOOK |HANDLING |PROTEST )?(CHARGES?|FEES?)\b|支票費/, code: '65101', tag: 'bank_charge' },
  { pattern: /\bFPS ?(PAYMENT )?(FEES?|CHARGES?)\b|\bFPSPAYMENT\b/, code: '65101', tag: 'bank_charge' },
  { pattern: /\bWIRE TRANSFER (FEES?|CHARGES?)\b|\bTT (FEES?|CHARGES?)\b|\bREMITTANCE (FEES?|CHARGES?)\b|\bOUTGOING TRANSFER FEES?\b|匯款費用/, code: '65101', tag: 'bank_charge' },
  { pattern: /\bMIN(IMUM)? BAL(ANCE)? FEES?\b|\bMAINTENANCE FEES?\b|\bANNUAL FEES?\b|年費|月費/, code: '65101', tag: 'bank_charge' },

  // ── interest income (deposits only; expense variants matched above) ──
  { pattern: /\bINTEREST\b|利息收入|利息/, code: '42101', tag: 'interest_income', direction: 'deposit' },

  // ── internal transfers between own accounts (narrow: no narration after
  //    account number, or explicit SWEEP). Narrated rows like
  //    "CR TO <acct> WEB HOSTING" fall through to the catalog instead. ──
  { pattern: /\bSWEEP\b|^CR TO$|^FROM$/, code: '', tag: 'internal_transfer' },

  // ── tax payments ──
  { pattern: /\bINLAND REVENUE\b|稅務局|\bPROFITS? TAX\b|\bIRD\b|\bTAX\b|稅/, code: '21301', tag: 'tax', direction: 'withdrawal' },

  // ── professional & cost ──
  { pattern: /\bPASTEL TECH\b|\bSUB CONTRACT\b|\bOUTSOURC|外判/, code: '51101', tag: 'expense', direction: 'withdrawal' },
  { pattern: /\bAUDIT\b|審計|\bDELOITTE\b|\bKPMG\b|\bPWC\b|\bERNST YOUNG\b/, code: '63101', tag: 'expense', direction: 'withdrawal' },
  { pattern: /\bSECRETARY\b|秘書|\bHKICS\b/, code: '63102', tag: 'expense', direction: 'withdrawal' },
  { pattern: /\bLEGAL\b|律師|法律|\bBAKER MCKENZIE\b/, code: '63103', tag: 'expense', direction: 'withdrawal' },
  { pattern: /\bINSURANCE\b|保險|保险/, code: '63300', tag: 'expense', direction: 'withdrawal' },

  // ── staff ──
  { pattern: /\bSALARIES\b|\bSALARY\b|\bPAYROLL\b|\bWAGES?\b|薪金|薪資|工資/, code: '61201', tag: 'expense', direction: 'withdrawal' },
  { pattern: /\bMPF\b|強積金|公積金|\bMANULIFE\b/, code: '61202', tag: 'expense', direction: 'withdrawal' },

  // ── premises & utilities ──
  { pattern: /\bRENT\b|租金/, code: '62101', tag: 'expense', direction: 'withdrawal' },
  { pattern: /\bCLP\b|\bHK ELECTRIC\b|\bELECTRICITY\b|中電|港燈|電費|电费/, code: '62201', tag: 'expense', direction: 'withdrawal' },
  { pattern: /\bWATER\b|水費|水费/, code: '62202', tag: 'expense', direction: 'withdrawal' },
  { pattern: /\bUTILITIES\b|水電/, code: '62200', tag: 'expense', direction: 'withdrawal' },

  // ── advertising BEFORE software (GOOGLE ADS must not hit CLOUD/SUBSCRIPTION) ──
  { pattern: /\bGOOGLE ADS\b|\bADVERTISING\b|廣告|广告|\bMARKETING\b|推廣|推广/, code: '64101', tag: 'expense', direction: 'withdrawal' },

  // ── comms / hosting / software ──
  { pattern: /\bWEB HOSTING\b|\bHOSTING\b|\bDOMAIN\b|\bDNS\b|寄存|域名/, code: '62302', tag: 'expense', direction: 'withdrawal' },
  { pattern: /\bHKT\b|\bTELECOM\b|\bBROADBAND\b|\bMOBILE\b|\bPHONE\b|\bPCCW\b|\bSMARTONE\b|\bCHINA MOBILE\b|電話|上網/, code: '62301', tag: 'expense', direction: 'withdrawal' },
  { pattern: /\bSOFTWARE\b|\bSUBSCRIPTION\b|\bAWS\b|\bMICROSOFT\b|\bADOBE\b|\bGOOGLE CLOUD\b|\bCLOUD\b|\bAPI\b/, code: '62303', tag: 'expense', direction: 'withdrawal' },
  { pattern: /\bVISA DEBIT\b|扣賬卡交易/, code: '62303', tag: 'expense', direction: 'withdrawal' },

  // ── transport / travel / meals ──
  { pattern: /\bMTR\b|\bUBER\b|\bTAXI\b|\bOCTOPUS\b|交通|油費/, code: '64301', tag: 'expense', direction: 'withdrawal' },
  { pattern: /\bCATHAY\b|\bAIRWAYS\b|\bAIRLINE\b|\bHOTELS?\b|\bFLIGHT\b|\bTRAVEL\b|機票|机票|海外/, code: '64302', tag: 'expense', direction: 'withdrawal' },
  { pattern: /\bDELIVEROO\b|\bFOODPANDA\b|\bRESTAURANT\b|\bCAFE\b|\bSTARBUCKS\b|\bMCDONALD\b|\bPACIFIC COFFEE\b|\bDINING\b|\bMEALS?\b|餐飲|餐饮|餐廳|餐厅/, code: '64202', tag: 'expense', direction: 'withdrawal' },
  { pattern: /\bCOMMISSIONS?\b|佣金/, code: '64201', tag: 'expense', direction: 'withdrawal' },
  { pattern: /\bENTERTAINMENT\b|交際|應酬/, code: '64202', tag: 'expense', direction: 'withdrawal' },

  // ── supplies / shopping / misc ──
  { pattern: /\bOFFICE SUPPLIES\b|\bWHSMITH\b|\bBOOKAZINE\b|\bOFFICE DEPOT\b|\bSTATIONERY\b|\bPRINTING\b|文具|辦公|印刷/, code: '62401', tag: 'expense', direction: 'withdrawal' },
  { pattern: /\bPARKNSHOP\b|\bWELLCOME\b|\bSUPERMARKET\b|\bGROCERY\b|\bAEON\b|\bPANTRY\b|超市|百佳|惠康/, code: '62402', tag: 'expense', direction: 'withdrawal' },
  { pattern: /\bAPPLE\b|\bSHOPEE\b|\bAMAZON\b|\bTAOBAO\b|\bSHOPPING\b/, code: '66203', tag: 'expense', direction: 'withdrawal' },
  { pattern: /\bCOURIER\b|\bPOSTAGE\b|\bSF EXPRESS\b|順豐|顺丰|郵費/, code: '66203', tag: 'expense', direction: 'withdrawal' },
  { pattern: /\bREPAIRS?\b|\bMAINTENANCE\b|維修|维修/, code: '66203', tag: 'expense', direction: 'withdrawal' },
  { pattern: /\bDONATION\b|捐款|慈善/, code: '66202', tag: 'expense', direction: 'withdrawal' },
  { pattern: /\bOUTCLEARING\b|\bCHEQUE RETURN\b|退票/, code: '66203', tag: 'expense', direction: 'withdrawal' },
  { pattern: /\bTRANSFER DEBIT\b|轉賬支出/, code: '66203', tag: 'expense', direction: 'withdrawal' },

  // ── income side (deposits) ──
  { pattern: /\bCLIENT PAYMENT\b|\bCUSTOMER PAYMENT\b|\bFPS INWARD\b|\bINWARD REMITTANCE\b|\bCHEQUE DEPOSIT\b|\bDEPOSIT MACHINE\b|\bECQ DEPOSIT\b|\bCREDIT TRANSFER\b|收款|入賬/, code: '41101', tag: 'income', direction: 'deposit' },
];

// ── Director detection ─────────────────────────────────────────────────────

/** Static director/insider name list incl. HSBC privacy-masked + initial forms. */
const DIRECTOR_NAME_PATTERNS: RegExp[] = [
  /\bJOSEPH LIN\b/,
  /\bLIN PUI KEUNG\b/,
  /\bSZETO CHI MAN\b/,
  /\bLAI KIN CHEONG\b/,
  /\bLIN P\*+ K\*+ J\*+/,   // masked: LIN P** K**** J*****
  /\bLIN P K J\b/,          // initials skeleton
];

export function isDirectorDescription(normDesc: string): boolean {
  return DIRECTOR_NAME_PATTERNS.some(p => p.test(normDesc));
}

const DIRECTOR_TRANSFERISH = /\bTRANSFER\b|\bFPS\b|\bATM\b|\bSWEEP\b|\bCHEQUE\b|轉賬/;

function directorResult(dir?: 'deposit' | 'withdrawal', normDesc = ''): CategorizeResult | null {
  if (!isDirectorDescription(normDesc)) return null;
  if (!dir || dir === 'deposit' || DIRECTOR_TRANSFERISH.test(normDesc)) {
    return { code: '21201', tag: 'director', confidence: 'exact' };
  }
  return null;
}

// ── Fuzzy tier ─────────────────────────────────────────────────────────────

interface FuzzyEntry { token: string; code: string; tag: RuleTag; direction?: 'deposit' | 'withdrawal'; }

const FUZZY_KEYWORDS: FuzzyEntry[] = [
  { token: 'CHARGE', code: '65101', tag: 'bank_charge', direction: 'withdrawal' },
  { token: 'FEE', code: '65101', tag: 'bank_charge', direction: 'withdrawal' },
  { token: 'HANDLING', code: '65101', tag: 'bank_charge', direction: 'withdrawal' },
  { token: 'SUBSCRIPTION', code: '62303', tag: 'expense', direction: 'withdrawal' },
  { token: 'ADVERTIS', code: '64101', tag: 'expense', direction: 'withdrawal' },
  { token: 'RENTAL', code: '62101', tag: 'expense', direction: 'withdrawal' },
  { token: 'SALARY', code: '61201', tag: 'expense', direction: 'withdrawal' },
  { token: 'PAYROLL', code: '61201', tag: 'expense', direction: 'withdrawal' },
  { token: 'UTILITIES', code: '62200', tag: 'expense', direction: 'withdrawal' },
  { token: 'INSURANCE', code: '63300', tag: 'expense', direction: 'withdrawal' },
  { token: 'TELECOM', code: '62301', tag: 'expense', direction: 'withdrawal' },
  { token: 'HOSTING', code: '62302', tag: 'expense', direction: 'withdrawal' },
];

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  // Prefix relation (HSBC truncation / plurals): confident match
  if ((a.length >= 4 || b.length >= 4) && (a.startsWith(b) || b.startsWith(a))) return 0.9;
  return 1 - levenshtein(a, b) / max;
}

function fuzzyMatch(desc: string, dir?: 'deposit' | 'withdrawal'): { code: string; tag: RuleTag } | null {
  const tokens = desc.split(' ').filter(t => t.length >= 3 && /[A-Z]/.test(t));
  let best: { score: number; entry: FuzzyEntry } | null = null;
  for (const tok of tokens) {
    for (const e of FUZZY_KEYWORDS) {
      if (e.direction && dir && e.direction !== dir) continue;
      const s = similarity(tok, e.token);
      if (s >= 0.85 && (!best || s > best.score)) best = { score: s, entry: e };
    }
  }
  return best ? { code: best.entry.code, tag: best.entry.tag } : null;
}

// ── Engine ─────────────────────────────────────────────────────────────────

/**
 * Categorize one transaction description.
 * @returns `{code:'', tag:'ignore'|'internal_transfer'}` when no posting should
 * occur; `null` when uncategorized (leave for user); otherwise the COA result.
 */
export function categorizeTransaction(rawDesc: string, dir?: 'deposit' | 'withdrawal'): CategorizeResult | null {
  const desc = normalizeDescription(rawDesc);
  if (!desc) return null;

  for (const r of CATEGORIZE_RULES) {
    if (r.direction && dir && r.direction !== dir) continue;
    if (r.pattern.test(desc)) return { code: r.code, tag: r.tag, confidence: 'exact' };
  }

  const dirRes = directorResult(dir, desc);
  if (dirRes) return dirRes;

  const fuzzy = fuzzyMatch(desc, dir);
  if (fuzzy) return { ...fuzzy, confidence: 'fuzzy' };

  return null;
}

// ── Bank account resolution ────────────────────────────────────────────────

/** Map statement bank name to its COA bank account: HSBC → 11102, else Other Bank. */
export function resolveBankAccountCode(bankName?: string | null): '11102' | '11103' {
  return /HSBC|SHANGHAI BANKING|滙豐|汇丰/i.test(bankName || '') ? '11102' : '11103';
}
