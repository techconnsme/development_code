# Task 1: Backend — Add dry_run to /auto-generate-entries

## What I Implemented

Modified `api/src/routes/bookkeeping.ts` to add `dry_run=true` query parameter support to the `/auto-generate-entries` endpoint:

1. **Query parameter extraction** (line 1628): `const dryRun = c.req.query('dry_run') === 'true';`
2. **Suggestion collection array** (line 1649): `const suggestions: any[] = [];`
3. **Confidence/reason determination** (lines 1745-1753): Added logic to compute confidence (`confirmed` for exact matches, `needs_review` otherwise) and reason strings based on categorization source
4. **Dry-run branch** (lines 1755-1782): When `dryRun=true`, pushes suggestion objects instead of INSERTing to database
5. **Modified return** (lines 1785-1792): Returns `{ suggestions, total_unposted, skipped_noise }` when dry_run, otherwise returns original response

Each suggestion object includes: `transaction_id`, `description`, `amount`, `direction`, `transaction_date`, `bank_account_code`, `bank_account_name`, `contra_account_code`, `contra_account_name`, `confidence`, `reason`.

## What I Tested

- TypeScript typecheck: No new errors introduced. All 43+ pre-existing errors remain unchanged.
- The modification is minimal and follows the exact pattern specified in the task brief.

## Files Changed

- `api/src/routes/bookkeeping.ts`: +60 lines, -18 lines

## Self-Review Findings

- All requirements from the task brief are met
- No overbuilding — only the exact changes requested were made
- Existing patterns followed (function names, code style)
- Edge cases handled: empty lines still skip, existing non-dry-run path unchanged

## Commits

- `fc81f9d` feat(api): add dry_run mode to auto-generate-entries endpoint
