import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { Bindings, Variables } from '../types';
import * as pdfjsWorkerModule from 'pdfjs-dist/build/pdf.worker.mjs';

// pdf.js's fake worker (used when isNodeJS is true, which includes workerd's
// nodejs_compat runtime) looks for `globalThis.pdfjsWorker.WorkerMessageHandler`
// BEFORE its runtime `import(workerSrc)` — which workerd cannot resolve
// ("No such module pdf.worker.mjs"). Publishing the statically-bundled worker
// module there makes the in-process fake worker work in workerd.
(globalThis as any).pdfjsWorker = pdfjsWorkerModule;
import { authMiddleware, requireHigherTier } from '../middleware/auth';
import { categorizeTransaction, resolveBankAccountCode } from '../lib/transaction-categorizer';
import { tryPostInvoiceToGl } from '../lib/post-invoice';
import { wsBroadcast } from './ws';
import { generateReceiptNumber, detectOwnNumber } from '../lib/numbering';
import { processBankStatement, extractCompanyInfo, extractBankInfo } from '../lib/bank-ocr';
import { fuzzyMatchCompany, matchBankName, resolveStatementBankName } from '../lib/company-matcher';
import { resolveDirection, extractAcName } from '../lib/direction-resolver';
import { extractPrintedTotal } from '../lib/printed-total';
import { buildTextFromItems } from '../lib/pdf-layout';
import { reconcileDirections } from '../lib/balance-reconcile';
import { generateStatementJournalEntries } from '../lib/bank-journal';
import { llmCompleteJson, llmKeysFromEnv, hasLlmKey, type LlmKeys } from '../lib/llm-parse';
import { buildFileLinks } from '../lib/manual-booking';
import { buildFileListSql } from '../lib/list-filters';

// Audit logging helper
async function auditLog(db: any, userId: string, action: string, entityType: string, entityId: string | null, changes?: object) {
  try {
    await db.prepare(
      'INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, changes) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(`al-${uuidv4().slice(0,8)}`, userId, action, entityType, entityId, changes ? JSON.stringify(changes) : null).run();
  } catch { /* never block main flow for audit errors */ }
}

// Bank name detection fallback from OCR text and/or filename.
// Uses fuzzy HK bank alias map for comprehensive matching (English + Chinese, acronyms).
function inferBankName(...texts: (string | null | undefined)[]): string | null {
  for (const t of texts) {
    if (!t) continue;
    const m = matchBankName(t);
    if (m) return m;
  }
  return null;
}

// Account number detection fallback from OCR text.
// (Lily issue #6 — account number not detected.)
function inferAccountNumber(ocrText: string | null | undefined): string | null {
  if (!ocrText) return null;
  const m = ocrText.match(/\b\d{3,4}[- ]\d{1,10}[- ]\d{1,4}\b/);
  return m ? m[0].replace(/\s/g, '-') : null;
}

// Shared import: file_record → bank_statement + bank_transactions
async function importStatementFromFile(
  fileId: string, userId: string, db: D1Database, fileBucket: R2Bucket, ai: any, llmKeys: LlmKeys, glmApiKey?: string,
): Promise<{ success: boolean; statement_id?: string; error?: string; transactions_count?: number; parsed_via_ai?: boolean; parse_failed?: boolean; ai_provider?: string | null; ocr_failed?: boolean; duplicate_info?: { type?: string; bank_name: string | null; period: string | null; file_name: string | null }; usage?: any; glm_usage?: any; deepseek_raw?: string | null; ocr_source?: string; is_duplicate?: boolean; duplicate_status?: string | null; duplicate_existing_id?: string | null; duplicate_blocked?: boolean; needs_review?: boolean; balance_check?: any; balance_status?: string }> {
  let glmUsage: any = null; // hoisted above the GLM fallback (TDZ fix 2026-08-17)

  const fileRow = await db.prepare(
    'SELECT id, r2_key, filename, original_name, file_type, ocr_text, ocr_status, category, content_hash FROM file_records WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(fileId, userId).first<{ id: string; r2_key: string; filename: string; original_name: string; file_type: string; ocr_text: string; ocr_status: string; category: string; content_hash: string | null }>();
  if (!fileRow) return { success: false, error: 'File not found' };

  // Check for duplicate: active first, then soft-deleted.
  // Two signals: (1) exact r2_key reuse — only happens when the SAME file_record
  // is imported twice; each new upload gets a fresh r2_key, so (2) content_hash
  // matching is what actually catches re-uploading the same statement file.
  let isDuplicate = false, duplicateStatus: string | null = null, duplicateExistingId: string | null = null;
  const existingActive = await db.prepare(
    'SELECT id, bank_name, period_start, period_end, file_name FROM bank_statements WHERE user_id = ? AND r2_key = ? AND deleted_at IS NULL'
  ).bind(userId, fileRow.r2_key).first<{ id: string; bank_name: string | null; period_start: string | null; period_end: string | null; file_name: string | null }>();
  if (existingActive) {
    isDuplicate = true;
    duplicateStatus = 'active';
    duplicateExistingId = existingActive.id;
  } else {
    const existingDeleted = await db.prepare(
      'SELECT id FROM bank_statements WHERE user_id = ? AND r2_key = ? AND deleted_at IS NOT NULL'
    ).bind(userId, fileRow.r2_key).first<{ id: string }>();
    if (existingDeleted) {
      isDuplicate = true;
      duplicateStatus = 'deleted';
      duplicateExistingId = existingDeleted.id;
    }
  }
  if (!isDuplicate && fileRow.content_hash) {
    // Same bytes uploaded before under a different r2_key → find that upload's
    // LIVE statement (draft or active): importing again would multiply its data.
    const hashDup = await db.prepare(
      `SELECT bs.id FROM bank_statements bs
       JOIN file_records fr ON fr.user_id = bs.user_id AND fr.r2_key = bs.r2_key AND fr.deleted_at IS NULL
       WHERE bs.user_id = ? AND bs.deleted_at IS NULL AND fr.content_hash = ?
       ORDER BY bs.created_at DESC LIMIT 1`
    ).bind(userId, fileRow.content_hash).first<{ id: string }>();
    if (hashDup) {
      isDuplicate = true;
      duplicateStatus = 'active';
      duplicateExistingId = hashDup.id;
    }
  }
  // A live statement for this exact content already exists — never create a
  // second copy of its transactions/JEs. Point the caller at the existing one.
  if (isDuplicate && duplicateStatus === 'active' && duplicateExistingId) {
    return {
      success: true,
      statement_id: duplicateExistingId,
      transactions_count: 0,
      parsed_via_ai: false,
      ocr_source: 'tomarkdown',
      is_duplicate: true,
      duplicate_status: 'active',
      duplicate_existing_id: duplicateExistingId,
      duplicate_blocked: true,
      needs_review: false,
      balance_check: null,
      balance_status: 'ok',
      usage: null,
      glm_usage: null,
      deepseek_raw: null,
    };
  }

  // Get OCR text from file record or run GLM-OCR
  let ocrText = fileRow.ocr_text || '';
  if (!ocrText || ocrText.length < 20) {
    if (glmApiKey) {
      try {
        const mimeType = fileRow.file_type || 'application/pdf';
        const decryptedFile = await fetchAndDecryptFile(fileRow.r2_key, mimeType, fileBucket);
        if (decryptedFile?.base64) {
          console.log('[GLM-OCR|debug] Calling, mime:', mimeType);
          const glmResp = await fetch('https://api.z.ai/api/paas/v4/layout_parsing', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${glmApiKey}` },
            body: JSON.stringify({ model: 'glm-ocr', file: `data:${mimeType};base64,${decryptedFile.base64}` }),
          });
          console.log('[GLM-OCR|debug] Response status:', glmResp.status);
          if (glmResp.ok) {
            const glmData = await glmResp.json() as any;
            glmUsage = glmData.usage || null;
            ocrText = typeof glmData === 'string' ? glmData : JSON.stringify(glmData);
            console.log('[GLM-OCR|debug] Text length:', ocrText.length, 'preview:', ocrText.slice(0, 200));
          } else {
            const errBody = await glmResp.text();
            console.log('[GLM-OCR|debug] Error body:', errBody.slice(0, 500));
          }
        }
      } catch (e: any) {
        console.log('[GLM-OCR|debug] Exception:', e?.message || String(e));
      }
      if (ocrText) {
        await db.prepare("UPDATE file_records SET ocr_text = ?, ocr_status = 'completed', updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL").bind(ocrText, fileId).run();
      }
    }
  }

  if (!ocrText || ocrText.length < 10) {
    // OCR could not read the file. Instead of returning an error (which makes the
    // frontend hang on "Processing…"), create an EMPTY draft statement so the user
    // is taken to the review page and can enter transactions manually.
    // (Lily issues #14, #15, #16 — blurry / random / near-empty files hung forever.)
    const emptyId = `bs-${crypto.randomUUID().slice(0, 8)}`;
    const inferredBank = inferBankName(fileRow.original_name || fileRow.filename || '');
    await db.prepare(
      `INSERT INTO bank_statements (id, user_id, file_name, r2_key, bank_name, currency, status,
       opening_balance, closing_balance, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'HKD', 'draft', 0, 0, datetime('now'), datetime('now'))`
    ).bind(emptyId, userId, String(fileRow.original_name || fileRow.filename || 'statement.pdf'), String(fileRow.r2_key || ''), inferredBank || null).run();
    return {
      success: true,
      statement_id: emptyId,
      ocr_failed: true,
      error: 'Could not read this file automatically — please enter transactions manually on the review page.',
    };
  }

  // Parse via the Qwen-first LLM chain (was DeepSeek-only — the DeepSeek balance
  // ran out 2026-08-26 and its silent failures created empty statements) —
  // with GLM-OCR retry on balance failure
  let parsed: any = null;
  let usage: any = null;
  let parseProvider: string | null = null;
  let ocrSource: 'tomarkdown' | 'glm-ocr' | 'pdf-text' = 'tomarkdown';

  const tryLlmParse = async (inputOcrText: string, ocrLabel: string): Promise<any> => {
    if (!hasLlmKey(llmKeys)) return null;
    console.log(`[PARSE-BANK|${ocrLabel}] Sending to LLM chain, OCR text length: ${inputOcrText.length}`);
    const prompt = `Parse the following bank statement OCR text into structured JSON. Extract:
- bank_name: the bank name
- account_number: account number if visible
- currency: default "HKD"
- statement_year and statement_month: from statement period
- period_start and period_end: dates in YYYY-MM-DD
- opening_balance and closing_balance: numbers (opening is the starting balance, closing is the ending balance, for the statement as a whole)
- transactions: array of { transaction_date (YYYY-MM-DD), description, deposit_amount (number, 0 if withdrawal), withdrawal_amount (number, 0 if deposit), balance (number or null), account_type (string or null) }

IMPORTANT — some statements (especially HSBC Business Direct) contain MORE THAN ONE sub-account in the same document, e.g. a "HKD Current" section and a separate "HKD Savings" section, each with its OWN "B/F BALANCE" row and its own running balance column. Treat each such section as a separate ledger:
- Set "account_type" on every transaction to the name of the sub-account/section heading it belongs to (e.g. "HKD Current", "HKD Savings"). Use the exact section heading text from the statement.
- Always include the "B/F BALANCE" row itself as the first transaction of each sub-account (deposit_amount 0, withdrawal_amount 0, balance = the stated opening balance for that sub-account). This row anchors that sub-account's running balance.
- If the statement only has a single account/ledger, set account_type to null for all transactions (or a single consistent value).
- Never mix rows from different sub-accounts into one running sequence — keep them tagged separately via account_type.

IMPORTANT — banks (especially HSBC) often print SEVERAL transaction lines on the same date as one batch, but only print the running "Balance" figure once, next to the LAST line of that batch — the earlier lines in the batch have a blank/empty balance column. This does NOT mean those earlier lines should be skipped, merged into the next line, or given that later line's balance:
- Output EVERY transaction line as its own separate row in "transactions", in the exact order they appear on the statement, even if several rows share the same date and same description prefix.
- If a line has no balance figure printed directly next to it, set that row's "balance" to null. Do NOT copy/borrow the balance from a later or earlier line, and do NOT combine two lines' deposit/withdrawal amounts into a single row.
- Only set "balance" to a number when that exact figure is printed on that exact line.

IMPORTANT — deciding whether a line's amount is a deposit or a withdrawal:
- Judge ONLY by which column (Deposit vs Withdrawal) the number is printed under / aligned with in the original layout. Never infer it from wording in the description such as "CR", "CR TO", "credit", "DR", "debit", etc.
- For HTML tables: read each <td> position relative to the header row (columns: Date | Details | Deposit | Withdrawal | Balance). An amount in the Deposit column = deposit_amount. An amount in the Withdrawal column = withdrawal_amount.
- For [L]/[M]/[R] tagged text: [L]=left columns (date/description), [M]=middle columns, [R]=right columns (Deposit/Withdrawal/Balance). Cross-reference with HTML tables for column mapping.
- A figure printed with a trailing "DR" suffix directly attached to it (e.g. "10,500.00DR") means the running balance is NEGATIVE. Parse it as a negative number.
- Self-check: keep a running total from B/F BALANCE and verify against every printed balance checkpoint. If it doesn't reconcile, you've swapped a deposit/withdrawal — correct it before returning JSON.

Return ONLY valid JSON, no explanation. If you can't parse something, use null.

OCR TEXT:
${inputOcrText.slice(0, 8000)}`;
    const result = await llmCompleteJson(llmKeys, prompt, `bank:${ocrLabel}`);
    if (result.parsed) parseProvider = result.provider;
    return result.parsed;
  };

  // ── Dual-path: try both stored OCR + toMarkdown (pdftotext gated for future) ──
  // When a Docker host runs pdftotext and stores output in file_records.ocr_text,
  // set ENABLE_PDFTOTEXT_DUAL_PATH to true to activate dual-path comparison.
  const ENABLE_PDFTOTEXT_DUAL_PATH = true;
  let pdftotextOcrText = '';
  if (ENABLE_PDFTOTEXT_DUAL_PATH && hasLlmKey(llmKeys)) {
    // Path A: the existing stored OCR text (could be pdftotext from Docker worker, or toMarkdown)
    try { parsed = await tryLlmParse(ocrText, 'tomarkdown'); } catch {}
    if (parsed) usage = (parsed as any)._usage;

    // Path B (if available): check if file has pdftotext output from Docker worker.
    // pdftotext output doesn't start with '#' (toMarkdown) or '{' (GLM-JSON).
    // If the stored OCR is already pdftotext, Path A used it; run toMarkdown as Path B.
    const isStoredPdftotext = ocrText && ocrText.length > 200 && ocrText[0] !== '#' && ocrText[0] !== '{';
    if (isStoredPdftotext && parsed) {
      // Stored OCR is pdftotext → run toMarkdown for comparison via file bucket
      try {
        const obj = await fileBucket.get(fileRow.r2_key);
        if (obj && (ai as any)?.toMarkdown) {
          const buffer = await obj.arrayBuffer();
          const mdResult = await (ai as any).toMarkdown([{ name: fileRow.original_name || 'file.pdf', blob: new Blob([buffer], { type: 'application/pdf' }) }]);
          const tmText = Array.isArray(mdResult) ? mdResult.map((r: any) => r?.data || r?.content || '').join('\n') : String(mdResult || '');
          if (tmText.length > 20) pdftotextOcrText = ocrText; // save pdftotext for reference
          const tmParsed = await tryLlmParse(tmText, 'tomarkdown-dualpath');
          if (tmParsed?.transactions?.length > 0) {
            // Quick balance check to compare paths
            const origTxs = parsed.transactions || [];
            const origDep = origTxs.reduce((s: number, t: any) => s + (Number(t.deposit_amount) || 0), 0);
            const origWit = origTxs.reduce((s: number, t: any) => s + (Number(t.withdrawal_amount) || 0), 0);
            const origOk = parsed.closing_balance == null || Math.abs((parsed.opening_balance ?? 0) + origDep - origWit - parsed.closing_balance) <= 0.01;

            const tmTxs = tmParsed.transactions || [];
            const tmDep = tmTxs.reduce((s: number, t: any) => s + (Number(t.deposit_amount) || 0), 0);
            const tmWit = tmTxs.reduce((s: number, t: any) => s + (Number(t.withdrawal_amount) || 0), 0);
            const tmOk = tmParsed.closing_balance == null || Math.abs((tmParsed.opening_balance ?? 0) + tmDep - tmWit - tmParsed.closing_balance) <= 0.01;

            // If toMarkdown passes balance but pdftotext doesn't, use toMarkdown
            if (tmOk && !origOk && tmParsed.transactions.length > 0) {
              console.log('[DUAL-PATH|tomarkdown] Passed balance check, pdftotext failed — choosing toMarkdown');
              parsed = tmParsed;
              ocrText = tmText;
              ocrSource = 'tomarkdown';
            }
          }
        }
      } catch (e: any) { console.log('[DUAL-PATH|tomarkdown] Comparison error:', e?.message || String(e)); }
    }
  }

  // Pre-check balance: if result looks wrong, retry with GLM-OCR
  if (parsed && glmApiKey && (parsed.opening_balance != null) && (parsed.closing_balance != null)) {
    const txs = parsed.transactions || [];
    const preTotalDep = txs.reduce((s: number, t: any) => s + (Number(t.deposit_amount) || 0), 0);
    const preTotalWit = txs.reduce((s: number, t: any) => s + (Number(t.withdrawal_amount) || 0), 0);
    const preComputed = (parsed.opening_balance ?? 0) + preTotalDep - preTotalWit;
    const balanceMismatched = Math.abs(preComputed - parsed.closing_balance) > 0.01;

    if (balanceMismatched) {
      console.log(`[RETRY|tomarkdown→GLM] Balance MISMATCH (computed=${preComputed} stated=${parsed.closing_balance}), triggering GLM-OCR retry...`);
      try {
        const obj = await fileBucket.get(fileRow.r2_key);
        if (obj) {
          const buffer = await obj.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          const base64 = btoa(binary);
          const mimeType = fileRow.file_type || 'application/pdf';

          // GLM-OCR with rate-limit retry (up to 3 attempts, 3s/6s/9s delays)
          let glmResp: Response | null = null;
          for (let glmAttempt = 0; glmAttempt < 3; glmAttempt++) {
            if (glmAttempt > 0) {
              const delay = glmAttempt * 3000;
              console.log(`[RETRY|GLM-OCR] Rate-limited (429), waiting ${delay}ms before retry ${glmAttempt + 1}/3...`);
              await new Promise(r => setTimeout(r, delay));
            }
            glmResp = await fetch('https://api.z.ai/api/paas/v4/layout_parsing', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${glmApiKey}` },
              body: JSON.stringify({ model: 'glm-ocr', file: `data:${mimeType};base64,${base64}` }),
            });
            if (glmResp.status !== 429) break;
            console.log(`[RETRY|GLM-OCR] 429 rate limited, attempt ${glmAttempt + 1}/3`);
          }

          if (glmResp && glmResp.ok) {
            const glmData = await glmResp.json() as any;
            glmUsage = glmData.usage || null;

            // Build new positional format: HTML tables + [L/M/R] column tags
            const pages = glmData?.layout_details || [];
            const newParts: string[] = [];
            for (const p of pages) {
              for (const el of p) {
                if (el.label === 'table' && el.content) {
                  newParts.push(el.content); // HTML table with column structure preserved
                } else if (el.label === 'text' && el.content) {
                  const x = el.bbox_2d?.[0] || 0;
                  const col = x < 600 ? 'L' : x < 1200 ? 'M' : 'R';
                  newParts.push(`[${col}] ${el.content}`);
                }
              }
              newParts.push('');
            }
            const glmFormatted = newParts.join('\n').trim();

            if (glmFormatted.length > 20) {
              console.log('[RETRY|GLM-OCR] Formatted positional output, length:', glmFormatted.length);
              const retryParsed = await tryLlmParse(glmFormatted, 'glm-ocr');
              if (retryParsed?.transactions?.length > 0) {
                // Re-validate balance on retry
                const retryTxs = retryParsed.transactions || [];
                const retryTotalDep = retryTxs.reduce((s: number, t: any) => s + (Number(t.deposit_amount) || 0), 0);
                const retryTotalWit = retryTxs.reduce((s: number, t: any) => s + (Number(t.withdrawal_amount) || 0), 0);
                const retryComputed = (retryParsed.opening_balance ?? 0) + retryTotalDep - retryTotalWit;
                const retryOk = retryParsed.closing_balance == null || Math.abs(retryComputed - retryParsed.closing_balance) <= 0.01;

                console.log(`[DS-BANK|glm-ocr] Balance check: computed=${retryComputed} stated=${retryParsed.closing_balance} ok=${retryOk}`);

                if (retryOk) {
                  // GLM-OCR retry passed — use this result
                  parsed = retryParsed;
                  ocrText = glmFormatted; // update OCR text to GLM format
                  ocrSource = 'glm-ocr';
                  // Store the improved OCR text for future use
                  await db.prepare("UPDATE file_records SET ocr_text = ?, ocr_status = 'completed', updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL")
                    .bind(glmFormatted.slice(0, 50000), fileId).run();
                } else {
                  console.log('[RETRY|GLM-OCR] Balance also failed, keeping toMarkdown result flagged as draft');
                }
              }
            }
          }
        }
      } catch (e: any) {
        console.log('[RETRY|GLM-OCR] Error:', e?.message || String(e));
      }
    }
  }
  const deepseekRaw = parsed ? JSON.stringify(parsed).slice(0, 3000) : null;

  const stmtId = `bs-${uuidv4().slice(0, 8)}`;
  // Bank name: prefer AI parse, else infer from OCR text + filename (Lily #1, #9).
  // Canonicalized so every statement of the same account stores ONE name
  // ('HSBC Business Direct' / full legal name / 'HSBC' all → 'HSBC').
  const bankName = resolveStatementBankName(
    parsed?.bank_name,
    ocrText,
    fileRow.original_name || fileRow.filename,
  );
  // Account number: prefer AI parse, else infer from OCR text (Lily #6)
  const accountNumber = parsed?.account_number
    || inferAccountNumber(ocrText)
    || null;
  const currency = parsed?.currency || 'HKD';
  const stmtYear = parsed?.statement_year || null;
  const stmtMonth = parsed?.statement_month || null;
  const periodStart = parsed?.period_start || null;
  const periodEnd = parsed?.period_end || null;
  const openingBal = parsed?.opening_balance ?? null;
  const closingBal = parsed?.closing_balance ?? null;

  // Period+account duplicate check: same bank + account + month = same statement
  // (catches different scanners producing different files of the same document)
  if (!isDuplicate && bankName && accountNumber && stmtYear && stmtMonth) {
    const periodDup = await db.prepare(
      `SELECT id FROM bank_statements
       WHERE user_id = ? AND bank_name = ? AND account_number = ?
       AND statement_year = ? AND statement_month = ? AND id != ?
       AND deleted_at IS NULL LIMIT 1`
    ).bind(userId, bankName, accountNumber, stmtYear, stmtMonth, 'none').first<{ id: string }>();
    if (periodDup) {
      isDuplicate = true;
      duplicateStatus = 'active';
      if (!duplicateExistingId) duplicateExistingId = periodDup.id;
    }
  }

  // ── Insert bank statement first (FK constraint: transactions reference this) ──
  // Start with a tentative status; we'll UPDATE after validating balance
  await db.prepare(
    `INSERT INTO bank_statements (id, user_id, file_name, file_type, r2_key,
     bank_name, account_number, currency,
     statement_year, statement_month, period_start, period_end,
     opening_balance, closing_balance, ocr_text, ocr_source, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(stmtId, userId, String(fileRow.original_name || fileRow.filename || 'statement.pdf'), String(fileRow.file_type || 'application/pdf'),
    String(fileRow.r2_key || ''), String(bankName || ''), String(accountNumber || ''), String(currency || 'HKD'),
    stmtYear || null, stmtMonth || null, periodStart || null, periodEnd || null,
    typeof openingBal === 'number' ? openingBal : null, typeof closingBal === 'number' ? closingBal : null, String(ocrText || ''),
    ocrSource, 'active'  // tentative — will update after balance check
  ).run();

  let txCount = 0;
  // Reconcile directions against the printed running-balance anchors before insert
  const transactions = reconcileDirections(parsed?.transactions || [], openingBal, closingBal);
  for (const tx of transactions) {
    if (!tx.transaction_date) continue;
    const txId = `bt-${uuidv4().slice(0, 8)}`;
    await db.prepare(
      `INSERT INTO bank_transactions (id, bank_statement_id, user_id, transaction_date, description,
       deposit_amount, withdrawal_amount, balance, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(txId, stmtId, userId, String(tx.transaction_date || ''), String(tx.description || ''),
      Number(tx.deposit_amount || 0), Number(tx.withdrawal_amount || 0), typeof tx.balance === 'number' ? tx.balance : null, txCount
    ).run();
    txCount++;
  }

  // ── Balance validation: verify opening + deposits - withdrawals = closing ──
  const totalDeposits = transactions.reduce((s: number, tx: any) => s + (Number(tx.deposit_amount) || 0), 0);
  const totalWithdrawals = transactions.reduce((s: number, tx: any) => s + (Number(tx.withdrawal_amount) || 0), 0);
  const computedClosing = (openingBal ?? 0) + totalDeposits - totalWithdrawals;
  let balanceOk = true;
  let balanceMismatch: { expected: number; actual: number; diff: number } | null = null;
  if (openingBal != null && closingBal != null && txCount > 0 && Math.abs(computedClosing - closingBal) > 0.01) {
    balanceOk = false;
    balanceMismatch = { expected: computedClosing, actual: closingBal, diff: closingBal - computedClosing };
  }

  // Update status and balance info after transactions are in.
  // Defense-in-depth: a TOTAL parse failure used to silently create an ACTIVE
  // statement with zero transactions (eStatement202603 incident, 2026-08-26) —
  // now it lands as a draft the user can review/enter manually.
  const finalStatus = (parsed == null || (!balanceOk && txCount > 0)) ? 'draft' : 'active';
  console.log(`[IMPORT-BANK] stmtId=${stmtId} userId=${userId} txCount=${txCount} openingBal=${openingBal} closingBal=${closingBal} computedClosing=${computedClosing} balanceOk=${balanceOk} finalStatus=${finalStatus} ocrSource=${ocrSource}`);
  await db.prepare(
    `UPDATE bank_statements SET status = ?, balance_status = ?, balance_check = ?, updated_at = datetime('now')
     WHERE id = ? AND user_id = ?`
  ).bind(finalStatus, balanceOk ? 'ok' : 'mismatch',
    balanceMismatch ? JSON.stringify(balanceMismatch) : null,
    stmtId, userId).run();
  // Verify the row exists
  const verify = await db.prepare('SELECT id, status FROM bank_statements WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .bind(stmtId, userId).first();
  console.log(`[IMPORT-BANK-VERIFY] stmtId=${stmtId} found=${!!verify} status=${(verify as any)?.status || 'N/A'}`);

  await db.prepare(
    "UPDATE file_records SET category = 'bank_statement', folder = 'Bank Statements', updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL"
  ).bind(fileId).run();

  // Resolve + persist this statement's COA bank account (11102 HSBC / 11103 other)
  let stmtBankCode = '11103';
  try {
    const stmtRow = await db.prepare(
      'SELECT bank_name, account_code FROM bank_statements WHERE id = ? AND user_id = ?'
    ).bind(stmtId, userId).first<{ bank_name: string | null; account_code: string | null }>();
    stmtBankCode = stmtRow?.account_code || await resolveBankAccountCode(db, userId, stmtRow?.bank_name);
    if (!stmtRow?.account_code) {
      await db.prepare(
        "UPDATE bank_statements SET account_code = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
      ).bind(stmtBankCode, stmtId, userId).run();
    }
  } catch { /* non-critical */ }

  // Auto-categorize transactions via the shared engine
  let autoCategorized = 0;
  try {
    const txs = await db.prepare(
      'SELECT id, description, deposit_amount, invoice_id, match_status FROM bank_transactions WHERE bank_statement_id = ? AND account_code IS NULL AND deleted_at IS NULL'
    ).bind(stmtId).all();

    for (const tx of txs.results as any[]) {
      const dir = (tx.deposit_amount > 0 ? 'deposit' : 'withdrawal') as 'deposit' | 'withdrawal';
      const r = categorizeTransaction(tx.description || '', dir);
      if (!r) continue;
      if (r.code === '') {
        // Opening balances / internal transfers: never require an invoice link
        if (r.tag === 'ignore') {
          await db.prepare("UPDATE bank_transactions SET match_status = 'not_required', is_edited = 1 WHERE id = ? AND deleted_at IS NULL").bind(tx.id).run();
        }
        continue;
      }
      // Credit interest can never link to an invoice — auto-N/A the link when unmatched
      const naLink = r.tag === 'interest_income' && !tx.invoice_id && (!tx.match_status || tx.match_status === 'unmatched');
      await db.prepare(`UPDATE bank_transactions SET account_code = ?${naLink ? ", match_status = 'not_required'" : ''} WHERE id = ? AND deleted_at IS NULL`).bind(r.code, tx.id).run();
      autoCategorized++;
    }
  } catch { /* non-critical */ }

  // Auto-fill company & bank profile from first bank statement if empty
  try {
    const text = fileRow.ocr_text || ocrText || '';
    if (text.length > 100) {
      const company = extractCompanyInfo(text);
      const bank = extractBankInfo(text);

      const existing = await db.prepare(
        'SELECT name, address, bank_name, bank_account FROM company_settings WHERE user_id = ?'
      ).bind(userId).first<{ name: string; address: string | null; bank_name: string; bank_account: string }>();

      const sets: string[] = [];
      const params: any[] = [];

      if (company.name && (!existing?.name || existing.name === 'OPCC CRM' || !existing?.name)) {
        sets.push('name = ?, legal_name = ?');
        params.push(company.name, company.name);
      }
      if (company.address && (!existing?.address || !existing.address?.trim() || existing.address === 'Hong Kong')) {
        sets.push('address = ?');
        params.push(company.address);
      }
      if (company.address2) {
        sets.push('address2 = ?');
        params.push(company.address2);
      }
      if (bank.bank_name && !existing?.bank_name) {
        sets.push('bank_name = ?');
        params.push(bank.bank_name);
      }
      if (bank.account_number && !existing?.bank_account) {
        sets.push('bank_account = ?');
        params.push(bank.account_number);
      }

      if (sets.length > 0) {
        sets.push("updated_at = datetime('now')");
        params.push(userId);
        await db.prepare(`UPDATE company_settings SET ${sets.join(', ')} WHERE user_id = ?`).bind(...params).run();
      }
    }
  } catch { /* non-critical */ }

  // Auto-generate journal entries ONLY when the import lands ACTIVE.
  // Draft statements (balance mismatch / needs review) post on confirm instead —
  // posting before review was the root cause of duplicate-entry pile-ups when
  // users re-uploaded the same statement while fighting a failing review.
  let created = 0;
  let skippedTransfers = 0;
  if (finalStatus === 'active') {
    try {
      const gen = await generateStatementJournalEntries(db, userId, stmtId);
      created = gen.created;
      skippedTransfers = gen.skippedTransfers;
    } catch { /* non-critical - auto-generation is best-effort */ }
  }

  return {
    success: true,
    statement_id: stmtId,
    transactions_count: txCount,
    auto_categorized: autoCategorized,
    bank_account_code: stmtBankCode,
    skipped_transfers: skippedTransfers,
    journal_entries_created: created,
    parsed_via_ai: !!parsed,
    parse_failed: parsed == null,
    ai_provider: parseProvider,
    usage,
    glm_usage: glmUsage,
    deepseek_raw: deepseekRaw,
    ocr_source: ocrSource,
    is_duplicate: isDuplicate,
    duplicate_status: duplicateStatus,
    duplicate_existing_id: duplicateExistingId,
    needs_review: !balanceOk && txCount > 0,
    balance_check: balanceMismatch,
    balance_status: balanceOk ? 'ok' : 'mismatch',
  };
}

// Extract readable text from GLM-OCR layout_parsing JSON response.
// GLM-OCR returns nested layout data like:
//   { pages: [{ elements: [{ type: "text", content: "TAX INVOICE" }, ...] }] }
// This extracts just the text content, joined as readable lines.
// Detect if OCR output is just PDF metadata (not real invoice text).
// toMarkdown sometimes produces metadata instead of text content for PDFs
// that lack extractable text layers. We want to fall through to GLM-OCR.
function isPdfMetadataOnly(text: string): boolean {
  if (!text || text.length < 30) return false;
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length === 0) return false;
  // Count metadata-like lines vs real content lines
  let metaLines = 0;
  let contentLines = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(#|##)\s/.test(trimmed) && /\.pdf$/i.test(trimmed)) { metaLines++; continue; }
    if (/^##\s*Metadata/i.test(trimmed)) { metaLines++; continue; }
    // Generic metadata key-value lines ("- Key=Value" or "- Key: Value") cover the
    // full toMarkdown metadata format (EncryptFilterName, CreationDate, ModDate, ...)
    if (/^-\s*[A-Za-z][A-Za-z0-9_]*\s*(=|:)/.test(trimmed)) { metaLines++; continue; }
    if (trimmed.length > 5) contentLines++;
  }
  // If metadata lines dominate and there's very little real content, it's metadata-only
  return metaLines >= 3 && contentLines < 3;
}

// ── PDF Decryption ─────────────────────────────────────────────────────────
// HSBC eStatements and similar bank PDFs use Standard encryption (V=1,R=2 or V=4,R=4)
// with an EMPTY password — the PDF viewer decrypts silently because there's no
// user password set. We replicate that decryption so GLM-OCR / Cloudflare AI
// receive readable content.

const PDF_PADDING_BYTES = new Uint8Array([
  0x28,0xBF,0x4E,0x5E,0x4E,0x75,0x8A,0x41,0x64,0x00,0x4E,0x56,0xFF,0xFA,0x01,0x08,
  0x2E,0x2E,0x00,0xB6,0xD0,0x68,0x3E,0x80,0x2F,0x0C,0xA9,0xFE,0x64,0x53,0x69,0x7A,
]);

function padPassword(pw: string): Uint8Array {
  const bytes = new Uint8Array(32);
  const encoder = new TextEncoder();
  const pwBytes = encoder.encode(pw);
  for (let i = 0; i < 32; i++) {
    bytes[i] = i < pwBytes.length ? pwBytes[i] : PDF_PADDING_BYTES[i - pwBytes.length];
  }
  return bytes;
}

// MD5 using Node.js crypto (nodejs_compat), with pure-JS fallback
// ── PDF text-layer extraction (pdfjs-dist, driven directly) ──
// unpdf's inlined serverless bundle crashes in workerd ("Cannot set
// properties of undefined (setting '_isSameOrigin')"), and pdf.js's fake
// worker relative import is not resolvable there either. So load
// pdfjs-dist directly and point it at a vendored worker entry — wrangler
// bundles files referenced via `new URL(..., import.meta.url)` as
// sub-worker entrypoints, and workerd supports the Worker constructor.

let lastPdfTextError: string | null = null;
let pdfJsMod: any = null;

async function getPdfJsModule(): Promise<any | null> {
  if (pdfJsMod) return pdfJsMod;
  try {
    pdfJsMod = await import('pdfjs-dist');
    return pdfJsMod;
  } catch (e: any) {
    lastPdfTextError = e?.message || String(e);
    return null;
  }
}

async function extractPdfTextWithPassword(
  pdfBytes: Uint8Array, password: string
): Promise<string | null> {
  const lib = await getPdfJsModule();
  if (!lib) return null;
  try {
    const doc = await lib.getDocument({ data: pdfBytes, password, disableAutoFetch: true, disableStream: true }).promise;
    const parts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      // Position-aware join: pdf.js fragments numbers ("3 4 , 2 00.00")
      parts.push(buildTextFromItems(tc.items.map((it: any) => ({
        str: it.str,
        x: it.transform?.[4] ?? 0,
        y: it.transform?.[5] ?? 0,
        width: it.width ?? 0,
        height: it.height ?? 10,
        hasEOL: !!it.hasEOL,
      }))));
    }
    const clean = parts.join('\n').trim();
    return clean.length > 20 ? clean : null;
  } catch (e: any) { lastPdfTextError = e?.message || String(e); return null; }
}

/**
 * Extract the text layer of a PDF (no password).
 * Free, deterministic — preferred over vision OCR for text-based PDFs.
 * Returns null for scans / encrypted PDFs / failures (caller falls back).
 */
async function extractPdfText(pdfBytes: Uint8Array): Promise<string | null> {
  const lib = await getPdfJsModule();
  if (!lib) return null;
  try {
    const doc = await lib.getDocument({ data: pdfBytes, disableAutoFetch: true, disableStream: true }).promise;
    const parts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      // Position-aware join: pdf.js fragments numbers ("3 4 , 2 00.00")
      parts.push(buildTextFromItems(tc.items.map((it: any) => ({
        str: it.str,
        x: it.transform?.[4] ?? 0,
        y: it.transform?.[5] ?? 0,
        width: it.width ?? 0,
        height: it.height ?? 10,
        hasEOL: !!it.hasEOL,
      }))));
    }
    const clean = parts.join('\n').trim();
    return clean.length > 20 ? clean : null;
  } catch (e: any) { lastPdfTextError = e?.message || String(e); return null; }
}

/**
 * Sanity check: does the extracted text look like a real invoice/statement
 * (has digits + invoice-like keywords), or is it scan garbage?
 */
function isMeaningfulPdfText(text: string): boolean {
  if (!text || text.length < 150) return false;
  if (!/\d/.test(text)) return false;
  return /(invoice|receipt|total|amount|a\/c|payment|statement|hk\$|\busd\b|rmb|deposit|withdrawal|balance)/i.test(text);
}

let nodeCrypto: any = null;
try { nodeCrypto = require('crypto'); } catch {}

function md5(data: Uint8Array): Uint8Array {
  if (nodeCrypto) {
    const hash = nodeCrypto.createHash('md5');
    hash.update(Buffer.from(data));
    return new Uint8Array(hash.digest());
  }
  // Pure-JS MD5 fallback
  function rotateLeft(x: number, n: number) { return (x << n) | (x >>> (32 - n)); }
  function toUint32(x: number) { return x >>> 0; }

  const msg = new Uint8Array(data.length + 72);
  msg.set(data);
  const origLen = data.length * 8;
  msg[data.length] = 0x80;
  const padLen = ((data.length + 8) % 64 <= 56) ? (56 - (data.length + 1) % 64) : (120 - (data.length + 1) % 64);
  for (let i = 0; i < 8; i++) {
    msg[data.length + 1 + padLen + i] = (origLen >>> (i * 8)) & 0xff;
  }
  const totalLen = data.length + 1 + padLen + 8;

  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;

  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const K = new Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000);

  for (let offset = 0; offset < totalLen; offset += 64) {
    const M = new Array(16);
    for (let i = 0; i < 16; i++) {
      M[i] = msg[offset + i*4] | (msg[offset + i*4 + 1] << 8) | (msg[offset + i*4 + 2] << 16) | (msg[offset + i*4 + 3] << 24);
    }
    let A = a, B = b, C = c, D = d;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5*i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3*i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7*i) % 16; }
      F = toUint32(F + A + K[i] + M[g]);
      A = D; D = C; C = B;
      B = toUint32(B + rotateLeft(F, S[i]));
    }
    a = toUint32(a + A); b = toUint32(b + B); c = toUint32(c + C); d = toUint32(d + D);
  }

  const result = new Uint8Array(16);
  const words = [a, b, c, d];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) result[i*4 + j] = (words[i] >>> (j*8)) & 0xff;
  }
  return result;
}

// Helper: find byte sequence in Uint8Array
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, startPos: number = 0): number {
  for (let i = startPos; i <= haystack.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { match = false; break; }
    }
    if (match) return i;
  }
  return -1;
}

// RC4 (ARC4) stream cipher — uses Node crypto if available, pure-JS fallback
function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (nodeCrypto) {
    try {
      const cipher = nodeCrypto.createCipheriv('rc4', Buffer.from(key), null);
      const result = Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]);
      return new Uint8Array(result);
    } catch {}
  }
  // Pure-JS fallback
  const s: number[] = [];
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  let a = 0, b = 0;
  const result = new Uint8Array(data.length);
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) & 0xff;
    b = (b + s[a]) & 0xff;
    [s[a], s[b]] = [s[b], s[a]];
    result[k] = data[k] ^ s[(s[a] + s[b]) & 0xff];
  }
  return result;
}

function parseEncryptDict(pdfBytes: Uint8Array): {
  v: number; r: number; o: Uint8Array; u: Uint8Array; p: number;
  length: number; encryptStart: number; id1: Uint8Array | null;
} | null {
  const text = new TextDecoder('latin1').decode(pdfBytes.slice(0, 6000));

  // Find the encrypt dict: look for /Type /Encrypt within a << ... >> block
  const encIdx = text.indexOf('/Type /Encrypt');
  if (encIdx < 0) return null;

  // Find the enclosing << and >>
  let openIdx = text.lastIndexOf('<<', encIdx);
  let closeIdx = text.indexOf('>>', encIdx);
  if (openIdx < 0 || closeIdx < 0 || openIdx >= closeIdx) return null;

  // Include the full << ... >> but exclude the delimiters
  const encSection = text.slice(openIdx + 2, closeIdx);

  const dictStr = encSection;

  // Extract V, R, O, U, P, Length from the encryption dict
  const vMatch = dictStr.match(/\/V\s+(\d+)/);
  const rMatch = dictStr.match(/\/R\s+(\d+)/);
  const pMatch = dictStr.match(/\/P\s+(-?\d+)/);
  const lenMatch = dictStr.match(/\/Length\s+(\d+)/);
  if (!vMatch || !rMatch || !pMatch) return null;

  const v = parseInt(vMatch[1]);
  const r = parseInt(rMatch[1]);
  const p = parseInt(pMatch[1]);
  const length = lenMatch ? parseInt(lenMatch[1]) : 40;

  // Extract O and U strings using Latin-1 text (1:1 byte-to-char mapping)
  // We work with the FULL Latin-1 decoded PDF so indexOf works on multi-char strings
  const latin1Full = new TextDecoder('latin1').decode(pdfBytes);

  function extractPdfString(fullText: string, keyName: string): Uint8Array | null {
    const keyWithParen = '/' + keyName + ' (';
    const idx = fullText.indexOf(keyWithParen);
    if (idx < 0) {
      // Try with newline variant: /O\n(
      const altIdx = fullText.indexOf('/' + keyName + '\n(');
      if (altIdx < 0) return null;
      return extractParenString(fullText, altIdx + keyName.length + 3); // skip "/O\n("
    }
    return extractParenString(fullText, idx + keyWithParen.length - 1); // position at the '('
  }

  function extractParenString(text: string, parenPos: number): Uint8Array | null {
    // parenPos points to '(' — parse balanced parens with PDF escape handling
    const bytes: number[] = [];
    let depth = 1;
    let pos = parenPos + 1; // skip opening '('
    while (pos < text.length && depth > 0) {
      let b = text.charCodeAt(pos); // Latin-1 char code = original byte value
      if (b === 0x5C && pos + 1 < text.length) { // backslash escape
        pos++;
        const esc = text.charCodeAt(pos);
        if (esc === 0x6E || esc === 0x6E) bytes.push(0x0A);      // \n
        else if (esc === 0x72 || esc === 0x72) bytes.push(0x0D);  // \r
        else if (esc === 0x74 || esc === 0x74) bytes.push(0x09);  // \t
        else if (esc === 0x62 || esc === 0x62) bytes.push(0x08);  // \b
        else if (esc === 0x66 || esc === 0x66) bytes.push(0x0C);  // \f
        else if (esc >= 0x30 && esc <= 0x37) {                    // \ddd octal
          let octal = String.fromCharCode(esc);
          if (pos + 1 < text.length && text.charCodeAt(pos+1) >= 0x30 && text.charCodeAt(pos+1) <= 0x37) {
            pos++; octal += text.charAt(pos);
          }
          if (pos + 1 < text.length && text.charCodeAt(pos+1) >= 0x30 && text.charCodeAt(pos+1) <= 0x37) {
            pos++; octal += text.charAt(pos);
          }
          bytes.push(parseInt(octal, 8));
        } else {
          bytes.push(text.charCodeAt(pos)); // escaped literal: \\, \), etc.
        }
      } else if (b === 0x29) { // close paren ')'
        depth--;
        if (depth === 0) break;
        bytes.push(b);
      } else {
        bytes.push(b);
      }
      pos++;
    }
    return bytes.length > 0 ? new Uint8Array(bytes) : null;
  }

  let o = extractPdfString(latin1Full, 'O');
  let u = extractPdfString(latin1Full, 'U');

  // Fallback: try hex format
  if (!o) {
    const oHex = dictStr.match(/\/O\s*<([0-9a-fA-F]+)>/);
    if (oHex) {
      o = new Uint8Array(oHex[1].length / 2);
      for (let i = 0; i < o.length; i++) o[i] = parseInt(oHex[1].substr(i*2, 2), 16);
    }
  }
  if (!u) {
    const uHex = dictStr.match(/\/U\s*<([0-9a-fA-F]+)>/);
    if (uHex) {
      u = new Uint8Array(uHex[1].length / 2);
      for (let i = 0; i < u.length; i++) u[i] = parseInt(uHex[1].substr(i*2, 2), 16);
    }
  }

  if (!o || !u) return null;

  // Extract first ID from the trailer's /ID array (at the END of PDF, not beginning)
  const trailerText = new TextDecoder('latin1').decode(pdfBytes.slice(Math.max(0, pdfBytes.length - 2000)));
  const idMatch = trailerText.match(/\/ID\s*\[\s*<([0-9a-fA-F]+)>/);
  let id1: Uint8Array | null = null;
  if (idMatch) {
    id1 = new Uint8Array(idMatch[1].length / 2);
    for (let i = 0; i < id1.length; i++) id1[i] = parseInt(idMatch[1].substr(i*2, 2), 16);
  }

  return { v, r, o, u, p, length, encryptStart: 0, id1 };
}

function needsDecryption(pdfBytes: Uint8Array): boolean {
  const header = new TextDecoder().decode(pdfBytes.slice(0, 500));
  return /\/Encrypt\s+\d+\s+0\s+R/.test(header) || /\/Type\s*\/Encrypt/.test(header);
}

async function tryDecryptPdf(pdfBytes: Uint8Array, password: string = ''): Promise<Uint8Array | null> {
  const dict = parseEncryptDict(pdfBytes);
  if (!dict) return null;

  console.log(`[PDF-DECRYPT] Found encrypted PDF V=${dict.v} R=${dict.r} P=${dict.p}`);

  try {
    // Compute encryption key per PDF spec (Algorithm 3.2)
    // For V=1/R=2: key = MD5(password_pad + O + P), NO file ID
    // For V>=4 or R>=4: key = MD5(password_pad + O + P + ID1)
    const includeId = dict.v >= 4 || dict.r >= 4;
    const keyInput = new Uint8Array(paddedPw.length + dict.o.length + 4 + (includeId && dict.id1 ? 16 : 0));
    keyInput.set(paddedPw, 0);
    keyInput.set(dict.o, paddedPw.length);

    // P as 4-byte little-endian (unsigned)
    const pBytes = new Uint8Array(4);
    pBytes[0] = dict.p & 0xff;
    pBytes[1] = (dict.p >>>8) & 0xff;
    pBytes[2] = (dict.p >>>16) & 0xff;
    pBytes[3] = (dict.p >>>24) & 0xff;
    keyInput.set(pBytes, paddedPw.length + dict.o.length);

    if (includeId && dict.id1) {
      keyInput.set(dict.id1.slice(0, 16), paddedPw.length + dict.o.length + 4);
    }

    const hash = md5(keyInput);
    const keyLen = Math.min(dict.length / 8 + 5, 16);
    const encKey = hash.slice(0, keyLen);

    // Try both key derivations: without file ID (R=2) and with file ID (R>=3)
    const keysToTry: Uint8Array[] = [encKey];
    if (dict.id1 && !includeId) {
      // Also try with file ID as fallback
      const altInput = new Uint8Array(paddedPw.length + dict.o.length + 4 + 16);
      altInput.set(paddedPw, 0);
      altInput.set(dict.o, paddedPw.length);
      altInput.set(pBytes, paddedPw.length + dict.o.length);
      altInput.set(dict.id1.slice(0, 16), paddedPw.length + dict.o.length + 4);
      const altHash = md5(altInput);
      keysToTry.push(altHash.slice(0, keyLen));
    }

    // Try each key — decrypt first stream, check for valid zlib header (0x78).
    // Use Latin-1 for byte-perfect round-trip with binary PDF data.
    const pdfText = new TextDecoder('latin1').decode(pdfBytes);
    const streamRegex = /(\d+\s+0\s+obj[\s\S]*?\/Length\s+\d+[\s\S]*?)\nstream\n([\s\S]*?)endstream/g;
    const firstMatch = streamRegex.exec(pdfText);
    let bestKey: Uint8Array | null = null;

    if (firstMatch) {
      const streamContent = firstMatch[2];
      const objMatch = firstMatch[1].match(/^(\d+)\s+0\s+obj/);
      const objNum = objMatch ? parseInt(objMatch[1]) : 0;
      const streamBytes = latin1ToBytes(streamContent);

      for (const key of keysToTry) {
        const streamKeyInput = new Uint8Array(key.length + 5);
        streamKeyInput.set(key, 0);
        streamKeyInput[key.length] = objNum & 0xff;
        streamKeyInput[key.length + 1] = (objNum >> 8) & 0xff;
        streamKeyInput[key.length + 2] = (objNum >> 16) & 0xff;
        const streamHash = md5(streamKeyInput);
        const streamKey = streamHash.slice(0, Math.min(key.length + 5, 16));
        const decryptedBytes = rc4(streamKey, streamBytes);
        // FlateDecode streams start with zlib header 0x78
        if (decryptedBytes.length > 2 && decryptedBytes[0] === 0x78) {
          bestKey = key;
          console.log('[PDF-DECRYPT] Key works — stream decrypts to valid zlib');
          break;
        }
      }
    }

    if (!bestKey) {
      console.log('[PDF-DECRYPT] No key produced readable stream content');
      return null;
    }

    // Helper: convert string to bytes preserving Latin-1 byte values
    function latin1ToBytes(s: string): Uint8Array {
      const bytes = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
      return bytes;
    }
    function bytesToLatin1(bytes: Uint8Array): string {
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return s;
    }

    // Decrypt all streams with the working key
    let decryptedPdf = pdfText;
    decryptedPdf = decryptedPdf.replace(/\/Encrypt\s+\d+\s+0\s+R/g, '');
    let result = decryptedPdf;
    const allStreams = decryptedPdf.matchAll(/(\d+\s+0\s+obj[\s\S]*?\/Length\s+\d+[\s\S]*?)\nstream\n([\s\S]*?)endstream/g);

    for (const match of allStreams) {
      const streamHeader = match[1];
      const streamContent = match[2];
      const streamStart = match.index! + match[1].length + 8;
      // Find the LAST object number before this stream position
      const beforeStream = decryptedPdf.slice(0, match.index);
      const allObjs = [...beforeStream.matchAll(/(\d+)\s+0\s+obj/g)];
      const objNum = allObjs.length > 0 ? parseInt(allObjs[allObjs.length - 1][1]) : 0;
      const isMetadata = streamHeader.includes('/Type /Metadata') || streamHeader.includes('/Type/Metadata');
      if (!isMetadata && streamContent.length > 0) {
        const streamBytes = latin1ToBytes(streamContent);
        const streamKeyInput = new Uint8Array(bestKey.length + 5);
        streamKeyInput.set(bestKey, 0);
        streamKeyInput[bestKey.length] = objNum & 0xff;
        streamKeyInput[bestKey.length + 1] = (objNum >> 8) & 0xff;
        streamKeyInput[bestKey.length + 2] = (objNum >> 16) & 0xff;
        const streamHash = md5(streamKeyInput);
        const streamKey = streamHash.slice(0, Math.min(bestKey.length + 5, 16));
        const decryptedBytes = rc4(streamKey, streamBytes);
        result = result.substring(0, streamStart) + new TextDecoder().decode(decryptedBytes) + result.substring(streamStart + streamContent.length);
      }
    }

    const resultBytes = latin1ToBytes(result);
    console.log(`[PDF-DECRYPT] Decrypted PDF, size: ${pdfBytes.length} → ${resultBytes.length} bytes`);
    return resultBytes;
  } catch (e: any) {
    console.log('[PDF-DECRYPT] Decryption error:', e?.message || e);
    return null;
  }
}

// ── End PDF Decryption ─────────────────────────────────────────────────────

// Helper: read file from R2, decrypt if encrypted, return base64 data-URI
// Returns { base64, needsPassword } — needsPassword=true means encrypted & empty-pw failed
async function fetchAndDecryptFile(
  r2Key: string, mimeType: string, fileBucket: R2Bucket
): Promise<{ base64: string; needsPassword: boolean } | null> {
  try {
    const obj = await fileBucket.get(r2Key);
    if (!obj) return null;
    const buffer = await obj.arrayBuffer();
    let bytes = new Uint8Array(buffer);
    let needsPassword = false;

    if (mimeType.includes('pdf') && needsDecryption(bytes)) {
      console.log(`[PDF-DECRYPT] Encrypted PDF detected for ${r2Key}, attempting decryption...`);
      const passwords = ['', 'hsbc', 'HSBC'];
      let decrypted: Uint8Array | null = null;
      for (const pw of passwords) {
        decrypted = await tryDecryptPdf(bytes, pw);
        if (decrypted) break;
      }
      if (decrypted) {
        bytes = decrypted;
      } else {
        needsPassword = true;
        console.log(`[PDF-DECRYPT] Decryption failed — PDF requires a user password`);
      }
    }

    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return { base64: btoa(binary), needsPassword };
  } catch (e: any) {
    console.log(`[PDF-DECRYPT] Error:`, e?.message || e);
    return null;
  }
}

// ── End PDF Helpers ────────────────────────────────────────────────────────

function extractTextFromGlmOcr(glmData: any): string {
  if (typeof glmData === 'string') return glmData;
  try {
    const parts: string[] = [];
    const pages = glmData?.pages || glmData?.data?.pages || [];
    for (const page of pages) {
      const elements = page?.elements || page?.text_blocks || page?.blocks || [];
      for (const el of elements) {
        const text = el?.content || el?.text || el?.value || '';
        if (text.trim()) parts.push(text.trim());
      }
      if (parts.length > 0 && parts[parts.length - 1] !== '') parts.push('');
    }
    // Remove trailing empty string
    while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
    const result = parts.join('\n').trim();
    if (result.length > 10) {
      console.log('[GLM-OCR|invoice] Extracted', parts.length, 'text elements,', result.length, 'chars');
      return result;
    }
    console.log('[GLM-OCR|invoice] Too little text, falling back to raw JSON');
    return JSON.stringify(glmData);
  } catch (e: any) {
    console.log('[GLM-OCR|invoice] Error extracting text:', e?.message || e);
    return JSON.stringify(glmData);
  }
}

// Shared import: file_record → invoice + invoice_items
async function importInvoiceFromFile(
  fileId: string, userId: string, db: D1Database, fileBucket: R2Bucket, ai: any, llmKeys: LlmKeys, glmApiKey?: string,
  directionOverride?: string | null,
): Promise<{ success: boolean; invoice_id?: string; error?: string; items_count?: number; ocr_failed?: boolean; parsed?: any; parse_failed?: boolean; ai_provider?: string | null; folder?: string; is_receipt?: boolean; receipt_number?: string | null; needs_direction_review?: boolean; company_not_detected?: boolean; total_mismatch?: any; discount_amount?: number; discount_description?: string; ocr_source?: string; usage?: any; glm_usage?: any; deepseek_raw?: string | null; is_duplicate?: boolean; duplicate_status?: string | null; duplicate_existing_id?: string | null; auto_linked_invoice_id?: string | null; new_counterparty?: boolean; direction?: string; duplicate_info?: any; needs_review?: boolean }> {
  const fileRow = await db.prepare(
    'SELECT id, r2_key, filename, original_name, file_type, ocr_text, ocr_text_source, ocr_status, category, direction FROM file_records WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(fileId, userId).first<{ id: string; r2_key: string; filename: string; original_name: string; file_type: string; ocr_text: string; ocr_text_source: string | null; ocr_status: string; category: string; direction: string }>();
  if (!fileRow) return { success: false, error: 'File not found' };

  let ocrSource: 'tomarkdown' | 'glm-ocr' | 'pdf-text' = 'tomarkdown';
  let glmUsage: any = null; // hoisted above the GLM fallback (TDZ fix 2026-08-17)
  let ocrText = fileRow.ocr_text || '';
  // OCR already ran upstream (import-document / try-decrypt) — honor its source.
  if (ocrText && ocrText.length >= 20 && (fileRow.ocr_text_source === 'pdf-text' || fileRow.ocr_text_source === 'glm-ocr' || fileRow.ocr_text_source === 'tomarkdown')) {
    ocrSource = fileRow.ocr_text_source;
  }
  if (!ocrText || ocrText.length < 20) {
    const obj = await fileBucket.get(fileRow.r2_key);
    if (obj) {
      const buffer = await obj.arrayBuffer();
      const mimeType = fileRow.file_type || 'application/pdf';

      // Attempt 0: pdf.js text-layer extraction (free, deterministic — best
      // for text-based PDFs like Pastel/VEII/EHSIA; scans fall through)
      if (mimeType === 'application/pdf') {
        try {
          const pdfText = await extractPdfText(new Uint8Array(buffer));
          if (pdfText && isMeaningfulPdfText(pdfText)) {
            ocrText = pdfText;
            ocrSource = 'pdf-text';
            console.log('[OCR|pdf-text] Invoice succeeded, length:', ocrText.length, 'preview:', ocrText.slice(0, 200));
          }
        } catch {}
      }

      // Attempt 1: GLM-OCR (best for scanned PDFs and images)
      if ((!ocrText || ocrText.length < 20) && glmApiKey) {
        try {
          const bytes = new Uint8Array(buffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          const base64 = btoa(binary);
          const glmResp = await fetch('https://api.z.ai/api/paas/v4/layout_parsing', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${glmApiKey}` },
            body: JSON.stringify({ model: 'glm-ocr', file: `data:${mimeType};base64,${base64}` }),
          });
          if (glmResp.ok) {
            const glmData = await glmResp.json() as any;
            glmUsage = glmData.usage || null;
            const candidate = extractTextFromGlmOcr(glmData);
            console.log('[OCR|GLM-OCR] Invoice result:', candidate.slice(0, 200));
            if (candidate && candidate.length > 20) { ocrText = candidate; ocrSource = 'glm-ocr'; }
          }
        } catch {}
      }

      // Attempt 2: Cloudflare AI Workers toMarkdown (works great on text-layer PDFs)
      if ((!ocrText || ocrText.length < 20) && ai) {
        try {
          const mdResult = await (ai as any).toMarkdown([{
            name: fileRow.original_name || fileRow.filename || 'invoice.pdf',
            blob: new Blob([buffer], { type: mimeType }),
          }]);
          const candidate = Array.isArray(mdResult) ? mdResult.map((r: any) => r?.data || r?.content || '').join('\n') : String(mdResult || '');
          if (candidate && candidate.length > 20) {
            if (isPdfMetadataOnly(candidate)) {
              console.log('[OCR|tomarkdown] Invoice: only PDF metadata, discarding for GLM-OCR');
            } else {
              ocrText = candidate;
              console.log('[OCR|tomarkdown] Invoice succeeded, length:', ocrText.length, 'preview:', ocrText.slice(0, 200));
            }
          }
        } catch {}
      }

      if (ocrText && ocrText.length >= 20) {
        await db.prepare("UPDATE file_records SET ocr_text = ?, ocr_text_source = ?, ocr_status = 'completed', updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL").bind(ocrText, ocrSource, fileId).run();
      }
    }
  }

  // If both OCR methods failed, create an empty pending_review invoice so the user
  // can enter the data manually on the review page — same pattern as bank statement OCR failure.
  if (!ocrText || ocrText.length < 20) {
    // Ensure a customer exists as placeholder
    let placeholderCustomerId: string | null = null;
    const placeholderCust = await db.prepare('SELECT id FROM customers WHERE user_id = ? ORDER BY created_at LIMIT 1').bind(userId).first<{ id: string }>();
    if (placeholderCust) {
      placeholderCustomerId = placeholderCust.id;
    } else {
      placeholderCustomerId = `c-${uuidv4().slice(0, 8)}`;
      await db.prepare('INSERT INTO customers (id, user_id, name, is_active) VALUES (?, ?, ?, 1)').bind(placeholderCustomerId, userId, 'Unknown Customer', true).run();
    }
    const emptyInvId = `i-${uuidv4().slice(0, 8)}`;
    const emptyInvNumber = `DRAFT-${Date.now().toString(36).toUpperCase()}`;
    await db.prepare(
      `INSERT INTO invoices (id, user_id, invoice_number, customer_id, status, issue_date, due_date, subtotal, total, currency, file_id, source)
       VALUES (?, ?, ?, ?, 'pending_review', date('now'), date('now', '+30 days'), 0, 0, 'HKD', ?, 'ocr')`
    ).bind(emptyInvId, userId, emptyInvNumber, placeholderCustomerId, fileId).run();
    await db.prepare("UPDATE file_records SET category = 'invoice', ocr_status = 'failed', updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL").bind(fileId).run();
    return { success: true, invoice_id: emptyInvId, items_count: 0, ocr_failed: true };
  }

  // Parse with DeepSeek AI
  // Detect if this is a payment receipt (not a sales invoice)
  // Signals: filename has 'receipt', OCR text contains 'RECEIPT #', 'received payment', etc.
  const originalName = (fileRow.original_name || fileRow.filename || '').toLowerCase();
  const isReceipt = /receipt/i.test(originalName) || /RECEIPT\s*#|we have received|payment received|hereby confirmed/i.test(ocrText);

  // ── Regex pre-extraction (runs before AI, used to validate/correct AI output) ──
  function regexExtractInvoiceParties(text: string): { letterheadVendor: string | null; billToCustomer: string | null } {
    // Extract the letterhead: first company-like name at the top, often followed by INVOICE or an address
    // Pattern: "COMPANY NAME LIMITED INVOICE" or "COMPANY NAME\nCity, Country\nINVOICE"
    const letterheadMatch = text.match(
      /^[#\s]*(?:##\s*Page\s*\d+\s*)?([A-Z][A-Z\s&.'-]{4,60}(?:LIMITED|LTD|INC|CORP|CORPORATION|COMPANY|GMBH|LLC|LLP|CO\.?|HOLDINGS|GROUP))\b/mi
    );
    const letterheadVendor = letterheadMatch ? letterheadMatch[1].trim() : null;

    // Extract the Bill To / Customer name — handle compact OCR where fields run together
    // e.g. "BILL TOXENUS TECHNOLOGY LIMITEDUnit 1201" → captures "XENUS TECHNOLOGY LIMITED"
    // Stop at lowercase-after-uppercase transition, digit, or common address words
    const billToMatch = text.match(
      /(?:BILL\s*TO|Bill\s*To:|Customer:|Attn:|To:)\s*\n?\s*([A-Z][A-Z\s&.'-]{4,60}(?:LIMITED|LTD|INC|CORP|CORPORATION|COMPANY|GMBH|LLC|LLP|CO\.?|HOLDINGS|GROUP)?)/mi
    );
    let billToCustomer: string | null = null;
    if (billToMatch) {
      let raw = billToMatch[1].trim();
      // Clean up: truncate at first lowercase-after-uppercase boundary (compact OCR artifact)
      // e.g. "XENUS TECHNOLOGY LIMITEDUnit" → "XENUS TECHNOLOGY LIMITED"
      const cleanup = raw.match(/^([A-Z][A-Z\s&.'-]{3,60}(?:LIMITED|LTD|INC|CORP|CORPORATION|COMPANY|GMBH|LLC|LLP|CO\.?|HOLDINGS|GROUP)?)/i);
      if (cleanup) raw = cleanup[1].trim();
      // Remove trailing artifacts like "Unit", "Tel", "Fax", "Email", etc.
      raw = raw.replace(/\s*(?:Unit|Tel|Fax|Email|Phone|Attn|Date|Issue|Due|Currency|Invoice|Total)\s*.*$/i, '').trim();
      if (raw.length > 2) billToCustomer = raw;
    }

    return { letterheadVendor, billToCustomer };
  }

  const regexParties = !isReceipt ? regexExtractInvoiceParties(ocrText) : { letterheadVendor: null, billToCustomer: null };
  console.log('[REGEX-PARTIES] letterheadVendor:', regexParties.letterheadVendor, '| billToCustomer:', regexParties.billToCustomer);

  let parsed: any = null;
  let usage: any = null;
  let parseProvider: string | null = null;
  if (hasLlmKey(llmKeys)) {
    try {
      const promptForReceipt = `Parse this PAYMENT RECEIPT into structured JSON. Extract:
- receipt_number: the receipt number (look for "RECEIPT #:" or "Receipt No:")
- invoice_number: the invoice number being paid (look for "Invoice #" in the body), or null
- customer_name: the company that ISSUED this receipt (the one who received the payment)
- payer_name: the company that MADE the payment (look for "issued by", "received from")
- issue_date: YYYY-MM-DD (the receipt date)
- currency: default "HKD"
- items: array of { description, quantity (default 1), unit_price (number), amount (number) } for each invoice/payment line
- total: the total amount received
- notes: any additional notes

Return ONLY valid JSON, no explanation. Use null for missing values.

OCR TEXT:
${ocrText.slice(0, 8000)}`;

      // Extract PDF metadata from toMarkdown output (Author is often the vendor)
      let metadataAuthor: string | null = null;
      const authorMatch = ocrText.match(/^- Author[=:]\s*(.+)$/m);
      if (authorMatch) metadataAuthor = authorMatch[1].trim();
      // Filter out non-company values (software names, generic strings)
      if (metadataAuthor && /^(Word|Microsoft|Adobe|macOS|Excel|PowerPoint|Pages|Numbers|Keynote|WPS|LibreOffice|Unknown|Writer|Calc)$/i.test(metadataAuthor)) {
        metadataAuthor = null;
      }

      // Build hints from PDF metadata + regex pre-extraction to guide the AI
      const hints: string[] = [];
      if (metadataAuthor && !isReceipt) {
        hints.push(`- PDF metadata Author field: "${metadataAuthor}" — this is almost certainly the vendor/issuer of this invoice.`);
      }
      if (!isReceipt && regexParties.letterheadVendor) {
        hints.push(`- The letterhead/issuer (vendor) at the top of the document appears to be: ${regexParties.letterheadVendor}`);
      }
      if (!isReceipt && regexParties.billToCustomer) {
        hints.push(`- The party being billed (customer) appears to be: ${regexParties.billToCustomer}`);
      }
      if (!isReceipt) {
        const acHint = extractAcName(ocrText);
        if (acHint) {
          hints.push(`- The bank "A/C Name" printed in the PAYMENT METHOD section is: ${acHint} — this is the bank account of the invoice ISSUER (the company being paid).`);
        }
      }
      if (hints.length > 0) {
        hints.push('- IMPORTANT: vendor_name MUST be the issuer (company that sent this bill), customer_name MUST be the party being billed.');
      }
      const hintBlock = hints.length > 0 ? `HINTS (use these to guide your extraction):\n${hints.join('\n')}\n\n` : '';

      const promptForInvoice = `${hintBlock}Parse this invoice OCR text into structured JSON. Extract:
- vendor_name: the company that ISSUED this invoice (the sender/supplier). If HINTS provide a PDF Author or letterhead vendor, use that. The vendor is the company that will receive payment. If you cannot determine the vendor name, use null — NEVER use "User", "Unknown", "N/A", or generic placeholder names.
- customer_name: the company being BILLED (the client/buyer). If HINTS provide a billed party, use that. The customer is the company that needs to pay this invoice. If you cannot determine the customer name, use null — NEVER use "User", "Unknown", or generic placeholder names.
- customer_email: optional customer email
- invoice_number: the invoice number/ID
- issue_date: YYYY-MM-DD
- due_date: YYYY-MM-DD if visible
- currency: default "HKD"
- items: array of { description, quantity (number — copy EXACTLY from PDF, if PDF shows 0 then quantity MUST be 0, NEVER change 0 to 1), unit_price (number), amount (number — if quantity is 0 then amount MUST be 0, copy total from PDF exactly) } for each product/service line item. Do NOT include discount/rebate lines here.
- discount_amount: any discount, rebate, or deduction applied (as a POSITIVE number, e.g. 1000 means $1,000 off). Look for lines labeled "Discount", "Rebate", "Less:", "Deduction", or where the total is less than the sum of line items. If no discount, use 0.
- discount_description: short description of the discount if present (e.g. "Early payment discount", "Promotional rebate"), or null
- total: the FINAL total amount AFTER all discounts (the amount actually to be paid)
- notes: any additional notes

Return ONLY valid JSON, no explanation. Use null for missing values.

OCR TEXT:
${ocrText.slice(0, 8000)}`;

      const result = await llmCompleteJson(llmKeys, isReceipt ? promptForReceipt : promptForInvoice, 'invoice:tomarkdown');
      parsed = result.parsed;
      parseProvider = result.provider;
    } catch {}
  }
  const deepseekRaw = parsed ? JSON.stringify(parsed).slice(0, 3000) : null;

  // ── Post-AI cleanup: filter out generic placeholder names ──
  if (parsed) {
    const isGenericName = (s: string | null | undefined) =>
      !s || /^(user|unknown|n\/a|none|someone|test|admin|client|customer|supplier|vendor)$/i.test(s.trim());
    if (isGenericName(parsed.vendor_name)) parsed.vendor_name = null;
    if (isGenericName(parsed.customer_name)) parsed.customer_name = null;
    if (isGenericName(parsed.payer_name)) parsed.payer_name = null;
  }

  // ── Post-AI correction: if AI swapped vendor/customer, fix using regex extraction ──
  if (!isReceipt && parsed && regexParties.letterheadVendor) {
    const norm = (s: string | null | undefined) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const aiVendorNorm = norm(parsed.vendor_name);
    const regexLetterheadNorm = norm(regexParties.letterheadVendor);
    const regexCustomerNorm = norm(regexParties.billToCustomer);

    // If AI vendor matches regex Bill To (not the letterhead), the AI got it backwards
    if (regexCustomerNorm && aiVendorNorm === regexCustomerNorm && aiVendorNorm !== regexLetterheadNorm) {
      // Swap: the letterhead is the real vendor, the Bill To is the real customer
      parsed = {
        ...parsed,
        vendor_name: regexParties.letterheadVendor,
        customer_name: parsed.vendor_name, // the AI's "vendor" was actually the customer
      };
    }
    // If AI returned no vendor_name but regex found the letterhead
    if (!parsed.vendor_name && regexParties.letterheadVendor) {
      parsed.vendor_name = regexParties.letterheadVendor;
    }
    // If AI returned no customer_name but regex found the Bill To
    if (!parsed.customer_name && regexParties.billToCustomer) {
      parsed.customer_name = regexParties.billToCustomer;
    }
    console.log('[POST-AI-CORRECTION] Final — vendor:', parsed?.vendor_name, '| customer:', parsed?.customer_name);
  }

  // For receipts: the "customer" is the payer (the company that made the payment)
  // For invoices: figure out which extracted name is actually the counterparty —
  // the letterhead "vendor_name" and the "Customer:"/"Bill To:" customer_name can each
  // legitimately be either OUR OWN company or the other party, depending on whether this
  // document is a bill WE issued (outgoing) or a bill FROM a supplier TO us (incoming).
  // Compare both against our own company name (from company_settings) to tell them apart.
  // Uses fuzzy matching to handle "Pastel Tech" ↔ "PASTEL TECH LIMITED" variants.

  let counterpartyName: string | null = null;
  let isIncoming = false;
  let needsDirectionReview = false;
  let companyNotDetected = false;
  // Hoisted out of the if-block: the GLM-OCR retry (sibling block) also
  // needs the own-company candidates for its direction re-check.
  let ownCandidates: string[] = [];

  if (!isReceipt) {
    const ownCompany = await db.prepare(
      'SELECT name, legal_name, short_name FROM company_settings WHERE user_id = ?'
    ).bind(userId).first<{ name: string | null; legal_name: string | null; short_name: string | null }>();
    ownCandidates = [ownCompany?.name, ownCompany?.legal_name, ownCompany?.short_name]
      .filter((s): s is string => !!s && s.trim().length > 0);
    // Fallback: no company_settings row (e.g. legacy accounts) → use the user's
    // own company name so direction detection still has something to compare
    // against. 2026-08-18: Joseph Lin had no company_settings row, so every
    // own-issued invoice (letterhead = own company) was heuristically guessed
    // as incoming. The fuzzy matcher tolerates spelling variants (e.g.
    // "Proficiency…" vs "Proficient…" scores ~97), so the spelling is not the
    // blocker — the MISSING own-name was.
    if (ownCandidates.length === 0) {
      const u = await db.prepare('SELECT company_name FROM users WHERE id = ?')
        .bind(userId).first<{ company_name: string | null }>();
      if (u?.company_name && u.company_name.trim().length > 0) ownCandidates.push(u.company_name);
    }
    // ── Direction decision (fuzzy own-company match + A/C Name cross-check) ──
    // The bank "A/C Name" holder is the invoice issuer in this business
    // context (verified across Pastel / VEII / EHSIA families 2026-08-18).
    // resolveDirection also swaps mislabeled vendor/customer pairs and flags
    // thin parses for review instead of silently accepting a direction.
    const direction = resolveDirection({
      vendorName: parsed?.vendor_name || null,
      customerName: parsed?.customer_name || null,
      ocrText,
      ownCompanyCandidates: ownCandidates,
    });

    // If the A/C Name proved the AI had vendor/customer backwards, fix the
    // parsed roles so downstream counterparty routing uses the right party.
    if (direction.swapped && parsed) {
      const realVendor = parsed.customer_name;
      parsed = { ...parsed, vendor_name: realVendor, customer_name: parsed.vendor_name };
    }

    isIncoming = direction.isIncoming;
    counterpartyName = direction.counterpartyName;
    needsDirectionReview = direction.needsDirectionReview;
    companyNotDetected = direction.companyNotDetected;
    console.log('[DIRECTION]', JSON.stringify(direction));
  }

  // ── GLM-OCR retry on direction uncertainty ──
  if (!isReceipt && (needsDirectionReview || companyNotDetected) && glmApiKey && parsed) {
    console.log('[RETRY|tomarkdown→GLM] Invoice direction uncertain, retrying with GLM-OCR...');
    try {
      const obj = await fileBucket.get(fileRow.r2_key);
      if (obj) {
        const buffer = await obj.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const base64 = btoa(binary);
        const mimeType = fileRow.file_type || 'application/pdf';

        let glmResp: Response | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 3000));
          glmResp = await fetch('https://api.z.ai/api/paas/v4/layout_parsing', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${glmApiKey}` },
            body: JSON.stringify({ model: 'glm-ocr', file: `data:${mimeType};base64,${base64}` }),
          });
          if (glmResp.status !== 429) break;
        }

        if (glmResp?.ok) {
          const glmData = await glmResp.json() as any;
          const pages = glmData?.layout_details || [];
          const parts: string[] = [];
          for (const p of pages) {
            for (const el of p) {
              if (el.label === 'table' && el.content) parts.push(el.content);
              else if (el.label === 'text' && el.content) {
                const x = el.bbox_2d?.[0] || 0;
                parts.push(`[${x < 600 ? 'L' : x < 1200 ? 'M' : 'R'}] ${el.content}`);
              }
            }
            parts.push('');
          }
          const glmFormatted = parts.join('\n').trim();

          if (glmFormatted.length > 20) {
            // Call DeepSeek with positional format
            const mdAuthor = ocrText.match(/^- Author[=:]\s*(.+)$/m);
            const metaAuthor = mdAuthor?.[1]?.trim() || null;
            const hints = metaAuthor ? `HINT: PDF Author="${metaAuthor}" — likely the vendor.\n` : '';
            const retryPrompt = `${hints}Parse this invoice OCR into JSON. Fields: vendor_name (issuer/supplier), customer_name (party being billed), invoice_number, issue_date, due_date, total. IMPORTANT: Positional format with [L]=top/left (letterhead/vendor), [M]=middle (client/customer), HTML tables have column headers. Return ONLY valid JSON.\n\nOCR:\n${glmFormatted.slice(0, 8000)}`;

            const retryResult = await llmCompleteJson(llmKeys, retryPrompt, 'invoice:glm-ocr', { maxTokens: 2000 });
            let retryParsed: any = retryResult.parsed;

            if (retryParsed) {
              // Re-check direction with GLM-OCR result (same resolver, so the
              // A/C Name swap + thin-parse guard apply to the retry too)
              const retryDirection = resolveDirection({
                vendorName: retryParsed.vendor_name || null,
                customerName: retryParsed.customer_name || null,
                ocrText: glmFormatted,
                ownCompanyCandidates: ownCandidates,
              });

              if (!retryDirection.needsDirectionReview && !retryDirection.companyNotDetected) {
                console.log('[DS-INVOICE|glm-ocr] Direction resolved:', JSON.stringify(retryDirection));
                if (retryDirection.swapped) {
                  const realVendor = retryParsed.customer_name;
                  retryParsed = { ...retryParsed, vendor_name: realVendor, customer_name: retryParsed.vendor_name };
                }
                parsed = retryParsed;
                parseProvider = retryResult.provider;
                isIncoming = retryDirection.isIncoming;
                counterpartyName = retryDirection.counterpartyName;
                needsDirectionReview = false;
                companyNotDetected = false;
                glmUsage = glmData.usage || null;
                ocrText = glmFormatted; // Use GLM OCR text going forward
                ocrSource = 'glm-ocr';
              } else {
                console.log('[DS-INVOICE|glm-ocr] Still uncertain, keeping original');
              }
            }
          }
        }
      }
    } catch (e: any) {
      console.log('[RETRY|GLM-OCR] Invoice error:', e?.message || String(e));
    }
  }

  const customerName = isReceipt
    ? (parsed?.payer_name || parsed?.customer_name || null)
    : counterpartyName;
  const customerEmail = isReceipt ? null : (parsed?.customer_email || null);

  // Route counterparty to correct table:
  // - Incoming invoice (supplier billed us) → suppliers table
  // - Outgoing invoice (we billed customer) → customers table
  // Deduplication: fuzzy-match name before creating to avoid duplicate records.

  const isValidName = (s: string | null | undefined) =>
    !!s && s.trim().length > 2 && s.trim().toLowerCase() !== 'unknown';

  // Shared fuzzy dedup helper
  const findOrCreateCounterparty = async (
    table: 'customers' | 'suppliers',
    name: string,
    email?: string | null,
  ): Promise<{ id: string; created: boolean }> => {
    const rows = await db.prepare(`SELECT id, name FROM ${table} WHERE user_id = ?`).bind(userId).all<{ id: string; name: string }>();
    const candidates = (rows.results || []).map(r => ({ id: r.id, name: r.name }));
    const match = fuzzyMatchCompany(name, candidates, { topN: 3, minScore: 50 });
    if (match.best && match.best.score >= 70 && match.best.id) {
      return { id: match.best.id, created: false };
    }
    // Email exact-match fallback
    if (email) {
      const byEmail = await db.prepare(`SELECT id FROM ${table} WHERE user_id = ? AND email = ?`).bind(userId, email).first<{ id: string }>();
      if (byEmail) return { id: byEmail.id, created: false };
    }
    // Create new
    const newId = table === 'customers' ? `c-${uuidv4().slice(0, 8)}` : `sup-${uuidv4().slice(0, 8)}`;
    await db.prepare(`INSERT INTO ${table} (id, user_id, name, email, is_active) VALUES (?, ?, ?, ?, 1)`)
      .bind(newId, userId, name, email || null).run();
    return { id: newId, created: true };
  };

  let customerId: string | null = null;
  let supplierId: string | null = null;
  // True when the counterparty was NOT in our customers/suppliers DB and a new
  // record had to be created — surfaced to the user as a review flag so they
  // can confirm the new company (2026-08-18).
  let newCounterparty = false;

  if (isIncoming && isValidName(customerName)) {
    // Supplier invoice — find or create in suppliers table (fuzzy dedup)
    const supResult = await findOrCreateCounterparty('suppliers', customerName, customerEmail);
    supplierId = supResult.id;
    newCounterparty = supResult.created;
    // For incoming invoices, we (PNR) are the customer being billed.
    // Find or create a self-customer record representing our own company.
    const ownCompanyName = (await db.prepare('SELECT name FROM company_settings WHERE user_id = ?').bind(userId).first<{ name: string | null }>())?.name || 'My Company (please set your company name in Settings)';
    const selfCust = await db.prepare('SELECT id FROM customers WHERE user_id = ? AND name = ?').bind(userId, ownCompanyName).first<{ id: string }>();
    if (selfCust) {
      customerId = selfCust.id;
    } else {
      customerId = `c-self-${uuidv4().slice(0, 6)}`;
      await db.prepare('INSERT INTO customers (id, user_id, name, is_active) VALUES (?, ?, ?, 1)')
        .bind(customerId, userId, ownCompanyName).run();
    }
  } else if (isValidName(customerName)) {
    // Outgoing invoice — find or create in customers table (fuzzy dedup)
    const custResult = await findOrCreateCounterparty('customers', customerName, customerEmail);
    customerId = custResult.id;
    newCounterparty = custResult.created;
  }

  // If no customer found/created (name was invalid/unknown), use a placeholder
  // but DON'T create a new customer record — just find any existing one
  if (!customerId) {
    const anyCustomer = await db.prepare('SELECT id FROM customers WHERE user_id = ? LIMIT 1').bind(userId).first<{ id: string }>();
    if (anyCustomer) {
      customerId = anyCustomer.id;
    } else {
      // Only create if truly no customers exist yet
      customerId = `c-${uuidv4().slice(0, 8)}`;
      await db.prepare('INSERT INTO customers (id, user_id, name, is_active) VALUES (?, ?, ?, 1)')
        .bind(customerId, userId, customerName || 'Unknown').run();
    }
  }

  // Calculate totals
  const items: any[] = (parsed?.items || []).map((it: any, i: number) => {
    const rawQty = it.quantity !== undefined && it.quantity !== null ? Number(it.quantity) : 1;
    const unitPrice = Number(it.unit_price || 0);
    const extractedAmount = Number(it.amount ?? 0);
    // Key logic: if PDF amount is 0 or qty is explicitly 0, force qty=0 amount=0
    // This fixes the "Engineer Overtime qty=0 $0" being read as qty=1 $450
    const isZeroRow = extractedAmount === 0 || rawQty === 0;
    const qty = isZeroRow ? 0 : (rawQty || 1);
    const amount = isZeroRow ? 0 : (extractedAmount || qty * unitPrice);
    return {
      description: it.description || 'Item',
      quantity: qty,
      unit_price: unitPrice,
      amount: amount,
      sort_order: i,
    };
  });
  if (items.length === 0) {
    // Single-item fallback from total
    const total = parsed?.total || parseFloat(ocrText.match(/(?:total|合計|金額)[^\d]*([\d,]+\.?\d*)/i)?.[1]?.replace(/,/g, '') || '0') || 0;
    if (total > 0) {
      items.push({ description: 'Invoice item', quantity: 1, unit_price: total, amount: total, sort_order: 0 });
    }
  }
  if (items.length === 0) {
    // Still no items - create placeholder so user can fill in manually on review page
    items.push({ description: 'Invoice item', quantity: 1, unit_price: 0, amount: 0, sort_order: 0 });
  }

  const subtotal = items.reduce((s: number, it: any) => s + it.amount, 0);

  // ── Discount handling: use LLM-detected discount if available ──
  const llmDiscount = typeof parsed?.discount_amount === 'number' && parsed.discount_amount > 0
    ? parsed.discount_amount : 0;
  const llmDiscountDesc = parsed?.discount_description || null;

  // Compute total: prefer parsed total, but if the LLM detected a discount, use subtotal - discount
  const computedTotal = llmDiscount > 0 ? subtotal - llmDiscount : subtotal;
  let total = parsed?.total || computedTotal;

  // ── Printed grand-total extraction (EN + ZH labels, HK bilingual invoices) ──
  // Trust the printed "Total Amount Due" / "總額" over the AI-parsed total when
  // both exist and disagree. Fixes unit-price-as-total misreads (e.g. EHSIA
  // invoice #E2025501: AI stored the $480 unit price instead of the printed
  // $4,800 grand total — the self-consistency check below couldn't catch it
  // because the AI's own item sum agreed with its own wrong total).
  // Moved to src/lib/printed-total.ts — the inline regex's bare TOTAL
  // alternative also matched "Monthly Total 1 Jan 2025" date lines on the
  // pdf-text OCR, producing a bogus printedTotal=1 (2026-08-18).
  const printedTotal = extractPrintedTotal(ocrText);

  // ── Total validation ──
  // Cross-check three signals — printed grand total (regex), AI total, item sum —
  // and pick the most credible. toMarkdown OCR is non-deterministic run-to-run:
  // sometimes it garbles the printed total (e.g. "$480" instead of "$4,800"),
  // sometimes the AI total is wrong. A grand total can never be SMALLER than the
  // largest detected amount, so when the printed value sits below the AI/item
  // signals we distrust the printed value and use the larger one. Any
  // intervention flags the invoice for review.
  let totalMismatch: { expected: number; actual: number; diff: number } | null = null;
  const aiMax = Math.max(parsed?.total || 0, subtotal);
  if (printedTotal != null && printedTotal > 0) {
    if (printedTotal < aiMax && aiMax > 0) {
      totalMismatch = { expected: aiMax, actual: printedTotal, diff: printedTotal - aiMax };
      total = aiMax;
      console.log(`[TOTAL-CHECK] printed=${printedTotal} < detected=${aiMax} → using detected, needs_review=total`);
    } else if (Math.abs(printedTotal - total) > 0.02) {
      totalMismatch = { expected: printedTotal, actual: total, diff: total - printedTotal };
      total = printedTotal;
      console.log(`[TOTAL-CHECK] printed=${printedTotal} ai=${totalMismatch.actual} → using printed, needs_review=total`);
    }
  } else if (parsed?.total && items.length > 0) {
    const expectedAfterDiscount = subtotal - llmDiscount;
    if (Math.abs(expectedAfterDiscount - parsed.total) > 0.01) {
      totalMismatch = { expected: expectedAfterDiscount, actual: parsed.total, diff: parsed.total - expectedAfterDiscount };
    }
  }

  // Smart number detection: check if OCR-extracted number matches client's pattern
  const patterns = await db.prepare(
    'SELECT invoice_number_pattern, receipt_number_pattern FROM company_settings WHERE user_id = ?'
  ).bind(userId).first<{ invoice_number_pattern: string | null; receipt_number_pattern: string | null }>();

  // For receipts: use receipt_number column as the display number
  const receiptNum = isReceipt ? (parsed?.receipt_number || parsed?.invoice_number || null) : null;
  let counterpartyRef: string | null = null;

  let invNumber: string;
  if (isReceipt) {
    const ocrNum = parsed?.receipt_number || parsed?.invoice_number || null;
    const detected = detectOwnNumber(ocrNum, patterns?.invoice_number_pattern, patterns?.receipt_number_pattern);
    if (detected.isOurs) {
      invNumber = `REC-${Date.now().toString(36).toUpperCase()}`;
    } else {
      invNumber = await generateReceiptNumber(db, userId);
      if (ocrNum && !detected.isOurs) counterpartyRef = ocrNum;
    }
  } else {
    const ocrNum = parsed?.invoice_number || null;
    const detected = detectOwnNumber(ocrNum, patterns?.invoice_number_pattern, patterns?.receipt_number_pattern);
    if (detected.isOurs) {
      invNumber = ocrNum!;
    } else {
      invNumber = `INV-${Date.now().toString(36).toUpperCase()}`;
      if (ocrNum && !detected.isOurs) counterpartyRef = ocrNum;
    }
  }

  const issueDate = parsed?.issue_date || new Date().toISOString().split('T')[0];
  const dueDate = isReceipt ? issueDate : (parsed?.due_date || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0]);
  // Always use isIncoming from AI+company comparison — never trust fileRow.direction for invoices
  // fileRow.direction is set by classifyFile which can't know company context
  const direction = directionOverride || (isReceipt ? 'incoming' : (isIncoming ? 'incoming' : 'outgoing'));

  // Duplicate check: if same invoice/receipt number exists, append suffix instead of blocking
  let isDuplicate = false;
  if (!isReceipt) {
    const existing = await db.prepare(
      'SELECT id, invoice_number FROM invoices WHERE user_id = ? AND invoice_number = ?'
    ).bind(userId, invNumber).first<{ id: string }>();
    if (existing) isDuplicate = true;
  }
  if (isReceipt && receiptNum) {
    const existing = await db.prepare(
      'SELECT id FROM invoices WHERE user_id = ? AND receipt_number = ?'
    ).bind(userId, receiptNum).first<{ id: string }>();
    if (existing) isDuplicate = true;
  }
  if (isDuplicate) {
    invNumber = isReceipt
      ? `REC-${Date.now().toString(36).toUpperCase()}`
      : `${invNumber}-${Date.now().toString(36).slice(-3).toUpperCase()}`;
  }

  // Check by file_id — flag but don't block (user can still review)
  let duplicateExistingId: string | null = null;
  let duplicateStatus: string | null = null;
  const existingByFile = await db.prepare(
    'SELECT id, invoice_number, receipt_number FROM invoices WHERE user_id = ? AND file_id = ? AND deleted_at IS NULL'
  ).bind(userId, fileId).first<{ id: string; invoice_number: string; receipt_number: string | null }>();
  if (existingByFile) {
    isDuplicate = true;
    duplicateExistingId = existingByFile.id;
    duplicateStatus = 'active';
  }

  // Build review flags for persistent display in the Invoices list.
  // Only force manual review when OCR is provably unreliable: the sum of
  // AI-extracted line items doesn't match the AI-extracted total.
  // Direction uncertainty and company-name-not-found are informational
  // flags but don't block auto-save when the numbers are consistent.
  const reviewFlags: string[] = [];
  if (needsDirectionReview && !directionOverride) reviewFlags.push('direction');
  if (companyNotDetected) reviewFlags.push('company_not_detected');
  if (isDuplicate) reviewFlags.push('duplicate');
  if (totalMismatch) reviewFlags.push('total');
  if (newCounterparty) reviewFlags.push('new_company');
  const needsReview = reviewFlags.length > 0 ? reviewFlags.join(',') : '';

  const invId = `i-${uuidv4().slice(0, 8)}`;
  // Clean imports → 'active' (auto-confirmed). Needs-review imports → 'pending_review'.
  const invStatus = needsReview ? 'pending_review' : 'active';
  await db.prepare(
    `INSERT INTO invoices (id, user_id, invoice_number, customer_id, supplier_id, status, issue_date, due_date, subtotal, total, currency, notes, file_id, vendor_name, receipt_number, direction, needs_review, counterparty_ref, discount_amount, tax_rate, tax_amount, ocr_source, payer_name, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ocr')`
  ).bind(invId, userId, invNumber, customerId, supplierId || null, invStatus, issueDate, dueDate, subtotal, total, parsed?.currency || 'HKD', parsed?.notes || null, fileId, customerName || null, receiptNum, direction, needsReview, counterpartyRef, llmDiscount || 0, parsed?.tax_rate || 0, (parsed?.tax_amount || parsed?.tax) || 0, ocrSource, isReceipt ? (parsed?.payer_name || null) : null).run();
  console.log('[INVOICE-CREATED] id:', invId, '| direction:', direction, '| status:', invStatus, '| needsReview:', needsReview, '| vendor:', customerName, '| total:', total, '| currency:', parsed?.currency || 'HKD', '| ocrSource:', ocrSource);

  // Auto-link: if this is a receipt, try to find its invoice.
  // Receipt = proof of payment. Links to AR (customer paid us) or AP (we paid
  // supplier). Fixed 2026-08-26 (was amount-only + status-blind):
  //  - 'active'/'overdue' invoices are now eligible (clean imports land as
  //    'active'; the old status list never saw them), while 'pending_review'
  //    is excluded so a receipt can't silently pay an invoice nobody reviewed.
  //  - Direction preference from the payer name: payer = own company → AP
  //    receipt (incoming invoices); otherwise AR receipt (outgoing invoices).
  //  - Counterparty fuzzy match preferred; with several equal-amount
  //    candidates and no corroborating signal, do NOT auto-link (the old
  //    ORDER BY tie-break once linked a receipt to a leftover duplicate).
  let linkedInvoiceId: string | null = null;
  if (isReceipt && total > 0) {
    const ownRow = await db.prepare(
      'SELECT name, legal_name, short_name FROM company_settings WHERE user_id = ?'
    ).bind(userId).first<{ name: string | null; legal_name: string | null; short_name: string | null }>();
    const ownNames = [ownRow?.name, ownRow?.legal_name, ownRow?.short_name].filter((s): s is string => !!s?.trim());
    if (ownNames.length === 0) {
      const u = await db.prepare('SELECT company_name FROM users WHERE id = ?').bind(userId).first<{ company_name: string | null }>();
      if (u?.company_name?.trim()) ownNames.push(u.company_name);
    }
    // Direction preference cascade (2026-08-26 v3 — v2 broke when the AI put
    // the ISSUER into payer_name, e.g. FP Receipt 000175F: "payer"=Smart City):
    //   payer  ≈ own → we paid               → AP (incoming)
    //   issuer ≈ own → we issued the receipt → AR (outgoing)
    //   neither  own → third party issued it → AP (incoming)
    //   (payer-only / issuer-only variants follow the same own-vs-other logic)
    const nameScoreVsOwn = (n: string | null | undefined) =>
      n && ownNames.length > 0 ? (fuzzyMatchCompany(n, ownNames, { topN: 1, minScore: 50 })?.best?.score ?? 0) : 0;
    const receiptPayer = parsed?.payer_name || null;
    const receiptIssuer = parsed?.customer_name || null;
    const payerIsOwn = nameScoreVsOwn(receiptPayer) >= 70;
    const issuerIsOwn = nameScoreVsOwn(receiptIssuer) >= 70;
    let prefDirection: 'incoming' | 'outgoing' | null = null;
    if (payerIsOwn) prefDirection = 'incoming';
    else if (issuerIsOwn) prefDirection = 'outgoing';
    else if (receiptIssuer || receiptPayer) prefDirection = 'incoming';
    // Counterparty = the non-own name on the receipt (used to rank candidates)
    const receiptCounterparty = payerIsOwn ? receiptIssuer
      : issuerIsOwn ? receiptPayer
      : (receiptIssuer || receiptPayer);

    // D1 reads can lag the invoice INSERT by a couple of seconds (same
    // eventual-consistency pattern as the file-row retry above) — retry empty
    // results before concluding there is nothing to link.
    const fetchCandidates = () => db.prepare(
      `SELECT i.id, i.invoice_number, i.total, i.direction, i.issue_date,
              cust.name AS customer_name, supp.name AS supplier_name
       FROM invoices i
       LEFT JOIN customers cust ON i.customer_id = cust.id
       LEFT JOIN suppliers supp ON i.supplier_id = supp.id
       WHERE i.user_id = ? AND i.status NOT IN ('paid', 'cancelled')
         AND i.deleted_at IS NULL AND i.receipt_number IS NULL AND i.linked_invoice_id IS NULL
         AND ABS(i.total - ?) < 0.02
       ORDER BY i.issue_date DESC LIMIT 20`
    ).bind(userId, total).all<{ id: string; invoice_number: string; total: number; direction: string; issue_date: string; customer_name: string | null; supplier_name: string | null }>();
    let candidates = (await fetchCandidates()).results || [];
    for (let attempt = 0; candidates.length === 0 && attempt < 2; attempt++) {
      await new Promise((r) => setTimeout(r, 1200));
      candidates = (await fetchCandidates()).results || [];
    }

    const scored = candidates
      .map((c) => {
        const counterparty = c.direction === 'incoming' ? (c.supplier_name || c.customer_name) : (c.customer_name || c.supplier_name);
        const nameScore = receiptCounterparty && counterparty
          ? (fuzzyMatchCompany(receiptCounterparty, [counterparty], { topN: 1, minScore: 50 })?.best?.score ?? 0)
          : 0;
        return { c, dirOk: (c.direction || 'outgoing') === prefDirection, nameScore };
      })
      .sort((a, b) => Number(b.dirOk) - Number(a.dirOk) || b.nameScore - a.nameScore || (b.c.issue_date || '').localeCompare(a.c.issue_date || ''));

    const top = scored[0];
    const dirOkCount = scored.filter((s) => s.dirOk).length;
    // Link only when the direction-preferred set is unambiguous: either a
    // counterparty-corroborated candidate or a single direction-ok candidate.
    const safe = !!top && top.dirOk && (top.nameScore >= 70 || dirOkCount === 1);
    if (safe) {
      linkedInvoiceId = top.c.id;
      await db.prepare("UPDATE invoices SET status = 'paid', linked_invoice_id = ? WHERE id = ?")
        .bind(invId, top.c.id).run();
    }
  }

  for (const item of items) {
    await db.prepare(
      'INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, amount, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(`ii-${uuidv4().slice(0, 8)}`, invId, item.description, item.quantity, item.unit_price, item.amount, item.sort_order).run();
  }

  // Set the reverse link on the receipt
  if (linkedInvoiceId) {
    await db.prepare('UPDATE invoices SET linked_invoice_id = ? WHERE id = ?')
      .bind(linkedInvoiceId, invId).run();
  }

  // Post the invoice leg to the GL. This is the dominant import path — a clean
  // OCR import lands as 'active' and never visits the review page, so without
  // this the receivable/payable is never recorded and only the later payment
  // leg reaches the ledger, driving AR/AP negative.
  //
  // Idempotent and non-fatal. 'pending_review' imports are skipped by the
  // helper's status guard and post later, when the review is confirmed.
  await tryPostInvoiceToGl(db, userId, invId);
  // A matched receipt flips its counterpart to 'paid'; post that one too, so a
  // previously-unposted invoice doesn't end up settled but never recorded.
  if (linkedInvoiceId) await tryPostInvoiceToGl(db, userId, linkedInvoiceId);

  // Keep the file in the classified folder (Invoices or Receipts) — no per-partner subfolders
  const folder = isReceipt ? 'Receipts' : 'Invoices';

  // Update file record
  await db.prepare(
    "UPDATE file_records SET category = ?, direction = ?, payment_status = 'unmatched', amount = ?, folder = ?, updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL"
  ).bind(isReceipt ? 'receipt' : 'invoice', direction, total, folder, fileId).run();

  // Return parsed data so the review page can pre-populate without another round-trip
  // Only report needs_direction_review when balance doesn't match.
  // Direction uncertainty and company-not-found are informational; they
  // don't block auto-save on their own.
  return {
    success: true,
    invoice_id: invId,
    items_count: items.length,
    folder,
    is_receipt: isReceipt,
    receipt_number: receiptNum,
    needs_direction_review: directionOverride ? false : needsDirectionReview,
    company_not_detected: companyNotDetected,
    total_mismatch: totalMismatch,
    discount_amount: llmDiscount || 0,
    discount_description: llmDiscountDesc,
    ocr_source: ocrSource,
    usage,
    glm_usage: glmUsage,
    deepseek_raw: deepseekRaw,
    parse_failed: parsed == null,
    ai_provider: parseProvider,
    is_duplicate: isDuplicate,
    duplicate_status: duplicateStatus,
    duplicate_existing_id: duplicateExistingId,
    auto_linked_invoice_id: linkedInvoiceId,
    new_counterparty: newCounterparty,
    direction,
    parsed: {
      invoice_number: invNumber,
      customer_name: customerName,
      vendor_name: parsed?.vendor_name || null,
      issue_date: issueDate,
      due_date: dueDate,
      currency: parsed?.currency || 'HKD',
      notes: parsed?.notes || null,
      subtotal,
      total,
      items,
    },
  };
}

// Extract the largest dollar amount from OCR text
function extractAmount(ocrText: string): number | null {
  const amounts: number[] = [];
  // Match patterns like $10,000.00 or HKD 10000 or 10,000.00
  for (const match of ocrText.matchAll(/(?:\$|HKD|HK\$)\s*([\d,]+\.?\d*)/gi)) {
    const n = parseFloat(match[1].replace(/,/g, ''));
    if (n > 0) amounts.push(n);
  }
  // Also match "Total: 10,000.00" patterns
  for (const match of ocrText.matchAll(/(?:total|金額|金額|合計|合计|amount)\s*[:：]?\s*([\d,]+\.?\d*)/gi)) {
    const n = parseFloat(match[1].replace(/,/g, ''));
    if (n > 0) amounts.push(n);
  }
  if (amounts.length === 0) return null;
  // Return the largest amount (likely the total)
  return Math.max(...amounts);
}

const files = new Hono<{ Bindings: Bindings; Variables: Variables }>();
files.use('*', authMiddleware);

// Auto-classify file based on filename patterns
function classifyFile(filename: string, fileType: string, ocrText?: string): { folder: string; category: string; direction?: string } {
  const name = filename.toLowerCase();
  const type = fileType.toLowerCase();

  // Bank statements
  if (/hsbc|bank\s*statement|月結單|月结单|eStatement|statement\s*date|statement\s*period/i.test(name) && !/card|credit/i.test(name)) {
    return { folder: 'Bank Statements', category: 'bank_statement' };
  }
  // Card statements
  if (/card\s*statement|credit\s*card|信用卡|card\s*stmt|amex|mastercard|visa\s*statement/i.test(name)) {
    return { folder: 'Card Statements', category: 'card_statement' };
  }
  // Invoices — direction is determined later by company_settings comparison, not here
  if (/invoice|發票|发票|tax\s*invoice|inv[_-]?|bill[_-]?in|po[_-]?\d/i.test(name)) {
    return { folder: 'Invoices', category: 'invoice' };
  }
  // Receipts
  if (/receipt|收據|收据/i.test(name)) {
    return { folder: 'Receipts', category: 'receipt' };
  }

  // Everything else
  return { folder: 'Others', category: 'general' };
}

// Run GLM-OCR for PDFs and images
async function runGlmOcr(fileData: string, fileType: string, glmApiKey?: string): Promise<{ text: string; status: string }> {
  if (!glmApiKey) return { text: '', status: 'pending' };

  const isOcrCandidate = fileType.includes('pdf') || fileType.includes('image') || fileType.includes('png') || fileType.includes('jpg') || fileType.includes('jpeg');
  if (!isOcrCandidate) return { text: '', status: 'skipped' };

  try {
    const resp = await fetch('https://api.z.ai/api/paas/v4/layout_parsing', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${glmApiKey}`,
      },
      body: JSON.stringify({ model: 'glm-ocr', file: fileData }),
    });
    if (!resp.ok) return { text: '', status: 'failed' };
    const data = await resp.json() as any;
    const text = extractTextFromGlmOcr(data);
    console.log('[GLM-OCR|raw] Result:', text.slice(0, 200));
    return { text, status: text.length > 20 ? 'completed' : 'unclear' };
  } catch {
    return { text: '', status: 'failed' };
  }
}

// List files with optional folder filter and search.
// ?unlinked=1 → only files with no invoice / bank / card / journal-entry link
// (used by the Expenses → Others tab document picker).
files.get('/', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const folder = c.req.query('folder') || '';
  const q = c.req.query('q') || '';
  const limit = parseInt(c.req.query('limit') || '0', 10);
  const unlinked = c.req.query('unlinked') === '1';

  const { sql, params } = buildFileListSql({
    tenantId,
    folder: folder || undefined,
    q: q || undefined,
    limit: limit > 0 ? limit : undefined,
    unlinked,
  });

  const rows = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json({ data: rows.results });
});

// List distinct folder names
files.get('/folders', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const rows = await c.env.DB.prepare(
    'SELECT DISTINCT folder FROM file_records WHERE user_id = ? AND deleted_at IS NULL ORDER BY folder'
  ).bind(tenantId).all();
  return c.json({ data: rows.results.map(r => r.folder) });
});

// Get files with issues (for nav badge)
files.get('/issues', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const row = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM file_records WHERE user_id = ? AND ocr_status IN ('failed', 'unclear') AND deleted_at IS NULL"
  ).bind(tenantId).first<{ count: number }>();
  return c.json({ issues: row?.count || 0 });
});

files.get('/:id/linked-records', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const id = c.req.param('id');

  const fr = await db.prepare(
    `SELECT fr.id, fr.filename,
      i.id as invoice_id, i.invoice_number, i.total as invoice_total, i.vendor_name,
      cust.name as customer_name,
      bs.id as statement_id, bs.bank_name as stmt_bank_name, bs.source as stmt_source,
      cs.id as card_statement_id, cs.card_issuer, cs.source as card_source
    FROM file_records fr
    LEFT JOIN invoices i ON i.file_id = fr.id AND i.user_id = fr.user_id AND i.deleted_at IS NULL
    LEFT JOIN customers cust ON i.customer_id = cust.id
    LEFT JOIN bank_statements bs ON (bs.r2_key = fr.r2_key OR bs.source_file_id = fr.id)
      AND bs.user_id = fr.user_id AND bs.deleted_at IS NULL
    LEFT JOIN card_statements cs ON (cs.r2_key = fr.r2_key OR cs.source_file_id = fr.id)
      AND cs.user_id = fr.user_id AND cs.deleted_at IS NULL
    WHERE fr.id = ? AND fr.user_id = ? AND fr.deleted_at IS NULL`
  ).bind(id, tenantId).first();

  if (!fr) return c.json({ error: 'File not found' }, 404);

  const jeRows = await db.prepare(
    `SELECT je.id, je.entry_number, je.entry_date FROM journal_entry_files jef
     JOIN journal_entries je ON je.id = jef.entry_id
     WHERE jef.file_record_id = ? AND je.deleted_at IS NULL`
  ).bind(id).all();

  return c.json({ file_id: id, links: buildFileLinks(fr, jeRows.results as any[]) });
});

// Check if a file with the same name already exists
files.get('/check-duplicate', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const filename = c.req.query('filename');
  if (!filename) return c.json({ exists: false });

  const existing = await c.env.DB.prepare(
    'SELECT id, filename, original_name, folder, created_at FROM file_records WHERE user_id = ? AND (filename = ? OR original_name = ?) AND deleted_at IS NULL LIMIT 1'
  ).bind(tenantId, filename, filename).first<{ id: string; filename: string; original_name: string; folder: string; created_at: string }>();

  if (existing) {
    return c.json({ exists: true, existing_file: existing });
  }
  return c.json({ exists: false });
});

// Upload file to R2 + store metadata in D1
files.post('/upload', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const body = await c.req.json();
  const { filename, original_name, file_type, file_size, file_data, folder: reqFolder, description, skip_ocr } = body;

  if (!file_data) return c.json({ error: 'file_data required (base64)' }, 400);

  // Validate file size (max 10MB base64 ≈ 13.3MB encoded)
  if (file_data.length > 14_000_000) return c.json({ error: 'File too large. Maximum 10MB.' }, 400);

  const id = `fs-${uuidv4().slice(0, 8)}`;
  const safeName = original_name || filename || 'untitled';

  // Resolve the MIME type from the filename when the client's value is missing
  // or opaque. Browsers derive file.type from an OS-level extension map, so the
  // same file arrives as 'image/heic' from macOS but '' from Windows. Validating
  // the raw value alone let identical uploads pass on one OS and fail on the
  // other, and made a plain octet-stream fallback a hard 400.
  const extMime: Record<string, string> = {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', csv: 'text/csv',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel',
  };
  const ext = safeName.includes('.') ? safeName.split('.').pop()!.toLowerCase() : '';
  const claimedType = String(file_type || '').toLowerCase().trim();
  const effectiveType = (claimedType && claimedType !== 'application/octet-stream')
    ? claimedType
    : (extMime[ext] || '');

  // Validate file type
  const allowedTypes = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv', 'application/vnd.ms-excel'];
  if (!allowedTypes.includes(effectiveType)) {
    if (ext === 'heic' || ext === 'heif') {
      return c.json({ error: 'HEIC/HEIF photos are not supported. On iPhone: Settings > Camera > Formats > "Most Compatible", or export the photo as JPEG first.' }, 400);
    }
    return c.json({ error: `File type not allowed: ${claimedType || (ext ? '.' + ext : 'unknown')}` }, 400);
  }

  const r2Key = `${tenantId}/${id}-${safeName}`;
  const displayName = filename || safeName;

  // Auto-classify
  const classification = classifyFile(safeName, effectiveType);
  const folder = reqFolder || classification.folder;

  // Skip GLM-OCR during upload — it blocks for 20-40s and times out frequently.
  // OCR runs in import-document using Cloudflare AI toMarkdown (fast, built-in).
  // skip_ocr (per 2026-08-27 manual-statements design §5.1): store without ever
  // queueing analysis — consumed by the Petty Cash / Others form attachments
  // and the FileUpload "Save without AI Analysis" path.
  const ocrResult = { text: '', status: skip_ocr ? 'skipped' : 'pending' };
  const ocrDirection = classification.direction;
  const ocrAmount = null;

  const cleanBase64 = file_data.replace(/^data:.*?;base64,/, '');
  const binary = Uint8Array.from(atob(cleanBase64), ch => ch.charCodeAt(0));

  // Compute SHA-256 content hash for duplicate detection
  const hashBuffer = await crypto.subtle.digest('SHA-256', binary);
  const contentHash = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  await c.env.FILE_BUCKET.put(r2Key, binary, {
    httpMetadata: { contentType: effectiveType },
    customMetadata: { originalName: safeName, userId: user.id },
  });

  await c.env.DB.prepare(
    `INSERT INTO file_records (id, user_id, folder, filename, original_name, file_type, file_size, r2_key, description, ocr_text, ocr_status, category, direction, amount, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, tenantId, folder, displayName, safeName,
    effectiveType, file_size || binary.byteLength,
    r2Key, description || '', ocrResult.text, ocrResult.status, classification.category,
    ocrDirection || null, ocrAmount, contentHash).run();

  const row = await c.env.DB.prepare(
    'SELECT id, folder, filename, original_name, file_type, file_size, description, ocr_status, category, created_at FROM file_records WHERE id = ? AND deleted_at IS NULL'
  ).bind(id).first();

  // Notify OCR worker via WebSocket
  try {
    wsBroadcast(user.id, { type: 'ocr_request', file_id: id, filename: displayName, file_type: effectiveType, folder: folder, category: classification.category });
  } catch { /* WebSocket not available */ }

  // NOTE: Bank statement auto-import is now handled explicitly by the frontend calling
  // POST /:id/import-document immediately after upload. That endpoint runs OCR, detects
  // whether the file is a bank statement or invoice, and dispatches accordingly.
  // Keeping this background block would double-create statements.
  // If you want to re-enable server-side auto-import, first make the dedup check atomic
  // (unique index on bank_statements.r2_key or SELECT+INSERT in a transaction).
  if (false && classification.category === 'bank_statement') {
    c.executionCtx.waitUntil((async () => {
      try {
        // Mark as processing
        await c.env.DB.prepare("UPDATE file_records SET ocr_status = 'processing', updated_at = datetime('now') WHERE id = ?")
          .bind(id).run();

        // Path A: Import using pdftotext OCR
        const importResult = await importStatementFromFile(id, tenantId, c.env.DB, c.env.FILE_BUCKET, c.env.AI, llmKeysFromEnv(c.env), c.env.GLM_API_KEY);

        // Path B: Run GLM-OCR in background for cross-validation
        if (importResult.success && c.env.GLM_API_KEY) {
          try {
            const obj = await c.env.FILE_BUCKET.get(r2Key);
            if (obj) {
              const buffer = await obj.arrayBuffer();
              const bytes = new Uint8Array(buffer);
              let binary = '';
              for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
              const base64 = btoa(binary);

              const glmResp = await fetch('https://api.z.ai/api/paas/v4/layout_parsing', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${c.env.GLM_API_KEY}`,
                },
                body: JSON.stringify({ model: 'glm-ocr', file: `data:${file_type || 'application/pdf'};base64,${base64}` }),
              });

              if (glmResp.ok) {
                const glmData = await glmResp.json() as any;
                const glmText = JSON.stringify(glmData);
                // Store full GLM-OCR in file_records
                await c.env.DB.prepare(
                  "UPDATE file_records SET ocr_text = ?, ocr_status = 'completed' WHERE id = ?"
                ).bind(glmText.slice(0, 50000), id).run();
                // Also update linked bank_statement
                await c.env.DB.prepare(
                  "UPDATE bank_statements SET ocr_text = ? WHERE r2_key = ?"
                ).bind(glmText.slice(0, 50000), r2Key).run();
              }
            }
          } catch { /* GLM-OCR is supplementary */ }
        }

        // Mark as completed
        await c.env.DB.prepare("UPDATE file_records SET ocr_status = 'completed', updated_at = datetime('now') WHERE id = ?")
          .bind(id).run();
      } catch (e) {
        await c.env.DB.prepare("UPDATE file_records SET ocr_status = 'failed', updated_at = datetime('now') WHERE id = ?")
          .bind(id).run();
      }
    })());
  }

  // Auto-import invoices with dual OCR
  // DISABLED 2026-08-17: the frontend (FileUpload.tsx / FileStorage.tsx) and all
  // test scripts explicitly call POST /:id/import-document right after /upload.
  // Keeping this background block live runs importInvoiceFromFile twice per upload;
  // its dedup checks are flag-only (never block the INSERT), so every upload created
  // duplicate invoice rows. Re-enable only after making dedup atomic (see note above).
  if (false && classification.category === 'invoice') {
    c.executionCtx.waitUntil((async () => {
      try {
        await c.env.DB.prepare("UPDATE file_records SET ocr_status = 'processing', updated_at = datetime('now') WHERE id = ?")
          .bind(id).run();

        // Try GLM-OCR first for better invoice recognition
        let ocrText = ocrResult.text || '';
        if (c.env.GLM_API_KEY) {
          try {
            const obj = await c.env.FILE_BUCKET.get(r2Key);
            if (obj) {
              const buffer = await obj.arrayBuffer();
              const bytes = new Uint8Array(buffer);
              let binary = '';
              for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
              const base64 = btoa(binary);

              const glmResp = await fetch('https://api.z.ai/api/paas/v4/layout_parsing', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${c.env.GLM_API_KEY}`,
                },
                body: JSON.stringify({ model: 'glm-ocr', file: `data:${file_type || 'application/pdf'};base64,${base64}` }),
              });
              if (glmResp.ok) {
                const glmData = await glmResp.json() as any;
                ocrText = extractTextFromGlmOcr(glmData);
                console.log('[OCR|GLM-OCR] Auto-import result:', ocrText.slice(0, 200));
                await c.env.DB.prepare(
                  "UPDATE file_records SET ocr_text = ?, ocr_status = 'completed' WHERE id = ?"
                ).bind(ocrText.slice(0, 10000), id).run();
              } else {
                console.log('[GLM-OCR|auto-import] Failed with status:', glmResp.status);
              }
            }
          } catch (e: any) {
            console.log('[GLM-OCR|auto-import] Error:', e?.message || e);
          }
        }

        // Fallback: if GLM-OCR produced no text, try Cloudflare AI toMarkdown (fast, built-in)
        if ((!ocrText || ocrText.length < 20) && c.env.AI) {
          try {
            const obj = await c.env.FILE_BUCKET.get(r2Key);
            if (obj) {
              const arrayBuffer = await obj.arrayBuffer();
              const ui8 = new Uint8Array(arrayBuffer);
              const base64ForAI = btoa(Array.from(ui8).map(b => String.fromCharCode(b)).join(''));
              const aiResp = await c.env.AI.run('@cf/unum/uform-gen2-qwen-500m', {
                prompt: 'Extract all text from this document. Return all visible text including company names, invoice numbers, dates, amounts, line items, and totals.',
                image: base64ForAI,
              });
              if (aiResp?.description) {
                ocrText = aiResp.description;
                console.log('[OCR|tomarkdown] Auto-import fallback:', ocrText.slice(0, 200));
                await c.env.DB.prepare(
                  "UPDATE file_records SET ocr_text = ? WHERE id = ?"
                ).bind(ocrText.slice(0, 10000), id).run();
              }
            }
          } catch (e: any) {
            console.log('[OCR|tomarkdown] Auto-import fallback error:', e?.message || e);
          }
        }

        // Import the invoice — even if our background OCR failed,
        // importInvoiceFromFile has its own OCR fallback and creates an
        // empty draft when the file is truly unreadable.
        try {
          const importResult = await importInvoiceFromFile(id, tenantId, c.env.DB, c.env.FILE_BUCKET, c.env.AI, llmKeysFromEnv(c.env), c.env.GLM_API_KEY);
          if (importResult.success && importResult.invoice_id) {
            await c.env.DB.prepare("UPDATE file_records SET invoice_id = ?, ocr_status = 'completed', updated_at = datetime('now') WHERE id = ?")
              .bind(importResult.invoice_id, id).run();
            console.log(`[AUTO-IMPORT|Invoice] ${importResult.invoice_id} created from file ${id}`);
          } else {
            console.log(`[AUTO-IMPORT|Fail] File ${id}: ${importResult.error || 'unknown'}`);
            await c.env.DB.prepare("UPDATE file_records SET ocr_status = 'completed', updated_at = datetime('now') WHERE id = ?")
              .bind(id).run();
          }
        } catch (importErr: any) {
          console.log(`[AUTO-IMPORT|Error] File ${id}: ${importErr?.message || importErr}`);
          await c.env.DB.prepare("UPDATE file_records SET ocr_status = 'completed', updated_at = datetime('now') WHERE id = ?")
            .bind(id).run();
        }
      } catch (e) {
        await c.env.DB.prepare("UPDATE file_records SET ocr_status = 'failed', updated_at = datetime('now') WHERE id = ?")
          .bind(id).run();
      }
    })());
  }

  // Auto-import bank statements with dual OCR (same pattern as invoices above)
  // DISABLED 2026-08-17: same double-import race as the invoice block above —
  // importStatementFromFile's r2_key dedup is flag-only and bank_statements has no
  // UNIQUE index on r2_key, so every upload created duplicate statement rows.
  // Re-enable only after adding a partial UNIQUE index on r2_key (see note above).
  if (false && classification.category === 'bank_statement') {
    c.executionCtx.waitUntil((async () => {
      try {
        await c.env.DB.prepare("UPDATE file_records SET ocr_status = 'processing', updated_at = datetime('now') WHERE id = ?")
          .bind(id).run();

        // Try GLM-OCR first for better bank statement recognition
        let ocrText = '';
        if (c.env.GLM_API_KEY) {
          try {
            const mimeType = file_type || 'application/pdf';
            const decryptedFile = await fetchAndDecryptFile(r2Key, mimeType, c.env.FILE_BUCKET);
            if (decryptedFile?.base64) {
              // If encrypted and needs password, mark as encrypted and skip OCR —
              // the user must provide a password to unlock
              if (decryptedFile.needsPassword) {
                await c.env.DB.prepare(
                  "UPDATE file_records SET ocr_status = 'encrypted', updated_at = datetime('now') WHERE id = ?"
                ).bind(id).run();
                console.log('[AUTO-STMT|Encrypted] File is encrypted — marked as needs password');
                return; // Don't attempt OCR on encrypted PDF
              }
              const glmResp = await fetch('https://api.z.ai/api/paas/v4/layout_parsing', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${c.env.GLM_API_KEY}`,
                },
                body: JSON.stringify({ model: 'glm-ocr', file: `data:${mimeType};base64,${decryptedFile.base64}` }),
              });
              if (glmResp.ok) {
                const glmData = await glmResp.json() as any;
                ocrText = extractTextFromGlmOcr(glmData);
                console.log('[OCR|GLM-OCR] Auto-statement result:', ocrText.slice(0, 200));
                await c.env.DB.prepare(
                  "UPDATE file_records SET ocr_text = ? WHERE id = ?"
                ).bind(ocrText.slice(0, 50000), id).run();
              } else {
                console.log('[GLM-OCR|auto-stmt] Failed with status:', glmResp.status);
              }
            }
          } catch (e: any) {
            console.log('[GLM-OCR|auto-stmt] Error:', e?.message || e);
          }
        }

        // Fallback: Cloudflare AI toMarkdown
        if ((!ocrText || ocrText.length < 20) && c.env.AI) {
          try {
            const obj = await c.env.FILE_BUCKET.get(r2Key);
            if (obj) {
              const arrayBuffer = await obj.arrayBuffer();
              const ui8 = new Uint8Array(arrayBuffer);
              const base64ForAI = btoa(Array.from(ui8).map(b => String.fromCharCode(b)).join(''));
              const aiResp = await c.env.AI.run('@cf/unum/uform-gen2-qwen-500m', {
                prompt: 'Extract all text from this bank statement. Return: Bank Name, Account Number, Statement Period, Opening Balance, Closing Balance, and all transactions with dates, descriptions, deposits, withdrawals, and balances.',
                image: base64ForAI,
              });
              if (aiResp?.description) {
                ocrText = aiResp.description;
                console.log('[OCR|tomarkdown] Auto-stmt fallback:', ocrText.slice(0, 200));
                await c.env.DB.prepare(
                  "UPDATE file_records SET ocr_text = ? WHERE id = ?"
                ).bind(ocrText.slice(0, 10000), id).run();
              }
            }
          } catch (e: any) {
            console.log('[OCR|tomarkdown] Auto-stmt fallback error:', e?.message || e);
          }
        }

        // Reclassification check: if OCR text looks like an invoice, switch category
        if (ocrText && ocrText.length > 20) {
          const isActuallyInvoice = /(?:TAX\s*INVOICE|PURCHASE\s*BILL|BILL\s*TO|INVOICE\s*#|發票|发票)/i.test(ocrText)
            && !/(?:BANK|STATEMENT|eStatement|月結單|月结单|ACCOUNT\s*NUMBER|BALANCE\s*BROUGHT|OPENING\s*BALANCE|CLOSING\s*BALANCE)/i.test(ocrText);
          if (isActuallyInvoice) {
            console.log('[AUTO-STMT|Reclassify] Reclassifying as invoice based on OCR content');
            await c.env.DB.prepare(
              "UPDATE file_records SET category = 'invoice', folder = 'Invoices', ocr_status = 'completed', updated_at = datetime('now') WHERE id = ?"
            ).bind(id).run();
            // Re-run as invoice import
            try {
              const invResult = await importInvoiceFromFile(id, tenantId, c.env.DB, c.env.FILE_BUCKET, c.env.AI, llmKeysFromEnv(c.env), c.env.GLM_API_KEY);
              if (invResult.success && invResult.invoice_id) {
                await c.env.DB.prepare("UPDATE file_records SET invoice_id = ? WHERE id = ?")
                  .bind(invResult.invoice_id, id).run();
                console.log(`[AUTO-STMT|Reclassify] Invoice ${invResult.invoice_id} created`);
              }
            } catch (e: any) {
              console.log('[AUTO-STMT|Error] Reclassification:', e?.message || e);
            }
            return; // Don't create a bank statement
          }
        }

        // Import the bank statement — even if our background OCR failed,
        // importStatementFromFile has its own OCR fallback and creates an
        // empty draft when the file is truly unreadable.
        try {
          const stmtResult = await importStatementFromFile(id, tenantId, c.env.DB, c.env.FILE_BUCKET, c.env.AI, llmKeysFromEnv(c.env), c.env.GLM_API_KEY);
          if (stmtResult.success && stmtResult.statement_id) {
            await c.env.DB.prepare("UPDATE file_records SET statement_id = ?, ocr_status = 'completed', updated_at = datetime('now') WHERE id = ?")
              .bind(stmtResult.statement_id, id).run();
            console.log(`[AUTO-STMT|Bank] ${stmtResult.statement_id} from ${id}, ${stmtResult.transactions_count || 0} txns, ocr_failed=${stmtResult.ocr_failed || false}`);
          } else {
            console.log(`[AUTO-STMT|Fail] File ${id}: ${stmtResult.error || 'unknown'}`);
            await c.env.DB.prepare("UPDATE file_records SET ocr_status = 'completed', updated_at = datetime('now') WHERE id = ?")
              .bind(id).run();
          }
        } catch (importErr: any) {
          console.log(`[AUTO-STMT|Error] File ${id}: ${importErr?.message || importErr}`);
          await c.env.DB.prepare("UPDATE file_records SET ocr_status = 'completed', updated_at = datetime('now') WHERE id = ?")
            .bind(id).run();
        }
      } catch (e) {
        await c.env.DB.prepare("UPDATE file_records SET ocr_status = 'failed', updated_at = datetime('now') WHERE id = ?")
          .bind(id).run();
      }
    })());
  }

  return c.json(row, 201);
});

// Batch upload multiple files
files.post('/upload-batch', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const body = await c.req.json();
  const { files: fileList, folder: batchFolder, description: batchDesc } = body as {
    files: { filename: string; original_name?: string; file_type?: string; file_size?: number; file_data: string }[];
    folder?: string;
    description?: string;
  };

  if (!Array.isArray(fileList) || fileList.length === 0) {
    return c.json({ error: 'files array required' }, 400);
  }

  const results = [];
  for (const f of fileList) {
    if (!f.file_data) continue;

    const id = `fs-${uuidv4().slice(0, 8)}`;
    const safeName = f.original_name || f.filename || 'untitled';
    const r2Key = `${tenantId}/${id}-${safeName}`;
    const displayName = f.filename || safeName;

    const classification = classifyFile(safeName, f.file_type || '');
    const folder = batchFolder || classification.folder;

    const ocrResult = await runGlmOcr(f.file_data, f.file_type || '', c.env.GLM_API_KEY);

    const cleanBase64 = f.file_data.replace(/^data:.*?;base64,/, '');
    const binary = Uint8Array.from(atob(cleanBase64), ch => ch.charCodeAt(0));

    await c.env.FILE_BUCKET.put(r2Key, binary, {
      httpMetadata: { contentType: f.file_type || 'application/octet-stream' },
      customMetadata: { originalName: safeName, userId: user.id },
    });

    await c.env.DB.prepare(
      `INSERT INTO file_records (id, user_id, folder, filename, original_name, file_type, file_size, r2_key, description, ocr_text, ocr_status, category)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, tenantId, folder, displayName, safeName,
      f.file_type || 'application/octet-stream', f.file_size || binary.byteLength,
      r2Key, batchDesc || '', ocrResult.text, ocrResult.status, classification.category).run();

    results.push({ id, filename: displayName, folder, ocr_status: ocrResult.status, category: classification.category });

    // Auto-import bank statements — DISABLED to avoid double-creation.
    // The frontend calls /:id/import-document after upload which handles both statements and invoices.
    if (false && classification.category === 'bank_statement') {
      c.executionCtx.waitUntil(
        importStatementFromFile(id, tenantId, c.env.DB, c.env.FILE_BUCKET, c.env.AI, llmKeysFromEnv(c.env), c.env.GLM_API_KEY)
      );
    }

    // Auto-import invoices — DISABLED for same reason.
    if (false && classification.category === 'invoice') {
      c.executionCtx.waitUntil((async () => {
        try {
          const obj = await c.env.FILE_BUCKET.get(r2Key);
          if (obj) {
            const buffer = await obj.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
            const base64 = btoa(binary);

            const glmResp = await fetch('https://api.z.ai/api/paas/v4/layout_parsing', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${c.env.GLM_API_KEY}`,
              },
              body: JSON.stringify({ model: 'glm-ocr', file: `data:${f.file_type || 'application/pdf'};base64,${base64}` }),
            });
            if (glmResp.ok) {
              const glmData = await glmResp.json() as any;
              await c.env.DB.prepare(
                "UPDATE file_records SET ocr_text = ?, ocr_status = 'completed' WHERE id = ?"
              ).bind(JSON.stringify(glmData).slice(0, 10000), id).run();
            }
          }
        } catch {}
        await importInvoiceFromFile(id, tenantId, c.env.DB, c.env.FILE_BUCKET, c.env.AI, llmKeysFromEnv(c.env), c.env.GLM_API_KEY);
      })());
    }
  }

  return c.json({ uploaded: results.length, files: results }, 201);
});

// Get file metadata
files.get('/:id', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const row = await c.env.DB.prepare(
    'SELECT id, folder, filename, original_name, file_type, file_size, description, ocr_text, ocr_status, category, direction, payment_status, amount, created_at, updated_at FROM file_records WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(c.req.param('id'), tenantId).first();
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(row);
});

// Download from R2
files.get('/:id/download', async (c) => {
  const user = c.get('user');
  let tenantId = c.get('client_user_id') || user.id;
  // Iframes can't send the X-Active-Client header, so PDF previews pass
  // ?client=<firm_client_id>. Resolve it server-side against the caller's firm
  // (same rule as the middleware) — fixes "Not found" in firm-client contexts.
  const clientParam = c.req.query('client');
  if (clientParam && !c.get('client_user_id') && user.firm_id) {
    const fc = await c.env.DB.prepare(
      'SELECT client_user_id FROM firm_clients WHERE firm_id = ? AND id = ? AND status = ?'
    ).bind(user.firm_id, clientParam, 'active').first<{ client_user_id: string }>();
    if (fc) tenantId = fc.client_user_id;
  }
  const row = await c.env.DB.prepare(
    'SELECT r2_key, file_type, original_name, filename FROM file_records WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(c.req.param('id'), tenantId).first();
  if (!row) return c.json({ error: 'Not found' }, 404);

  const obj = await c.env.FILE_BUCKET.get(row.r2_key as string);
  if (!obj) return c.json({ error: 'File not found in storage' }, 404);

  const downloadName = (row.original_name || row.filename || 'file') as string;
  const disposition = c.req.query('inline') === '1' ? 'inline' : 'attachment';
  return new Response(obj.body, {
    headers: {
      'Content-Type': (row.file_type as string) || 'application/octet-stream',
      'Content-Disposition': `${disposition}; filename="${downloadName}"`,
      'Content-Length': obj.size.toString(),
    },
  });
});

// Update metadata (rename, move folder, change description)
files.patch('/:id', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const id = c.req.param('id');
  const body = await c.req.json();

  const existing = await c.env.DB.prepare('SELECT id FROM file_records WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .bind(id, tenantId).first();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const allowedFields = ['filename', 'folder', 'description'];
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (allowedFields.includes(k)) {
      sets.push(`${k} = ?`);
      params.push(v);
    }
  }
  if (sets.length === 0) return c.json({ error: 'No valid fields' }, 400);
  sets.push("updated_at = datetime('now')");
  params.push(id, tenantId);

  await c.env.DB.prepare(`UPDATE file_records SET ${sets.join(', ')} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`)
    .bind(...params).run();

  const row = await c.env.DB.prepare(
    'SELECT id, folder, filename, original_name, file_type, file_size, description, ocr_status, category, created_at, updated_at FROM file_records WHERE id = ? AND deleted_at IS NULL'
  ).bind(id).first();
  return c.json(row);
});

// Delete (SOFT DELETE — sets deleted_at; requires 'higher' tier)
files.delete('/:id', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;

  if (!await requireHigherTier(c)) {
    return c.json({
      error: 'Only account owner or boss-level users can delete files',
      hint: 'Ask your admin to grant you higher permission, or ask them to perform the delete.',
    }, 403);
  }

  const existing = await c.env.DB.prepare(
    'SELECT id, r2_key, category FROM file_records WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(c.req.param('id'), tenantId).first<{ id: string; r2_key: string | null; category: string | null }>();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const now = new Date().toISOString();

  // Soft-delete the file record
  await c.env.DB.prepare(
    'UPDATE file_records SET deleted_at = ?, deleted_by = ? WHERE id = ? AND user_id = ?'
  ).bind(now, user.id, c.req.param('id'), tenantId).run();

  // Cascade: if this file was imported as a bank statement, soft-delete that statement too
  // (avoids orphan "pending review" drafts pointing to a deleted PDF)
  let statementsRemoved = 0;
  let transactionsRemoved = 0;
  if (existing.r2_key) {
    const stmtRes = await c.env.DB.prepare(
      'UPDATE bank_statements SET deleted_at = ?, deleted_by = ? WHERE r2_key = ? AND user_id = ? AND deleted_at IS NULL'
    ).bind(now, user.id, existing.r2_key, tenantId).run();
    statementsRemoved = stmtRes.meta?.changes || 0;
    if (statementsRemoved > 0) {
      // Also soft-delete the transactions on those statements
      const txRes = await c.env.DB.prepare(
        `UPDATE bank_transactions SET deleted_at = ?
         WHERE bank_statement_id IN (
           SELECT id FROM bank_statements WHERE r2_key = ? AND user_id = ? AND deleted_at IS NULL
         ) AND deleted_at IS NULL`
      ).bind(now, existing.r2_key, tenantId).run();
      transactionsRemoved = txRes.meta?.changes || 0;
    }
    // Also soft-delete invoices linked to this file (aligned with the recycle-bin
    // flow — invoices DO have a deleted_at column). They are restored together
    // with the file from the Recycle Bin. invoice_items are left in place.
    await c.env.DB.prepare(
      'UPDATE invoices SET deleted_at = ?, deleted_by = ? WHERE file_id = ? AND user_id = ? AND deleted_at IS NULL'
    ).bind(now, user.id, c.req.param('id'), tenantId).run();
  }

  await auditLog(c.env.DB, user.id, 'delete', 'file', c.req.param('id'), { category: existing.category, statements_removed: statementsRemoved });

  return c.json({
    success: true,
    restorable_until: new Date(Date.now() + 30 * 86400_000).toISOString(),
    statements_removed: statementsRemoved,
    transactions_removed: transactionsRemoved,
  });
});

// Run OCR via DeepSeek Vision API (supports images and PDFs)
async function runDeepseekOcr(base64: string, mimeType: string, apiKey: string): Promise<{ text: string; status: string }> {
  const dataUri = `data:${mimeType};base64,${base64}`;
  try {
    const resp = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Extract all visible text from this document. Return: document type, dates, amounts, company names, invoice numbers, item descriptions. Be thorough.' },
            { type: 'image_url', image_url: { url: dataUri } },
          ],
        }],
        max_tokens: 2000,
      }),
    });
    if (!resp.ok) return { text: '', status: 'failed' };
    const data = await resp.json() as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content || '';
    return { text, status: text.length > 10 ? 'completed' : 'unclear' };
  } catch {
    return { text: '', status: 'failed' };
  }
}

// DISABLED 2026-08-27: bulk reprocess was dangerous and UI-orphaned.
// It swept every file with ocr_status IN ('pending','skipped','failed') (up to
// 50 per call), ran GLM-OCR on each, and OVERWROTE category + folder — which
// would silently destroy files saved via `skip_ocr` (form attachments that the
// user explicitly wants left un-analyzed). No frontend page or component, no
// backend route, and no cron ever called it (verified by grep; the only
// dist hit was micromark's unrelated preprocess.js module).
// Per-file analysis goes through the explicit "Analyze" action
// (POST /file-storage/:id/import-document) instead.
// If ever revived: exclude ocr_status='skipped' from the WHERE clause.
/*
files.post('/reprocess', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;

  const rows = await db.prepare(
    "SELECT id, r2_key, filename, original_name, file_type FROM file_records WHERE user_id = ? AND (ocr_status IN ('pending','skipped','failed') OR category = '' OR category IS NULL) AND deleted_at IS NULL LIMIT 50"
  ).bind(tenantId).all();

  let processed = 0;
  let failed = 0;

  for (const row of (rows.results || []) as { id: string; r2_key: string; filename: string; original_name: string; file_type: string }[]) {
    try {
      const classification = classifyFile(row.original_name || row.filename, row.file_type);

      const isOcrCandidate = (row.file_type || '').includes('pdf') || (row.file_type || '').includes('image') || (row.file_type || '').includes('png') || (row.file_type || '').includes('jpg') || (row.file_type || '').includes('jpeg');

      let ocrText = '';
      let ocrStatus = 'skipped';

      if (isOcrCandidate) {
        const obj = await c.env.FILE_BUCKET.get(row.r2_key);
        if (obj && obj.size <= 10 * 1024 * 1024) {
          const buffer = await obj.arrayBuffer();
          const bytes = new Uint8Array(buffer);

          // Use GLM-OCR for both PDFs and images
          let binary = '';
          for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          const base64 = btoa(binary);
          const mimeType = row.file_type || 'application/pdf';
          if (c.env.GLM_API_KEY) {
            try {
              const glmResp = await fetch('https://api.z.ai/api/paas/v4/layout_parsing', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${c.env.GLM_API_KEY}` },
                body: JSON.stringify({ model: 'glm-ocr', file: `data:${mimeType};base64,${base64}` }),
              });
              if (glmResp.ok) {
                const glmData = await glmResp.json() as any;
                ocrText = typeof glmData === 'string' ? glmData : JSON.stringify(glmData);
                ocrStatus = ocrText.length > 20 ? 'completed' : 'unclear';
              } else {
                ocrStatus = 'failed';
              }
            } catch { ocrStatus = 'failed'; }
          } else {
            ocrStatus = 'skipped';
          }
        }
      }

      await db.prepare(
        "UPDATE file_records SET ocr_text = ?, ocr_status = ?, category = ?, folder = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
      ).bind(ocrText, ocrStatus, classification.category, classification.folder, row.id, tenantId).run();

      processed++;
    } catch {
      failed++;
    }
  }

  return c.json({ processed, failed, total: (rows.results || []).length });
});
*/

// Docker OCR worker updates OCR results for a file
files.post('/:id/ocr-result', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const id = c.req.param('id');
  const body = await c.req.json();
  const { ocr_text, ocr_status, category, folder } = body as { ocr_text?: string; ocr_status?: string; category?: string; folder?: string };

  const existing = await db.prepare('SELECT id FROM file_records WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .bind(id, tenantId).first();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const sets: string[] = [];
  const params: unknown[] = [];
  if (ocr_text !== undefined) { sets.push('ocr_text = ?'); params.push(ocr_text); }
  if (ocr_status !== undefined) { sets.push('ocr_status = ?'); params.push(ocr_status); }
  if (category !== undefined) { sets.push('category = ?'); params.push(category); }
  if (folder !== undefined) { sets.push('folder = ?'); params.push(folder); }
  if (sets.length === 0) return c.json({ error: 'No fields' }, 400);
  sets.push("updated_at = datetime('now')");
  params.push(id, tenantId);

  await db.prepare(`UPDATE file_records SET ${sets.join(', ')} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`).bind(...params).run();
  const row = await db.prepare('SELECT id, filename, ocr_status, ocr_text, category, folder FROM file_records WHERE id = ? AND deleted_at IS NULL').bind(id).first();

  // Auto-import bank statements / invoices when Docker worker provides good OCR
  // DISABLED — /import-document is the sole trigger for creating statements/invoices.
  const updatedCategory = category || (row as any)?.category || '';
  const updatedOcrStatus = ocr_status || (row as any)?.ocr_status || '';
  if (false && (updatedCategory === 'bank_statement' || updatedCategory === 'bank') && updatedOcrStatus === 'completed') {
    c.executionCtx.waitUntil(
      importStatementFromFile(id, tenantId, db, c.env.FILE_BUCKET, c.env.AI, llmKeysFromEnv(c.env), c.env.GLM_API_KEY)
    );
  }
  if (false && updatedCategory === 'invoice' && updatedOcrStatus === 'completed') {
    c.executionCtx.waitUntil(
      importInvoiceFromFile(id, tenantId, db, c.env.FILE_BUCKET, c.env.AI, llmKeysFromEnv(c.env), c.env.GLM_API_KEY)
    );
  }

  return c.json(row);
});

// Import a file as a bank statement (OCR + AI parse → bank_statement + bank_transactions)
files.post('/:id/import-statement', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const result = await importStatementFromFile(
    c.req.param('id'), tenantId, c.env.DB, c.env.FILE_BUCKET, c.env.AI, llmKeysFromEnv(c.env), c.env.GLM_API_KEY
  );
  if (!result.success) {
    const status = result.error === 'File not found' ? 404 : result.error === 'Statement already imported' ? 409 : 422;
    return c.json({ error: result.error, statement_id: result.statement_id, duplicate_info: result.duplicate_info }, status as any);
  }
  return c.json(result, 201);
});

// Import a file as an invoice (OCR + AI parse → invoice + invoice_items)
files.post('/:id/import-invoice', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const result = await importInvoiceFromFile(
    c.req.param('id'), tenantId, c.env.DB, c.env.FILE_BUCKET, c.env.AI, llmKeysFromEnv(c.env), c.env.GLM_API_KEY
  );
  if (!result.success) {
    const status = result.error === 'File not found' ? 404 : result.error?.includes('already exists') || result.error?.includes('already been imported') ? 409 : 422;
    return c.json({ error: result.error, invoice_id: result.invoice_id, duplicate_info: result.duplicate_info }, status as any);
  }
  return c.json(result, 201);
});


// ── Update file direction manually ──
files.patch('/:id/direction', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const id = c.req.param('id');
  const { direction } = await c.req.json();
  if (!['outgoing', 'incoming'].includes(direction)) {
    return c.json({ error: 'direction must be outgoing or incoming' }, 400);
  }
  await c.env.DB.prepare(
    'UPDATE file_records SET direction = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(direction, id, tenantId).run();
  return c.json({ success: true });
});

// DeepSeek Vision OCR — send images to DeepSeek Chat (supports vision)
files.post('/deepseek-vision', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const { images, prompt } = body as { images: string[]; prompt?: string };

  if (!images || images.length === 0) return c.json({ error: 'images array required (base64 data URIs)' }, 400);

  const defaultPrompt = `Extract all visible text from this bank statement. Return the data as JSON with:
- bank_name, account_number, statement_period (YYY-MM-DD to YYY-MM-DD)
- opening_balance (number), closing_balance (number)
- transactions: array of { transaction_date (YYY-MM-DD), description, deposit_amount (number, 0 if withdrawal), withdrawal_amount (number, 0 if deposit), balance (number or null) }
Return ONLY the JSON object, no other text.`;

  const content: any[] = [{ type: 'text', text: prompt || defaultPrompt }];
  for (const img of images) {
    content.push({ type: 'image_url', image_url: { url: img } });
  }

  try {
    const resp = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${c.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content }], max_tokens: 4000 }),
    });
    const respText = await resp.text();
    let data: any;
    try { data = JSON.parse(respText); } catch { data = { parse_error: true, raw: respText.slice(0, 1000) }; }

    if (!resp.ok) {
      return c.json({ error: 'DeepSeek API error', status: resp.status, detail: data }, 502);
    }

    const raw = data.choices?.[0]?.message?.content || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { raw };
    return c.json({ success: true, data: parsed, raw, usage: data.usage });
  } catch (e: any) {
    return c.json({ error: 'DeepSeek Vision failed: ' + (e.message || 'unknown') }, 500);
  }
});

// Z.AI GLM-OCR proxy — dedicated OCR model, supports PDF and images
files.post('/glm-ocr', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const { file_data, file_url } = body as { file_data?: string; file_url?: string };

  if (!file_data && !file_url) return c.json({ error: 'file_data (base64) or file_url required' }, 400);
  if (!c.env.GLM_API_KEY) return c.json({ error: 'GLM_API_KEY not configured' }, 500);

  try {
    const requestBody: any = { model: 'glm-ocr' };
    if (file_url) {
      requestBody.file = file_url;
    } else {
      requestBody.file = file_data;
    }

    const resp = await fetch('https://api.z.ai/api/paas/v4/layout_parsing', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${c.env.GLM_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
    });
    const respText = await resp.text();
    let data: any;
    try { data = JSON.parse(respText); } catch { data = { raw: respText }; }

    if (!resp.ok) {
      return c.json({ error: 'GLM-OCR API error', status: resp.status, detail: data }, 502);
    }

    return c.json({ success: true, data });
  } catch (e: any) {
    return c.json({ error: 'GLM-OCR failed: ' + (e.message || 'unknown') }, 500);
  }
});

// Run GLM-OCR on an uploaded file (downloads from R2, sends to Z.AI)
files.post('/:id/glm-ocr', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const id = c.req.param('id');

  const fileRow = await c.env.DB.prepare(
    'SELECT id, r2_key, filename, original_name, file_type, ocr_text FROM file_records WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(id, tenantId).first<{ id: string; r2_key: string; filename: string; original_name: string; file_type: string; ocr_text: string }>();
  if (!fileRow) return c.json({ error: 'File not found' }, 404);

  const obj = await c.env.FILE_BUCKET.get(fileRow.r2_key);
  if (!obj) return c.json({ error: 'File not found in storage' }, 404);
  if (!c.env.GLM_API_KEY) return c.json({ error: 'GLM_API_KEY not configured' }, 500);

  const buffer = await obj.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary);

  try {
    const resp = await fetch('https://api.z.ai/api/paas/v4/layout_parsing', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${c.env.GLM_API_KEY}`,
      },
      body: JSON.stringify({ model: 'glm-ocr', file: `data:${fileRow.file_type || 'application/pdf'};base64,${base64}` }),
    });
    const respText = await resp.text();
    let data: any;
    try { data = JSON.parse(respText); } catch { data = { raw: respText }; }

    if (!resp.ok) {
      return c.json({ error: 'GLM-OCR API error', status: resp.status, detail: data }, 502);
    }

    // Save OCR result to file_records (full GLM-OCR JSON)
    const ocrText = typeof data === 'string' ? data : JSON.stringify(data);
    await c.env.DB.prepare(
      "UPDATE file_records SET ocr_text = ?, ocr_status = 'completed', updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL"
    ).bind(ocrText.slice(0, 50000), id).run();

    // Also update linked bank_statement ocr_text
    await c.env.DB.prepare(
      "UPDATE bank_statements SET ocr_text = ?, updated_at = datetime('now') WHERE r2_key = (SELECT r2_key FROM file_records WHERE id = ? AND deleted_at IS NULL) AND deleted_at IS NULL"
    ).bind(ocrText.slice(0, 50000), id).run();

    return c.json({ success: true, file_id: id, ocr_result: data });
  } catch (e: any) {
    return c.json({ error: 'GLM-OCR failed: ' + (e.message || 'unknown') }, 500);
  }
});

// ── Card Statement import: OCR + Qwen-first LLM chain parsing ──
async function importCardStatementFromFile(
  fileId: string, userId: string, db: D1Database, fileBucket: R2Bucket, ai: any, llmKeys: LlmKeys, glmApiKey?: string,
): Promise<{ success: boolean; statement_id?: string; error?: string; transactions_count?: number; ocr_failed?: boolean; duplicate_info?: any; parsed_via_ai?: boolean; parse_failed?: boolean; ai_provider?: string | null; usage?: any; glm_usage?: any; ocr_source?: string; needs_review?: boolean; balance_check?: any; balance_status?: string; is_duplicate?: boolean; duplicate_status?: string | null }> {
  const fileRow = await db.prepare(
    'SELECT id, r2_key, filename, original_name, file_type, ocr_text, ocr_status FROM file_records WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(fileId, userId).first<{ id: string; r2_key: string; filename: string; original_name: string; file_type: string; ocr_text: string; ocr_status: string }>();
  if (!fileRow) return { success: false, error: 'File not found' };

  let ocrSource: 'tomarkdown' | 'glm-ocr' | 'pdf-text' = 'tomarkdown';
  let glmUsage: any = null; // hoisted above the GLM fallback (TDZ fix 2026-08-17)

  // Duplicate check
  const existing = await db.prepare(
    'SELECT id, card_issuer, period_start, period_end, file_name FROM card_statements WHERE user_id = ? AND r2_key = ? AND deleted_at IS NULL'
  ).bind(userId, fileRow.r2_key).first<{ id: string; card_issuer: string | null; period_start: string | null; period_end: string | null; file_name: string | null }>();
  if (existing) return {
    success: false, error: 'Statement already imported', statement_id: existing.id,
    duplicate_info: { type: 'card_statement', bank_name: existing.card_issuer, period: existing.period_start && existing.period_end ? `${existing.period_start} – ${existing.period_end}` : null, file_name: existing.file_name },
  };

  // Get OCR text
  let ocrText = fileRow.ocr_text || '';
  if ((!ocrText || ocrText.length < 20) && fileBucket && glmApiKey) {
    try {
      const obj = await fileBucket.get(fileRow.r2_key);
      if (obj) {
        const buffer = await obj.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = ''; for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const base64 = btoa(binary);
        const glmResp = await fetch('https://api.z.ai/api/paas/v4/layout_parsing', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${glmApiKey}` },
          body: JSON.stringify({ model: 'glm-ocr', file: `data:${fileRow.file_type || 'application/pdf'};base64,${base64}` }),
        });
        if (glmResp.ok) {
          const glmData = await glmResp.json() as any;
          glmUsage = glmData.usage || null;
          ocrText = typeof glmData === 'string' ? glmData : JSON.stringify(glmData);
        }
      }
    } catch {}
    if (ocrText) await db.prepare("UPDATE file_records SET ocr_text = ?, ocr_status = 'completed', updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL").bind(ocrText, fileId).run();
  }

  if (!ocrText || ocrText.length < 10) {
    const emptyId = `cs-${crypto.randomUUID().slice(0, 8)}`;
    await db.prepare(
      "INSERT INTO card_statements (id, user_id, file_name, file_type, r2_key, status) VALUES (?, ?, ?, ?, ?, 'draft')"
    ).bind(emptyId, userId, fileRow.original_name || fileRow.filename, fileRow.file_type, fileRow.r2_key).run();
    return { success: true, statement_id: emptyId, ocr_failed: true, error: 'Could not read this file automatically.' };
  }

  // Parse via the Qwen-first LLM chain (was DeepSeek-only)
  let parsed: any = null;
  let usage: any = null;
  let parseProvider: string | null = null;
  if (hasLlmKey(llmKeys)) {
    try {
      const cardPrompt = `Parse this credit card statement OCR text into structured JSON:

{
  "card_issuer": "HSBC / Standard Chartered / Hang Seng / Amex / etc",
  "card_network": "Visa / MasterCard / Amex / UnionPay",
  "card_number_last4": "last 4 digits if visible",
  "cardholder_name": "name on card",
  "currency": "HKD",
  "statement_year": 2026,
  "statement_month": 1,
  "period_start": "YYYY-MM-DD",
  "period_end": "YYYY-MM-DD",
  "credit_limit": number or null,
  "opening_balance": number or null,
  "closing_balance": number or null,
  "minimum_payment": number or null,
  "payment_due_date": "YYYY-MM-DD or null",
  "transactions": [
    {
      "transaction_date": "YYYY-MM-DD",
      "posting_date": "YYYY-MM-DD or null",
      "description": "merchant name / transaction description",
      "amount": number (always positive),
      "transaction_type": "purchase / payment / refund / fee / interest / cash_advance",
      "foreign_currency": "USD etc or null",
      "foreign_amount": number or null
    }
  ]
}

Rules:
- Card statements list purchases, payments, refunds, fees. All amounts are positive numbers.
- "payment" type = payment made to the card (reduces balance)
- "purchase" type = charged to card
- "refund" type = merchant refund credited to card
- "fee" type = annual fee, late fee, overlimit fee, etc
- "interest" type = finance charges, interest
- "cash_advance" type = cash withdrawal from card
- IMPORTANT: opening_balance is the balance carried forward from the previous statement. Look for "Previous Balance", "Balance B/F", "Opening Balance", "上月結欠", "上期結欠", "承前結欠" — this is the starting amount owed at the beginning of the period.
- IMPORTANT: closing_balance is the NEW balance at the end of this statement (what you currently owe). Look for "Closing Balance", "New Balance", "Current Balance", "Statement Balance", "今期結欠", "總結欠", "本月結欠".
- The OCR text may NOT explicitly label opening_balance — if only "Previous Balance" is shown, use that as opening_balance.
- Transactions often list date, description/merchant, and amount
- If no transaction detail, return empty transactions array
- Return valid JSON only, no markdown

OCR text:
${ocrText.slice(0, 12000)}`;
      const result = await llmCompleteJson(llmKeys, cardPrompt, 'card:tomarkdown');
      parsed = result.parsed;
      parseProvider = result.provider;
    } catch (e: any) { console.log('[PARSE-CARD|tomarkdown] Error:', e.message); }
  }

  // ── GLM-OCR retry on balance mismatch ──
  if (parsed && glmApiKey && (parsed.opening_balance != null) && (parsed.closing_balance != null)) {
    const txs = parsed.transactions || [];
    const totalCharges = txs.reduce((s: number, t: any) => {
      const amt = Number(t.amount || 0);
      const tt = (t.transaction_type || '').toLowerCase();
      return s + (tt === 'payment' || tt === 'refund' ? -amt : amt);
    }, 0);
    const preComputed = (parsed.opening_balance ?? 0) + totalCharges;
    if (Math.abs(preComputed - parsed.closing_balance) > 0.01) {
      console.log('[RETRY|tomarkdown→GLM] Card balance mismatch, retrying with GLM-OCR...');
      try {
        const obj = await fileBucket.get(fileRow.r2_key);
        if (obj) {
          const buffer = await obj.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let binary = ''; for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          const base64 = btoa(binary);
          const mimeType = fileRow.file_type || 'application/pdf';

          let glmResp: Response | null = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 3000));
            glmResp = await fetch('https://api.z.ai/api/paas/v4/layout_parsing', {
              method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${glmApiKey}` },
              body: JSON.stringify({ model: 'glm-ocr', file: `data:${mimeType};base64,${base64}` }),
            });
            if (glmResp.status !== 429) break;
          }

          if (glmResp?.ok) {
            const glmData = await glmResp.json() as any;
            const glmUsageData = glmData.usage || null;
            const pages = glmData?.layout_details || [];
            const parts: string[] = [];
            for (const p of pages) {
              for (const el of p) {
                if (el.label === 'table' && el.content) parts.push(el.content);
                else if (el.label === 'text' && el.content) {
                  const x = el.bbox_2d?.[0] || 0;
                  parts.push(`[${x < 600 ? 'L' : x < 1200 ? 'M' : 'R'}] ${el.content}`);
                }
              }
              parts.push('');
            }
            const glmFormatted = parts.join('\n').trim();

            if (glmFormatted.length > 20) {
              const cardRetryPrompt = `Parse this card statement OCR into JSON. Fields: card_issuer, card_network, card_number_last4, cardholder_name, currency, statement_year, statement_month, period_start, period_end (YYYY-MM-DD), credit_limit, opening_balance, closing_balance, minimum_payment, payment_due_date, transactions: [{ transaction_date, posting_date, description, amount, transaction_type }]. IMPORTANT: Positional format [L/M/R] and HTML tables preserve column alignment. Return ONLY valid JSON.\n\nOCR:\n${glmFormatted.slice(0, 8000)}`;
              const retryResult = await llmCompleteJson(llmKeys, cardRetryPrompt, 'card:glm-ocr');
              let retryParsed: any = retryResult.parsed;

              if (retryParsed?.transactions?.length > 0) {
                const rtTxs = retryParsed.transactions || [];
                const rtChange = rtTxs.reduce((s: number, t: any) => {
                  const amt = Number(t.amount || 0);
                  const tt = (t.transaction_type || '').toLowerCase();
                  return s + (tt === 'payment' || tt === 'refund' ? -amt : amt);
                }, 0);
                const rtComputed = (retryParsed.opening_balance ?? 0) + rtChange;
                if (retryParsed.closing_balance == null || Math.abs(rtComputed - retryParsed.closing_balance) <= 0.01) {
                  console.log('[PARSE-CARD|glm-ocr] Balance passed, using retry result');
                  parsed = retryParsed;
                  parseProvider = retryResult.provider;
                  glmUsage = glmUsageData;
                  ocrText = glmFormatted;
                  ocrSource = 'glm-ocr';
                }
              }
            }
          }
        }
      } catch (e: any) { console.log('[RETRY|GLM-OCR] Card error:', e?.message || String(e)); }
    }
  }

  // Insert card statement first (FK constraint: transactions reference this)
  const stmtId = `cs-${crypto.randomUUID().slice(0, 8)}`;
  await db.prepare(
    `INSERT INTO card_statements (id, user_id, file_name, file_type, r2_key, ocr_text, ocr_source,
     card_issuer, card_network, card_number_last4, cardholder_name, currency,
     statement_year, statement_month, period_start, period_end,
     credit_limit, opening_balance, closing_balance, minimum_payment, payment_due_date, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(stmtId, userId, fileRow.original_name || fileRow.filename, fileRow.file_type, fileRow.r2_key, ocrText, ocrSource,
    parsed?.card_issuer || null, parsed?.card_network || null, parsed?.card_number_last4 || null,
    parsed?.cardholder_name || null, parsed?.currency || 'HKD',
    parsed?.statement_year || null, parsed?.statement_month || null,
    parsed?.period_start || null, parsed?.period_end || null,
    parsed?.credit_limit ?? null, parsed?.opening_balance ?? null, parsed?.closing_balance ?? null,
    parsed?.minimum_payment ?? null, parsed?.payment_due_date || null, 'active').run();

  let txCount = 0;
  let netChange = 0;
  if (parsed?.transactions && Array.isArray(parsed.transactions)) {
    for (let i = 0; i < parsed.transactions.length; i++) {
      const tx = parsed.transactions[i];
      await db.prepare(
        `INSERT INTO card_transactions (id, card_statement_id, user_id, transaction_date, posting_date,
         description, amount, transaction_type, foreign_currency, foreign_amount, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(`ct-${crypto.randomUUID().slice(0, 8)}`, stmtId, userId,
        tx.transaction_date, tx.posting_date || null, tx.description || '',
        tx.amount || 0, tx.transaction_type || null, tx.foreign_currency || null,
        tx.foreign_amount || null, i).run();
      txCount++;
      // Accumulate net change: purchases increase balance, payments/refunds decrease it
      const txType = (tx.transaction_type || '').toLowerCase();
      const amt = Number(tx.amount || 0);
      netChange += (txType === 'payment' || txType === 'refund') ? -amt : amt;
    }
  }

  // ── Balance validation: verify opening + net change = closing ──
  const csOpening = parsed?.opening_balance ?? null;
  const csClosing = parsed?.closing_balance ?? null;
  let csBalanceOk = true;
  let csBalanceMismatch: { expected: number; actual: number; diff: number } | null = null;
  if (csOpening != null && csClosing != null && txCount > 0) {
    const expectedClosing = csOpening + netChange;
    if (Math.abs(expectedClosing - csClosing) > 0.01) {
      csBalanceOk = false;
      csBalanceMismatch = { expected: expectedClosing, actual: csClosing, diff: csClosing - expectedClosing };
    }
  }

  // Update status based on balance validation.
  // Defense-in-depth (same as bank statements): a total parse failure lands
  // as a draft instead of a silently-ACTIVE zero-transaction statement.
  const csFinalStatus = (parsed == null || !csBalanceOk) ? 'draft' : 'active';
  await db.prepare(
    `UPDATE card_statements SET status = ?, balance_status = ?, balance_check = ?, updated_at = datetime('now')
     WHERE id = ? AND user_id = ?`
  ).bind(csFinalStatus, csBalanceOk ? 'ok' : 'mismatch',
    csBalanceMismatch ? JSON.stringify(csBalanceMismatch) : null,
    stmtId, userId).run();

  return { success: true, statement_id: stmtId, transactions_count: txCount, parsed_via_ai: !!parsed, parse_failed: parsed == null, ai_provider: parseProvider, usage, glm_usage: glmUsage,
    ocr_source: ocrSource, needs_review: !csBalanceOk, balance_check: csBalanceMismatch, balance_status: csBalanceOk ? 'ok' : 'mismatch' };
}

// ── Smart document import: detect bank statement vs invoice, dispatch to right importer ──
files.post('/:id/import-document', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const fileId = c.req.param('id');
  const db = c.env.DB;
  const force = c.req.query('force') === 'true';
  const directionQuery = c.req.query('direction');
  const directionOverride = (directionQuery === 'outgoing' || directionQuery === 'incoming') ? directionQuery : null;
  // Hoisted to the top: the empty-OCR fallback below uses this before the type-decision
  // section used to declare it (TDZ ReferenceError — fixed 2026-08-17).
  const forcedType = c.req.query('type') || '';
  // Diagnostic: why did the pdf.js text-layer attempt fail (if it did)?
  let pdfTextDiag: string | null = null;

  // Get the file's OCR text (or run OCR first if missing)
  // Retry up to 3 times with 500ms delay — D1 has eventual consistency
  let fileRow: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    fileRow = await db.prepare(
      'SELECT id, r2_key, original_name, file_type, ocr_text, category, content_hash FROM file_records WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    ).bind(fileId, tenantId).first();
    if (fileRow) break;
    if (attempt < 2) await new Promise(r => setTimeout(r, 600));
  }
  if (!fileRow) return c.json({ error: 'File not found' }, 404);

  // force=true: user explicitly said "upload again" on duplicate warning.
  // Delete any existing invoice OR bank statement linked to this file so re-import succeeds cleanly.
  if (force) {
    // Delete linked invoices (invoice_items cascade via FK)
    await db.prepare('DELETE FROM invoices WHERE file_id = ? AND user_id = ?').bind(fileId, tenantId).run();
    // Soft-delete linked bank statements (by r2_key)
    if (fileRow.r2_key) {
      const existingStmt = await db.prepare(
        'SELECT id FROM bank_statements WHERE r2_key = ? AND user_id = ? AND deleted_at IS NULL'
      ).bind(fileRow.r2_key, tenantId).first<{ id: string }>();
      if (existingStmt) {
        const now = new Date().toISOString();
        await db.prepare('UPDATE bank_statements SET deleted_at = ?, deleted_by = ? WHERE id = ? AND user_id = ?')
          .bind(now, user.id, existingStmt.id, tenantId).run();
        await db.prepare('UPDATE bank_transactions SET deleted_at = ? WHERE bank_statement_id = ? AND user_id = ? AND deleted_at IS NULL')
          .bind(now, existingStmt.id, tenantId).run();
      }
    }
    // Clear OCR cache so it re-runs fresh
    await db.prepare("UPDATE file_records SET ocr_text = '', ocr_text_source = NULL, ocr_status = 'pending' WHERE id = ? AND user_id = ? AND deleted_at IS NULL")
      .bind(fileId, tenantId).run();
    // Re-fetch fileRow with cleared OCR
    fileRow = await db.prepare(
      'SELECT id, r2_key, original_name, file_type, ocr_text, category FROM file_records WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    ).bind(fileId, tenantId).first<{ id: string; r2_key: string; original_name: string; file_type: string; ocr_text: string; category: string }>() || fileRow;
  }

  // ── Filename-based pre-classification (runs before OCR, very reliable) ──────
  const fname = (fileRow.original_name || fileRow.filename || '').toLowerCase();
  let filenameBank = 0;
  let filenameInvoice = 0;
  // Filename hints are tie-breakers only (1 pt each).
  // OCR content is the primary signal — a misleading filename must not override it.
  if (/e[-_]?statement|bank.*statement|statement.*\d{6,8}/.test(fname)) filenameBank += 1;
  if (/deposit\s*(rs|jl|slip)|credit\s*advice/.test(fname)) filenameBank += 1;
  if (/invoice|inv\d|#e\d|inv022|inv-|tax\s*invoice/i.test(fname)) filenameInvoice += 1;
  if (/receipt|rec\d/i.test(fname)) filenameInvoice += 2; // receipts go through invoice flow

  let ocrText = fileRow.ocr_text || '';
  if (!ocrText || ocrText.length < 20) {
    const obj = await c.env.FILE_BUCKET.get(fileRow.r2_key);
    if (obj) {
      const buffer = await obj.arrayBuffer();
      const mimeType = fileRow.file_type || 'application/pdf';

      // Attempt 0: pdf.js text-layer extraction (free, deterministic — best
      // for text-based PDFs like Pastel/VEII/EHSIA; scans fall through)
      if (mimeType === 'application/pdf') {
        try {
          const pdfText = await extractPdfText(new Uint8Array(buffer));
          if (pdfText && isMeaningfulPdfText(pdfText)) {
            ocrText = pdfText;
            console.log('[OCR|pdf-text] Import-doc succeeded, length:', ocrText.length, 'preview:', ocrText.slice(0, 200));
            await db.prepare("UPDATE file_records SET ocr_text = ?, ocr_text_source = 'pdf-text', ocr_status = 'completed', updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL").bind(ocrText, fileId).run();
          } else {
            pdfTextDiag = pdfText
              ? `extracted ${pdfText.length} chars but failed isMeaningfulPdfText`
              : `extractPdfText returned null${lastPdfTextError ? ' — ' + lastPdfTextError : ''}`;
          }
        } catch (e: any) {
          pdfTextDiag = e?.message || String(e);
          console.log('[OCR|pdf-text] Import-doc failed:', pdfTextDiag);
        }
      }

      // Attempt 1: Cloudflare AI Workers toMarkdown — best for text-layer PDFs (fast, free)
      if ((!ocrText || ocrText.length < 20) && c.env.AI) {
        try {
          const mdResult = await (c.env.AI as any).toMarkdown([{
            name: fileRow.original_name || fileRow.filename || 'file.pdf',
            blob: new Blob([buffer], { type: mimeType }),
          }]);
          const candidate = Array.isArray(mdResult)
            ? mdResult.map((r: any) => r?.data || r?.content || '').join('\n')
            : String(mdResult || '');
          if (candidate && candidate.length > 20) {
            if (isPdfMetadataOnly(candidate)) {
              console.log('[OCR|tomarkdown] Import-doc: only PDF metadata, using GLM-OCR');
              // Check if this is an encrypted PDF that toMarkdown can't read
              const isEncrypted = await (async () => {
                try {
                  const bytes = new Uint8Array(buffer);
                  if (needsDecryption(bytes)) return true;
                } catch { return false; }
                return false;
              })();
              if (isEncrypted) {
                // HSBC-style empty-password encryption — try silent decryption and re-OCR
                // before falling back to the password modal
                const dec = await fetchAndDecryptFile(fileRow.r2_key, mimeType, c.env.FILE_BUCKET);
                if (dec && !dec.needsPassword) {
                  try {
                    const decryptedBytes = Uint8Array.from(atob(dec.base64), ch => ch.charCodeAt(0));
                    const mdResult2 = await (c.env.AI as any).toMarkdown([{
                      name: fileRow.original_name || fileRow.filename || 'file.pdf',
                      blob: new Blob([decryptedBytes], { type: mimeType }),
                    }]);
                    const candidate2 = Array.isArray(mdResult2)
                      ? mdResult2.map((r: any) => r?.data || r?.content || '').join('\n')
                      : String(mdResult2 || '');
                    if (candidate2 && candidate2.length > 20 && !isPdfMetadataOnly(candidate2)) {
                      ocrText = candidate2;
                      console.log('[OCR|tomarkdown] Import-doc: decrypted PDF, re-OCR succeeded, length:', ocrText.length);
                      await db.prepare(
                        "UPDATE file_records SET ocr_text = ?, ocr_text_source = 'pdf-text', ocr_status = 'completed', updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL"
                      ).bind(ocrText, fileId).run();
                    }
                  } catch (e: any) {
                    console.log('[OCR|tomarkdown] Import-doc: decrypted re-OCR failed:', e?.message || e);
                  }
                }
                if (!ocrText || ocrText.length < 20) {
                  await c.env.DB.prepare(
                    "UPDATE file_records SET ocr_text = ?, ocr_status = 'encrypted', updated_at = datetime('now') WHERE id = ?"
                  ).bind(candidate.slice(0, 50000), fileId).run();
                  return c.json({
                    type: 'encrypted_pdf',
                    success: false,
                    error: 'This PDF is encrypted. Please enter the password to unlock it for OCR scanning.',
                    status: 'password_required',
                    file_id: fileId,
                  });
                }
              }
              // Not encrypted — just a bad scan, fall through to GLM-OCR
            } else {
              ocrText = candidate;
              console.log('[OCR|tomarkdown] Import-doc succeeded, length:', ocrText.length, 'preview:', ocrText.slice(0, 200));
              await db.prepare("UPDATE file_records SET ocr_text = ?, ocr_text_source = 'tomarkdown', ocr_status = 'completed', updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL").bind(ocrText, fileId).run();
            }
          }
        } catch (e: any) {
          console.log('[OCR|tomarkdown] Import-doc failed:', e?.message || e);
        }
      }

      // Attempt 2: GLM-OCR — for scanned/image PDFs
      if ((!ocrText || ocrText.length < 20) && c.env.GLM_API_KEY) {
        try {
          const bytes = new Uint8Array(buffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          const base64 = btoa(binary);
          const glmResp = await fetch('https://api.z.ai/api/paas/v4/layout_parsing', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${c.env.GLM_API_KEY}` },
            body: JSON.stringify({ model: 'glm-ocr', file: `data:${mimeType};base64,${base64}` }),
          });
          if (glmResp.ok) {
            const glmData = await glmResp.json() as any;
            const candidate = extractTextFromGlmOcr(glmData);
            console.log('[OCR|GLM-OCR] Import-doc result:', candidate.slice(0, 200));
            if (candidate && candidate.length > 20) {
              ocrText = candidate;
              await db.prepare("UPDATE file_records SET ocr_text = ?, ocr_text_source = 'glm-ocr', ocr_status = 'completed', updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL").bind(ocrText, fileId).run();
            }
          }
        } catch (e: any) {
          console.log('[OCR|GLM-OCR] Import-doc error:', e?.message || e);
        }
      }
    }
  }

  // If BOTH OCR methods failed but filename clearly says bank statement → create empty draft
  // If filename clearly says invoice → fall through to invoice empty draft below
  // If still no text and filename is ambiguous → create bank statement draft (safer default)
  if (!ocrText || ocrText.length < 10) {
    // If caller forced a type, respect it regardless of filename hints
    if (forcedType) {
      if (forcedType === 'card_statement') {
        const result = await importCardStatementFromFile(
          fileId, tenantId, db, c.env.FILE_BUCKET, c.env.AI, llmKeysFromEnv(c.env), c.env.GLM_API_KEY
        );
        return c.json({ type: 'card_statement', ...result, scores: { bankScore: filenameBank, invoiceScore: filenameInvoice, cardScore: 0 } }, result.success ? 201 : 422 as any);
      }
      if (forcedType === 'invoice') {
        const result = await importInvoiceFromFile(
          fileId, tenantId, db, c.env.FILE_BUCKET, c.env.AI, llmKeysFromEnv(c.env), c.env.GLM_API_KEY, directionOverride
        );
        return c.json({ type: 'invoice', ...result, scores: { bankScore: filenameBank, invoiceScore: filenameInvoice }, pdf_text_diag: pdfTextDiag }, result.success ? 201 : 422 as any);
      }
      // forcedType === 'bank_statement' — fall through to default below
    } else if (filenameInvoice > filenameBank) {
      // Let importInvoiceFromFile handle the empty invoice draft
      const result = await importInvoiceFromFile(
        fileId, tenantId, db, c.env.FILE_BUCKET, c.env.AI, llmKeysFromEnv(c.env), c.env.GLM_API_KEY, directionOverride
      );
      return c.json({ type: 'invoice', ...result, scores: { bankScore: filenameBank, invoiceScore: filenameInvoice }, pdf_text_diag: pdfTextDiag }, result.success ? 201 : 422 as any);
    }
    // Default: bank statement empty draft
    const dupCheck = await db.prepare(
      'SELECT id, bank_name, period_start, period_end, file_name FROM bank_statements WHERE user_id = ? AND r2_key = ? AND deleted_at IS NULL'
    ).bind(tenantId, fileRow.r2_key).first<{ id: string; bank_name: string | null; period_start: string | null; period_end: string | null; file_name: string | null }>();
    if (dupCheck) {
      return c.json({
        type: 'bank_statement',
        error: 'Statement already imported',
        statement_id: dupCheck.id,
        duplicate_info: {
          type: 'bank_statement',
          bank_name: dupCheck.bank_name,
          period: dupCheck.period_start && dupCheck.period_end ? `${dupCheck.period_start} – ${dupCheck.period_end}` : null,
          file_name: dupCheck.file_name,
        },
      }, 409);
    }
    const emptyId = `bs-${crypto.randomUUID().slice(0, 8)}`;
    const inferredBank = inferBankName(fileRow.original_name || '');
    await db.prepare(
      `INSERT INTO bank_statements (id, user_id, file_name, r2_key, bank_name, currency, status,
       opening_balance, closing_balance, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'HKD', 'draft', 0, 0, datetime('now'), datetime('now'))`
    ).bind(emptyId, tenantId, fileRow.original_name, fileRow.r2_key, inferredBank).run();
    return c.json({
      type: 'bank_statement',
      statement_id: emptyId,
      ocr_failed: true,
      message: 'Could not read this file automatically. Please enter the transactions manually on the review page.',
    }, 201);
  }

  // Detect document type from OCR text content (add filename pre-scores as baseline)
  const lower = ocrText.toLowerCase();
  let bankScore = filenameBank;
  let invoiceScore = filenameInvoice;
  let cardScore = 0;

  // Bank statement signals
  if (/statement\s+of\s+account/i.test(ocrText)) bankScore += 3;
  if (/account\s+activities/i.test(ocrText)) bankScore += 3;
  if (/business\s+direct\s+statement/i.test(ocrText)) bankScore += 3;
  if (/opening\s+balance|closing\s+balance|b\/f\s*balance|c\/f\s*balance/i.test(ocrText)) bankScore += 2;
  if (/(deposit|withdrawal|debit|credit)/i.test(ocrText) && (lower.match(/balance/g) || []).length >= 2) bankScore += 2;
  if (/transaction\s+(details|date|history)/i.test(ocrText)) bankScore += 1;
  if (/(hsbc|standard\s+chartered|citibank|hang\s+seng|bank\s+of\s+china|dbs)/i.test(ocrText)) bankScore += 1;
  // Penalize bank score for card-specific signals
  if (/credit\s+card|信用卡|card\s+statement/i.test(ocrText)) { bankScore -= 2; cardScore += 4; }

  // Invoice signals
  if (/\binvoice\b/i.test(ocrText)) invoiceScore += 3; // bumped: strong signal
  if (/invoice\s*(no|number|#)/i.test(ocrText)) invoiceScore += 3;
  // Handle garbled OCR: "B I L L   T O" or "B I L L T O"
  if (/bill\s*to|b\s*i\s*l\s*l\s*t\s*o/i.test(ocrText)) invoiceScore += 3;
  if (/\breceipt\b/i.test(ocrText)) invoiceScore += 2;
  if (/(due\s*date|payment\s*terms|net\s*\d+\s*days)/i.test(ocrText)) invoiceScore += 2;
  if (/(subtotal|total\s*due|total\s*amount)/i.test(ocrText)) invoiceScore += 1;
  if (/(unit\s*price|qty|quantity)/i.test(ocrText)) invoiceScore += 2; // bumped: line items = invoice
  // Demote card when invoice signals present — credit card as payment method ≠ card statement
  if (/\binvoice\b/i.test(ocrText) && /credit\s+card|visa|mastercard/i.test(ocrText)) {
    invoiceScore += 4; // invoice mentioning card = invoice paid by card, not card statement
    cardScore -= 4;
  }

  // Card statement signals
  if (/credit\s+card\s+statement|信用卡.*月結|信用卡.*月结|card\s+statement/i.test(ocrText)) cardScore += 5;
  if (/(american\s+express|amex)/i.test(ocrText)) cardScore += 3;
  if (/visa\s*(card|platinum|gold|signature|infinite)?/i.test(ocrText)) cardScore += 2;
  if (/mastercard|master\s*card/i.test(ocrText)) cardScore += 2;
  if (/unionpay|銀聯|银联/i.test(ocrText)) cardScore += 2;
  if (/credit\s+limit/i.test(ocrText)) cardScore += 3;
  if (/minimum\s+payment/i.test(ocrText)) cardScore += 3;
  // "payment due date" alone is common on invoices too — require card context
  if (/payment\s+due\s+date/i.test(ocrText) && /credit\s+card|信用卡|card/i.test(ocrText)) cardScore += 2;
  if (/finance\s+charge|interest\s+charge|late\s+payment\s+fee/i.test(ocrText)) cardScore += 2;
  if (/cash\s+advance/i.test(ocrText)) cardScore += 2;
  if (/card\s+number|card\s+(no|#)|cardholder|card\s+holder/i.test(ocrText)) cardScore += 2;
  if (/previous\s+balance|new\s+balance|outstanding\s+balance/i.test(ocrText)) { cardScore += 2; bankScore -= 1; }
  if (/(purchase|payment.*received|refund|annual\s+fee)/i.test(ocrText) && /credit\s+card|信用卡|card/i.test(ocrText)) cardScore += 1;

  // 3-way decision (or use forced type from caller — declared at the top of the handler)
  let type: string;
  if (forcedType === 'bank_statement' || forcedType === 'card_statement' || forcedType === 'invoice') {
    type = forcedType;
    console.log(`[SMART-IMPORT] file=${fileId} type forced to ${type} by caller`);
  } else if (cardScore > bankScore && cardScore > invoiceScore && cardScore >= 5) {
    type = 'card_statement';
  } else if (bankScore > invoiceScore) {
    type = 'bank_statement';
  } else {
    type = 'invoice';
  }
  console.log(`[SMART-IMPORT] file=${fileId} bankScore=${bankScore} invoiceScore=${invoiceScore} cardScore=${cardScore} → ${type}`);

  // Duplicate detection: check content_hash for soft duplicate flag
  // (individual import functions handle the actual duplicate logic — never block here)
  let hashDuplicate = false, hashDuplicateId: string | null = null;
  if (fileRow.content_hash && !force) {
    const existingFile = await db.prepare(
      `SELECT id FROM file_records WHERE user_id = ? AND content_hash = ? AND id != ? AND deleted_at IS NULL`
    ).bind(tenantId, fileRow.content_hash, fileId).first<{ id: string }>();
    if (existingFile) {
      hashDuplicate = true;
      hashDuplicateId = existingFile.id;
    }
  }

  if (type === 'card_statement') {
    const result = await importCardStatementFromFile(
      fileId, tenantId, db, c.env.FILE_BUCKET, c.env.AI, llmKeysFromEnv(c.env), c.env.GLM_API_KEY
    );
    if (!result.success) {
      const status = result.error === 'File not found' ? 404 : result.error === 'Statement already imported' ? 409 : 422;
      return c.json({ type, error: result.error, statement_id: result.statement_id, duplicate_info: result.duplicate_info, scores: { bankScore, invoiceScore, cardScore } }, status as any);
    }
    // If type was force-overridden, always mark as draft regardless of balance
    if (forcedType && result.statement_id) {
      await db.prepare("UPDATE card_statements SET status = 'draft' WHERE id = ? AND user_id = ?")
        .bind(result.statement_id, tenantId).run();
    }
    result.is_duplicate = result.is_duplicate || hashDuplicate;
    if (hashDuplicate && !result.duplicate_status) result.duplicate_status = 'active';
    console.log(`[SMART-IMPORT] file=${fileId} → card_statement ocrSource=${result.ocr_source || 'unknown'}`);
    return c.json({ type, ...result, scores: { bankScore, invoiceScore, cardScore }, ocr_text: ocrText,
      needs_review: !!(forcedType || result.needs_review) }, 201);
  }

  if (type === 'bank_statement') {
    const result = await importStatementFromFile(
      fileId, tenantId, db, c.env.FILE_BUCKET, c.env.AI, llmKeysFromEnv(c.env), c.env.GLM_API_KEY
    );
    if (!result.success) {
      const status = result.error === 'File not found' ? 404 : result.error === 'Statement already imported' ? 409 : 422;
      return c.json({ type, error: result.error, statement_id: result.statement_id, duplicate_info: result.duplicate_info, scores: { bankScore, invoiceScore, cardScore } }, status as any);
    }
    console.log(`[IMPORT-DOC] bank force path: forcedType=${forcedType} statement_id=${result.statement_id} needs_review=${result.needs_review} balance_check=${JSON.stringify(result.balance_check)}`);
    // If type was force-overridden, always mark as draft regardless of balance
    if (forcedType && result.statement_id) {
      console.log(`[IMPORT-DOC] forcing draft status for ${result.statement_id}`);
      await db.prepare("UPDATE bank_statements SET status = 'draft' WHERE id = ? AND user_id = ?")
        .bind(result.statement_id, tenantId).run();
    }
    result.is_duplicate = result.is_duplicate || hashDuplicate;
    if (hashDuplicate && !result.duplicate_status) result.duplicate_status = 'active';
    console.log(`[SMART-IMPORT] file=${fileId} → bank_statement ocrSource=${result.ocr_source || 'unknown'}`);
    return c.json({ type, ...result, scores: { bankScore, invoiceScore, cardScore }, ocr_text: ocrText,
      needs_review: !!(forcedType || result.needs_review) }, 201);
  } else {
    const result = await importInvoiceFromFile(
      fileId, tenantId, db, c.env.FILE_BUCKET, c.env.AI, llmKeysFromEnv(c.env), c.env.GLM_API_KEY, directionOverride
    );
    if (!result.success) {
      const status = result.error === 'File not found' ? 404 : result.error?.includes('already exists') || result.error?.includes('already been imported') ? 409 : 422;
      return c.json({ type, error: result.error, invoice_id: result.invoice_id, duplicate_info: result.duplicate_info, scores: { bankScore, invoiceScore, cardScore } }, status as any);
    }
    // If type was force-overridden, always mark as draft regardless of total match
    if (forcedType && result.invoice_id) {
      await db.prepare("UPDATE invoices SET status = 'draft' WHERE id = ? AND user_id = ?")
        .bind(result.invoice_id, tenantId).run();
    }
    result.is_duplicate = result.is_duplicate || hashDuplicate;
    if (hashDuplicate && !result.duplicate_status) result.duplicate_status = 'active';
    console.log(`[SMART-IMPORT] file=${fileId} → invoice ocrSource=${result.ocr_source || 'unknown'}`);
    return c.json({ type, ...result, scores: { bankScore, invoiceScore, cardScore }, ocr_text: ocrText,
      needs_review: !!(forcedType || result.needs_direction_review || result.company_not_detected || result.total_mismatch || result.needs_review),
      pdf_text_diag: pdfTextDiag, __build: 'diag-v3' }, 201);
  }
});

// ── Encrypted PDF password prompt ─────────────────────────────────────────
// POST /:id/try-decrypt — user provides a password, we attempt decryption + re-import
files.post('/:id/try-decrypt', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const fileId = c.req.param('id');
  const { password } = await c.req.json<{ password: string }>();

  if (!password) return c.json({ error: 'Password required' }, 400);

  const fileRow = await c.env.DB.prepare(
    'SELECT id, r2_key, file_type, original_name, category FROM file_records WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(fileId, tenantId).first<{ id: string; r2_key: string; file_type: string; original_name: string; category: string }>();
  if (!fileRow) return c.json({ error: 'File not found' }, 404);

  const obj = await c.env.FILE_BUCKET.get(fileRow.r2_key);
  if (!obj) return c.json({ error: 'File data not available' }, 404);

  const buffer = await obj.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  if (!needsDecryption(bytes)) {
    return c.json({ error: 'This PDF is not encrypted', status: 'not_encrypted' }, 400);
  }

  // Try to extract text directly with pdfjs-dist (handles decryption + text extraction)
  const ocrText = await extractPdfTextWithPassword(bytes, password);

  if (!ocrText) {
    return c.json({
      success: false,
      message: 'Wrong password — could not decrypt this PDF. Please check your password and try again.',
      status: 'wrong_password',
    });
  }

  console.log(`[PDF-DECRYPT] Successfully decrypted file ${fileId}, extracted ${ocrText.length} chars of text`);

  // Store decrypted OCR text and update file record
  await c.env.DB.prepare(
    "UPDATE file_records SET ocr_text = ?, ocr_text_source = 'pdf-text', ocr_status = 'completed', updated_at = datetime('now') WHERE id = ?"
  ).bind(ocrText.slice(0, 50000), fileId).run();

  // Re-trigger import based on category
  let importResult: any = { success: false };
  if (fileRow.category === 'bank_statement') {
    importResult = await importStatementFromFile(fileId, tenantId, c.env.DB, c.env.FILE_BUCKET, c.env.AI, llmKeysFromEnv(c.env), c.env.GLM_API_KEY);
  } else if (fileRow.category === 'invoice') {
    importResult = await importInvoiceFromFile(fileId, tenantId, c.env.DB, c.env.FILE_BUCKET, c.env.AI, llmKeysFromEnv(c.env), c.env.GLM_API_KEY);
  }

  return c.json({
    success: true,
    message: 'File decrypted and processed successfully',
    ocr_text_length: ocrText.length,
    import: importResult,
  });
});

// ── Diagnostic endpoint: trace full OCR→DeepSeek pipeline for a file ──────────
// Mirrors the PRODUCTION pipeline: toMarkdown → DeepSeek → balance check →
// ONLY if mismatch → GLM-OCR → DeepSeek re-parse
files.post('/debug-pipeline', authMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const { file_id, force_glm } = await c.req.json();

  if (!file_id) return c.json({ error: 'file_id required' }, 400);

  const db = c.env.DB;
  const fileBucket = c.env.FILE_BUCKET;
  const ai = c.env.AI;
  const glmApiKey = c.env.GLM_API_KEY;

  const fileRow = await db.prepare(
    'SELECT id, r2_key, filename, original_name, file_type, ocr_text, ocr_status, category FROM file_records WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(file_id, tenantId).first<{ id: string; r2_key: string; filename: string; original_name: string; file_type: string; ocr_text: string; ocr_status: string; category: string }>();

  if (!fileRow) return c.json({ error: 'File not found' }, 404);

  const diagnostics: any = { stages: {} };
  let ocrText = '';
  let balanceMismatched = false;

  // ── helper: DeepSeek parse ──
  async function deepSeekParse(text: string, label: string) {
    const dsPrompt = `You are a bank statement parser.
Return JSON: { "bank_name": string or null, "account_number": string or null, "currency": string, "period_start": "YYYY-MM-DD", "period_end": "YYYY-MM-DD", "opening_balance": number, "closing_balance": number, "transactions": [ { "transaction_date": "YYYY-MM-DD", "description": string, "deposit_amount": number (0 if withdrawal), "withdrawal_amount": number (0 if deposit), "balance": number|null } ] }

IMPORTANT — deciding whether a line's amount is a deposit or a withdrawal:
- Judge ONLY by which column (Deposit vs Withdrawal) the number is printed under / aligned with in the original layout. Never infer it from wording in the description such as "CR", "CR TO", "credit", "DR", "debit", etc.
- For HTML tables: read each <td> position relative to the header row (columns: Date | Details | Deposit | Withdrawal | Balance). An amount in the Deposit column = deposit_amount. An amount in the Withdrawal column = withdrawal_amount.
- For [L]/[M]/[R] tagged text: [L]=left columns (date/description), [M]=middle columns, [R]=right columns (Deposit/Withdrawal/Balance). Cross-reference with HTML tables for column mapping.
- Self-check: keep a running total from B/F BALANCE and verify against every printed balance checkpoint. If it doesn't reconcile, you've swapped a deposit/withdrawal — correct it before returning JSON.

OCR TEXT:
${text.slice(0, 8000)}`;

    const llmResult = await llmCompleteJson(llmKeysFromEnv(c.env), dsPrompt, `debug:${label}`);
    const raw = llmResult.raw;
    const result: any = { raw_response: raw, usage: null, provider: llmResult.provider };

    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      result.parsed = parsed;
      const txs = parsed.transactions || [];
      const totalDep = txs.reduce((s: number, t: any) => s + (Number(t.deposit_amount) || 0), 0);
      const totalWit = txs.reduce((s: number, t: any) => s + (Number(t.withdrawal_amount) || 0), 0);
      const computedClosing = (parsed.opening_balance ?? 0) + totalDep - totalWit;
      const ok = parsed.closing_balance == null || Math.abs(computedClosing - parsed.closing_balance) <= 0.01;
      result.balance_check = {
        opening: parsed.opening_balance,
        total_deposits: totalDep,
        total_withdrawals: totalWit,
        computed_closing: computedClosing,
        stated_closing: parsed.closing_balance,
        matches: ok,
      };
    }
    return result;
  }

  // ═══════════════════════════════════════════════════════════════
  // STEP 1: toMarkdown (Cloudflare AI) — primary OCR
  // ═══════════════════════════════════════════════════════════════
  let tmText = '';
  try {
    const obj = await fileBucket.get(fileRow.r2_key);
    if (obj && (ai as any)?.toMarkdown) {
      const buffer = await obj.arrayBuffer();
      const mdResult = await (ai as any).toMarkdown([{ name: fileRow.original_name || 'file.pdf', blob: new Blob([buffer], { type: 'application/pdf' }) }]);
      tmText = Array.isArray(mdResult) ? mdResult.map((r: any) => r?.data || r?.content || '').join('\n') : String(mdResult || '');
      diagnostics.stages.step1_tomarkdown = { text: tmText, length: tmText.length };
    } else {
      diagnostics.stages.step1_tomarkdown = { error: 'toMarkdown not available or file not in R2' };
    }
  } catch (e: any) {
    diagnostics.stages.step1_tomarkdown = { error: e?.message || String(e) };
  }

  // ═══════════════════════════════════════════════════════════════
  // STEP 2: DeepSeek parse on toMarkdown output
  // ═══════════════════════════════════════════════════════════════
  if (tmText) {
    ocrText = tmText;
    diagnostics.stages.step2_deepseek_on_tomarkdown = await deepSeekParse(tmText, 'tomarkdown');
    balanceMismatched = !diagnostics.stages.step2_deepseek_on_tomarkdown?.balance_check?.matches;
  }

  // ═══════════════════════════════════════════════════════════════
  // STEP 3: GLM-OCR — ONLY if toMarkdown balance mismatched
  // ═══════════════════════════════════════════════════════════════
  if ((balanceMismatched || force_glm) && glmApiKey) {
    diagnostics.stages.step3_glm_trigger = { reason: force_glm ? 'force_glm flag set — running GLM-OCR for comparison' : 'toMarkdown balance mismatch — triggering GLM-OCR retry' };
    try {
      const obj = await fileBucket.get(fileRow.r2_key);
      if (obj) {
        const buffer = await obj.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const base64 = btoa(binary);
        const mimeType = fileRow.file_type || 'application/pdf';

        const glmResp = await fetch('https://api.z.ai/api/paas/v4/layout_parsing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${glmApiKey}` },
          body: JSON.stringify({ model: 'glm-ocr', file: `data:${mimeType};base64,${base64}` }),
        });

        if (glmResp.ok) {
          const glmData = await glmResp.json() as any;
          diagnostics.stages.step3_glm_ocr = { status: glmResp.status, usage: glmData.usage || null };

          // Build positional format: HTML tables + [L/M/R] column tags
          const pages = glmData?.layout_details || [];
          const newParts: string[] = [];
          let tableCount = 0, textCount = 0;
          for (const p of pages) {
            for (const el of p) {
              if (el.label === 'table' && el.content) {
                newParts.push(el.content);
                tableCount++;
              } else if (el.label === 'text' && el.content) {
                const x = el.bbox_2d?.[0] || 0;
                const col = x < 600 ? 'L' : x < 1200 ? 'M' : 'R';
                newParts.push(`[${col}] ${el.content}`);
                textCount++;
              }
            }
            newParts.push('');
          }
          const glmFormatted = newParts.join('\n').trim();
          diagnostics.stages.step3_glm_ocr.formatted_positional = { text: glmFormatted, length: glmFormatted.length, tables: tableCount, text_lines: textCount };

          // ═══════════════════════════════════════════════════════
          // STEP 4: DeepSeek re-parse on GLM-OCR positional output
          // ═══════════════════════════════════════════════════════
          if (glmFormatted.length > 20) {
            diagnostics.stages.step4_deepseek_on_glm = await deepSeekParse(glmFormatted, 'glm-ocr');
            const glmOk = diagnostics.stages.step4_deepseek_on_glm?.balance_check?.matches;
            if (glmOk) {
              ocrText = glmFormatted; // GLM result used
            }
          } else {
            diagnostics.stages.step4_deepseek_on_glm = { error: 'GLM formatted output too short' };
          }
        } else {
          diagnostics.stages.step3_glm_ocr = { status: glmResp.status, error: await glmResp.text().catch(() => 'unknown') };
        }
      }
    } catch (e: any) {
      diagnostics.stages.step3_glm_ocr = { error: e?.message || String(e) };
    }
  } else if (!balanceMismatched) {
    diagnostics.stages.step3_glm_trigger = { reason: 'toMarkdown balance OK — GLM-OCR skipped' };
  } else {
    diagnostics.stages.step3_glm_trigger = { reason: 'No GLM API key — GLM-OCR skipped' };
  }

  // ── Summary ──
  const tomarkdownOk = diagnostics.stages.step2_deepseek_on_tomarkdown?.balance_check?.matches;
  const glmOk = diagnostics.stages.step4_deepseek_on_glm?.balance_check?.matches;
  diagnostics.summary = {
    tomarkdown_balance_ok: tomarkdownOk,
    glm_triggered: balanceMismatched,
    glm_balance_ok: glmOk,
    winner: tomarkdownOk ? 'tomarkdown' : (glmOk ? 'glm-ocr' : 'neither'),
    tomarkdown_tx_count: diagnostics.stages.step2_deepseek_on_tomarkdown?.parsed?.transactions?.length || 0,
    glm_tx_count: diagnostics.stages.step4_deepseek_on_glm?.parsed?.transactions?.length || 0,
  };

  return c.json(diagnostics);
});

export { files as fileStorageRoutes };
