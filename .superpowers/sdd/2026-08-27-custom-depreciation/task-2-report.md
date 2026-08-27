# Task 2: Custom Depreciation Schedule Helpers

**Status:** COMPLETE  
**Date:** 2026-08-27

## Summary

Added custom depreciation schedule types and validation/calculation helpers to `api/src/lib/depreciation.ts` with comprehensive tests.

## Files Modified

| File | Change |
|------|--------|
| `api/src/lib/depreciation.ts` | Added 3 interfaces (`CustomScheduleLine`, `CustomSchedule`, `ValidationResult`) and 2 functions (`validateCustomSchedule`, `calculateCustomPeriodDepreciation`) |
| `tests/depreciation-custom.test.ts` | NEW — 13 test cases covering validation and calculation |

## Test Results

**New tests:** 13 passed, 0 failed  
**Existing depreciation tests:** 41 passed, 0 failed (no regressions)

### Test Coverage

**validateCustomSchedule (7 tests):**
- Valid schedule with rate-based lines
- Valid schedule with amount-based lines
- Rate > 100% rejected
- Total exceeds depreciable amount rejected
- Both rate + amount set on same line rejected
- Neither rate nor amount set rejected
- Empty lines array rejected

**calculateCustomPeriodDepreciation (6 tests):**
- Year 1 rate-based: 40% of 10000 = 4000
- Year 2 rate-based: 30% of 10000 = 3000
- Year 3 amount-based: fixed 2500
- Period beyond schedule returns null
- Rate-based rounding to 2 decimal places
- Rate 0 is valid but yields 0 depreciation

## Implementation Notes

- Types and functions placed between `Asset` interface and `DepreciationLine` interface for logical grouping
- Validation uses 0.001 tolerance (`* 1.001`) to account for floating-point rounding in rate calculations
- `calculateCustomPeriodDepreciation` prioritizes `amount` over `rate` when both are set (defensive — validator prevents this)
- All functions are pure with no side effects

## TDD Protocol Followed

1. **RED:** Wrote 13 failing tests first — all failed with "is not a function" as expected
2. **GREEN:** Implemented minimal types and functions to pass all tests
3. **REFACTOR:** No refactoring needed — code is clean on first pass
