# Multi-Invoice (1:N) Bank Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bank transactions can be suggested, confirmed, ledger-posted, and unlinked against *groups* of invoices (exact combined payments), alongside today's 1:1 flow which stays byte-for-byte unchanged.

**Architecture:** One direction-agnostic junction table (`bank_transaction_invoice_links`) + a pure subset-sum matcher appended after the existing tiers in a three-phase pipeline (high/medium singles → exact-sum groups → name-tier singles last). Confirm/unlink become group-aware behind the same endpoint; the payment JE gains per-invoice allocation lines while staying one JE per tx.

**Tech Stack:** Cloudflare Workers + Hono + D1 (API), React + TanStack Query (frontend), plain `tsx`-run assert scripts for unit tests (repo convention — no vitest/jest).

**Spec:** `docs/superpowers/specs/2026-08-24-multi-invoice-bank-matching-design.md`

## Global Constraints

- Repo root: `C:\Users\samue\Documents\Pastel\Tech_Connect_SME\Development_code\latest_code` (all paths below relative to it)
- Unit tests run with: `npx --yes tsx tests/<file>.test.ts` from repo root (node:assert/strict, custom `t()` harness — copy the pattern in `tests/bank-matcher.test.ts`)
- API typecheck: `cd api && npx tsc --noEmit` (strict mode)
- Frontend typecheck: `cd frontend && npx tsc -b`
- Sum tolerance at match time: ±0.01 (`< 0.01`). Sum tolerance at confirm time: reject when `>= 0.02` (same constant style as the existing check in `api/src/routes/bank-statements.ts:793`)
- 1:1 behaviour must not change: `bank_transactions.invoice_id` keeps working exactly as today; NULL `invoice_id` on a confirmed tx means "group — read the links"
- No per-member unlink, no `partially_paid` status this round (N:1 fast-follow)
- Do NOT touch the unrelated uncommitted changes already present in the worktree; stage only files listed per task

---

### Task 1: Migration — junction table

**Files:**
- Create: `api/src/db/migration-bank-transaction-invoice-links.sql`
- Modify: `api/src/db/schema.sql` (append table)

**Interfaces:**
- Produces: table `bank_transaction_invoice_links (id TEXT pk, user_id TEXT, transaction_id TEXT, invoice_id TEXT, allocated_amount REAL, created_at TEXT, updated_at TEXT)` + indexes `idx_btil_tx`, `idx_btil_inv`. All later tasks rely on these exact names.

- [ ] **Step 1: Write the migration file**

```sql
-- bank_transaction_invoice_links: direction-agnostic tx↔invoice membership.
-- One row per invoice settled by a bank transaction. 1:1 matches keep using
-- bank_transactions.invoice_id; a GROUP match = match_status='confirmed' +
-- N rows here + bt.invoice_id left NULL. allocated_amount == invoice total
-- this round (full settlement); the N:1 split-payment fast-follow reuses the
-- same rows with allocated_amount < total.
CREATE TABLE IF NOT EXISTS bank_transaction_invoice_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  allocated_amount REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_btil_tx ON bank_transaction_invoice_links(transaction_id);
CREATE INDEX IF NOT EXISTS idx_btil_inv ON bank_transaction_invoice_links(invoice_id);
```

- [ ] **Step 2: Append the same `CREATE TABLE IF NOT EXISTS` + indexes block to `api/src/db/schema.sql`** (end of file, matching its `CREATE TABLE IF NOT EXISTS` house style)

- [ ] **Step 3: Apply locally and verify**

Run:
```bash
cd api && npx wrangler d1 execute opcc-crm-db --local --file=src/db/migration-bank-transaction-invoice-links.sql
npx wrangler d1 execute opcc-crm-db --local --command="SELECT name FROM sqlite_master WHERE name LIKE 'bank_transaction_invoice%'"
```
Expected: table + 2 indexes listed. (Remote apply happens in Task 8, explicitly flagged.)

- [ ] **Step 4: Commit**

```bash
git add api/src/db/migration-bank-transaction-invoice-links.sql api/src/db/schema.sql
git commit -m "feat: bank_transaction_invoice_links junction table migration"
```

---

### Task 2: `findInvoiceGroupMatch` — TDD

**Files:**
- Test: `tests/bank-matcher.test.ts` (append)
- Modify: `api/src/lib/bank-matcher.ts`

**Interfaces:**
- Consumes: existing `MatchableTx`, `MatchableInvoice`, `parseDate`, `fuzzyMatchCompany`, `DAY` inside `bank-matcher.ts`
- Produces:
```ts
export interface InvoiceGroupMatch {
  invoices: MatchableInvoice[];      // members, sorted total desc
  confidence: MatchConfidence;       // 'high' (narration) | 'medium' (exact sum)
  reason: string;
}
export function findInvoiceGroupMatch(
  tx: MatchableTx,
  invoices: MatchableInvoice[],
  excludeIds?: Set<string>
): InvoiceGroupMatch | null;
```
Also annotates existing `InvoiceMatch` with optional `tier?: number` (1=narration, 2=exact, 3=near, 4=name) — Task 3 depends on it.

- [ ] **Step 1: Append failing tests to `tests/bank-matcher.test.ts`** (before the final `console.log` summary), extending the import line to `import { findBestInvoiceMatch, findInvoiceGroupMatch } from '../api/src/lib/bank-matcher';`:

```ts
// ── findInvoiceGroupMatch (multi-invoice combined payments) ──
const P = 'Pastel Tech Limited';
const mkInv = (id: string, num: string, total: number, issue: string, due: string): typeof INV =>
  ({ ...INV, id, invoice_number: num, total, issue_date: issue, due_date: due, counterparty_name: P });

// Ground truth 1: 19 Sep 2025 −57,580.80 = #001414 (15,300) + #001417v2 (42,280.80)
const gt1Pool = [
  mkInv('a1', '#001414', 15300, '2025-06-08', '2025-07-08'),
  mkInv('a2', '#001417v2', 42280.8, '2025-08-20', '2025-09-19'),
];
t('group GT1: 57,580.80 = 15,300 + 42,280.80', () => {
  const g = findInvoiceGroupMatch(
    { id: 'txG1', transaction_date: '2025-09-19', description: 'PASTEL TECH LIMITED HC1259078 19SEP', amount: 57580.8 },
    [...gt1Pool, mkInv('other', '#009999', 99999, '2025-01-01', '2025-02-01')]
  );
  assert.ok(g);
  assert.deepEqual(g.invoices.map(i => i.id).sort(), ['a1', 'a2']);
  assert.equal(g.confidence, 'medium');
  assert.match(g.reason, /Combined payment: 15,300\.00 \+ 42,280\.80 = 57,580\.80/);
});

// Ground truth 2: 5 Nov 2025 −55,000 = #001441 (40,050) + #001442 (14,950)
t('group GT2: 55,000 = 40,050 + 14,950', () => {
  const pool = [
    mkInv('b1', '#001441', 40050, '2025-10-06', '2025-11-05'),
    mkInv('b2', '#001442', 14950, '2025-10-20', '2025-11-19'),
  ];
  const g = findInvoiceGroupMatch(
    { id: 'txG2', transaction_date: '2025-11-05', description: 'PASTEL TECH LIMITED HC125B05213 05NOV', amount: 55000 },
    pool
  );
  assert.ok(g);
  assert.equal(g.invoices.length, 2);
});

// Ground truth 3: 5 Feb 2026 −27,544 = 3 invoices
t('group GT3: 27,544 = 5,200 + 4,150 + 18,194 (three members)', () => {
  const pool = [
    mkInv('c1', '#001458v2', 5200, '2026-01-06', '2026-02-05'),
    mkInv('c2', '#001467-v2', 4150, '2026-01-10', '2026-02-09'),
    mkInv('c3', '#001484-v2', 18194, '2026-01-15', '2026-02-14'),
  ];
  const g = findInvoiceGroupMatch(
    { id: 'txG3', transaction_date: '2026-02-05', description: 'PASTEL TECH LIMITED HC125C0599 05FEB', amount: 27544 },
    pool
  );
  assert.ok(g);
  assert.equal(g.invoices.length, 3);
  assert.match(g.reason, /5,200\.00 \+ 4,150\.00 \+ 18,194\.00 = 27,544\.00/);
});

t('group excludes reserved ids', () => {
  const g = findInvoiceGroupMatch(
    { id: 'txX', transaction_date: '2025-11-05', description: 'PASTEL TECH LIMITED x', amount: 55000 },
    [
      mkInv('b1', '#001441', 40050, '2025-10-06', '2025-11-05'),
      mkInv('b2', '#001442', 14950, '2025-10-20', '2025-11-19'),
    ],
    new Set(['b1'])
  );
  assert.equal(g, null);
});

t('group narration fast-path: 2 referenced numbers -> high confidence without sum match', () => {
  const pool = [
    mkInv('d1', 'INV-777001', 1111, '2025-10-01', '2025-11-01'),
    mkInv('d2', 'INV-777002', 2222, '2025-10-02', '2025-11-02'),
    mkInv('d3', 'INV-777003', 3333, '2025-10-03', '2025-11-03'),
  ];
  const g = findInvoiceGroupMatch(
    { id: 'txY', transaction_date: '2025-11-05', description: 'PAYMENT INV-777001 INV-777002', amount: 88888 },
    pool
  );
  assert.ok(g);
  assert.equal(g.confidence, 'high');
  assert.deepEqual(g.invoices.map(i => i.id).sort(), ['d1', 'd2']);
});

t('group date gate: beyond due+120d rejected', () => {
  // Issue 2025-03-01 due 2025-03-31 -> gate ends ~2025-07-29; pay 2025-09-19.
  const g = findInvoiceGroupMatch(
    { id: 'txZ', transaction_date: '2025-09-19', description: 'PASTEL TECH LIMITED late', amount: 30000 },
    [
      mkInv('e1', '#LATE1', 10000, '2025-03-01', '2025-03-31'),
      mkInv('e2', '#LATE2', 20000, '2025-03-05', '2025-04-04'),
    ]
  );
  assert.equal(g, null);
});

t('group date gate: due+103d passes (real #001414 shape)', () => {
  const g = findInvoiceGroupMatch(
    { id: 'txW', transaction_date: '2025-09-19', description: 'PASTEL TECH LIMITED ok', amount: 57580.8 },
    gt1Pool
  );
  assert.ok(g); // oldest issue Jun 8 − newest due Sep 19 +120d window contains Sep 19
});

t('group sum off by 0.02 -> null', () => {
  const g = findInvoiceGroupMatch(
    { id: 'txV', transaction_date: '2025-11-05', description: 'PASTEL TECH LIMITED off', amount: 55000.02 },
    [
      mkInv('f1', '#S1', 40050, '2025-10-06', '2025-11-05'),
      mkInv('f2', '#S2', 14950, '2025-10-20', '2025-11-19'),
    ]
  );
  assert.equal(g, null);
});

t('group skips cross-currency invoices', () => {
  const g = findInvoiceGroupMatch(
    { id: 'txU', transaction_date: '2025-11-05', description: 'PASTEL TECH LIMITED usd', amount: 55000 },
    [
      { ...mkInv('g1', '#U1', 40050, '2025-10-06', '2025-11-05'), currency: 'USD' },
      mkInv('g2', '#U2', 14950, '2025-10-20', '2025-11-19'),
    ]
  );
  assert.equal(g, null);
});

t('group skips when counterparty does not score >=80 on narration', () => {
  const g = findInvoiceGroupMatch(
    { id: 'txT', transaction_date: '2025-11-05', description: 'TOTALLY UNRELATED COMPANY', amount: 55000 },
    [
      mkInv('h1', '#T1', 40050, '2025-10-06', '2025-11-05'),
      mkInv('h2', '#T2', 14950, '2025-10-20', '2025-11-19'),
    ]
  );
  assert.equal(g, null);
});

t('group pool over cap of 30 -> skip combinatorics', () => {
  const big = Array.from({ length: 31 }, (_, k) => mkInv(`p${k}`, `#P${k}`, 1000 + k, '2025-10-01', '2025-11-01'));
  const g = findInvoiceGroupMatch(
    { id: 'txS', transaction_date: '2025-11-05', description: 'PASTEL TECH LIMITED big', amount: 2000 },
    big
  );
  assert.equal(g, null);
});
```

Note: `INV` and the `t()` harness already exist at the top of the file; `mkInv` builds on `INV` so currency defaults to HKD.

- [ ] **Step 2: Run to verify failure**

Run: `npx --yes tsx tests/bank-matcher.test.ts`
Expected: FAIL — import error / `findInvoiceGroupMatch is not a function` (all new cases fail, all 13 existing cases pass).

- [ ] **Step 3: Implement in `api/src/lib/bank-matcher.ts`**

(a) Extend the exported interface:

```ts
export interface InvoiceMatch {
  invoice: MatchableInvoice;
  confidence: MatchConfidence;
  reason: string;
  tier?: number; // 1 narration · 2 exact · 3 near · 4 name — pipeline ordering (see route phase logic)
}
```

(b) In `evaluateInvoice`, annotate every `return { invoice: inv, ... }` with its tier number: narration → `tier: 1`; exact-amount branch → `tier: 2` (both the medium in-window return and the weak out-of-window one); near-amount return → `tier: 3`; counterparty-name return → `tier: 4`.

(c) In `findBestInvoiceMatch`, make ties deterministic toward earlier tiers:

```ts
if (!best || TIER_RANK[r.confidence] < TIER_RANK[best.confidence]
    || (r.confidence === best.confidence && (r.tier ?? 4) < (best.tier ?? 4))) {
```

(d) Append the group matcher:

```ts
export interface InvoiceGroupMatch {
  invoices: MatchableInvoice[];
  confidence: MatchConfidence;
  reason: string;
}

const GROUP_SUM_TOLERANCE = 0.01;
const GROUP_MAX_MEMBERS = 4;
const GROUP_POOL_CAP = 30;

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
 * Combined-payment detection: one tx settling 2..4 invoices exactly.
 * Pool shares one counterparty whose fuzzy score vs the narration is >=80
 * (same gate as the name tier). Narration fast-path first, then smallest-size-
 * first subset search within ±0.01, gated by loose dates (oldest issue −15d …
 * newest due +120d — real combined payments settle long after due date).
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
    const score = fuzzyMatchCompany(tx.description || '', [party]);
    if (!score.best || score.best.score < 80) continue;
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
        reason: `Combined payment: ${found.map(i => i.total.toFixed(2)).join(' + ')} = ${tx.amount.toFixed(2)}`,
      };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx --yes tsx tests/bank-matcher.test.ts`
Expected: all cases pass (existing 13 + new 11), exit code 0.

- [ ] **Step 5: API typecheck** — Run: `cd api && npx tsc --noEmit` → Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add api/src/lib/bank-matcher.ts tests/bank-matcher.test.ts
git commit -m "feat: findInvoiceGroupMatch — exact-sum combined-payment detection"
```

---

### Task 3: Auto-match route — three-phase pipeline

**Files:**
- Modify: `api/src/routes/bank-statements.ts` (the `bank.post('/auto-match')` handler, lines ~301–412)

**Interfaces:**
- Consumes: `findBestInvoiceMatch` (now returning `tier`), `findInvoiceGroupMatch` (Task 2)
- Produces: response `matched[]` entries — singles keep today's shape `{transaction_id, invoice_id, invoice_number, amount, confidence, reason, direction, invoice_file_id, stmt_file_id}`; groups add entries shaped `{transaction_id, invoice_ids: string[], invoices: {invoice_number,total,file_id}[], amount, confidence, reason, direction, stmt_file_id}` (no `invoice_id` field). `unmatched_count` counts distinct matched transactions. Task 7 consumes this shape.

- [ ] **Step 1: Replace the matching section** (from `const matched: any[] = [];` through the end of the withdrawals loop, keeping `toMatchable` and `deposits`/`withdrawals`/`allInvoices` queries above untouched):

```ts
  const matched: any[] = [];
  const usedInvoiceIds = new Set<string>();
  const matchedTxIds = new Set<string>();
  interface DeferredTx { tx: any; amountKey: string; direction: string; pool: any[]; }
  const deferred: DeferredTx[] = [];

  const toMatchable = (i: any) => ({
    id: i.id, invoice_number: i.invoice_number, total: i.total, currency: i.currency,
    issue_date: i.issue_date, due_date: i.due_date,
    counterparty_name: i.direction === 'incoming' ? (i.supplier_name || i.customer_name) : (i.customer_name || i.supplier_name),
    file_id: i.file_id || null,
  });

  async function stmtFileIdFor(txId: string): Promise<string | null> {
    const stmt = await db.prepare('SELECT r2_key FROM bank_statements WHERE id = (SELECT bank_statement_id FROM bank_transactions WHERE id = ?)').bind(txId).first<any>();
    if (!stmt?.r2_key) return null;
    const f = await db.prepare('SELECT id FROM file_records WHERE r2_key = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1').bind(stmt.r2_key, tenantId).first<any>();
    return f?.id || null;
  }

  function findTiered(tx: any, invoices: any[], amountKey: string) {
    const r = findBestInvoiceMatch(
      { id: tx.id, transaction_date: tx.transaction_date, description: tx.description, reference: tx.reference, amount: tx[amountKey], currency: tx.currency },
      invoices.map(toMatchable),
      usedInvoiceIds
    );
    return r ? { bestMatch: r.invoice, bestConfidence: r.confidence, reason: r.reason, tier: r.tier ?? 4 } : null;
  }

  // Phase A — narration/exact/near singles (tiers 1–3). Name-tier candidates
  // (tier 4) are DEFERRED so groups get first pick of their members (anti-starvation).
  for (const { txs, amountKey, direction, pool } of [
    { txs: deposits.results as any[], amountKey: 'deposit_amount', direction: 'deposit→AR', pool: arInvoices },
    { txs: withdrawals.results as any[], amountKey: 'withdrawal_amount', direction: 'withdrawal→AP', pool: apInvoices },
  ]) {
    for (const tx of txs) {
      const result = findTiered(tx, pool, amountKey);
      if (result && result.tier <= 3) {
        matched.push({ transaction_id: tx.id, invoice_id: result.bestMatch.id,
          invoice_number: result.bestMatch.invoice_number, amount: tx[amountKey],
          confidence: result.bestConfidence, reason: result.reason, direction,
          invoice_file_id: result.bestMatch.file_id || null,
          stmt_file_id: await stmtFileIdFor(tx.id) });
        usedInvoiceIds.add(result.bestMatch.id);
        matchedTxIds.add(tx.id);
      } else {
        deferred.push({ tx, amountKey, direction, pool });
      }
    }
  }

  // Phase B — exact-sum groups over whatever the high tiers left unconsumed.
  for (const d of deferred) {
    const g = findInvoiceGroupMatch(
      { id: d.tx.id, transaction_date: d.tx.transaction_date, description: d.tx.description, reference: d.tx.reference, amount: d.tx[d.amountKey], currency: d.tx.currency },
      d.pool.map(toMatchable),
      usedInvoiceIds
    );
    if (!g) continue;
    matched.push({
      transaction_id: d.tx.id,
      invoice_ids: g.invoices.map(i => i.id),
      invoices: g.invoices.map(i => ({ invoice_number: i.invoice_number, total: i.total, file_id: (i as any).file_id || null })),
      amount: d.tx[d.amountKey], confidence: g.confidence, reason: g.reason,
      direction: d.direction, stmt_file_id: await stmtFileIdFor(d.tx.id),
    });
    for (const i of g.invoices) usedInvoiceIds.add(i.id);
    matchedTxIds.add(d.tx.id);
  }

  // Phase C — name-tier singles LAST, only on invoices no group reserved.
  for (const d of deferred) {
    if (matchedTxIds.has(d.tx.id)) continue; // got a group in Phase B
    const result = findTiered(d.tx, d.pool, d.amountKey);
    if (!result) continue;
    matched.push({ transaction_id: d.tx.id, invoice_id: result.bestMatch.id,
      invoice_number: result.bestMatch.invoice_number, amount: d.tx[d.amountKey],
      confidence: result.bestConfidence, reason: result.reason, direction: d.direction,
      invoice_file_id: result.bestMatch.file_id || null,
      stmt_file_id: await stmtFileIdFor(d.tx.id) });
    usedInvoiceIds.add(result.bestMatch.id);
    matchedTxIds.add(d.tx.id);
  }

  const totalUnmatched = (deposits.results as any[]).length + (withdrawals.results as any[]).length;
  const unmatchedCount = totalUnmatched - matchedTxIds.size;
  return c.json({ matched, unmatched_count: unmatchedCount, excluded_skipped });
```

Update the import at the top of the file: add `findInvoiceGroupMatch` alongside `findBestInvoiceMatch`.

- [ ] **Step 2: Typecheck** — `cd api && npx tsc --noEmit` → Expected: clean.

- [ ] **Step 3: Sanity-run the unit suite again** (matcher unchanged but guard against accidental edits) — `npx --yes tsx tests/bank-matcher.test.ts` → all pass.

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/bank-statements.ts
git commit -m "feat: auto-match 3-phase pipeline — groups between amount singles and name singles"
```

---

### Task 4: `validateGroupConfirm` — TDD

**Files:**
- Create: `api/src/lib/group-confirm.ts`
- Test: `tests/group-confirm.test.ts`

**Interfaces:**
- Consumes: nothing (pure)
- Produces (used by Task 6):
```ts
export interface GroupConfirmInvoiceRow {
  id: string; total: number; direction: string; currency: string | null;
  status: string; deleted_at: string | null; file_id: string | null;
}
export type GroupConfirmResult =
  | { ok: true; allocations: { invoice_id: string; allocated_amount: number }[]; fileIds: (string | null)[] }
  | { ok: false; httpStatus: number; error: string };
export function validateGroupConfirm(input: {
  txAmount: number; txIsDeposit: boolean; txCurrency: string;
  invoices: (GroupConfirmInvoiceRow | undefined)[]; // undefined = requested id not found; order preserved
}): GroupConfirmResult;
```

- [ ] **Step 1: Write failing tests — `tests/group-confirm.test.ts`:**

```ts
/**
 * Group-confirm validator tests — run: npx --yes tsx tests/group-confirm.test.ts
 */
import assert from 'node:assert/strict';
import { validateGroupConfirm, GroupConfirmInvoiceRow } from '../api/src/lib/group-confirm';

let pass = 0, fail = 0;
function t(name: string, fn: () => void): void {
  try { fn(); pass++; console.log('ok   - ' + name); }
  catch (e: any) { fail++; console.error('FAIL - ' + name + '\n       ' + e.message); }
}

const row = (over: Partial<GroupConfirmInvoiceRow>): GroupConfirmInvoiceRow =>
  ({ id: 'x', total: 100, direction: 'incoming', currency: 'HKD', status: 'sent', deleted_at: null, file_id: null, ...over });

const input = (invoices: any[], over: object = {}) => ({
  txAmount: 55000, txIsDeposit: false, txCurrency: 'HKD', invoices, ...over,
});

t('happy path: two AP invoices summing exactly', () => {
  const v = validateGroupConfirm(input([
    row({ id: 'a', total: 40050 }), row({ id: 'b', total: 14950 }),
  ]));
  assert.ok(v.ok);
  assert.deepEqual(v.allocations, [{ invoice_id: 'a', allocated_amount: 40050 }, { invoice_id: 'b', allocated_amount: 14950 }]);
  assert.deepEqual(v.fileIds, [null, null]);
});

t('missing invoice id -> 404', () => {
  const v = validateGroupConfirm(input([row({ id: 'a', total: 40050 }), undefined]));
  assert.ok(!v.ok && v.httpStatus === 404);
});

t('single invoice -> 400 (use the 1:1 path)', () => {
  const v = validateGroupConfirm(input([row({ total: 55000 })]));
  assert.ok(!v.ok && v.httpStatus === 400);
});

t('duplicate ids -> 400', () => {
  const v = validateGroupConfirm(input([row({ id: 'a', total: 27500 }), row({ id: 'a', total: 27500 })]));
  assert.ok(!v.ok && v.httpStatus === 400);
});

t('deleted member -> 409', () => {
  const v = validateGroupConfirm(input([row({ deleted_at: '2026-01-01' }), row()]));
  assert.ok(!v.ok && v.httpStatus === 409);
});

t('paid member -> 409', () => {
  const v = validateGroupConfirm(input([row({ status: 'paid' }), row()]));
  assert.ok(!v.ok && v.httpStatus === 409);
});

t('cancelled member -> 409', () => {
  const v = validateGroupConfirm(input([row({ status: 'cancelled' }), row()]));
  assert.ok(!v.ok && v.httpStatus === 409);
});

t('deposit cannot pay AP incoming -> 400', () => {
  const v = validateGroupConfirm(input([row({ total: 40050 }), row({ total: 14950 })], { txIsDeposit: true }));
  assert.ok(!v.ok && v.httpStatus === 400);
});

t('withdrawal cannot pay AR outgoing -> 400', () => {
  const v = validateGroupConfirm(input([row({ direction: 'outgoing', total: 40050 }), row({ direction: 'outgoing', total: 14950 })]));
  assert.ok(!v.ok && v.httpStatus === 400);
});

t('currency mismatch -> 409', () => {
  const v = validateGroupConfirm(input([row({ currency: 'USD', total: 40050 }), row()]));
  assert.ok(!v.ok && v.httpStatus === 409);
});

t('sum off by 0.03 -> 409', () => {
  const v = validateGroupConfirm(input([row({ total: 40050 }), row({ total: 14953 })]));
  assert.ok(!v.ok && v.httpStatus === 409);
});

t('sum boundary: off by exactly 0.02 rejected, 0.01 accepted', () => {
  const rej = validateGroupConfirm(input([row({ total: 40050 }), row({ total: 14952 })]));
  assert.ok(!rej.ok && rej.httpStatus === 409);
  const acc = validateGroupConfirm(input([row({ total: 40050 }), row({ total: 14951 })]));
  assert.ok(acc.ok);
});
```

- [ ] **Step 2: Run** — `npx --yes tsx tests/group-confirm.test.ts` → Expected: FAIL (module not found).

- [ ] **Step 3: Implement `api/src/lib/group-confirm.ts`:**

```ts
/**
 * Pure validation for confirming ONE bank transaction against a GROUP of
 * invoices (combined payment). Mirrors the single-match guards in
 * PATCH /bank-statements/transactions/:id/match — extracted so the rules are
 * unit-testable without a DB.
 */

export interface GroupConfirmInvoiceRow {
  id: string;
  total: number;
  direction: string;
  currency: string | null;
  status: string;
  deleted_at: string | null;
  file_id: string | null;
}

export type GroupConfirmResult =
  | { ok: true; allocations: { invoice_id: string; allocated_amount: number }[]; fileIds: (string | null)[] }
  | { ok: false; httpStatus: number; error: string };

export function validateGroupConfirm(input: {
  txAmount: number;
  txIsDeposit: boolean;
  txCurrency: string;
  invoices: (GroupConfirmInvoiceRow | undefined)[];
}): GroupConfirmResult {
  const invs = input.invoices;
  if (invs.some(i => !i)) return { ok: false, httpStatus: 404, error: 'One or more invoices not found' };
  if (invs.length < 2) return { ok: false, httpStatus: 400, error: 'A combined payment needs at least two invoices' };

  const ids = new Set(invs.map(i => i!.id));
  if (ids.size !== invs.length) return { ok: false, httpStatus: 400, error: 'Duplicate invoice ids in invoice_ids' };

  for (const inv of invs as GroupConfirmInvoiceRow[]) {
    if (inv.deleted_at) return { ok: false, httpStatus: 409, error: 'One or more invoices are deleted' };
    if (inv.status === 'paid') return { ok: false, httpStatus: 409, error: 'Invoice already paid' };
    if (inv.status === 'cancelled') return { ok: false, httpStatus: 409, error: 'Invoice is cancelled' };
    const incoming = inv.direction === 'incoming';
    if (input.txIsDeposit === incoming) {
      return { ok: false, httpStatus: 400, error: input.txIsDeposit
        ? 'A deposit cannot pay an incoming (AP) invoice'
        : 'A withdrawal cannot pay an outgoing (AR) invoice' };
    }
    if ((inv.currency || 'HKD') !== input.txCurrency) {
      return { ok: false, httpStatus: 409, error: `Currency mismatch: ${input.txCurrency} vs ${inv.currency || 'HKD'}` };
    }
  }

  const sum = invs.reduce((s, i) => s + i!.total, 0);
  if (Math.abs(sum - input.txAmount) >= 0.02) {
    return { ok: false, httpStatus: 409, error: `Amount mismatch: transaction ${input.txAmount} vs invoices total ${sum}` };
  }

  return {
    ok: true,
    allocations: invs.map(i => ({ invoice_id: i!.id, allocated_amount: i!.total })),
    fileIds: invs.map(i => i!.file_id),
  };
}
```

- [ ] **Step 4: Run** — all 12 pass, exit 0.

- [ ] **Step 5: Commit**

```bash
git add api/src/lib/group-confirm.ts tests/group-confirm.test.ts
git commit -m "feat: validateGroupConfirm pure validator for combined-payment confirms"
```

---

### Task 5: `postPaymentToGl` allocation lines — TDD with a fake D1

**Files:**
- Modify: `api/src/lib/post-payment.ts`
- Test: `tests/post-payment.test.ts` (create)

**Interfaces:**
- Consumes: junction table names from Task 1; signature unchanged: `postPaymentToGl(db, tenantId, txId) → {entry_id, entry_number, already_posted?, error?}`
- Produces: for group txs ONE JE (`reference_type='payment'`, `reference_id=txId`) with N contra lines + 1 bank line; entry numbers `JE-PMT-MULTI-<txId8>` (groups) vs `JE-PMT-<invoice_number>` (1:1, unchanged).

- [ ] **Step 1: Write failing tests — `tests/post-payment.test.ts`:** (note: this file needs an **async** harness — replace the sync `t()` from other files with the variant shown below)

```ts
/**
 * postPaymentToGl tests with a minimal fake D1 — run: npx --yes tsx tests/post-payment.test.ts
 */
import assert from 'node:assert/strict';
import { postPaymentToGl } from '../api/src/lib/post-payment';

let pass = 0, fail = 0;
async function t(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); pass++; console.log('ok   - ' + name); }
  catch (e: any) { fail++; console.error('FAIL - ' + name + '\n       ' + e.message); }
}

class FakeD1 {
  calls: { sql: string; args: any[] }[] = [];
  constructor(private scripted: [RegExp, any][] = []) {}
  prepare(sql: string) {
    const bound = {
      first: async () => {
        this.calls.push({ sql, args });
        for (const [re, v] of this.scripted) if (re.test(sql)) return v;
        return null;
      },
      all: async () => {
        this.calls.push({ sql, args });
        for (const [re, v] of this.scripted) if (re.test(sql)) return { results: v };
        return { results: [] };
      },
      run: async () => { this.calls.push({ sql, args }); return { meta: { changes: 1 } }; },
      raw: async () => { throw new Error('not implemented in fake'); },
    };
    return { bind: (..._args: any[]) => bound } as any;
  }
  batch(_stmts: any[]) { throw new Error('postPaymentToGl must not batch'); }
  insertedLines(): { account_code: string; debit: number; credit: number; description: string }[] {
    return this.calls
      .filter(c => /INSERT INTO journal_lines/.test(c.sql))
      .map(c => ({ account_code: c.args[2], debit: c.args[5], credit: c.args[6], description: c.args[4] }));
  }
  entryNumber(): string | null {
    const ins = this.calls.find(c => /INSERT INTO journal_entries/.test(c.sql));
    return ins ? ins.args[2] : null;
  }
}
const db = (f: FakeD1) => f as unknown as D1Database;

const TX_BASE = {
  id: 'tx-multi', transaction_date: '2025-11-05', deposit_amount: 0, withdrawal_amount: 55000,
  invoice_id: null, match_status: 'confirmed', bank_account_code: '11102',
};
const LINKS = [
  { invoice_id: 'ia', allocated_amount: 40050, invoice_number: '#001441', direction: 'incoming' },
  { invoice_id: 'ib', allocated_amount: 14950, invoice_number: '#001442', direction: 'incoming' },
];

t('group: one JE, N creditor Dr lines + one bank Cr line, MULTI entry number', async () => {
  const f = new FakeD1([
    [/FROM bank_transactions[\s\S]*LEFT JOIN bank_statements/, { ...TX_BASE }],
    [/reference_type = 'payment'/, null],
    [/bank_transaction_invoice_links/, LINKS],
  ]);
  const r = await postPaymentToGl(db(f), 'tenant', 'tx-multi');
  assert.ok(!r.error, r.error);
  assert.match(r.entry_number, /^JE-PMT-MULTI-tx-multi/);
  const lines = f.insertedLines();
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map(l => l.account_code), ['21101', '21101', '11102']);
  assert.equal(lines[0].debit, 40050);
  assert.equal(lines[0].description, '#001441');
  assert.equal(lines[1].debit, 14950);
  assert.equal(lines[2].credit, 55000);
  const je = f.calls.find(c => /INSERT INTO journal_entries/.test(c.sql));
  assert.match(je!.args[4], /#001441.*#001442|Combined payment/i);
});

t('1:1 fallback: invoice_id set -> legacy pair + JE-PMT-<number>', async () => {
  const f = new FakeD1([
    [/FROM bank_transactions/, { ...TX_BASE, invoice_id: 'ia' }],
    [/reference_type = 'payment'/, null],
    [/FROM invoices WHERE id/, { invoice_number: '#001441', total: 40050, direction: 'incoming' }],
  ]);
  const r = await postPaymentToGl(db(f), 'tenant', 'tx-single');
  assert.ok(!r.error, r.error);
  assert.equal(r.entry_number, 'JE-PMT-#001441');
  const lines = f.insertedLines();
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map(l => l.account_code), ['21101', '11102']);
  assert.equal(lines[0].debit, 40050);
  assert.equal(lines[1].credit, 40050);
});

t('idempotent: existing live payment JE short-circuits', async () => {
  const f2 = new FakeD1([
    [/FROM journal_entries[\s\S]*reference_type = 'payment'/, { id: 'je-x', entry_number: 'JE-PMT-old' }],
    [/FROM bank_transactions/, { ...TX_BASE }],
  ]);
  const r = await postPaymentToGl(db(f2), 'tenant', 'tx-multi');
  assert.equal(r.entry_id, 'je-x');
  assert.equal(r.already_posted, true);
  assert.equal(f2.insertedLines().length, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

(The `t()` harness here must be the async variant shown above; tsx runs ESM so top-level `await` works.)

**Prefix every test invocation with `await`** — e.g. `await t('group: one JE, N creditor Dr lines + one bank Cr line, MULTI entry number', async () => { … });` — so the trailing `${pass} passed, ${fail} failed` summary runs after all cases finish and the exit-code gate stays correct.

- [ ] **Step 2: Implement in `api/src/lib/post-payment.ts`** — replace the body after the idempotency check:

```ts
  // Idempotency check stays where it is today: AFTER the base-tx fetch, BEFORE
  // any INSERT. (Original file order preserved.)

  const base = await db.prepare(
    `SELECT bt.*, bs.account_code as bank_account_code
     FROM bank_transactions bt
     LEFT JOIN bank_statements bs ON bt.bank_statement_id = bs.id
     WHERE bt.id = ? AND bt.user_id = ? AND bt.match_status = 'confirmed' AND bt.deleted_at IS NULL`
  ).bind(txId, tenantId).first<{ id: string; transaction_date: string; deposit_amount: number; withdrawal_amount: number; invoice_id: string | null; bank_account_code: string | null }>();
  if (!base) return { error: 'Transaction not found or not matched', entry_id: '', entry_number: '' };

  const isDeposit = base.deposit_amount > 0;
  const amount = isDeposit ? base.deposit_amount : base.withdrawal_amount;
  const bankAccount = base.bank_account_code || '11101';
  const jeId = `je-${uuidv4().slice(0, 8)}`;

  // GROUP path: confirmed tx with junction rows and NULL invoice_id
  let links: { invoice_id: string; allocated_amount: number; invoice_number: string }[] = [];
  if (!base.invoice_id) {
    const lr = await db.prepare(
      `SELECT l.invoice_id, l.allocated_amount, i.invoice_number
       FROM bank_transaction_invoice_links l JOIN invoices i ON l.invoice_id = i.id
       WHERE l.transaction_id = ? AND l.user_id = ?
       ORDER BY l.allocated_amount DESC`
    ).bind(txId, tenantId).all<{ invoice_id: string; allocated_amount: number; invoice_number: string }>();
    links = lr.results || [];
    if (links.length === 0) return { error: 'Transaction not found or not matched to an invoice', entry_id: '', entry_number: '' };
  }

  if (links.length > 0) {
    const jeNum = `JE-PMT-MULTI-${txId.slice(0, 8)}`;
    const nums = links.map(l => l.invoice_number).join(', ');
    const desc = `Combined payment for ${links.length} invoices: ${nums}`;
    await db.prepare(
      'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id) VALUES (?,?,?,?,?,?,?)'
    ).bind(jeId, tenantId, jeNum, base.transaction_date, desc, 'payment', txId).run();

    let sort = 0;
    const line = (accountCode: string, accountName: string, lineDesc: string, debit: number, credit: number) =>
      db.prepare(
        'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?,?,?,?,?,?,?,?)'
      ).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, accountCode, accountName, lineDesc, debit, credit, sort++).run();

    if (isDeposit) {
      await line(bankAccount, 'Bank', nums.slice(0, 120), amount, 0);
      for (const l of links) await line('11201', 'Trade Debtors', l.invoice_number, 0, l.allocated_amount);
    } else {
      for (const l of links) await line('21101', 'Trade Creditors', l.invoice_number, l.allocated_amount, 0);
      await line(bankAccount, 'Bank', nums.slice(0, 120), 0, amount);
    }
    return { entry_id: jeId, entry_number: jeNum };
  }

  // Legacy 1:1 path — fetch the linked invoice exactly as before and reuse the
  // original single-pair posting below unchanged.
  const inv = await db.prepare(
    'SELECT invoice_number, total, direction FROM invoices WHERE id = ? AND user_id = ?'
  ).bind(base.invoice_id, tenantId).first<{ invoice_number: string; total: number; direction: string }>();
  if (!inv) return { error: 'Transaction not found or not matched to an invoice', entry_id: '', entry_number: '' };

  const jeNum = `JE-PMT-${inv.invoice_number || txId.slice(0, 8)}`;
  // ... existing AR/AP single-pair INSERTs follow, using inv.invoice_number / amount
  // (keep the current code from here verbatim, substituting tx.invoice_number → inv.invoice_number)
```

Concretely, keep the old `if (isDeposit) {...} else {...}` blocks but bind `inv.invoice_number || ''` where they previously used `tx.invoice_number`, and use `jeNum` computed above instead of `JE-PMT-${tx.invoice_number||...}`.

- [ ] **Step 3: Run tests** — `npx --yes tsx tests/post-payment.test.ts` → 3 pass. Then `cd api && npx tsc --noEmit` → clean.

- [ ] **Step 4: Commit**

```bash
git add api/src/lib/post-payment.ts tests/post-payment.test.ts
git commit -m "feat: per-invoice allocation lines in payment JE for combined payments"
```

---

### Task 6: Endpoint — group confirm + group-aware unlink

**Files:**
- Modify: `api/src/routes/bank-statements.ts` — `bank.patch('/transactions/:id/match')` (lines ~749–856)

**Interfaces:**
- Consumes: `validateGroupConfirm` (Task 4), `postPaymentToGl` (Task 5), junction table (Task 1)
- Produces: request body accepts `invoice_ids: string[]` (≥2) alongside legacy `invoice_id`. Response for groups mirrors the single shape plus `invoice_ids`. Unlink reverts groups atomically. Consumed by frontend Task 7.

- [ ] **Step 1: Add the group-confirm branch.** First hoist the direction/amount consts: delete `const isDeposit = tx.deposit_amount > 0;` (single branch, ~line 786) and `const txAmount = isDeposit ? tx.deposit_amount : tx.withdrawal_amount;` (~line 792) from inside the single-invoice block, and declare both once just after `const effectiveAction = action === 'link' ? 'confirm' : action;` (~line 770). Then insert this branch right after the existing single-invoice `confirm` block (after line ~818):

```ts
  // ── GROUP confirm: one tx settles several invoices exactly ──
  if (effectiveAction === 'confirm' && Array.isArray(body.invoice_ids)) {
    const requested: string[] = body.invoice_ids;
    if (tx.match_status === 'confirmed') return c.json({ error: 'Transaction already matched — unlink first' }, 409);

    const placeholders = requested.map(() => '?').join(',');
    const rowsRes = await db.prepare(
      `SELECT id, status, total, direction, currency, file_id, deleted_at
       FROM invoices WHERE id IN (${placeholders}) AND user_id = ?`
    ).bind(...requested, tenantId).all<any>();
    const byId = new Map<string, any>((rowsRes.results || []).map(r => [r.id, r]));
    const ordered = requested.map(id => byId.get(id));

    const v = validateGroupConfirm({
      txAmount, txIsDeposit: tx.deposit_amount > 0, txCurrency: tx.currency, invoices: ordered,
    });
    if (!v.ok) return c.json({ error: v.error }, v.httpStatus as 400 | 404 | 409);

    const stmts = [
      db.prepare(
        `UPDATE bank_transactions SET match_confidence = 'manual', match_status = 'confirmed'
         WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
      ).bind(txId, tenantId),
      ...v.allocations.map(a => db.prepare(
        `INSERT INTO bank_transaction_invoice_links (id, user_id, transaction_id, invoice_id, allocated_amount)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(`btil-${uuidv4().slice(0, 8)}`, tenantId, txId, a.invoice_id, a.allocated_amount)),
      ...v.allocations.map(a => db.prepare(
        `UPDATE invoices SET status = 'paid', paid_date = ?, updated_at = datetime('now')
         WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
      ).bind(tx.transaction_date, a.invoice_id, tenantId)),
      ...v.fileIds.filter((fid): fid is string => !!fid).map(fid => db.prepare(
        `UPDATE file_records SET payment_status = 'matched', updated_at = datetime('now')
         WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
      ).bind(fid, tenantId)),
    ];
    await db.batch(stmts);

    const gl = await postPaymentToGl(db, tenantId, txId);
    const ids = v.allocations.map(a => a.invoice_id);
    await auditLog(db, user.id, 'confirm_match_group', 'bank_transaction', txId, { invoice_ids: ids, action: 'confirm_group', gl_entry: gl.entry_id || gl.error });
    return c.json({ success: true, invoice_status: 'paid', paid_date: tx.transaction_date, invoice_ids: ids, gl_entry_id: gl.entry_id || null, gl_error: gl.error || null });
  }
```

Add to the file imports: `validateGroupConfirm` and ensure `uuidv4` is imported (it is, for other routes).

- [ ] **Step 2: Make unlink/reject group-aware** — replace the body of the `reject/unlink` branch between "Reset the transaction" and the JE delete with:

```ts
    // Reset the transaction
    await db.prepare(
      `UPDATE bank_transactions SET invoice_id = NULL, match_confidence = NULL, match_status = 'unmatched' WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
    ).bind(txId, tenantId).run();

    // Group members (junction rows) — revert ALL of them atomically-ish with
    // the tx reset; there is no per-member unlink by design this round.
    const linkRows = await db.prepare(
      `SELECT l.invoice_id, i.file_id FROM bank_transaction_invoice_links l
       JOIN invoices i ON i.id = l.invoice_id
       WHERE l.transaction_id = ? AND l.user_id = ?`
    ).bind(txId, tenantId).all<{ invoice_id: string; file_id: string | null }>();
    const groupInvoiceIds = (linkRows.results || []).map(r => r.invoice_id);

    if (groupInvoiceIds.length > 0) {
      const ph = groupInvoiceIds.map(() => '?').join(',');
      await db.prepare(`DELETE FROM bank_transaction_invoice_links WHERE transaction_id = ? AND user_id = ?`).bind(txId, tenantId).run();
      await db.prepare(
        `UPDATE invoices SET status = 'sent', paid_date = NULL, updated_at = datetime('now')
         WHERE id IN (${ph}) AND user_id = ? AND status = 'paid'`
      ).bind(...groupInvoiceIds, tenantId).run();
      const fileIds = (linkRows.results || []).map(r => r.file_id).filter((f): f is string => !!f);
      if (fileIds.length > 0) {
        const phF = fileIds.map(() => '?').join(',');
        await db.prepare(
          `UPDATE file_records SET payment_status = 'unmatched', updated_at = datetime('now')
           WHERE id IN (${phF}) AND user_id = ? AND deleted_at IS NULL`
        ).bind(...fileIds, tenantId).run();
      }
    } else if (linkedInvoiceId) {
      // …existing 1:1 revert block stays here verbatim…
    }
```

Keep the trailing payment-JE delete and audit log as-is (they already apply to both shapes; optionally enrich auditLog `changes` payload with `{ group_size: groupInvoiceIds.length }`).

- [ ] **Step 3: Typecheck + suites** — `cd api && npx tsc --noEmit`; `npx --yes tsx tests/group-confirm.test.ts`; `npx --yes tsx tests/bank-matcher.test.ts`; `npx --yes tsx tests/post-payment.test.ts` → all green.

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/bank-statements.ts
git commit -m "feat: group confirm (invoice_ids[]) + group-aware unlink on match endpoint"
```

---

### Task 7: Frontend — review modal + page wiring

**Files:**
- Modify: `frontend/src/components/AutoMatchReviewModal.tsx`
- Modify: `frontend/src/pages/BankStatements.tsx` (`confirmMatchMut` ~line 135 + modal usage ~line 891)
- Modify: `frontend/src/pages/AP.tsx`, `frontend/src/pages/AR.tsx`, `frontend/src/pages/FileStorage.tsx` (their `matchConfirmMut` + modal usage)

**Interfaces:**
- Consumes: group response shape (Task 3), endpoint `invoice_ids` body (Task 6)
- Produces: modal prop contract `onConfirm: (txId: string, invoiceId: string | null, invoiceIds?: string[]) => void | Promise<void>`

- [ ] **Step 1: Update `AutoMatchReviewModal.tsx`:**

(a) Props + handlers:

```tsx
export default function AutoMatchReviewModal({ matches, onConfirm, onReject, onClose }: {
  matches: any[];
  onConfirm: (txId: string, invoiceId: string | null, invoiceIds?: string[]) => void | Promise<void>;
  onReject: (txId: string) => void | Promise<void>;
  onClose: () => void;
}) {
```

`handleConfirm` becomes `(m: any)`:

```tsx
  const handleConfirm = async (m: any) => {
    setProcessing(m.transaction_id);
    try {
      await onConfirm(m.transaction_id, m.invoice_id ?? null, m.invoice_ids);
      setConfirmed(prev => new Set(prev).add(m.transaction_id));
    } catch { /* parent surfaces the error; keep the row pending */ }
    setProcessing(null);
  };
```

`acceptAll` iterates `for (const m of pending) await handleConfirm(m);`.
Both Confirm buttons call `handleConfirm(m)`.
The pending filter (`confirmed`/`rejected` keyed by `transaction_id`) already collapses alternatives once one row of a tx resolves — no change needed there.

(b) Row header — replace the `<span className="text-sm font-medium truncate">{m.invoice_number}</span>` line with:

```tsx
{(m.invoice_ids?.length ?? 0) >= 2 ? (
  <>
    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">COMBINED</span>
    <span className="text-sm font-medium truncate">{m.invoices.map((i: any) => i.invoice_number).join(' + ')}</span>
  </>
) : (
  <span className="text-sm font-medium truncate">{m.invoice_number}</span>
)}
```

(c) Expanded preview pane — replace the two-pane `<div className="flex gap-3 h-80">…</div>` block with statement-left plus a horizontally scrollable invoice area:

```tsx
<div className="flex gap-3 h-80">
  <div className="flex-1 min-w-[220px] flex flex-col">
    <span className="text-[10px] text-muted-foreground mb-1">{tr('Bank Statement', '銀行月結單', '银行月结单')}</span>
    {m.stmt_file_id ? (
      <iframe src={`${WORKER_API_BASE}/file-storage/${m.stmt_file_id}/download?inline=1&token=${token}${iframeClientParam()}`}
        className="w-full flex-1 border rounded" title="Bank Statement" />
    ) : (
      <div className="w-full flex-1 border rounded bg-muted/30 flex items-center justify-center text-xs text-muted-foreground">
        {tr('No statement file', '沒有月結單文件', '没有月结单文件')}
      </div>
    )}
  </div>
  {(m.invoice_ids?.length ?? 0) >= 2 ? (
    <div className="flex-[2] flex gap-3 overflow-x-auto">
      {m.invoices.map((inv: any) => (
        <div key={inv.invoice_number} className="flex-1 min-w-[240px] flex flex-col">
          <span className="text-[10px] text-muted-foreground mb-1 truncate">{tr('Invoice', '發票', '发票')} · {inv.invoice_number}</span>
          {inv.file_id ? (
            <iframe src={`${WORKER_API_BASE}/file-storage/${inv.file_id}/download?inline=1&token=${token}${iframeClientParam()}`}
              className="w-full flex-1 border rounded" title={inv.invoice_number} />
          ) : (
            <div className="w-full flex-1 border rounded bg-muted/30 flex items-center justify-center text-xs text-muted-foreground">
              {tr('No invoice file', '沒有發票文件', '没有发票文件')}
            </div>
          )}
        </div>
      ))}
    </div>
  ) : (
    <div className="flex-1 flex flex-col">
      <span className="text-[10px] text-muted-foreground mb-1">{tr('Invoice', '發票', '发票')}</span>
      {m.invoice_file_id ? (
        <iframe src={`${WORKER_API_BASE}/file-storage/${m.invoice_file_id}/download?inline=1&token=${token}${iframeClientParam()}`}
          className="w-full flex-1 border rounded" title="Invoice" />
      ) : (
        <div className="w-full flex-1 border rounded bg-muted/30 flex items-center justify-center text-xs text-muted-foreground">
          {tr('No invoice file', '沒有發票文件', '没有发票文件')}
        </div>
      )}
    </div>
  )}
</div>
```

- [ ] **Step 2: Wire the four pages.** In each of `BankStatements.tsx` (`confirmMatchMut`) / `AP.tsx` / `AR.tsx` / `FileStorage.tsx` (`matchConfirmMut`):

```ts
    mutationFn: ({ txId, invoiceId, invoiceIds }: { txId: string; invoiceId: string | null; invoiceIds?: string[] }) =>
      api(`/bank-statements/transactions/${txId}/match`, {
        method: 'PATCH',
        body: invoiceIds?.length
          ? { invoice_ids: invoiceIds, action: 'confirm' }
          : { invoice_id: invoiceId, action: 'confirm' },
      }),
```

And each modal call site:

```tsx
onConfirm={(txId, invoiceId, invoiceIds) =>
  confirmMatchMut.mutateAsync({ txId, invoiceId, invoiceIds })
}
```

(matching the page's own mutation name — `matchConfirmMut` in AP/AR/FileStorage). Leave `LinkedDocModal` manual-link flows untouched.

- [ ] **Step 3: Typecheck** — `cd frontend && npx tsc -b` → clean. Optional smoke: `npm run dev` and click Auto-Match on a statement card.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/AutoMatchReviewModal.tsx frontend/src/pages/BankStatements.tsx frontend/src/pages/AP.tsx frontend/src/pages/AR.tsx frontend/src/pages/FileStorage.tsx
git commit -m "feat: COMBINED group suggestions with N-invoice side-by-side preview"
```

---

### Task 8: Live verification + docs

**Files:**
- Modify: `tests/REGRESSION_SUITE.md`, `SESSION_STATE.md`

**Context:** Tenant `u-83161e0c` (joseph.lin@pnr.hk) already holds the 7 component invoices (live since the 2026-08-24 observation run) and the 3 unmatched combined txs. `tests/auto-link-onetomany.spec.ts` supports `SKIP_UPLOAD=1 HOLD_MS=30000`.

- [ ] **Step 1: Apply migration to remote D1 (explicit deploy action)**

```bash
cd api && npx wrangler d1 execute opcc-crm-db --remote --file=src/db/migration-bank-transaction-invoice-links.sql
```

- [ ] **Step 2: Deploy** — `npm run deploy:api` and `npm run deploy:frontend` (root). Flag to the user before running.

- [ ] **Step 3: Live regression**

```bash
SKIP_UPLOAD=1 HOLD_MS=30000 npx playwright test auto-link-onetomany --headed
```
Expected: suggestions include the three combined amounts — 57,580.80 → 2 `invoice_ids`; 55,000 → 2; 27,544 → 3; no wrong name-tier single for those txs (alternatives may legitimately appear as separate rows).

- [ ] **Step 4: Confirm a group end-to-end in the observed browser session** (spec already holds the results modal; extend manually if needed): confirm the 55,000 group → verify response `invoice_ids`, invoice list shows both paid, GL entry `JE-PMT-MULTI-*` with 3 lines; then unlink → everything reverted. Record results in the task output.

- [ ] **Step 5: Update `tests/REGRESSION_SUITE.md`** multi-invoice section: mark the three combined-payment checks as PASSING with date + note "auto 1:N live-verified"; bump notes only — do not renumber existing checks.

- [ ] **Step 6: Append a dated note to `SESSION_STATE.md`**: feature shipped, spec + plan paths, migration applied remotely, live-verification summary.

- [ ] **Step 7: Commit**

```bash
git add tests/REGRESSION_SUITE.md SESSION_STATE.md
git commit -m "docs: 1:N combined-payment matching live-verified"
```

---

## Self-Review Notes (written by plan author)

- Spec §3→Task 1 · §4/§5→Tasks 2–3 · §6→Tasks 4+6 · §7→Task 5 · §8→Task 6 Step 2 · §9→Task 7 · §10→Task 4/6 validations · §11→unit steps in Tasks 2/4/5 + Task 8 live run · §12 out-of-scope respected (no partial states anywhere).
- Naming consistency checked: `findInvoiceGroupMatch` / `InvoiceGroupMatch` / `validateGroupConfirm` / `GroupConfirmResult` / `bank_transaction_invoice_links` identical across tasks.
- Known deliberate deviation from spec wording: spec said unlink writes "in one batch"; implementation keeps the existing sequential style for the shared tx-reset/JE-delete statements and batches nothing new — D1 batch was specified for the confirm path (which does use `db.batch`). Acceptable; flag to reviewer if strict atomicity wanted for unlink too.
