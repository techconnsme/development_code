/**
 * OCR Pipeline — Dual-Path with Arbitration
 *
 * Mirror of the production import pipeline. Uses dependency injection
 * for OCR backends so the same code runs in Cloudflare Workers (real APIs)
 * and local tests (pdftotext + REST).
 */

import { normalizeCompanyName, fuzzyMatchCompany, matchBankName } from './company-matcher';
import type { MatchCandidate } from './company-matcher';

// ── Types ──────────────────────────────────────────────────────────────────

export interface OcrBackend {
  name: string;                           // 'pdftotext' | 'tomarkdown' | 'glm-ocr'
  extractText: (pdfBytes: Uint8Array) => Promise<string>;
}

export interface DeepSeekConfig {
  apiKey: string;
  model?: string;                         // default 'deepseek-chat'
}

export interface PipelineConfig {
  ocrBackends: OcrBackend[];
  deepseek: DeepSeekConfig;
  ownCompanyNames: string[];              // e.g. ['Proficient and Reliance Company Limited']
  existingSuppliers?: MatchCandidate[];   // for invoice scoring
  existingCustomers?: MatchCandidate[];   // for bank statement counterparty matching
}

export interface ParsedTransaction {
  transaction_date: string;
  description: string;
  deposit_amount: number;
  withdrawal_amount: number;
  balance: number | null;
  account_type: string | null;
}

export interface ParsedStatement {
  bank_name?: string;
  account_number?: string;
  currency?: string;
  statement_year?: number;
  statement_month?: number;
  period_start?: string;
  period_end?: string;
  opening_balance?: number;
  closing_balance?: number;
  transactions: ParsedTransaction[];
}

export interface ParsedInvoice {
  vendor_name?: string;
  customer_name?: string;
  invoice_number?: string;
  issue_date?: string;
  due_date?: string;
  currency?: string;
  total?: number;
  items?: { description: string; quantity: number; unit_price: number; amount: number }[];
}

export interface StatementScore {
  total: number;           // 0–100
  balanceOk: boolean;      // opening + Σdep - Σwit = OCR closing
  checkpointOk: number;    // how many printed balances matched
  checkpointTotal: number; // total printed balances
  depositTotalOk: boolean; // Σdep = OCR-stated total deposits
  withdrawalTotalOk: boolean; // Σwit = OCR-stated total withdrawals
  detail: string;
}

export interface InvoiceScore {
  total: number;           // 0–100
  directionConfidence: number;
  vendorConfidence: number;
  totalOk: boolean;        // Σitems = stated total
  completeness: boolean;   // both names extracted
  detail: string;
}

export interface PipelineResult {
  backend: string;
  parsed: ParsedStatement | ParsedInvoice | null;
  score: StatementScore | InvoiceScore | null;
  deepseekUsage: any;
  ocrText: string;
  ocrLen: number;
  error?: string;
}

export interface ArbitrationResult {
  winner: PipelineResult;
  loser: PipelineResult | null;
  tied: boolean;
  needsReview: boolean;
  detail: string;
}

// ── DeepSeek Call ──────────────────────────────────────────────────────────

const BANK_PROMPT = (ocrText: string) => `Parse this bank statement OCR into JSON:
- bank_name, account_number, currency, statement_year, statement_month
- period_start, period_end (YYYY-MM-DD)
- opening_balance, closing_balance (numbers)
- transactions: [{ transaction_date (YYYY-MM-DD), description, deposit_amount (0 if withdrawal), withdrawal_amount (0 if deposit), balance (null if not on that line), account_type }]

IMPORTANT: Judge deposit vs withdrawal by COLUMN. For HTML tables read <td> positions. For position-tagged text [L/M/R], use column mapping. Self-check running total against printed balances. Return ONLY valid JSON.

OCR TEXT:
${ocrText.slice(0, 8000)}`;

const INVOICE_PROMPT = (ocrText: string, hints: string) => `${hints}Parse this invoice OCR into JSON:
- vendor_name: the issuer/supplier (company that sent this bill)
- customer_name: the party being billed (client)
- invoice_number, issue_date, due_date (YYYY-MM-DD), currency (default HKD)
- items: [{ description, quantity (number), unit_price (number), amount (number) }]
- total

IMPORTANT: vendor_name = sender/supplier, customer_name = recipient/client.
Return ONLY valid JSON.

OCR TEXT:
${ocrText.slice(0, 8000)}`;

export async function callDeepSeek(
  ocrText: string,
  docType: 'bank_statement' | 'invoice',
  config: DeepSeekConfig,
  hints?: string,
): Promise<{ parsed: any; usage: any; raw: string }> {
  const promptFn = docType === 'bank_statement' ? BANK_PROMPT : INVOICE_PROMPT;
  const prompt = promptFn(ocrText, hints || '');

  const resp = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model || 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4000,
    }),
  });
  const data = await resp.json() as any;
  const raw = data.choices?.[0]?.message?.content || '';
  const m = raw.match(/\{[\s\S]*\}/);
  let parsed: any = null;
  if (m) {
    try { parsed = JSON.parse(m[0]); } catch {}
  }
  return { parsed, usage: data.usage, raw };
}

// ── OCR Text Regex Extraction (ground truth, independent of DeepSeek) ──────

/**
 * Extract stated totals and balances from raw OCR text using regex.
 * These provide ground truth for scoring, independent of DeepSeek.
 */
export function extractStatementTotals(ocrText: string): {
  openingBalance: number | null;
  closingBalance: number | null;
  totalDeposits: number | null;
  totalWithdrawals: number | null;
  printedBalances: number[];  // all balance figures found, in order
} {
  const result = {
    openingBalance: null as number | null,
    closingBalance: null as number | null,
    totalDeposits: null as number | null,
    totalWithdrawals: null as number | null,
    printedBalances: [] as number[],
  };

  // Opening: B/F BALANCE followed by number
  const bfMatch = ocrText.match(/B\/F\s+BALANCE\s+([\d,]+\.?\d*)/i);
  if (bfMatch) result.openingBalance = parseFloat(bfMatch[1].replace(/,/g, ''));

  // Closing: last balance figure before "Total" or at end of transactions
  // Also try "Total balance in HKD" pattern
  const closingMatch = ocrText.match(/Total\s+balance\s+in\s+HKD\s+([\d,]+\.?\d*)/i);
  if (closingMatch) result.closingBalance = parseFloat(closingMatch[1].replace(/,/g, ''));

  // Also try the last transaction line balance as closing
  const allBalances = [...ocrText.matchAll(/(\d{1,3}(?:,\d{3})*\.\d{2})/g)];
  if (allBalances.length > 0) {
    result.printedBalances = allBalances.map(m => parseFloat(m[1].replace(/,/g, '')));
    if (!result.closingBalance && result.printedBalances.length > 0) {
      // Don't guess closing from last balance — leave null if not found
    }
  }

  // Totals
  const depMatch = ocrText.match(/Total\s+Deposit\s+Amount[:\s]*HKD\s*([\d,]+\.?\d*)/i);
  if (depMatch) result.totalDeposits = parseFloat(depMatch[1].replace(/,/g, ''));

  const witMatch = ocrText.match(/Total\s+Withdrawal\s+Amount[:\s]*HKD\s*([\d,]+\.?\d*)/i);
  if (witMatch) result.totalWithdrawals = parseFloat(witMatch[1].replace(/,/g, ''));

  return result;
}

/**
 * Extract PDF metadata Author field as vendor hint.
 */
export function extractPdfAuthor(ocrText: string): string | null {
  const am = ocrText.match(/^- Author[=:]\s*(.+)$/m);
  if (!am) return null;
  const author = am[1].trim();
  if (/^(Word|Microsoft|Adobe|macOS|Excel|PowerPoint|Pages|Numbers|Keynote|WPS|LibreOffice|Unknown|Writer|Calc)$/i.test(author)) {
    return null;
  }
  return author;
}

// ── Scoring ────────────────────────────────────────────────────────────────

export function scoreBankStatement(
  parsed: ParsedStatement,
  ocrRawText: string,
): StatementScore {
  const txs = parsed.transactions || [];
  const dep = txs.reduce((s, t) => s + (t.deposit_amount || 0), 0);
  const wit = txs.reduce((s, t) => s + (t.withdrawal_amount || 0), 0);
  const opening = parsed.opening_balance ?? 0;

  const ocrTotals = extractStatementTotals(ocrRawText);
  let total = 0;

  // 40 pts: balance reconciliation (independent OCR closing)
  let balanceOk = false;
  if (ocrTotals.closingBalance != null) {
    const computed = opening + dep - wit;
    balanceOk = Math.abs(computed - ocrTotals.closingBalance) <= 0.01;
  } else if (parsed.closing_balance != null) {
    // Fallback to DeepSeek's closing
    const computed = opening + dep - wit;
    balanceOk = Math.abs(computed - parsed.closing_balance) <= 0.01;
  }
  if (balanceOk) total += 40;

  // 30 pts: printed balance checkpoints
  let checkpointOk = 0;
  let checkpointTotal = 0;
  let running = opening;
  for (const t of txs) {
    running = running + (t.deposit_amount || 0) - (t.withdrawal_amount || 0);
    if (t.balance != null) {
      checkpointTotal++;
      if (Math.abs(running - t.balance) <= 0.01) checkpointOk++;
    }
  }
  if (checkpointTotal > 0) {
    total += Math.round(30 * (checkpointOk / checkpointTotal));
  }

  // 15 pts: deposit total match
  let depositTotalOk = false;
  if (ocrTotals.totalDeposits != null) {
    depositTotalOk = Math.abs(dep - ocrTotals.totalDeposits) <= 0.01;
    if (depositTotalOk) total += 15;
  }

  // 15 pts: withdrawal total match
  let withdrawalTotalOk = false;
  if (ocrTotals.totalWithdrawals != null) {
    withdrawalTotalOk = Math.abs(wit - ocrTotals.totalWithdrawals) <= 0.01;
    if (withdrawalTotalOk) total += 15;
  }

  return {
    total: Math.min(100, total),
    balanceOk,
    checkpointOk,
    checkpointTotal,
    depositTotalOk,
    withdrawalTotalOk,
    detail: `balance:${balanceOk} checkpoints:${checkpointOk}/${checkpointTotal} depTotal:${depositTotalOk} witTotal:${withdrawalTotalOk}`,
  };
}

export function scoreInvoice(
  parsed: ParsedInvoice,
  ownNames: string[],
  suppliers: MatchCandidate[],
): InvoiceScore {
  let total = 0;

  // 40 pts: direction confidence (customer matches our company?)
  const custMatch = parsed.customer_name
    ? fuzzyMatchCompany(parsed.customer_name, ownNames, { topN: 1, minScore: 50 })
    : null;
  const vendorMatchOwn = parsed.vendor_name
    ? fuzzyMatchCompany(parsed.vendor_name, ownNames, { topN: 1, minScore: 50 })
    : null;
  const directionConfidence = Math.max(
    custMatch?.best?.score ?? 0,
    vendorMatchOwn?.best?.score ? (100 - vendorMatchOwn.best.score) : 0,
  );
  total += Math.round(40 * directionConfidence / 100);

  // 20 pts: vendor matches known suppliers
  const vendorSupMatch = parsed.vendor_name
    ? fuzzyMatchCompany(parsed.vendor_name, suppliers, { topN: 1, minScore: 50 })
    : null;
  const vendorConfidence = vendorSupMatch?.best?.score ?? 0;
  total += Math.round(20 * vendorConfidence / 100);

  // 20 pts: line items sum to total
  const items = parsed.items || [];
  const itemsSum = items.reduce((s, it) => s + (it.amount || it.quantity * it.unit_price || 0), 0);
  const totalOk = parsed.total != null && Math.abs(itemsSum - parsed.total) <= 0.01;
  if (totalOk) total += 20;

  // 20 pts: completeness (both names extracted)
  const completeness = !!(parsed.vendor_name && parsed.customer_name &&
    parsed.vendor_name.trim().length > 2 && parsed.customer_name.trim().length > 2);
  if (completeness) total += 20;

  return {
    total: Math.min(100, total),
    directionConfidence,
    vendorConfidence,
    totalOk,
    completeness,
    detail: `dir:${directionConfidence} vendor:${vendorConfidence} totalOk:${totalOk} complete:${completeness}`,
  };
}

// ── Arbitration ────────────────────────────────────────────────────────────

/**
 * Compare two pipeline results and pick the winner.
 * Margin of 10 points required to declare a clear winner.
 */
export function arbitrate(
  results: PipelineResult[],
  docType: 'bank_statement' | 'invoice',
): ArbitrationResult {
  const valid = results.filter(r => r.parsed && r.score);
  if (valid.length === 0) {
    return {
      winner: results[0] || { backend: 'none', parsed: null, score: null, deepseekUsage: null, ocrText: '', ocrLen: 0, error: 'All paths failed' },
      loser: null, tied: false, needsReview: true,
      detail: 'No valid results from any OCR backend',
    };
  }
  if (valid.length === 1) {
    return {
      winner: valid[0], loser: null, tied: false,
      needsReview: (valid[0].score?.total ?? 0) < 70,
      detail: `Only one OCR backend succeeded: ${valid[0].backend}`,
    };
  }

  // Sort by score descending
  valid.sort((a, b) => (b.score?.total ?? 0) - (a.score?.total ?? 0));
  const [best, second] = valid;
  const margin = (best.score?.total ?? 0) - (second.score?.total ?? 0);

  if (margin > 10) {
    return {
      winner: best, loser: second, tied: false,
      needsReview: (best.score?.total ?? 0) < 70,
      detail: `${best.backend} wins by ${margin}pts (${best.score?.total} vs ${second.score?.total})`,
    };
  }

  return {
    winner: best, loser: second, tied: true,
    needsReview: true,
    detail: `Too close to call: ${best.backend}=${best.score?.total}, ${second.backend}=${second.score?.total} (margin ${margin})`,
  };
}

// ── Full Pipeline ──────────────────────────────────────────────────────────

/**
 * Run a single OCR backend through the full pipeline:
 * OCR → DeepSeek → parse → score
 */
export async function runSinglePath(
  backend: OcrBackend,
  pdfBytes: Uint8Array,
  docType: 'bank_statement' | 'invoice',
  config: PipelineConfig,
): Promise<PipelineResult> {
  const ocrStart = Date.now();
  let ocrText: string;
  try {
    ocrText = await backend.extractText(pdfBytes);
  } catch (e: any) {
    return {
      backend: backend.name, parsed: null, score: null, deepseekUsage: null,
      ocrText: '', ocrLen: 0,
      error: `OCR failed: ${e.message || String(e)}`,
    };
  }
  const ocrLen = ocrText.length;

  // Too little text — skip
  if (ocrLen < 20) {
    return {
      backend: backend.name, parsed: null, score: null, deepseekUsage: null,
      ocrText, ocrLen,
      error: `OCR produced only ${ocrLen} chars`,
    };
  }

  // Build hints for invoices
  let hints = '';
  if (docType === 'invoice') {
    const author = extractPdfAuthor(ocrText);
    if (author) hints = `HINT: PDF metadata Author="${author}" — likely the vendor/issuer.\n`;
  }

  // Call DeepSeek
  const dsStart = Date.now();
  let dsResult: { parsed: any; usage: any };
  try {
    dsResult = await callDeepSeek(ocrText, docType, config.deepseek, hints);
  } catch (e: any) {
    return {
      backend: backend.name, parsed: null, score: null, deepseekUsage: null,
      ocrText, ocrLen,
      error: `DeepSeek failed: ${e.message || String(e)}`,
    };
  }

  if (!dsResult.parsed) {
    return {
      backend: backend.name, parsed: null, score: null,
      deepseekUsage: dsResult.usage, ocrText, ocrLen,
      error: 'DeepSeek returned no valid JSON',
    };
  }

  // Score
  let score: StatementScore | InvoiceScore;
  if (docType === 'bank_statement') {
    score = scoreBankStatement(dsResult.parsed as ParsedStatement, ocrText);
  } else {
    score = scoreInvoice(
      dsResult.parsed as ParsedInvoice,
      config.ownCompanyNames,
      config.existingSuppliers || [],
    );
  }

  return {
    backend: backend.name,
    parsed: dsResult.parsed,
    score,
    deepseekUsage: dsResult.usage,
    ocrText,
    ocrLen,
  };
}

/**
 * Run the full dual-path pipeline and return the arbitrated winner.
 */
export async function runPipeline(
  pdfBytes: Uint8Array,
  docType: 'bank_statement' | 'invoice',
  config: PipelineConfig,
): Promise<{ results: PipelineResult[]; arbitration: ArbitrationResult }> {
  const results = await Promise.all(
    config.ocrBackends.map(backend => runSinglePath(backend, pdfBytes, docType, config)),
  );

  const arbitration = arbitrate(results, docType);
  return { results, arbitration };
}

// ── Convenience: detect text layer ─────────────────────────────────────────

/**
 * Quick check: does this PDF have a text layer?
 * Run pdftotext — if it produces meaningful text, text layer exists.
 */
export function hasTextLayer(text: string): boolean {
  return text.length > 200 && !/^# \S+\.pdf\n## Metadata\n/.test(text.trim().slice(0, 100));
}

/**
 * True if toMarkdown produced only PDF metadata (no real content).
 */
export function isPdfMetadataOnly(text: string): boolean {
  if (!text || text.length < 30) return false;
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length === 0) return false;
  let metaLines = 0, contentLines = 0;
  for (const line of lines) {
    const t = line.trim();
    if (/^(#|##)\s/.test(t) && /\.pdf$/i.test(t)) { metaLines++; continue; }
    if (/^-\s*(PDFFormatVersion|IsLinearized|IsAcroFormPresent|PDFVersion|Producer|Creator|Author|Title|Subject|Keywords|Created|Modified|Pages|Encrypted)/i.test(t)) { metaLines++; continue; }
    if (/^##\s*Metadata/i.test(t)) { metaLines++; continue; }
    if (t.length > 5) contentLines++;
  }
  return metaLines >= 3 && contentLines < 3;
}
