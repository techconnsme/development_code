# Task 4: GET /entries/manual + GET /entries/next-number

## Status: DONE

## What was implemented

Two new endpoints added to `api/src/routes/bookkeeping.ts`:

1. **`GET /bookkeeping/entries/manual`** - Lists manual journal entries (entry_source='manual' AND reference_type IS NULL)
   - Supports optional `start_date` and `end_date` query parameters
   - Returns entries with parsed `created_by` JSON, attached files, and reversal status
   - Limited to 500 entries per request
   - Route placed after `GET /entries` and before `GET /entries/:id`

2. **`GET /bookkeeping/entries/next-number`** - Returns the next voucher number
   - Takes optional `date` query parameter (defaults to today)
   - Returns `{ entry_number: 'MJ-YYYYMM-NNN' }` format
   - Uses existing `nextManualVoucherNumber` helper from `lib/manual-booking.ts`

## Test results

- TypeScript: 43 pre-existing errors (none in new code)
- Wrangler dry-run deploy: Success

## Files changed

- `api/src/routes/bookkeeping.ts` (lines 196-247 added in commit e812541)

## Self-review findings

No issues found. Implementation follows existing patterns and matches the plan specification exactly.
