# Task 5 Report: Reverse stamps/guards + delete → tombstone

## What I Implemented

Modified two endpoints in `api/src/routes/bookkeeping.ts`:

1. **`DELETE /entries/:id`** — Changed from hard delete to tombstone:
   - Replaced `DELETE FROM journal_entries` with `UPDATE journal_entries SET deleted_at = datetime('now'), updated_at = datetime('now')`
   - Updated comment to reflect tombstone behavior
   - Preserved existing closed-period guard

2. **`POST /entries/:id/reverse`** — Added guards and stamps:
   - Added tombstone rejection: returns 409 if `deleted_at` is set
   - Added period guard: uses `checkPeriodOpen` on the reversal date, returns 400 if closed
   - Updated INSERT to include `entry_source='manual'` and `created_by` (JSON with user id, name, email)
   - Updated TypeScript type annotation to include `deleted_at` field

## What I Tested

- TypeScript compilation: 43 errors (all pre-existing, none in modified code)
- Wrangler dry-run deploy: success
- Manual booking test suite: 17/17 passing

## Files Changed

- `api/src/routes/bookkeeping.ts` (lines 388-456)

## Self-Review Findings

None. The implementation follows the plan exactly, maintains existing patterns, and doesn't introduce new type errors.

## Commits

- `f7f9c7b` — feat(api): JE delete tombstones; reversal stamps + guards
