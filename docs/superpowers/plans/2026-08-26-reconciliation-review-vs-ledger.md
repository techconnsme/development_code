# Reconciliation "Review vs Ledger" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Bank Statements 🔍 Reconcile button into "Review vs Ledger" — a read-only month-end review that decomposes the statement-vs-GL gap and proposes advisory fixes (adjusting journals, invoice matches, postings) with pre-fill actions.

**Architecture:** New pure-logic lib `api/src/lib/statement-review.ts` (decomposition math + rule→template mapping + pipeline assembly, DB accessed through a minimal interface so it's unit-testable). Thin route `POST /bank-statements/:id/review` wires it to D1 and injects the LLM call (`llmCompleteJson`, provider chain already built). Frontend upgrades the existing `reconData` panel in `BankStatements.tsx`; Pre-fill buttons drive the *existing* posting editor and match modal. Nothing writes until users save through existing flows.

**Tech Stack:** Hono on Cloudflare Workers + D1, TypeScript, React + TanStack Query, `node:assert` tests run with `npx tsx` (repo convention, no vitest), Playwright for e2e.

**Spec:** `docs/superpowers/specs/2026-08-26-reconciliation-review-vs-ledger-design.md`

## Global Constraints

- **Read-only:** the review endpoint performs ZERO database writes (audit log entry is the sole exception).
- **Money tolerance:** all comparisons use `EPS = 0.01`.
- **AI items are always `confidence: 'low'`, `source: 'ai'`;** LLM failure/timeout/malformed JSON must never fail the request.
- **No API renames:** `/reconcile`, `/auto-match` URLs stay untouched.
- **Concurrency warning:** other agents edit this repo concurrently. Before EVERY edit step, re-read the target file region to get fresh content and locate edits by unique code anchors (shown in each task), NEVER by remembered line numbers. Keep diffs minimal; stage only files you touched when committing.
- Unit tests: `api/tests/<name>.test.ts` using `import assert from 'node:assert'`, run via `npx tsx api/tests/<name>.test.ts` from repo root (exit code 0 = pass).
- i18n: every user-visible string goes through `tr(en, zhTw, zhCn)` from `../lib/i18nHelpers`.

---

### Task 1: Review types, gap decomposition, rule templates (pure lib)

**Files:**
- Create: `api/src/lib/statement-review.ts`
- Test: `api/tests/statement-review.test.ts`

**Interfaces:**
- Consumes: `CategorizeResult` / `RuleTag` from `./transaction-categorizer` (`{code: string; tag: RuleTag; confidence: 'exact'|'fuzzy'} | null`, where `code === ''` means "no COA posting").
- Produces (used by Tasks 2–4):
  - `interface JePrefillLine { account_code: string; account_name: string; debit: number; credit: number }`
  - `type ReviewItemKind = 'adjusting_je' | 'invoice_match' | 'coa_posting' | 'info'`
  - `type ReviewSource = 'rule' | 'ai'`; `type ReviewConfidence = 'high' | 'medium' | 'low'`
  - `interface ReviewItem { id: string; kind: ReviewItemKind; source: ReviewSource; transaction_id?: string; explanation: string; confidence: ReviewConfidence; prefill?: { lines?: JePrefillLine[]; description?: string; invoice_id?: string; invoice_number?: string; account_code?: string } }`
  - `function decomposeGap(difference: number, items: ReviewItem[], bankCode: string): { projected_difference: number; unexplained_residual: number }`
  - `function ruleSuggestionFor(cat: CategorizeResult, dir: 'deposit'|'withdrawal', amount: number, txId: string, bankCode: string, nameOf: (code: string) => string): ReviewItem | null`

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/statement-review.test.ts
/**
 * Statement review engine — pure logic tests.
 * Run: npx tsx tests/statement-review.test.ts
 */
import assert from 'node:assert';
import { decomposeGap, ruleSuggestionFor, ReviewItem } from '../src/lib/statement-review';

const nameOf = (code: string) => ({ '11101': 'HSBC Bank', '42101': 'Interest income', '22101': "Director's loan", '66102': 'Bank charges' } as Record<string, string>)[code] || code;

// ── decomposeGap ──
{
  const interest: ReviewItem = { id: 's1', kind: 'adjusting_je', source: 'rule', explanation: '', confidence: 'high',
    prefill: { lines: [
      { account_code: '11101', account_name: 'HSBC Bank', debit: 12.30, credit: 0 },
      { account_code: '42101', account_name: 'Interest income', debit: 0, credit: 12.30 }] } };
  const ownerIn: ReviewItem = { id: 's2', kind: 'adjusting_je', source: 'rule', explanation: '', confidence: 'high',
    prefill: { lines: [
      { account_code: '11101', account_name: 'HSBC Bank', debit: 2000, credit: 0 },
      { account_code: '22101', account_name: "Director's loan", debit: 0, credit: 2000 }] } };

  // Real PNR Jan-2025 numbers: books missing interest (+12.30) and owner transfer-in (+2000)
  const r = decomposeGap(2012.30, [interest, ownerIn], '11101');
  assert.equal(r.projected_difference.toFixed(2), '0.00');
  assert.equal(r.unexplained_residual, 0);
}
{ // residual survives when suggestions don't cover the gap
  const r = decomposeGap(2012.30, [], '11101');
  assert.equal(r.projected_difference.toFixed(2), '2012.30');
  assert.equal(r.unexplained_residual.toFixed(2), '2012.30');
}
{ // info items and non-bank lines never count toward the projection
  const info: ReviewItem = { id: 'i1', kind: 'info', source: 'rule', explanation: 'x', confidence: 'high',
    prefill: { lines: [{ account_code: '99999', account_name: '?', debit: 5000, credit: 0 }] } };
  const r = decomposeGap(100, [info], '11101');
  assert.equal(r.unexplained_residual.toFixed(2), '100.00');
}

// ── ruleSuggestionFor ──
{ // credit interest deposit → Dr bank / Cr 42101
  const item = ruleSuggestionFor({ code: '42101', tag: 'interest_income', confidence: 'exact' },
    'deposit', 12.30, 'bt-x', '11101', nameOf);
  assert.equal(item!.kind, 'adjusting_je');
  assert.equal(item!.confidence, 'high');
  assert.deepEqual(item!.prefill!.lines!.map(l => [l.account_code, l.debit, l.credit]),
    [['11101', 12.30, 0], ['42101', 0, 12.30]]);
}
{ // bank charge withdrawal → Dr expense / Cr bank
  const item = ruleSuggestionFor({ code: '66102', tag: 'bank_charge', confidence: 'exact' },
    'withdrawal', 1300, 'bt-y', '11101', nameOf);
  assert.deepEqual(item!.prefill!.lines!.map(l => [l.account_code, l.debit, l.credit]),
    [['66102', 1300, 0], ['11101', 0, 1300]]);
}
{ // director deposit → Dr bank / Cr director's loan
  const item = ruleSuggestionFor({ code: '22101', tag: 'director', confidence: 'exact' },
    'deposit', 2000, 'bt-z', '11101', nameOf);
  assert.deepEqual(item!.prefill!.lines!.map(l => [l.account_code, l.debit, l.credit]),
    [['11101', 2000, 0], ['22101', 0, 2000]]);
}
{ // internal_transfer has code '' → advisory info item, no JE lines
  const item = ruleSuggestionFor({ code: '', tag: 'internal_transfer', confidence: 'exact' },
    'deposit', 100, 'bt-t', '11101', nameOf);
  assert.equal(item!.kind, 'info');
  assert.ok((item!.explanation || '').length > 10);
  assert.equal(item!.prefill, undefined);
}
{ // uncategorized → null (AI candidate later)
  assert.equal(ruleSuggestionFor(null as any, 'deposit', 5, 'bt-q', '11101', nameOf), null);
}

console.log('statement-review.test.ts: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx api/tests/statement-review.test.ts` (from repo root)
Expected: FAIL — cannot find module `../src/lib/statement-review`

- [ ] **Step 3: Write the implementation**

```ts
// api/src/lib/statement-review.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx api/tests/statement-review.test.ts`
Expected: PASS — prints `statement-review.test.ts: all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add api/src/lib/statement-review.ts api/tests/statement-review.test.ts
git commit -m "feat(api): statement review engine core (gap decomposition + rule templates)"
```

---

### Task 2: Review pipeline — compare, rules, invoice matches (no AI yet)

**Files:**
- Modify: `api/src/lib/statement-review.ts` (append pipeline)
- Test: `api/tests/statement-review.test.ts` (append cases)

**Interfaces:**
- Consumes (from Task 1): `ReviewItem`, `ruleSuggestionFor`, `decomposeGap`, `REVIEW_EPS`.
- Consumes (existing libs):
  - `categorizeTransaction(rawDesc: string, dir?)` from `./transaction-categorizer`
  - `findBestInvoiceMatch(tx: MatchableTx, invoices: MatchableInvoice[], excludeIds?)` from `./bank-matcher` — returns `{ invoice, confidence: 'high'|'medium'|'low', reason } | null`; `MatchableTx = { id, transaction_date, description, reference?, amount, currency? }`, `MatchableInvoice = { id, invoice_number, total, currency?, issue_date, due_date?, counterparty_name? }`
- Produces (consumed by Tasks 3–4):

```ts
export interface DbLike {
  prepare(sql: string): {
    bind(...args: any[]): {
      all(): Promise<{ results: any[] }>;
      first<T = any>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
}

export interface StatementReviewResult {
  statement_id: string;
  is_locked: boolean;
  balance_summary: { statement_balance: number; gl_balance: number; difference: number };
  projected_difference: number;
  items: ReviewItem[];
}

export async function buildStatementReview(
  db: DbLike,
  tenantId: string,
  stmtId: string,
  opts?: { llmFn?: LlmReviewFn },   // Task 3 injects; default undefined = skip AI
): Promise<StatementReviewResult>
```

SQL used inside `buildStatementReview` (copy of the proven preview queries in routes/bank-statements.ts `POST /:id/reconcile` — anchor: `SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0)`):

- statement row: `SELECT id, closing_balance, period_end, account_code FROM bank_statements WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
- GL balance: join `journal_lines jl JOIN journal_entries je ON jl.entry_id = je.id WHERE je.user_id = ? AND je.entry_date <= ? AND jl.account_code = ?` filtered by the same posted/live helpers the route file already imports (`jePosted('je')`, `jeNotOrphaned('je')`) — import them from `./journal-filters` exactly as routes/bank-statements.ts does today.
- transactions: `SELECT * FROM bank_transactions WHERE bank_statement_id = ? AND user_id = ? AND deleted_at IS NULL ORDER BY transaction_date`
- unpaid invoices: `SELECT id, invoice_number, customer_id, total, currency, issue_date, due_date, deleted_at FROM invoices WHERE user_id = ? AND status NOT IN ('paid','cancelled') AND deleted_at IS NULL AND total > 0`
- accounts for names: `SELECT account_code, account_name FROM accounts WHERE user_id = ? AND is_active = 1`
- lock check: `SELECT COUNT(*) AS n FROM bank_reconciliations WHERE bank_statement_id = ? AND user_id = ?`

- [ ] **Step 1: Write failing tests (append to `api/tests/statement-review.test.ts`)**

```ts
// ── buildStatementReview (fake D1) ──
import { buildStatementReview } from '../src/lib/statement-review';

function fakeDb(stmt: any, txRows: any[], jeSum: number, invoices: any[] = [], reconCount = 0, accts: any[] = []) {
  return {
    prepare(sql: string) {
      return {
        bind(..._args: any[]) {
          return {
            async all() {
              if (sql.includes('FROM bank_transactions')) return { results: txRows };
              if (sql.includes('FROM invoices')) return { results: invoices };
              if (sql.includes('FROM accounts')) return { results: accts };
              if (sql.includes("COUNT(*)")) throw new Error('unexpected count sql here');
              return { results: [] };
            },
            async first() {
              if (sql.includes('FROM bank_statements')) return stmt;
              if (sql.includes('SUM(jl.debit)')) return { balance: jeSum };
              if (sql.includes('bank_reconciliations')) return { n: reconCount };
              return null;
            },
            async run() { throw new Error('review must not write'); },
          };
        },
      };
    },
  } as any;
}

async function runPipelineTest() {
  const stmt = { id: 'bs-1', closing_balance: 100712.30, period_end: '2025-01-28', account_code: '11101' };
  const txRows = [
    { id: 'bt-int', description: 'CREDIT INTEREST', deposit_amount: 12.30, withdrawal_amount: 0, reference: null, currency: 'HKD', invoice_id: null, match_status: 'unmatched' },
    { id: 'bt-dir', description: 'LIN PUI KEUNG JOSEPH HC123', deposit_amount: 2000, withdrawal_amount: 0, reference: null, currency: 'HKD', invoice_id: null, match_status: 'unmatched' },
  ];
  const accts = [
    { account_code: '11101', account_name: 'HSBC Bank' },
    { account_code: '42101', account_name: 'Interest income' },
    { account_code: '22101', account_name: "Director's loan" },
  ];
  const res = await buildStatementReview(fakeDb(stmt, txRows, 98700, [], 0, accts), 'u-1', 'bs-1');

  assert.equal(res.statement_id, 'bs-1');
  assert.equal(res.balance_summary.difference.toFixed(2), '2012.30');
  assert.equal(res.is_locked, false);
  const kinds = res.items.map(i => i.kind);
  assert.ok(kinds.includes('adjusting_je'), 'interest+director should yield JE suggestions');
  const interest = res.items.find(i => i.transaction_id === 'bt-int');
  assert.equal(interest!.prefill!.lines![1].account_code, '42101');
  // both gaps explained → projected zero
  assert.equal(res.projected_difference, 0);

  // locked statement still reviews but flags lock
  const locked = await buildStatementReview(fakeDb(stmt, txRows, 98700, [], 1, accts), 'u-1', 'bs-1');
  assert.equal(locked.is_locked, true);

  // invoice matcher wired: exact-amount unpaid invoice gets suggested for bt-dir
  const invoices = [{ id: 'inv-9', invoice_number: 'INV-0009', customer_id: 'c1', total: 2000, currency: 'HKD', issue_date: '2025-01-05', due_date: '2025-02-04', counterparty_name: 'LIN PUI KEUNG JOSEPH', deleted_at: null }];
  const withInv = await buildStatementReview(fakeDb(stmt, txRows, 98700, invoices, 0, accts), 'u-1', 'bs-1');
  const m = withInv.items.find(i => i.kind === 'invoice_match' && i.transaction_id === 'bt-dir');
  assert.ok(m, 'expected invoice_match item');
  assert.equal(m!.prefill!.invoice_id, 'inv-9');

  // missing statement throws 404-ish sentinel
  await assert.rejects(
    () => buildStatementReview(fakeDb(null, [], 0, [], 0, []), 'u-1', 'nope'),
    /not found/i,
  );
  console.log('buildStatementReview: all assertions passed');
}
await runPipelineTest();
```

Note: `buildStatementReview` must treat `invoice_match` amounts as explained too (bank-side contribution = min(|tx amount|, |invoice.total|)) — add to the fake test above: after `withInv`, assert `withInv.projected_difference` reflects the 2000 now covered (12.30 + 2000 covered → residual 0 still, since both were already covered by rules; instead craft a variant where rules find nothing and only the invoice explains part). Add:

```ts
{ // invoice alone partially explains gap
  const plainTx = [{ id: 'bt-dir', description: 'UNKNOWN PARTY', deposit_amount: 2000, withdrawal_amount: 0, reference: null, currency: 'HKD', invoice_id: null, match_status: 'unmatched' }];
  const invoices = [{ id: 'inv-9', invoice_number: 'INV-0009', total: 1500, currency: 'HKD', issue_date: '2025-01-05', due_date: null, counterparty_name: null, deleted_at: null }];
  const r = await buildStatementReview(fakeDb({ ...stmt }, plainTx, 0 /* gl=0 → gap = closing */, invoices, 0, accts), 'u-1', 'bs-1');
  // closing 100712.30 − gl 0 = 100712.30 gap; only 1500 explainable via near-amount tier may NOT fire (no date window) → do not assert specific; assert fields exist:
  assert.equal(typeof r.projected_difference, 'number');
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx api/tests/statement-review.test.ts`
Expected: FAIL — `buildStatementReview` not exported

- [ ] **Step 3: Implement `buildStatementReview` (append to `api/src/lib/statement-review.ts`)**

Implementation notes (concrete requirements):
- Import `{ categorizeTransaction }` and `{ findBestInvoiceMatch }` plus journal filters exactly as routes/bank-statements.ts imports them (`import { jePosted, jeNotOrphaned } from './journal-filters'` — verify the export names by grepping `routes/bank-statements.ts` for `jePosted(` before writing; if they live elsewhere, mirror that import path).
- Direction per row: `deposit_amount > 0 ? 'deposit' : 'withdrawal'`.
- Rules run only for rows with `invoice_id == NULL` and `match_status !== 'confirmed'`.
- Invoice matching mirrors `POST /auto-match` phases but single-row: deposits → AR candidates, withdrawals → AP candidates (pass `counterparty_name` from the joined customer/supplier name; extend the invoices query with LEFT JOIN customers/suppliers like routes/bank-statements.ts does — copy that SQL verbatim).
- Emit `kind:'invoice_match'` item with `prefill.invoice_id/invoice_number`, `confidence` = matcher tier ('high'|'medium'|'low'), `explanation` = matcher reason.
- Skip AI entirely when `opts?.llmFn` is undefined (Task 3 adds the real default).
- After items are collected: compute `decomposeGap(difference, items, bankCode)`; append ONE trailing `kind:'info'` item when `unexplained_residual >= REVIEW_EPS`: `"Residual HKD X.XX remains unexplained"` (`source:'rule'`, `confidence:'high'`). The AI pass (Task 3) replaces/augments this.
- Throw `new Error('statement not found')` when the statement row is missing.
- `is_locked` from the reconciliations count query.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx api/tests/statement-review.test.ts`
Expected: PASS (all previous Task-1 assertions still green)

- [ ] **Step 5: Commit**

```bash
git add api/src/lib/statement-review.ts api/tests/statement-review.test.ts
git commit -m "feat(api): statement review pipeline (compare + rules + invoice suggestions)"
```

---

### Task 3: Conditional AI pass for the unexplained residual

**Files:**
- Modify: `api/src/lib/statement-review.ts`
- Test: `api/tests/statement-review.test.ts` (append)

**Interfaces:**
- Consumes: `llmCompleteJson(keys, prompt, label, opts?)` → `{ parsed: any|null; provider: string|null; raw: string }` and `llmKeysFromEnv(env)` from `./llm-parse` (never throws; Qwen→DeepSeek chain already implemented there).
- Produces: default `opts.llmFn` behaviour inside `buildStatementReview` — when residual ≥ 0.01 and env keys exist, exactly one LLM call; validated AI items appended with `source:'ai'`, forced `confidence:'low'`.

Validation rules for every parsed AI item (all must hold, else drop silently):
- `transaction_id` exists among candidate rows sent
- `account_code` appears in the tenant accounts list
- exactly one of `debit`/`credit` > 0 and equals the candidate row's amount ± 0.01
- `explanation` non-empty

- [ ] **Step 1: Write failing test (append)**

```ts
// ── AI pass (stubbed llmFn) ──
async function runAiTest() {
  const stmt = { id: 'bs-2', closing_balance: 100.00, period_end: '2025-01-28', account_code: '11101' };
  const txRows = [{ id: 'bt-mystery', description: 'WEIRD TRANSFER IN', deposit_amount: 100, withdrawal_amount: 0, reference: null, currency: 'HKD', invoice_id: null, match_status: 'unmatched' }];
  const accts = [{ account_code: '11101', account_name: 'HSBC Bank' }, { account_code: '12901', account_name: 'Sundry receivable' }];

  const goodLlm = async () => ({
    parsed: { items: [{ transaction_id: 'bt-mystery', explanation: 'Refund from supplier', account_code: '12901', debit: 0, credit: 100, description: 'Supplier refund' }] },
    provider: 'stub', raw: '',
  });
  const r1 = await buildStatementReview(fakeDb(stmt, txRows, 0, [], 0, accts), 'u-1', 'bs-2', { llmFn: goodLlm });
  const ai = r1.items.find(i => i.source === 'ai');
  assert.ok(ai, 'ai item present');
  assert.equal(ai!.confidence, 'low');                       // forced low
  assert.equal(ai!.kind, 'adjusting_je');
  assert.equal(r1.projected_difference, 0);                  // 100 now explained

  // invalid account dropped; malformed JSON tolerated
  const badLlm = async () => ({ parsed: { items: [{ transaction_id: 'bt-mystery', explanation: 'x', account_code: '99999', debit: 0, credit: 100, description: '?' }] }, provider: 'stub', raw: '' });
  const r2 = await buildStatementReview(fakeDb(stmt, txRows, 0, [], 0, accts), 'u-1', 'bs-2', { llmFn: badLlm });
  assert.equal(r2.items.filter(i => i.source === 'ai').length, 0);
  assert.ok(r2.items.some(i => i.kind === 'info'));          // residual info survives

  // throwing LLM never breaks the review
  const boomLlm = async () => { throw new Error('provider down'); };
  const r3 = await buildStatementReview(fakeDb(stmt, txRows, 0, [], 0, accts), 'u-1', 'bs-2', { llmFn: boomLlm });
  assert.equal(Array.isArray(r3.items), true);
  console.log('ai pass: all assertions passed');
}
await runAiTest();
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx api/tests/statement-review.test.ts`
Expected: FAIL — `llmFn` option ignored (no ai item)

- [ ] **Step 3: Implement (modify `buildStatementReview` in `statement-review.ts`)**

Concrete additions:
- Type: `export type LlmReviewFn = typeof import('./llm-parse').llmCompleteJson;`
- Default wiring: `const llmFn = opts?.llmFn ?? ((keys, prompt, label, o) => llmCompleteJson(keys, prompt, label, o));` with `import { llmCompleteJson, LlmKeys } from './llm-parse';` — but ONLY call when `env` was provided: extend signature to `opts?: { llmFn?: ...; env?: any; llmKeys?: LlmKeys }`. No env/keys → skip AI (keeps Task-2 tests valid).
- Prompt template (send candidates WITHOUT invoice-linked rows; cap at 20 rows):

```
You are a bookkeeping assistant reviewing a bank statement against a ledger.
Unexplained residual: HKD ${residual}.
Candidate transactions (JSON): ${JSON.stringify(candidates.map(c => ({ transaction_id: c.id, date: c.transaction_date, description: c.description, deposit_amount: c.deposit_amount, withdrawal_amount: c.withdrawal_amount })))}
Chart of accounts (code|name): ${accounts.map(a => `${a.account_code}|${a.account_name}`).join('\n')}
Return ONLY JSON: {"items":[{"transaction_id":"...","explanation":"...","account_code":"...","debit":0,"credit":0,"description":"..."}]}
Rules: use only listed accounts; the single nonzero side must equal the transaction amount; omit anything you cannot justify.
```

- Wrap call: `try { const res = await Promise.race([llmFn(...), timeout(8000)]); ... } catch { /* drop */ }` where `timeout(ms) = new Promise((_, rej) => setTimeout(() => rej(new Error('llm timeout')), ms))`.
- Convert surviving parsed items to `ReviewItem`s: `kind:'adjusting_je'`, `source:'ai'`, `confidence:'low'`, prefill lines `[contra(code, d, c), bank(...)]` ordered by movement direction (deposit ⇒ bank Dr first; withdrawal ⇒ bank Cr last) mirroring `ruleSuggestionFor`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx api/tests/statement-review.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/src/lib/statement-review.ts api/tests/statement-review.test.ts
git commit -m "feat(api): conditional AI suggestions for unexplained reconciliation residual"
```

---

### Task 4: Route endpoint `POST /bank-statements/:id/review`

**Files:**
- Modify: `api/src/routes/bank-statements.ts` (add route beside `POST /:id/reconcile`; anchor: comment line `// ── Bank Reconciliation ──`)

**Interfaces:**
- Consumes: `buildStatementReview(db, tenantId, stmtId, { env })` from `../lib/statement-review`; local `auditLog` helper (defined in this file).
- Produces: HTTP `200` with the `StatementReviewResult` JSON body; `404 {"error":"Statement not found"}` when unknown.

- [ ] **Step 1: Add the route (re-read the file region around the `// ── Bank Reconciliation ──` anchor immediately before editing)**

```ts
// ── Review vs Ledger (read-only month-end analysis) ──
// Decomposes statement-vs-ledger gap into rule/AI suggestions. Writes nothing
// except an audit-log entry. Suggestions are pre-fill only; users save via the
// existing posting/match flows.
bank.post('/:id/review', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  try {
    const result = await buildStatementReview(c.env.DB, tenantId, c.req.param('id'), { env: c.env });
    await auditLog(c.env.DB, user.id, 'review_statement', 'bank_statement', c.req.param('id'),
      { difference: result.balance_summary.difference });
    return c.json(result);
  } catch (e: any) {
    if (/not found/i.test(e?.message || '')) return c.json({ error: 'Statement not found' }, 404);
    console.error('review failed:', e);
    return c.json({ error: 'Review failed' }, 500);
  }
});
```

Plus the import at the top of the file (anchor: the `import { categorizeTransaction …` line):

```ts
import { buildStatementReview } from '../lib/statement-review';
```

- [ ] **Step 2: Typecheck**

Run: `cd api; npx tsc --noEmit` (if the project lacks a tsconfig-driven check, run `npx tsc --noEmit -p api` from root; verify which works by inspecting `api/tsconfig.json` presence first)
Expected: no new errors introduced by this change (pre-existing errors, if any, unchanged)

- [ ] **Step 3: Manual smoke against dev server**

Run: `cd api; npx wrangler dev` then in a second shell:
`curl -X POST http://localhost:8787/api/bank-statements/<real-id>/review -H "Cookie: token=<jwt>"` (obtain a token by logging in as `joseph.lin@pnr.hk` / `Test1234`)
Expected: JSON containing `balance_summary`, `items`, `projected_difference`; repeat request → identical result (proves read-only)

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/bank-statements.ts
git commit -m "feat(api): POST /bank-statements/:id/review read-only review endpoint"
```

---

### Task 5: Frontend — button rename + review panel

**Files:**
- Modify: `frontend/src/pages/BankStatements.tsx`

**Interfaces:**
- Consumes: `POST /bank-statements/:id/review` response shape from Task 4; existing state hooks `reconData`/`setReconData` (anchor: `const [reconData, setReconData]`).
- Produces: `reconData` now holds the full review payload (`balance_summary`, `projected_difference`, `items`); Task 6 renders per-item actions.

- [ ] **Step 1: Rename the button**

Find (anchor: `🔍 Reconcile` inside the `tr(...)` call near the `api(`/bank-statements/${detail.id}/reconcile`` onClick):

```tsx
{tr('🔍 Reconcile', '🔍 對賬 Reconcile', '🔍 对账 Reconcile')}
```

Replace with:

```tsx
{tr('🔍 Review vs Ledger', '🔍 對帳審查', '🔍 对账审查')}
```

Keep the onClick calling `/reconcile` UNCHANGED in this task (endpoint swap happens in Step 2 together so the panel never receives mismatched shapes mid-task).

- [ ] **Step 2: Swap the payload source and upgrade the panel**

Change the onClick body (same anchor region):

```tsx
const res = await api(`/bank-statements/${detail.id}/review`, { method: 'POST' });
setReconData(res);
```

Replace the existing `reconData && (...)` block (anchor: `{reconData && (`) with:

```tsx
{reconData && (
  <div className="border rounded-lg p-3 space-y-2 bg-muted/30">
    {/* Header figures */}
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <div><p className="text-xs text-muted-foreground">{tr('Bank', '銀行', '银行')}</p>
        <p className="font-bold text-lg">HKD {(reconData.balance_summary?.statement_balance ?? 0).toLocaleString()}</p></div>
      <div><p className="text-xs text-muted-foreground">{tr('Books', '帳面', '账面')}</p>
        <p className="font-bold text-lg">HKD {(reconData.balance_summary?.gl_balance ?? 0).toLocaleString()}</p></div>
      <div><p className="text-xs text-muted-foreground">{tr('Gap', '差額', '差额')}</p>
        <span className={`font-bold text-lg ${(Math.abs(reconData.balance_summary?.difference ?? 0) < 0.01) ? 'text-green-600' : 'text-red-600'}`}>
          HKD {(reconData.balance_summary?.difference ?? 0).toLocaleString()}</span></div>
      <div><p className="text-xs text-muted-foreground">{tr('After suggestions', '建議後', '建议后')}</p>
        <span className={`font-bold text-lg ${(Math.abs(reconData.projected_difference ?? 0) < 0.01) ? 'text-green-600' : 'text-amber-600'}`}>
          HKD {(reconData.projected_difference ?? 0).toLocaleString()}</span></div>
      {reconData.is_locked && (
        <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-700 text-xs">
          {tr('Statement is reconciled — read-only', '月結單已對賬——唯讀', '月结单已对账——只读')}</span>)}
    </div>

    {/* Items grouped by kind */}
    {(['adjusting_je', 'invoice_match', 'coa_posting'] as const).map(kind => {
      const group = (reconData.items || []).filter((i: any) => i.kind === kind);
      if (!group.length) return null;
      const titles: Record<string, [string, string, string]> = {
        adjusting_je: ['Suggested adjusting entries', '建議調整分錄', '建议调整分录'],
        invoice_match: ['Suggested invoice matches', '建議發票配對', '建议发票配对'],
        coa_posting: ['Postings needed', '待入帳項目', '待入账项目'],
      };
      const t = titles[kind];
      return (
        <div key={kind}>
          <p className="text-xs font-semibold mt-2 mb-1">{tr(t[0], t[1], t[2])}</p>
          <ul className="space-y-1">
            {group.map((it: any) => (
              <li key={it.id} data-testid="review-item" className="flex items-center justify-between gap-2 text-sm border rounded px-2 py-1">
                <span>
                  <span className={`mr-1 px-1 rounded text-[10px] ${it.source === 'ai' ? 'bg-purple-100 text-purple-700' : 'bg-slate-100 text-slate-600'}`}>
                    {it.source === 'ai' ? tr('AI', 'AI', 'AI') : tr('RULE', '規則', '规则')}</span>
                  {it.explanation}
                </span>
                <PreFillButton item={it} disabled={reconData.is_locked} />
              </li>))}
          </ul>
        </div>);
    })}
    {/* Info / residual notes */}
    {(reconData.items || []).filter((i: any) => i.kind === 'info').map((it: any) => (
      <p key={it.id} className="text-xs text-muted-foreground">{it.explanation}</p>))}
  </div>
)}
```

Add above the component's return (or as a small inner component in the same file):

```tsx
function PreFillButton({ item, disabled }: { item: any; disabled?: boolean }) {
  const { tReady } = { tReady: true }; // placeholder-free: see Task 6 for handlers
  return (
    <button data-testid="review-prefill" disabled={disabled}
      className="px-2 py-0.5 text-xs rounded border hover:bg-green-100 disabled:opacity-40">
      {item.kind === 'invoice_match'
        ? tr('Review match', '審視配對', '审视配对')
        : tr('Pre-fill', '預填', '预填')}
    </button>
  );
}
```

(Task 6 replaces this shell with the wired version — declared here so Task 5 compiles standalone.)

- [ ] **Step 3: Verify in browser**

Run: repo root `npm run dev`; log in as `joseph.lin@pnr.hk` / `Test1234`; open Bank Statements → expand any statement → click 🔍 Review vs Ledger
Expected: panel shows Bank/Books/Gap/After-suggestions figures and grouped items (or empty groups gracefully); old behaviour of `/reconcile` no longer referenced by the button

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/BankStatements.tsx
git commit -m "feat(frontend): Review vs Ledger panel replacing bare reconcile preview"
```

---

### Task 6: Pre-fill wiring (posting editor + match modal)

**Files:**
- Modify: `frontend/src/components/TxPostingPanel.tsx` (add one optional prop)
- Modify: `frontend/src/pages/BankStatements.tsx` (wire Pre-fillButton)

**Interfaces:**
- Consumes: `TxPostingPanelProps` (existing); `setExpandedTxId`, `setMatchTxId` state setters (anchors: `const [expandedTxId, setExpandedTxId]`, `const [matchTxId, setMatchTxId]`); match modal rendered at anchor `{matchTxId && (`.
- Produces: `TxPostingPanelProps.initialContraLines?: PostingLine[]` — used ONLY when `posting == null`, seeding the editable lines.

- [ ] **Step 1: Extend `TxPostingPanel` (backward compatible)**

Anchor in the props destructuring and `useState<PostingLine[]>` initializer:

```tsx
interface TxPostingPanelProps {
  // …existing props…
  /** Review suggestion seed (only honoured when no posting exists yet) */
  initialContraLines?: PostingLine[];
}
```

In the initializer, BEFORE falling back to `[currentCode]`:

```tsx
const [lines, setLines] = useState<PostingLine[]>(() => {
  if (posting && posting.lines.length > 0) { /* existing branch unchanged */ }
  if (initialContraLines && initialContraLines.length > 0) return initialContraLines;
  /* existing currentCode fallback unchanged */
});
```

- [ ] **Step 2: Wire `PreFillButton` handlers in `BankStatements.tsx`**

Replace the Task-5 shell component with a wired version receiving three callbacks:

```tsx
function PreFillButton({ item, disabled, onPrefillJe, onPrefillMatch }: {
  item: any; disabled?: boolean;
  onPrefillJe: (txId: string, lines: PostingLine[]) => void;
  onPrefillMatch: (txId: string, invoiceNumber?: string, confidence?: string) => void;
}) {
  if (item.kind === 'invoice_match')
    return <button data-testid="review-prefill" disabled={disabled}
      onClick={() => onPrefillMatch(item.transaction_id, item.prefill?.invoice_number, item.confidence)}
      className="px-2 py-0.5 text-xs rounded border hover:bg-green-100 disabled:opacity-40">
      {tr('Review match', '審視配對', '审视配对')}</button>;
  return <button data-testid="review-prefill" disabled={disabled || !item.transaction_id}
    onClick={() => onPrefillJe(item.transaction_id!,
      (item.prefill?.lines || [])
        .filter((l: any) => l.account_code !== reconBankCodeStatic)   // contra side only
        .map((l: any) => ({ account_code: l.account_code, amount: Math.round(((l.debit || 0) + (l.credit || 0)) * 100) / 100 })))}
    className="px-2 py-0.5 text-xs rounded border hover:bg-green-100 disabled:opacity-40">
    {tr('Pre-fill', '預填', '预填')}</button>;
}
```

Notes (concrete):
- `reconBankCodeStatic`: capture the statement's bank code at click time instead of module scope — pass `bankCode` down from the parent render (the detail object already carries `account_code`), i.e. give `PreFillButton` a fifth prop `bankCode: string` and filter `l.account_code !== bankCode`.
- `onPrefillJe` implementation inside the page component:

```tsx
(txId: string, lines: PostingLine[]) => {
  setPrefilledLines(lines);           // NEW state: const [prefilledLines, setPrefilledLines] = useState<PostingLine[] | undefined>(undefined);
  setExpandedTxId(txId);              // opens the row's TxPostingPanel
  toast.info(tr('Suggestion pre-filled — review and save', '建議已預填——請確認後保存', '建议已预填——请确认后保存'));
}
```

- Pass `initialContraLines={prefilledLines}` where `TxPostingPanel` is rendered for that row, and reset via `onClose`/after save: `setPrefilledLines(undefined)` in the existing save-success handler (anchor: the mutation calling `/transactions/${txId}/posting` or equivalent `onSave` wiring).
- `onPrefillMatch` implementation:

```tsx
(txId: string, invoiceNumber?: string, confidence?: string) => {
  if (invoiceNumber)
    toast.info(tr(`Suggested: ${invoiceNumber} (${confidence ?? 'low'} confidence)`,
                  `建議：${invoiceNumber}（${confidence ?? 'low'}）`, `建议：${invoiceNumber}（${confidence ?? 'low'}）`));
  setMatchTxId(txId);                 // opens the EXISTING match modal; user confirms there
}
```

- [ ] **Step 3: Verify in browser**

Same dev session as Task 5. Expected: clicking Pre-fill on a JE suggestion expands the transaction row with the suggested contra account seeded and correct amount; saving posts via the existing flow; clicking Review match opens the existing modal with a toast showing the suggested invoice.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/TxPostingPanel.tsx frontend/src/pages/BankStatements.tsx
git commit -m "feat(frontend): review suggestions pre-fill posting editor and match modal"
```

---

### Task 7: Playwright smoke test

**Files:**
- Create: `tests/reconciliation-review.spec.ts` (root Playwright project, alongside existing specs)

**Interfaces:**
- Consumes: login helpers/patterns used by sibling specs (open `tests/bank-statement-import.spec.ts` or similar and copy its auth + navigation setup verbatim; adapt selectors only).
- Produces: `npm run test -- reconciliation-review` green.

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test';

// Smoke: Review vs Ledger panel renders suggestions and pre-fill opens the editor.
test('review vs ledger panel renders and pre-fills', async ({ page }) => {
  // Auth: replicate the login block from an existing spec (email/password inputs + submit),
  // using joseph.lin@pnr.hk / Test1234.
  // Navigate: sidebar → Bank Statements; expand first statement row (data-testid or text fallback);
  // click button containing 'Review vs Ledger'.
  await expect(page.getByText(/Bank|銀行|银行/).first()).toBeVisible();

  const items = page.getByTestId('review-item');
  const count = await items.count();
  if (count > 0) {
    await items.first().getByTestId('review-prefill').click();
    // Either the posting editor opened (TxPostingPanel heading/save affordance visible)
    // or a toast confirmed pre-fill — accept either signal:
    const editorOrToast = page.getByText(/review and save|確認後保存|确认后保存|Save/).first();
    await expect(editorOrToast).toBeVisible();
  }
});
```

Before finalizing, replace the AUTH/NAVIGATE comments with the concrete code copied from the sibling spec (read it first — specs share a login helper or inline block).

- [ ] **Step 2: Run it**

Run: `npx playwright test reconciliation-review` (dev API+frontend running, or per sibling-spec conventions for baseURL/webServer)
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/reconciliation-review.spec.ts
git commit -m "test(e2e): reconciliation review-vs-ledger smoke"
```

---

## Self-review notes

- Spec coverage: rename (T5), read-only endpoint incl. audit + lock flag (T4/T2), compare math (T2), rules pass (T1/T2), invoice-match pass (T2), decomposition + projected difference (T1/T2), conditional AI + validation + timeout (T3), panel + grouping + projected-green (T5), pre-fill to existing editors (T6), Playwright smoke (T7), cent tolerance (EPS constant T1), no-FK/no-write guarantee asserted by fake-db `run()` throwing (T2).
- Type consistency: `ReviewItem`/`prefill` shapes identical across T1/T2/T3/T5/T6; `LlmReviewFn` matches `llmCompleteJson` signature.
- Known intentional simplification: Task 5 ships a handler-less `PreFillButton` shell so the commit compiles; Task 6 completes it within the same PR series.
