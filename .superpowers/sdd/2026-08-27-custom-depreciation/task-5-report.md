# Task 5: Custom Depreciation Scheduling - Integration Tests

**Date:** 2026-08-27
**Status:** COMPLETE
**File:** `tests/depreciation-custom-integration.test.ts`

## Test Results

All **14 tests passed**, 0 failed.

| Scenario | Test | Result |
|----------|------|--------|
| 3-year custom schedule | 3-year schedule valid | PASS |
| | Year 1: 40% of 100k = 40k | PASS |
| | Year 2: 30% of 100k = 30k | PASS |
| | Year 3: 30% of 100k = 30k | PASS |
| | Year 4: beyond schedule returns null | PASS |
| Monthly custom schedule | monthly schedule valid | PASS |
| | Month 1: 5% of 50k = 2.5k | PASS |
| | Month 2: 4% of 50k = 2k | PASS |
| Mixed rate and amount | mixed schedule valid | PASS |
| | Year 1: 25% of 60k = 15k | PASS |
| | Year 2: fixed 15k | PASS |
| | Year 3: fixed 10k | PASS |
| Validation errors | over-depreciation detected | PASS |
| | empty schedule invalid | PASS |

## Implementation Notes

- Created `tests/depreciation-custom-integration.test.ts` following the exact spec from the task.
- The test uses the lightweight `ok(cond, label)` assertion pattern (matching existing `depreciation.test.ts` convention), not a test framework.
- The test imports from `../api/src/lib/depreciation` which already exports `validateCustomSchedule`, `calculateCustomPeriodDepreciation`, and `calculateMonthlyDepreciation`.
- A pre-existing unit test file `tests/depreciation-custom.test.ts` covers more granular edge cases (rate > 100, both set, neither set, rounding). This integration test covers the end-to-end scenarios specified in the task.

## Concerns

None. All functions in `api/src/lib/depreciation.ts:34-82` implement the expected behavior. The `calculateMonthlyDepreciation` import is included per spec but not used in any test assertion (it was referenced in the spec's import block).
