# Custom Depreciation Schedule — Design Spec

**Date:** 2026-08-27
**Status:** Approved

## Overview

Add custom depreciation scheduling to Fixed Assets, allowing users to define per-period depreciation rates or amounts instead of relying solely on straight-line calculation.

## Background

Currently, the system only supports straight-line depreciation:
- User enters useful life (years) + salvage value
- System calculates: `(cost - salvage) / (useful_life * 12)` = monthly depreciation
- All periods use the same amount

Hong Kong accounting practice (SSAP 17 / IAS 16) allows any systematic method. Custom schedules are common for:
- Assets with higher wear in early years (vehicles, computers)
- Tax planning with IRD prescribed rates
- Matching depreciation to expected revenue patterns

## Design

### UI: Tabbed Depreciation Details

The "Depreciation Details" section in the Add/Edit Asset form becomes two tabs:

```
┌──────────────────────────────────────────────────────────┐
│ Depreciation Details                                      │
├────────────────────┬─────────────────────────────────────┤
│ Constant (平率折舊)  │ Custom (自訂折舊)                    │
├────────────────────┴─────────────────────────────────────┤
│                                                          │
│  [Tab content based on selection]                        │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

**Constant tab** (current behavior, default):
- Useful Life (years) input
- Salvage Value input
- Formula explanation text
- `depreciation_method = 'straight_line'`

**Custom tab**:
- Period type selector: Monthly (月) / Yearly (年)
- Dynamic rows table:

```
Period  │ Rate (%)      │ Amount (HKD)  │ Action
────────┼───────────────┼───────────────┼───────
Year 1  │ 20            │               │  ×
Year 2  │ 15            │               │  ×
Year 3  │               │ 5,000         │  ×
        │  [+] Add Period               │
```

- User enters EITHER rate (%) OR amount (HKD) per row
- System auto-calculates the other field:
  - If rate entered: `amount = cost × rate / 100`
  - If amount entered: `rate = amount / cost × 100`
- Period labels adapt to period type:
  - Monthly: "Month 1", "Month 2", ...
  - Yearly: "Year 1", "Year 2", ...
- Remaining periods auto-filled with straight-line if schedule is incomplete:
  - Remaining depreciable amount = cost - salvage - sum(custom amounts)
  - Remaining periods = total periods - custom periods defined
  - Auto-fill amount = remaining depreciable / remaining periods
- `depreciation_method = 'custom'`

### Schema Changes

Migration: `migration-custom-depreciation.sql`

```sql
ALTER TABLE fixed_assets ADD COLUMN custom_schedule TEXT;
-- JSON format:
-- {
--   "period_type": "monthly" | "yearly",
--   "lines": [
--     { "period": 1, "rate": 20.0, "amount": null },
--     { "period": 2, "rate": 15.0, "amount": null },
--     { "period": 3, "rate": null, "amount": 5000.0 }
--   ]
-- }
```

### Backend Changes

**`POST /fixed-assets` (create)**:
- Accept `depreciation_method`: `'straight_line'` | `'custom'`
- Accept `custom_schedule`: JSON object (validated)
- For `'custom'`: validate total depreciation doesn't exceed depreciable amount
- Calculate `monthly_depreciation` from first period for backward compatibility

**`POST /fixed-assets/:id` (update)**:
- Allow updating `custom_schedule` and `depreciation_method`

**`POST /run-depreciation`**:
- For `depreciation_method = 'straight_line'`: unchanged
- For `depreciation_method = 'custom'`:
  1. Determine current period number based on purchase_date + elapsed time
  2. Look up rate/amount from `custom_schedule.lines`
  3. If period exists in custom schedule: use that amount
  4. If period beyond custom schedule: auto-calculate straight-line for remaining
  5. Cap at remaining depreciable amount (cost - salvage - accumulated)

### Validation Rules

1. Total of all custom amounts must not exceed `cost - salvage_value`
2. Period numbers must be sequential starting from 1
3. Each line must have either `rate` or `amount` (not both, not neither)
4. Rate must be > 0 and <= 100
5. Amount must be > 0

### Backward Compatibility

- Existing assets with `depreciation_method = 'straight_line'` continue working unchanged
- `custom_schedule` is NULL for straight-line assets
- Frontend defaults to Constant tab when `custom_schedule` is NULL

## Testing

- Unit tests for custom schedule calculation logic
- Edge cases: empty schedule, partial schedule, schedule exceeding cost
- Verify run-depreciation uses correct period from schedule
- Verify auto-fill calculation for remaining periods
