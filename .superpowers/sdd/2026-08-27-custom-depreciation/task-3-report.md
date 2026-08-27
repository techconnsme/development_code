# Task 3 Report: Extend fixed-assets API for Custom Depreciation Schedules

**Status:** Complete  
**Date:** 2026-08-27  
**Files Modified:** `api/src/routes/fixed-assets.ts`

## Changes Made

### 1. Import (line 5)
Added import for `validateCustomSchedule`, `calculateCustomPeriodDepreciation`, and `CustomSchedule` from `../lib/depreciation`.

### 2. POST / (create asset) — lines 37-72
- Added `depreciation_method` and `custom_schedule` to destructured body
- When `depreciation_method === 'custom'`: validates `custom_schedule` presence and structure via `validateCustomSchedule`, returns 400 on failure, serializes schedule to JSON string
- INSERT statement now includes `depreciation_method` and `custom_schedule` columns (18 bind params, up from 17)

### 3. PATCH /:id (update asset) — lines 89-116
- Added `depreciation_method` to the allowed fields array
- Added `custom_schedule` handling: if present, validates against existing asset's cost/salvage when method is custom, serializes to JSON, or sets null if empty
- Validation only fires when `depreciation_method` is `'custom'`

### 4. POST /run-depreciation (depreciation loop) — lines 164-202
- Replaced the single-line straight-line calculation with a branching block:
  - **Custom path:** Parses the stored `custom_schedule` JSON, calculates `periodsElapsed` from purchase date to `period_end_date`, calls `calculateCustomPeriodDepreciation` for the current period. Falls back to straight-line auto-fill for periods beyond the schedule.
  - **Standard path:** Unchanged existing straight-line logic
- Both paths round to 2 decimal places and skip if `<= 0`

### 5. TypeScript Check
`npx tsc --noEmit` — no new errors introduced. All pre-existing errors are in other files (bank-journal, admin, auth, etc.), not in `fixed-assets.ts`.

## Concerns / Notes

- **DB schema:** The `custom_schedule` column must exist in the `fixed_assets` table. If Task 1 (migration) hasn't been applied yet, the INSERT/UPDATE will fail at runtime. The code assumes the column is already present.
- **Period counting edge case:** The period calculation uses calendar month subtraction, which can produce negative values if `period_end_date` is before `purchase_date`. The `Math.max(..., 1)` guard and `actualDepn <= 0` skip handle this gracefully.
- **Auto-fill fallback:** When a custom schedule's lines are exhausted, the code distributes remaining depreciable amount equally across remaining periods. This is a reasonable default but may not match user expectations for all schedules.
