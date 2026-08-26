# Review vs Ledger (reconciliation review with suggestions) — Design

- **Date:** 2026-08-26
- **Status:** Approved design, pending implementation plan
- **Scope:** Bank Statements feature area (`api/src/routes/bank-statements.ts`, `frontend/src/pages/BankStatements.tsx`)

## Problem

The 🔍 Reconcile button currently runs a bare preview: statement closing balance vs GL
balance, with a difference figure and a raw list of outstanding transactions. It does not
help the user *explain* the difference or *fix* it. The word "Reconcile" also collides with
two other concepts in the product (invoice matching, COA posting), confusing users
(e.g. Joseph Lin, 2026-08-26 session).

## Goals

1. Rename concept #3 (statement-vs-ledger proof) to **"Review vs Ledger" / 對帳審查 / 对账审查** in the UI.
2. Turn the button into a one-click month-end review that decomposes the gap into
   explained items and proposes fixes as suggestions.
3. Strictly advisory + pre-fill: nothing is written until the user saves through existing flows.

## Non-goals

- No sign-off/save to `bank_reconciliations`, no reopen flow (future phase; payload below is designed to be reusable for it).
- No API route renames: `/reconcile`, `/auto-match` etc. keep their URLs.
- No change to `journal_entries.status` vocabulary or invoice-matching vocabulary.

## Architecture

### Backend: `POST /bank-statements/:id/review`

Read-only endpoint, same auth/tenant pattern as sibling statement endpoints
(`tenantId = c.get('client_user_id') || user.id`). Pipeline:

1. **Compare** — reuse existing preview math from `POST /:id/reconcile`
   (`bank-statements.ts:1617`): `statement_balance = bank_statements.closing_balance`;
   `gl_balance = Σ(journal_lines.debit − credit)` for the GL bank account
   (`stmt.account_code || '11101'`) over posted, non-deleted entries up to `period_end`.
   `difference = statement_balance − gl_balance`.
2. **Rules pass** — run `categorizeTransaction()` (`api/src/lib/transaction-categorizer.ts`)
   over transactions that are unposted or not invoice-confirmed, and map `RuleTag`s to
   suggestion templates:
   - `interest_income` → Dr 11101 / Cr 42101 Interest income
   - `bank_charge` → Dr expense account returned by the categorizer rule / Cr 11101
   - `director` → Dr 11101 / Cr director's loan account
   - `internal_transfer` → withdrawal leg suggests Dr contra bank account / Cr 11101;
     deposit leg suggests Dr 11101 / Cr contra bank account
   - `null` categorization → no rule item (candidate for AI pass)
3. **Invoice-match pass** — suggest-only reuse of `findBestInvoiceMatch` /
   `findInvoiceGroupMatch` (`api/src/lib/bank-matcher.ts`) on rows with
   `match_status IS NULL OR 'unmatched'`, mirroring `POST /auto-match` behaviour.
   Emits `kind: 'invoice_match'` items; writes nothing.
4. **Decompose** — `explained_gap = Σ |suggested amounts hitting the GL bank account|`
   (cent-tolerant); `residual = |difference| − explained_gap`.
5. **AI pass (conditional)** — only if `residual ≥ 0.01`: exactly one server-side call to
   the LLM gateway (same integration `/chat` uses; NOT a chat-session write) with compact
   context: statement metadata, residual amount, descriptions/dates/amounts of candidate
   rows, tenant's chart of accounts (code+name only). Response constrained to strict JSON;
   items forced to `confidence: 'low'`, `source: 'ai'`.

### Response contract

```jsonc
{
  "statement_id": "bs-…",
  "is_locked": false,                    // bank_reconciliations row exists
  "balance_summary": {
    "statement_balance": 100712.30,
    "gl_balance": 98700.00,
    "difference": 2012.30
  },
  "projected_difference": 0.00,          // gap if all suggestions accepted
  "items": [{
    "id": "s1",
    "kind": "adjusting_je",              // adjusting_je | invoice_match | coa_posting | info
    "source": "rule",                    // rule | ai
    "transaction_id": "bt-…",
    "explanation": "Credit interest paid by bank, not yet booked",
    "confidence": "high",                // high | medium | low (ai always low)
    "prefill": {                         // shape varies by kind
      "lines": [
        {"account_code": "11101", "account_name": "HSBC Bank", "debit": 12.30, "credit": 0},
        {"account_code": "42101", "account_name": "Interest income", "debit": 0, "credit": 12.30}
      ],
      "description": "28 Jan credit interest"
    }
  }]
}
```

### Frontend: `BankStatements.tsx`

- Button label: `🔍 Review vs Ledger / 對帳審查 / 对账审查` via existing `tr()`.
- The `reconData` panel renders `items` grouped by kind, each row with explanation,
  confidence badge, and a **Pre-fill** button:
  - `adjusting_je` / `coa_posting` → opens the transaction's existing posting editor
    pre-filled; save path remains the existing `PUT /transactions/:id/posting`.
  - `invoice_match` → opens the existing match-confirm flow
    (`PATCH /transactions/:id/match`).
  - `info` → text only.
- Header shows statement/GL/projected figures; projected difference turns green at
  `|x| < 0.01`.
- If `is_locked`: banner "Statement is reconciled", panel read-only, no Pre-fill buttons.

## Error handling

- LLM timeout (>8 s) or malformed JSON → drop AI items, return remaining results plus one
  `info` item stating the unexplained residual. Never fail the whole request because of AI.
- Missing statement → 404 (consistent with siblings).
- All money comparisons cent-tolerant (`< 0.01`).
- Audit log entry per review run: `auditLog(db, user.id, 'review_statement', 'bank_statement', id, {difference})`.

## Testing

- Unit tests: gap decomposition math and RuleTag→template mapping (synthetic January-style
  fixture: deposits 100,000, fee −1,300, interest +12.30, transfers ±100, owner-in +2,000).
- Route integration test: mocked D1 + stubbed LLM gateway; assert response contract and
  assert zero writes (no INSERT/UPDATE calls).
- Playwright smoke: open statement detail → click Review vs Ledger → panel renders items →
  Pre-fill opens posting editor.

## Out of scope / future

Sign-off writing `bank_reconciliations` + reopen mechanism (Approach C), review history
view, renaming API endpoints.
