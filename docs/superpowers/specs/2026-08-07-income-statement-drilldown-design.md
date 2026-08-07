# Income Statement — Transaction-Level Drill-Down with Slide Panel

**Date:** 2026-08-07
**Status:** Design approved — awaiting implementation plan

## Overview

Currently, the Income Statement (P&L tab in Bookkeeping) drills down from Revenue/Expenses to COA account codes with aggregated amounts — and stops there. This enhancement adds a third level: clicking an account code opens a slide-out panel showing every transaction that contributes to that account's balance, with links to source documents and a path to post unjournalized bank transactions.

## Current State

```
Revenue ▾
  └── 40001  Sales Revenue    HKD 50,000   ← dead end
  └── 40002  Service Income   HKD 35,000
Expenses ▾
  └── 50001  Rent             HKD 10,000
```

- P&L data comes from `GET /bookkeeping/income-statement` (journal-based preferred, bank-transaction fallback)
- Account-level breakdown (`revenue_accounts`, `expense_accounts`) is already returned by the API
- No further drill-down exists

## Desired State

```
Revenue ▾
  └── 40001  Sales Revenue    HKD 50,000  ▶  ← click opens slide panel →

┌─────────────────── SLIDE PANEL (400px, from right) ───────────────────┐
│ 40001 — Sales Revenue                          HKD 50,000             │
│ ───────────────────────────────────────────────────────────────────── │
│ ● JOURNAL ENTRIES (12)                                               │
│ ┌ GJE-0067  2026-08-01  Consulting — DEF     15,300  📎INV 📄BS     │
│ ┌ GJE-0058  2026-07-22  Service fees — XYZ     8,200  📎INV         │
│ ┌ GJE-0042  2026-07-15  Client payment — ABC  12,500  📎INV 📄BS     │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│ ⚠ UNPOSTED BANK TRANSACTIONS (3)                                     │
│ ┌ 2026-08-03  TT from client   22,000  📄BS  [🩷 Post →]            │
│ ┌ 2026-07-28  FPS deposit      14,500  📄BS  [🩷 Post →]            │
│ ┌ 2026-07-14  unmatched dep.    3,500  📄BS  [🩷 Post →]            │
└───────────────────────────────────────────────────────────────────────┘
```

## Design Decisions

### 1. Mixed-Source Approach (Option C)

Journal entries are the source of truth. Bank transactions appear **only** when they haven't been journalized (no matching `journal_entries` row with `reference_type = 'bank_transaction'`). This prevents double-counting.

### 2. Sorting

1. Journal entries: newest → oldest
2. Dashed divider with `⚠ UNPOSTED BANK TRANSACTIONS (N)` label
3. Unposted bank transactions: newest → oldest

### 3. Slide Panel (not popup/modal)

- Slides in from the right edge using CSS `transform: translateX` with `transition: 0.3s ease`
- Width: 400px
- P&L compresses to accommodate; panel sits beside it
- Close via: X button, Escape key, or clicking backdrop overlay
- Panel is scrollable independently if content overflows

### 4. Pink "Post →" Button (not embedded journal entry creation)

- Unposted bank transactions get a pink (`#ec4899`) `Post →` button
- Clicking it does NOT open a journal entry form in the panel
- Instead it navigates to: `/bank-statements?statement=<BS-ID>&highlight=<TX-ID>`
- On that page:
  - The target bank statement auto-expands
  - The specific transaction is scrolled into view
  - A yellow pulse CSS animation highlights the transaction for 5 seconds

### 5. Document Links

- 📎 = link to invoice (`/invoices?highlight=<INV-ID>`) — opens invoice detail or preview
- 📄 = link to bank statement (`/bank-statements?statement=<BS-ID>`) — navigates to that statement
- Links navigate the user to the relevant page with appropriate highlight parameters

## API Changes

### New Endpoint: `GET /bookkeeping/income-statement/:account_code/transactions`

Returns all transactions contributing to a specific account code within the P&L period.

**Query params:** `start_date`, `end_date` (same as income-statement)

**Response:**
```json
{
  "account_code": "40001",
  "account_name": "Sales Revenue",
  "total": 50000,
  "journal_entries": [
    {
      "type": "journal",
      "entry_id": "je-xxx",
      "entry_number": "GJE-0067",
      "entry_date": "2026-08-01",
      "description": "Consulting — DEF International Ltd",
      "amount": 15300,
      "direction": "credit",
      "reference_type": "invoice",
      "reference_id": "inv-0115",
      "invoice_number": "INV-0115",
      "invoice_total": 15300,
      "bank_statement_id": "BS-0712",
      "bank_statement_period": "2026-07",
      "linked_documents": [
        {"type": "invoice", "id": "inv-0115", "number": "INV-0115"},
        {"type": "bank_statement", "id": "BS-0712", "label": "BS-0712 · Jul 2026 · HSBC"}
      ]
    }
  ],
  "unposted_bank_transactions": [
    {
      "type": "bank",
      "transaction_id": "bt-xxx",
      "transaction_date": "2026-08-03",
      "description": "Bank deposit — TT from client",
      "amount": 22000,
      "bank_statement_id": "BS-0712",
      "bank_statement_period": "2026-07",
      "account_code": "40001",
      "has_voucher": false,
      "linked_documents": [
        {"type": "bank_statement", "id": "BS-0712", "label": "BS-0712 · Jul 2026 · HSBC"}
      ]
    }
  ],
  "period": {"start": "2026-01-01", "end": "2026-12-31"}
}
```

**Query logic:**
1. Fetch journal lines for this account_code within the period (via `journal_lines` JOIN `journal_entries` WHERE `status != 'stale'`)
2. For each journal line, look up linked documents:
   - `journal_entries.reference_id` → invoice or bank_transaction
3. Fetch bank transactions with this account_code that are **not journalized** (LEFT JOIN `journal_entries` WHERE `je.reference_id IS NULL`)
4. Sort: journal entries first (newest), then unposted bank tx (newest)

### No Changes to Existing Endpoints

`GET /bookkeeping/income-statement` remains unchanged — the new endpoint is additive.

## Frontend Changes

### New Component: `SlidePanel`

Reusable slide-from-right panel component in `frontend/src/components/SlidePanel.tsx`.

```tsx
interface SlidePanelProps {
  open: boolean;
  onClose: () => void;
  title: string;
  width?: number; // default 400
  children: React.ReactNode;
}
```

- Renders with CSS `transform: translateX(open ? '0' : '100%')`
- `transition: transform 0.3s ease`
- Backdrop overlay when open (click to close)
- Escape key listener

### New Component: `AccountTransactionPanel`

Specific panel content for the income statement drill-down in `frontend/src/components/AccountTransactionPanel.tsx`.

- Fetches from `GET /bookkeeping/income-statement/:account_code/transactions`
- Renders two sections: Journal Entries + Unposted Bank Transactions
- Each row: date, reference number, description, amount, doc links, Post button (if applicable)
- Handles loading, empty, and error states

### Modified: `Bookkeeping.tsx` (P&L tab)

- **Line ~617-624:** Each account row in revenue_accounts/expense_accounts becomes clickable
- **New state:** `selectedAccountCode`, `panelOpen`
- **On click:** Set `selectedAccountCode` and open panel
- **Layout shift:** When panel is open, P&L table gets `max-w-xl` (or similar) to make room

### Modified: `BankStatements.tsx`

- **New query params:** Read `statement` and `highlight` from URL search params via `useSearchParams`
- **On mount:** If `statement` param present, auto-expand that statement and scroll to the highlighted transaction
- **Highlight:** Apply CSS class `highlight-pulse` to target transaction row
- Use `scrollIntoView({ behavior: 'smooth', block: 'center' })`

### New CSS: `frontend/src/index.css` additions

```css
@keyframes pulseHighlight {
  0%   { background-color: #fef3c7; }
  50%  { background-color: #fde68a; }
  100% { background-color: #fef3c7; }
}

.highlight-pulse {
  animation: pulseHighlight 1s ease-in-out 3;
  border: 2px solid #fbbf24;
  border-radius: 4px;
}
```

## Routing / URL Parameters

The Bank Statements subpage gains support for two query parameters:

| Param | Value | Effect |
|-------|-------|--------|
| `statement` | Bank statement ID (e.g. `BS-0712`) | Auto-expands that statement in the list |
| `highlight` | Transaction ID (e.g. `bt-xxx`) | Scrolls to and highlights the transaction |

The P&L panel constructs URLs like:
`/bank-statements?statement=BS-0712&highlight=bt-a8f3c2b1`

## Data Flow

```
User clicks account code in P&L
  → setSelectedAccountCode("40001")
  → setPanelOpen(true)
  → SlidePanel slides in from right
  → AccountTransactionPanel mounts
  → GET /bookkeeping/income-statement/40001/transactions?start_date=...&end_date=...
  → Renders journal entries section + unposted bank tx section
  → User clicks pink "Post →" on an unposted bank tx
    → navigate('/bank-statements?statement=BS-0712&highlight=bt-xxx')
    → BankStatements mounts, reads query params
    → Auto-expands BS-0712, scrolls to bt-xxx, applies highlight-pulse
```

## Edge Cases & Error Handling

| Scenario | Handling |
|----------|----------|
| Account has zero transactions | Panel shows "No transactions found for this account in the selected period" |
| Account has only journal entries | Show only the journal entries section (no unposted divider) |
| Account has only unposted bank tx | Show only the unposted section |
| API request fails | Toast error, panel stays closed |
| User navigates away while panel is open | Panel closes (unmounted) |
| Bank statement referenced by Post button is deleted | Show toast: "Statement no longer exists" |
| User resizes window < 768px | Panel goes full-width (responsive breakpoint) |

## Testing

### API Tests
- `GET /bookkeeping/income-statement/:code/transactions` returns correct journal entries sorted newest-first
- Unposted bank tx correctly excluded when journalized
- Empty results for account with no activity
- Period filtering works correctly

### E2E Tests
- Click account code → panel slides in
- Panel shows journal entries sorted correctly
- Unposted bank tx appear below divider with pink Post button
- Click Post → navigates to bank statements with correct params
- Bank statement auto-expands and transaction highlights
- Close panel via X, Escape, and backdrop click
- Responsive: panel goes full-width on mobile

## Files Affected

| File | Change |
|------|--------|
| `api/src/routes/bookkeeping.ts` | New endpoint: `GET /income-statement/:code/transactions` |
| `frontend/src/components/SlidePanel.tsx` | **New** — reusable slide panel |
| `frontend/src/components/AccountTransactionPanel.tsx` | **New** — P&L drill-down panel content |
| `frontend/src/pages/Bookkeeping.tsx` | Make account rows clickable, integrate panel |
| `frontend/src/pages/BankStatements.tsx` | Read `statement` + `highlight` params, auto-expand + highlight |
| `frontend/src/index.css` | Add `pulseHighlight` keyframes and `.highlight-pulse` class |
