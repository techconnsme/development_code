# Unreconciled Transaction Filter from Dashboard

## Goal

When a user clicks the "Unreconciled" card on the Dashboard, navigate to the Bank Statements page with a filter that shows only unreconciled transactions, grouped by bank statement, with clear visual highlighting.

## Current Behavior

- Dashboard "Unreconciled" card navigates to `/bank-statements` with no filter
- Bank statement page shows all transactions with color coding: yellow (suggested), green (confirmed)
- Amber warning triangle shown on unlinked transactions
- `match_status` field: `unmatched` / `suggested` / `confirmed` / `skipped`

## Design

### 1. Dashboard Navigation Change

**File:** `frontend/src/pages/Dashboard.tsx` (line 152)

Change `navigate('/bank-statements')` to `navigate('/bank-statements?filter=unmatched')`.

### 2. BankStatements Component — Filter Reading

**File:** `frontend/src/pages/BankStatements.tsx`

- Read `filter` from URL search params: `searchParams.get('filter')`
- Store as local state `activeFilter`

### 3. Auto-Expand Statements with Unreconciled Transactions

When `filter=unmatched` is active:

- Auto-expand every statement card where `unlinked_count > 0`
- Scroll to the first expanded statement
- Reuse existing `expandedStatements` state, just pre-populate it

### 4. Transaction Filtering Logic

When filter is active, show a transaction if:

- `match_status` is `unmatched` OR `match_status` is null/undefined
- OR the transaction is unlinked, not skipped, and not suggested (existing amber warning condition)

Hide a transaction if:

- `match_status` is `confirmed` or `skipped`

### 5. Visual Highlighting

When filter is active, add to each visible unreconciled transaction row:

- Left border accent: `border-l-4 border-amber-400`
- Existing amber warning triangle icon (already shown on unlinked transactions)
- Existing yellow/green row backgrounds still apply within filtered view

### 6. Filter Banner

When `filter=unmatched` is active, show a banner at the top of the page:

- Text: "Showing only unreconciled transactions"
- Button: "Clear filter" — removes `?filter` from URL, shows all transactions

### 7. Statement Card Badge

When filter is active, each statement card shows a badge with the count of unreconciled transactions it contains (e.g., "3 unreconciled").

### 8. Edge Cases

1. **No unreconciled transactions:** Show empty state "No unreconciled transactions found" with link back to dashboard
2. **Multiple statements with unreconciled:** Auto-expand all, scroll to first
3. **Filter persistence:** URL-only, no sticky state. Navigating to `/bank-statements` without `?filter` shows all
4. **Coexistence with `?highlight`:** Both params work independently

## Files to Modify

1. `frontend/src/pages/Dashboard.tsx` — Change navigate call (1 line)
2. `frontend/src/pages/BankStatements.tsx` — Add filter reading, auto-expand, transaction filtering, banner, badge, empty state

## No Backend Changes Required

All filtering is client-side. The existing API returns all transactions; the component filters after fetch.
