# Unreconciled Filter from Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When user clicks "Unreconciled" on Dashboard, navigate to Bank Statements page filtered to show only unreconciled transactions, grouped by statement, with visual highlighting.

**Architecture:** Client-side only. Dashboard passes `?filter=unmatched` query param. BankStatements component reads it, filters transactions, auto-expands affected statements, and shows a filter banner.

**Tech Stack:** React 18, React Router v6, Tailwind CSS, TypeScript

## Global Constraints

- No backend changes — all filtering is client-side
- Existing `?highlight` param must coexist with new `?filter` param
- Follow existing code patterns in `BankStatements.tsx`
- Use existing `tr()` for i18n (EN, zh-Hant, zh-Hans)

---

## File Map

| File | Change |
|------|--------|
| `frontend/src/pages/Dashboard.tsx` | Modify navigate call on line 152 |
| `frontend/src/pages/BankStatements.tsx` | Add filter reading, auto-expand, transaction filtering, banner, badge, empty state |

---

### Task 1: Dashboard — Add filter param to navigation

**Files:**
- Modify: `frontend/src/pages/Dashboard.tsx:152`

**Interfaces:**
- Consumes: nothing
- Produces: navigates to `/bank-statements?filter=unmatched`

- [ ] **Step 1: Change navigate call**

```tsx
// Line 152 — change from:
onClick={() => navigate('/bank-statements')}
// to:
onClick={() => navigate('/bank-statements?filter=unmatched')}
```

- [ ] **Step 2: Verify no other navigate calls to bank-statements need updating**

Search for `navigate('/bank-statements'` in Dashboard.tsx to confirm there's only one.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Dashboard.tsx
git commit -m "feat: add ?filter=unmatched param when navigating from unreconciled dashboard card"
```

---

### Task 2: BankStatements — Read filter from URL and auto-expand affected statements

**Files:**
- Modify: `frontend/src/pages/BankStatements.tsx:49-50` (searchParams section)
- Modify: `frontend/src/pages/BankStatements.tsx:208-224` (highlight useEffect section)

**Interfaces:**
- Consumes: `?filter=unmatched` from URL search params
- Produces: `activeFilter` state, auto-expanded statements

- [ ] **Step 1: Read filter from URL search params**

After line 50 (`const highlightStmtId = searchParams.get('highlight') || null;`), add:

```tsx
const activeFilter = searchParams.get('filter') || null;
```

- [ ] **Step 2: Add auto-expand useEffect for unreconciled filter**

After the existing `highlightStmtId` useEffect (after line 224), add a new useEffect:

```tsx
const filterFiredRef = useRef<boolean>(false);
useEffect(() => {
  if (activeFilter !== 'unmatched' || filterFiredRef.current || !statements.length) return;
  filterFiredRef.current = true;
  const stmtsWithUnreconciled = statements.filter((s: any) => s.unlinked_count > 0);
  if (stmtsWithUnreconciled.length > 0) {
    setExpandedId(stmtsWithUnreconciled[0].id);
    setTimeout(() => {
      const card = document.getElementById(`stmt-row-${stmtsWithUnreconciled[0].id}`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 200);
  }
}, [activeFilter, statements]);
```

- [ ] **Step 3: Verify expand works**

Manually test: navigate to `/bank-statements?filter=unmatched` — first statement with unlinked transactions should auto-expand and scroll into view.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/BankStatements.tsx
git commit -m "feat: read ?filter=unmatched from URL and auto-expand first affected statement"
```

---

### Task 3: BankStatements — Filter transactions when filter is active

**Files:**
- Modify: `frontend/src/pages/BankStatements.tsx:433` (transaction map in the table body)

**Interfaces:**
- Consumes: `activeFilter` state, `transactions` array
- Produces: filtered transaction list rendered in table

- [ ] **Step 1: Add filtered transactions computation**

After line 231 (`const suggestedCount = ...`), add:

```tsx
const filteredTransactions = activeFilter === 'unmatched'
  ? transactions.filter((tx: Transaction) =>
      !tx.invoice_id && !tx.card_statement_id &&
      tx.match_status !== 'confirmed' && tx.match_status !== 'skipped'
    )
  : transactions;
```

- [ ] **Step 2: Replace `transactions` with `filteredTransactions` in the table body**

On line 433, change:

```tsx
// from:
{transactions.map((tx: Transaction) => {
// to:
{filteredTransactions.map((tx: Transaction) => {
```

- [ ] **Step 3: Also filter the summary counts when filter is active**

After line 231, update the summary calculations to use filtered data when filter is active:

```tsx
const displayTransactions = activeFilter === 'unmatched' ? filteredTransactions : transactions;
const totalDeposits = displayTransactions.reduce((s: number, tx: Transaction) => s + tx.deposit_amount, 0);
const totalWithdrawals = displayTransactions.reduce((s: number, tx: Transaction) => s + tx.withdrawal_amount, 0);
```

Then use `displayTransactions` for the summary bar totals (lines 229-231).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/BankStatements.tsx
git commit -m "feat: filter transactions to show only unreconciled when filter=unmatched"
```

---

### Task 4: BankStatements — Visual highlighting on filtered rows

**Files:**
- Modify: `frontend/src/pages/BankStatements.tsx:443-446` (tr className)

**Interfaces:**
- Consumes: `activeFilter` state, transaction's `match_status`
- Produces: highlighted row styling

- [ ] **Step 1: Add amber left border to unreconciled rows when filter is active**

Change the `<tr>` className on line 443 from:

```tsx
<tr key={tx.id} className={`border-b border-muted/50 hover:bg-muted/20 ${dirty ? 'bg-blue-50 dark:bg-blue-950/20' : ''} ${
  tx.match_status === 'suggested' ? 'bg-yellow-50 dark:bg-yellow-950/20' :
  tx.match_status === 'confirmed' ? 'bg-green-50 dark:bg-green-950/20' : ''
}`}>
```

To:

```tsx
<tr key={tx.id} className={`border-b border-muted/50 hover:bg-muted/20 ${dirty ? 'bg-blue-50 dark:bg-blue-950/20' : ''} ${
  tx.match_status === 'suggested' ? 'bg-yellow-50 dark:bg-yellow-950/20' :
  tx.match_status === 'confirmed' ? 'bg-green-50 dark:bg-green-950/20' : ''
} ${
  activeFilter === 'unmatched' && !tx.invoice_id && !tx.card_statement_id &&
  tx.match_status !== 'confirmed' && tx.match_status !== 'skipped'
    ? 'border-l-4 border-l-amber-400' : ''
}`}>
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/pages/BankStatements.tsx
git commit -m "feat: add amber left border highlight to unreconciled rows when filter is active"
```

---

### Task 5: BankStatements — Filter banner with clear button

**Files:**
- Modify: `frontend/src/pages/BankStatements.tsx:234-238` (after the page header, before statements list)

**Interfaces:**
- Consumes: `activeFilter` state, `navigate`, `searchParams`
- Produces: banner UI with clear filter button

- [ ] **Step 1: Add filter banner after the page title section**

After line 238 (`<p className="text-muted-foreground mt-1">{t('bank.desc')}</p>`), before `<PendingReviewBanner />`, add:

```tsx
{activeFilter === 'unmatched' && (
  <div className="flex items-center justify-between bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-4 py-2.5">
    <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
      <AlertTriangle className="h-4 w-4" />
      <span>{tr('Showing only unreconciled transactions', '僅顯示未對賬交易', '仅显示未对账交易')}</span>
    </div>
    <button
      onClick={() => {
        const params = new URLSearchParams(searchParams);
        params.delete('filter');
        navigate(`/bank-statements${params.toString() ? '?' + params.toString() : ''}`, { replace: true });
      }}
      className="text-xs font-medium text-amber-700 dark:text-amber-300 hover:text-amber-900 dark:hover:text-amber-100 underline"
    >
      {tr('Clear filter', '清除篩選', '清除筛选')}
    </button>
  </div>
)}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/pages/BankStatements.tsx
git commit -m "feat: add filter banner with clear button when unreconciled filter is active"
```

---

### Task 6: BankStatements — Statement card badge showing unreconciled count

**Files:**
- Modify: `frontend/src/pages/BankStatements.tsx:281-288` (unlinked_count display area)

**Interfaces:**
- Consumes: `activeFilter` state, statement's `unlinked_count`
- Produces: badge on statement card

- [ ] **Step 1: Add unreconciled badge when filter is active**

After the existing unlinked_count display (line 285), when `activeFilter === 'unmatched'`, show a more prominent badge. Replace lines 281-288 with:

```tsx
{activeFilter === 'unmatched' && s.unlinked_count > 0 && (
  <span className="text-xs bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 font-medium px-2 py-0.5 rounded-full">
    {s.unlinked_count} {tr('unreconciled', '未對賬', '未对账')}
  </span>
)}
{activeFilter !== 'unmatched' && s.tx_count > 0 && s.unlinked_count > 0 && (
  <span className="text-xs text-amber-600 font-medium">
    ⚠ {s.unlinked_count}/{s.tx_count} unlinked ({Math.round(s.unlinked_count / s.tx_count * 100)}%)
  </span>
)}
{activeFilter !== 'unmatched' && s.tx_count > 0 && s.unlinked_count === 0 && (
  <span className="text-xs text-green-600 font-medium">✓ All linked</span>
)}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/pages/BankStatements.tsx
git commit -m "feat: show unreconciled count badge on statement cards when filter is active"
```

---

### Task 7: BankStatements — Empty state when no unreconciled transactions exist

**Files:**
- Modify: `frontend/src/pages/BankStatements.tsx:250-251` (empty state area)

**Interfaces:**
- Consumes: `activeFilter` state, `statements` array
- Produces: empty state UI

- [ ] **Step 1: Add empty state for unreconciled filter**

After line 251 (the existing `statements.length === 0` check), add a check for when filter is active but no statements have unreconciled transactions:

```tsx
{!isLoading && activeFilter === 'unmatched' && statements.length > 0 && statements.every((s: any) => s.unlinked_count === 0) && (
  <div className="text-center py-8">
    <CheckCircle2 className="h-8 w-8 text-green-500 mx-auto mb-2" />
    <p className="text-sm text-muted-foreground">
      {tr('No unreconciled transactions found', '沒有未對賬交易', '没有未对账交易')}
    </p>
    <button
      onClick={() => navigate('/dashboard')}
      className="text-xs text-primary hover:underline mt-2"
    >
      {tr('Back to dashboard', '返回主頁', '返回主页')}
    </button>
  </div>
)}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/pages/BankStatements.tsx
git commit -m "feat: add empty state when no unreconciled transactions exist"
```

---

### Task 8: Verification — End-to-end test

- [ ] **Step 1: Start dev server and test the full flow**

```
npm run dev
```

1. Go to Dashboard — verify "Unreconciled" card shows count
2. Click "Unreconciled" — verify URL is `/bank-statements?filter=unmatched`
3. Verify banner shows "Showing only unreconciled transactions" with "Clear filter" button
4. Verify statements with unreconciled transactions are auto-expanded
5. Verify only unreconciled transactions are shown in each expanded statement
6. Verify unreconciled rows have amber left border
7. Verify statement cards show "N unreconciled" badge
8. Click "Clear filter" — verify all transactions are shown again
9. Navigate to `/bank-statements?filter=unmatched` when all are matched — verify empty state shows

- [ ] **Step 2: Run lint/typecheck if available**

```bash
cd frontend && npm run lint && npm run typecheck
```

- [ ] **Step 3: Final commit if any fixes needed**

```bash
git add -A && git commit -m "fix: address lint/typecheck issues for unreconciled filter feature"
```
