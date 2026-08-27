# Design: Suggestion-Based Auto-Generate Journal Entries

**Date:** 2026-08-27
**Status:** Approved
**Approach:** Modify existing endpoint with dry_run flag + new confirm endpoint

## Problem

The current "Auto-Generate Journal Entries" button immediately creates all journal entries with no review. This is dangerous — users cannot verify the system's inferences before they become permanent records.

## Goal

Change auto-generate JDE to a suggestion-based flow (like auto-link invoice):
1. User clicks "Auto-Generate" → sees proposed entries
2. User reviews, edits contra accounts if needed, confirms/rejects each
3. Only confirmed entries are written to the database

## Design

### Backend: Suggest Mode

**Modify:** `POST /bookkeeping/auto-generate-entries`

Add `?dry_run=true` query parameter.

When `dry_run=true`:
- Same logic as today (fetch unposted transactions, categorize, build Dr/Cr lines)
- But instead of INSERTing, returns an array of suggestions
- No database writes

**Response:**
```json
{
  "suggestions": [
    {
      "transaction_id": "abc123",
      "description": "HSBC PAYMENT TO SUPPLIER",
      "amount": -5000,
      "direction": "debit",
      "transaction_date": "2026-08-25",
      "bank_account_code": "11102",
      "bank_account_name": "HSBC",
      "contra_account_code": "51101",
      "contra_account_name": "General Expenses",
      "confidence": "confirmed",
      "reason": "Bank charge pattern matched"
    }
  ],
  "total_unposted": 42,
  "skipped_noise": 5
}
```

**Confidence levels:**
- `confirmed` — regex matched with high certainty (exact pattern, known supplier, etc.)
- `needs_review` — fuzzy/fallback match, lower certainty

When `dry_run=false` (or omitted): existing behavior — creates entries immediately.

### Backend: Confirm Endpoint

**New:** `POST /bookkeeping/confirm-suggestion`

**Request:**
```json
{
  "transaction_id": "abc123",
  "contra_account_code": "51101",
  "voucher_number": "B-HSBC-202608-001"
}
```

- `transaction_id` (required): the bank transaction to create a JE for
- `contra_account_code` (optional): user override of proposed contra account
- `voucher_number` (optional): user override of auto-generated voucher number

**Response:**
```json
{
  "entry_id": "xyz789",
  "voucher_number": "B-HSBC-202608-001"
}
```

**Logic:**
1. Re-fetch the transaction (verify it exists, is unposted, not deleted)
2. Re-categorize using existing `categorizeTransaction()` logic
3. Resolve bank account code
4. Build journal lines (use user's `contra_account_code` if provided, else re-categorized code)
5. Generate or validate voucher number
6. Insert `journal_entries` + `journal_lines`
7. Return created entry ID + voucher number

**Re-run on confirm:** The backend re-runs categorization logic on confirm (not cached). This ensures:
- Transaction hasn't been posted by someone else
- Account codes haven't changed
- Same safety pattern as auto-link invoice

### Frontend: Suggestion Panel

When user clicks "+ Auto-Generate Journal Entries":

1. Call `POST /bookkeeping/auto-generate-entries?dry_run=true`
2. Show suggestion panel:
   - Each suggestion row shows:
     - Transaction description + date + amount
     - Proposed Dr/Cr lines (bank account → contra account)
     - Confidence badge: `CONFIRMED` (green) or `NEEDS REVIEW` (yellow)
     - Reason text
     - Editable contra account dropdown
     - ✓ Confirm / ✗ Reject buttons
   - "Confirm All" button at top (confirms all `confirmed` confidence items)
   - "Reject All" button
3. On confirm: call `POST /bookkeeping/confirm-suggestion` per item
4. Rejected items stay visible but dimmed until panel is closed
5. Panel closes when all items are confirmed or rejected

### Batch Upload Auto-Trigger

After batch bank-statement upload:
- Instead of calling the endpoint directly and creating entries
- Show the same suggestion panel (call with `dry_run=true`)
- User reviews before any entries are created

### Rejection Handling

- Rejected suggestions are skipped for this session only
- They can appear again next time user clicks Auto-Generate
- No database state for rejections

## Files to Modify

| File | Change |
|------|--------|
| `api/src/routes/bookkeeping.ts` | Add `dry_run` param to `/auto-generate-entries`, add `/confirm-suggestion` endpoint |
| `frontend/src/pages/Bookkeeping.tsx` | Replace direct mutation with suggestion panel UI |
| `frontend/src/pages/FileUpload.tsx` | Change auto-trigger to show suggestion panel |

## Testing

- Backend unit test: `dry_run=true` returns suggestions without writing to DB
- Backend unit test: `confirm-suggestion` creates entry correctly
- Playwright spec: suggestion panel renders after clicking Auto-Generate
- Live round-trip: suggest → confirm → verify entry exists
