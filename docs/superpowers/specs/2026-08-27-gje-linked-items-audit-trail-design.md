# GJE Linked Items & Audit Trail Design

**Date:** 2026-08-27
**Status:** Approved
**Scope:** Bookkeeping → GJE expanded row with linked items navigation and field-level audit trail

## Summary

When a user clicks a journal entry in the GJE table, the row expands to show:
1. Journal lines (existing)
2. Linked bank statements / invoices (new) — clickable, navigating to target pages
3. Field-level audit trail (new) — showing who changed what and when

## Data Model

### Existing linkage (already in `journal_entries`)

| `reference_type` | `reference_id` points to | Created by |
|---|---|---|
| `bank_transaction` | `bank_transactions.id` | Auto-generated from bank statement |
| `card_transaction` | `card_transactions.id` | Auto-generated from card statement |
| `invoice` | `invoices.id` | Invoice GL posting |
| `payment` | `bank_transactions.id` | Payment GL posting |
| `journal` | `journal_entries.id` | Reversal entries |
| `NULL` | — | Manual GJE entries |

### New table: `journal_entry_snapshots`

```sql
CREATE TABLE IF NOT EXISTS journal_entry_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  snapshot TEXT NOT NULL,           -- JSON: full entry + lines state
  action TEXT NOT NULL,             -- 'create', 'update', 'delete', 'status_change'
  changed_fields TEXT,              -- JSON array of field paths that changed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_je_snapshots_entry ON journal_entry_snapshots(entry_id, created_at);
```

**Snapshot JSON structure:**
```json
{
  "entry_number": "GJ00001",
  "entry_date": "2026-08-25",
  "description": "Payment to Supplier XYZ",
  "status": "posted",
  "reference_type": "bank_transaction",
  "reference_id": "bt-abc123",
  "lines": [
    { "account_code": "21101", "account_name": "Trade Creditors", "debit": 5000, "credit": 0 },
    { "account_code": "11101", "account_name": "Bank Account", "debit": 0, "credit": 5000 }
  ]
}
```

**Snapshot creation triggers (application-level):**
- On JE create: initial snapshot with `action='create'`
- On JE update (description, date, lines): new snapshot with `action='update'`, compute `changed_fields` diff
- On status change: snapshot with `action='status_change'`
- On JE delete: final snapshot with `action='delete'`

## API Changes

### Modified: `GET /api/bookkeeping/entries`

Add `resolved_links` field to each entry response:

```typescript
{
  // ... existing fields ...
  resolved_links: {
    bank_statement?: { id: string; statement_number: string; file_name: string };
    bank_transaction?: { id: string; description: string; amount: number; match_status: string; statement_id: string };
    invoice?: { id: string; invoice_number: string; direction: 'incoming' | 'outgoing'; total: number; vendor_or_customer: string };
    reversal?: { id: string; entry_number: string; entry_date: string };
    linked_invoices?: Array<{ id: string; invoice_number: string; allocated_amount: number }>; // group payments
  } | null;
  lines: Array<{ account_code; account_name; debit; credit; description; project }>;
}
```

**SQL join logic** uses `CASE je.reference_type` to resolve the referenced entity. For `bank_transaction` type, joins `bank_transactions` → `bank_statements` to include statement info. For `payment` type, also queries `bank_transaction_invoice_links` for group payment details.

### New: `GET /api/bookkeeping/entries/:id/audit-trail`

Returns snapshots with computed diffs:

```typescript
Array<{
  id: string;
  action: string;
  user_email: string;
  created_at: string;
  snapshot: object;
  changes: Array<{ field: string; old: any; new: any }>;
}>
```

Computes diffs by comparing consecutive snapshots for the same entry.

## Frontend Changes

### Expandable Row (Bookkeeping.tsx entries tab)

- State: `expandedEntryId: string | null` toggles row expansion
- Expanded row shows three sections:
  1. **Journal Lines** — existing table of DR/CR lines
  2. **Linked Items** — clickable chips for bank statements, invoices, reversals
  3. **Audit Trail** — chronological list of changes with field-level diffs

### Linked Items Display

- **Linear breadcrumb** at top: `Bank Statement → Transaction → Invoice`
- **Nested tree** below if branches exist (group payments, multiple invoices)
- Each item is a clickable chip/badge
- `reference_type=NULL` (manual entry): linked items section hidden
- `reference_type='journal'` (reversal): shows "Reversed by: JE-xxx" with link
- Missing references (deleted records): show "Linked [type] (deleted)" as disabled chip

### Navigation

| Linked item | Navigation target | State passed |
|---|---|---|
| Bank statement | `/bank-statements` | `{ highlight: statementId }` |
| Bank transaction | `/bank-statements/review/:statementId` | `{ highlight: txId }` |
| Invoice (incoming) | `/ap` | `{ highlight: invoiceId }` |
| Invoice (outgoing) | `/ar` | `{ highlight: invoiceId }` |
| Reversal JE | `/GJE` | `{ highlight: reversalId }` |

### Highlight Support (Target Pages)

New shared hook `useHighlightTarget.ts`:
```typescript
function useHighlightTarget() {
  const location = useLocation();
  const [highlightId, setHighlightId] = useState<string | null>(null);
  
  useEffect(() => {
    if (location.state?.highlight) {
      setHighlightId(location.state.highlight);
      const timer = setTimeout(() => setHighlightId(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [location.state]);
  
  return highlightId;
}
```

Target pages (`BankStatements.tsx`, `AP.tsx`, `AR.tsx`) use this hook to:
1. Find the row with matching ID
2. Expand it
3. Scroll into view
4. Apply temporary highlight visual (e.g., yellow background fade)

### Audit Trail Display

- Chronological list (newest first)
- Each entry: timestamp, user email, change description
- Field diffs: `field: old → new`
- Created/Deleted events: full entry display
- Large diffs (>20 lines): summary with "Show details" expand

## Error Handling & Edge Cases

- **Missing references**: Disabled chip, no navigation
- **Circular references**: Limit reversal chain display to 2 levels
- **Large diffs**: Summary mode for >20 changed lines
- **Snapshot retention**: Optional purge of snapshots older than 1 year
- **Performance**: Indexed SQL joins, lazy-loaded audit trail on expand

## Testing

- **API tests**: Verify `resolved_links` for each `reference_type`. Verify snapshot creation on all mutation operations. Verify diff computation.
- **E2E tests (Playwright)**: Expand GJE row → verify linked items → click chip → verify navigation + highlight. Verify audit trail field-level diffs.
- **Edge cases**: Manual entries, deleted references, reversal chains, group payments.
