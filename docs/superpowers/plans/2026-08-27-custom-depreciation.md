# Custom Depreciation Schedule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add custom depreciation scheduling to Fixed Assets, allowing per-period rates or amounts instead of straight-line only.

**Architecture:** Add JSON column for schedule storage, extend backend to handle custom period lookups, add tabbed UI with dynamic row editor.

**Tech Stack:** Hono (API), Cloudflare D1 (SQLite), React + TanStack Query (frontend), TypeScript

## Global Constraints

- D1 database (SQLite) — no JSON type, store as TEXT
- Frontend uses Tailwind CSS, Radix UI patterns
- Bilingual UI: English (default) / 繁體中文 / 简体中文 via `tr()` helper
- TDD required: write failing test first, then implement
- Existing patterns: `api/src/lib/depreciation.ts` for calculation helpers

---

## File Structure

| File | Purpose |
|------|---------|
| `api/src/db/migration-custom-depreciation.sql` | Migration: add `custom_schedule` column |
| `api/src/lib/depreciation.ts` | Add custom schedule calculation helpers |
| `api/src/routes/fixed-assets.ts` | Extend create/update/run-depreciation for custom |
| `frontend/src/pages/FixedAssets.tsx` | Add tabbed UI + custom schedule editor |
| `tests/depreciation-custom.test.ts` | Unit tests for custom schedule logic |

---

### Task 1: Database Migration

**Files:**
- Create: `api/src/db/migration-custom-depreciation.sql`

**Interfaces:**
- Produces: `custom_schedule TEXT` column on `fixed_assets` table

- [ ] **Step 1: Create migration file**

```sql
-- migration-custom-depreciation.sql
-- Adds custom_schedule JSON column to fixed_assets for custom depreciation scheduling

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

- [ ] **Step 2: Apply migration to remote D1**

Run: `cd api && npx wrangler d1 execute opcc-crm-db --file=src/db/migration-custom-depreciation.sql`

- [ ] **Step 3: Verify column exists**

Run: `cd api && npx wrangler d1 execute opcc-crm-db --command="PRAGMA table_info(fixed_assets);" | grep custom_schedule`

- [ ] **Step 4: Commit**

```bash
git add api/src/db/migration-custom-depreciation.sql
git commit -m "feat(db): add custom_schedule column to fixed_assets"
```

---

### Task 2: Custom Schedule Calculation Helpers

**Files:**
- Modify: `api/src/lib/depreciation.ts`
- Create: `tests/depreciation-custom.test.ts`

**Interfaces:**
- Produces: `validateCustomSchedule()`, `calculateCustomPeriodDepreciation()`, `buildCustomSchedulePreview()`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/depreciation-custom.test.ts
// Run: npx tsx tests/depreciation-custom.test.ts
import {
  validateCustomSchedule,
  calculateCustomPeriodDepreciation,
  buildCustomSchedulePreview,
  CustomSchedule,
} from '../api/src/lib/depreciation';

let pass = 0, fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) { pass++; } else { fail++; console.error(`FAIL: ${label}`); }
}

// ── validateCustomSchedule ──

const validSchedule: CustomSchedule = {
  period_type: 'yearly',
  lines: [
    { period: 1, rate: 20, amount: null },
    { period: 2, rate: 15, amount: null },
  ],
};
ok(validateCustomSchedule(validSchedule, 100000).valid === true, 'valid schedule');

// Rate exceeds 100%
const badRate: CustomSchedule = {
  period_type: 'yearly',
  lines: [{ period: 1, rate: 150, amount: null }],
};
ok(validateCustomSchedule(badRate, 100000).valid === false, 'rate > 100% invalid');

// Total exceeds depreciable amount
const exceedsCost: CustomSchedule = {
  period_type: 'yearly',
  lines: [{ period: 1, rate: null, amount: 80000 }],
};
ok(validateCustomSchedule(exceedsCost, 50000).valid === false, 'amount > depreciable invalid');

// Both rate and amount set
const bothSet: CustomSchedule = {
  period_type: 'yearly',
  lines: [{ period: 1, rate: 20, amount: 5000 }],
};
ok(validateCustomSchedule(bothSet, 100000).valid === false, 'both rate+amount invalid');

// Neither rate nor amount
const neitherSet: CustomSchedule = {
  period_type: 'yearly',
  lines: [{ period: 1, rate: null, amount: null }],
};
ok(validateCustomSchedule(neitherSet, 100000).valid === false, 'neither rate+amount invalid');

// ── calculateCustomPeriodDepreciation ──

const yearlySchedule: CustomSchedule = {
  period_type: 'yearly',
  lines: [
    { period: 1, rate: 20, amount: null },
    { period: 2, rate: 15, amount: null },
    { period: 3, rate: null, amount: 5000 },
  ],
};

// Year 1: 20% of 100000 = 20000
ok(calculateCustomPeriodDepreciation(yearlySchedule, 1, 100000) === 20000, 'year 1 rate-based');

// Year 2: 15% of 100000 = 15000
ok(calculateCustomPeriodDepreciation(yearlySchedule, 2, 100000) === 15000, 'year 2 rate-based');

// Year 3: fixed amount 5000
ok(calculateCustomPeriodDepreciation(yearlySchedule, 3, 100000) === 5000, 'year 3 amount-based');

// Period beyond schedule: returns null (auto-fill needed)
ok(calculateCustomPeriodDepreciation(yearlySchedule, 4, 100000) === null, 'period beyond schedule returns null');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx tests/depreciation-custom.test.ts`
Expected: FAIL with "validateCustomSchedule is not a function"

- [ ] **Step 3: Add types and functions to depreciation.ts**

```typescript
// Add to api/src/lib/depreciation.ts

export interface CustomScheduleLine {
  period: number;
  rate: number | null;
  amount: number | null;
}

export interface CustomSchedule {
  period_type: 'monthly' | 'yearly';
  lines: CustomScheduleLine[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a custom depreciation schedule.
 */
export function validateCustomSchedule(
  schedule: CustomSchedule,
  depreciableAmount: number,
): ValidationResult {
  const errors: string[] = [];

  if (!schedule.lines || schedule.lines.length === 0) {
    errors.push('Schedule must have at least one line');
    return { valid: false, errors };
  }

  let totalAmount = 0;
  for (const line of schedule.lines) {
    if (line.rate !== null && line.amount !== null) {
      errors.push(`Period ${line.period}: cannot set both rate and amount`);
    } else if (line.rate === null && line.amount === null) {
      errors.push(`Period ${line.period}: must set either rate or amount`);
    } else if (line.rate !== null) {
      if (line.rate <= 0 || line.rate > 100) {
        errors.push(`Period ${line.period}: rate must be between 0 and 100`);
      }
      totalAmount += depreciableAmount * line.rate / 100;
    } else if (line.amount !== null) {
      if (line.amount <= 0) {
        errors.push(`Period ${line.period}: amount must be positive`);
      }
      totalAmount += line.amount;
    }
  }

  if (totalAmount > depreciableAmount * 1.001) { // 0.1% tolerance for rounding
    errors.push(`Total depreciation (${totalAmount}) exceeds depreciable amount (${depreciableAmount})`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Get depreciation amount for a specific period from custom schedule.
 * Returns null if period is beyond the schedule (needs auto-fill).
 */
export function calculateCustomPeriodDepreciation(
  schedule: CustomSchedule,
  periodNumber: number,
  cost: number,
): number | null {
  const line = schedule.lines.find(l => l.period === periodNumber);
  if (!line) return null;

  if (line.amount !== null) return line.amount;
  if (line.rate !== null) return Math.round(cost * line.rate / 100 * 100) / 100;
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx tests/depreciation-custom.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add api/src/lib/depreciation.ts tests/depreciation-custom.test.ts
git commit -m "feat(api): add custom depreciation schedule validation and calculation"
```

---

### Task 3: Extend Fixed Assets API

**Files:**
- Modify: `api/src/routes/fixed-assets.ts`

**Interfaces:**
- Consumes: `validateCustomSchedule()`, `CustomSchedule` from Task 2
- Produces: Updated create/update/run-depreciation endpoints

- [ ] **Step 1: Update create endpoint to accept custom_schedule**

Find the `assets.post('/')` handler and add `custom_schedule` to the destructured body:

```typescript
const { asset_name, asset_code, category, purchase_date, cost, useful_life_years, salvage_value,
  account_code, depn_account_code, acc_depn_account_code, notes, depreciation_method, custom_schedule } = body;
```

After the existing validation, add custom schedule validation:

```typescript
const method = depreciation_method || 'straight_line';
let scheduleData = null;

if (method === 'custom') {
  if (!custom_schedule || !custom_schedule.lines || custom_schedule.lines.length === 0) {
    return c.json({ error: 'custom_schedule required for custom depreciation method' }, 400);
  }
  const depreciable = cost - (salvage || 0);
  const validation = validateCustomSchedule(custom_schedule, depreciable);
  if (!validation.valid) {
    return c.json({ error: 'Invalid custom schedule', details: validation.errors }, 400);
  }
  scheduleData = JSON.stringify(custom_schedule);
}
```

Update the INSERT statement to include `depreciation_method` and `custom_schedule`:

```typescript
await db.prepare(
  `INSERT INTO fixed_assets (id, user_id, asset_name, asset_code, category, purchase_date, cost,
   useful_life_years, salvage_value, depreciation_method, custom_schedule, monthly_depreciation, accumulated_depreciation,
   net_book_value, account_code, depn_account_code, acc_depn_account_code, notes)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
).bind(id, tenantId, asset_name, asset_code || null, category || 'office_equipment', purchase_date,
  cost, usefulLife, salvage, method, scheduleData, monthlyDepn, 0,
  cost, account_code || '12201', depn_account_code || '66101', acc_depn_account_code || '12301',
  notes || null).run();
```

- [ ] **Step 2: Update PATCH endpoint to allow custom_schedule updates**

Add `custom_schedule` and `depreciation_method` to the allowed fields:

```typescript
const fields = ['asset_name', 'category', 'useful_life_years', 'salvage_value', 'is_active',
  'account_code', 'depn_account_code', 'acc_depn_account_code', 'notes', 'disposal_date', 'disposal_amount',
  'depreciation_method', 'custom_schedule'];
```

Handle custom_schedule serialization:

```typescript
for (const [k, v] of Object.entries(body)) {
  if (fields.includes(k)) {
    const val = k === 'custom_schedule' ? JSON.stringify(v) : v;
    sets.push(`${k} = ?`);
    params.push(val);
  }
}
```

- [ ] **Step 3: Update run-depreciation to handle custom method**

In the `assets.post('/run-depreciation')` handler, after fetching `activeAssets`, add logic to handle custom schedules:

```typescript
for (const asset of activeAssets.results as any[]) {
  let actualDepn = 0;

  if (asset.depreciation_method === 'custom' && asset.custom_schedule) {
    const schedule: CustomSchedule = JSON.parse(asset.custom_schedule);
    // Calculate current period number based on purchase_date
    const purchaseDate = new Date(asset.purchase_date);
    const periodEnd = new Date(period_end_date);
    let periodsElapsed: number;

    if (schedule.period_type === 'yearly') {
      periodsElapsed = (periodEnd.getFullYear() - purchaseDate.getFullYear());
    } else {
      periodsElapsed = (periodEnd.getFullYear() - purchaseDate.getFullYear()) * 12
        + (periodEnd.getMonth() - purchaseDate.getMonth());
    }

    const currentPeriod = periodsElapsed + 1; // 1-indexed
    const amountFromSchedule = calculateCustomPeriodDepreciation(schedule, currentPeriod, asset.cost);

    if (amountFromSchedule !== null) {
      actualDepn = amountFromSchedule;
    } else {
      // Auto-fill: straight-line for remaining periods
      const remainingBook = asset.net_book_value - (asset.salvage_value || 0);
      const totalPeriods = schedule.period_type === 'yearly'
        ? asset.useful_life_years
        : asset.useful_life_years * 12;
      const remainingPeriods = Math.max(totalPeriods - schedule.lines.length, 1);
      actualDepn = remainingBook / remainingPeriods;
    }
  } else {
    // Existing straight-line logic
    const monthlyDepn = asset.monthly_depreciation;
    const remainingBook = asset.net_book_value - (asset.salvage_value || 0);
    actualDepn = Math.min(monthlyDepn, Math.max(remainingBook, 0));
  }

  actualDepn = Math.round(actualDepn * 100) / 100;
  if (actualDepn <= 0) continue;

  // ... rest of existing logic (Dr/Cr lines, update asset)
}
```

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/fixed-assets.ts
git commit -m "feat(api): extend fixed-assets for custom depreciation schedules"
```

---

### Task 4: Frontend Tabbed UI

**Files:**
- Modify: `frontend/src/pages/FixedAssets.tsx`

**Interfaces:**
- Consumes: Updated API from Task 3
- Produces: Tabbed depreciation details with custom schedule editor

- [ ] **Step 1: Add state for depreciation method and custom schedule**

Add to the form state:

```typescript
const [form, setForm] = useState({
  // ... existing fields
  depreciation_method: 'straight_line',
  custom_schedule: { period_type: 'yearly' as 'monthly' | 'yearly', lines: [] as Array<{period: number, rate: number | null, amount: number | null}> },
});
```

- [ ] **Step 2: Replace depreciation details section with tabs**

Replace the current "Depreciation Details" section with:

```tsx
{/* Depreciation Details */}
<div className="space-y-3">
  <h4 className="text-sm font-medium text-muted-foreground border-b pb-1">
    {tr('Depreciation Details', '折舊詳情', '折旧详情')}
  </h4>

  {/* Tabs */}
  <div className="flex gap-1 border rounded-lg p-1 bg-muted">
    <button
      type="button"
      onClick={() => setForm({...form, depreciation_method: 'straight_line'})}
      className={`flex-1 px-3 py-1.5 text-sm rounded-md transition-colors ${
        form.depreciation_method === 'straight_line'
          ? 'bg-background shadow-sm font-medium'
          : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {tr('Constant', '平率折舊', '平率折旧')}
    </button>
    <button
      type="button"
      onClick={() => setForm({...form, depreciation_method: 'custom'})}
      className={`flex-1 px-3 py-1.5 text-sm rounded-md transition-colors ${
        form.depreciation_method === 'custom'
          ? 'bg-background shadow-sm font-medium'
          : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {tr('Custom', '自訂折舊', '自订折旧')}
    </button>
  </div>

  {/* Constant tab content */}
  {form.depreciation_method === 'straight_line' && (
    <div className="grid grid-cols-3 gap-3">
      {/* ... existing cost/useful_life/salvage inputs ... */}
    </div>
  )}

  {/* Custom tab content */}
  {form.depreciation_method === 'custom' && (
    <CustomScheduleEditor
      schedule={form.custom_schedule}
      cost={Number(form.cost) || 0}
      onChange={(schedule) => setForm({...form, custom_schedule: schedule})}
    />
  )}
</div>
```

- [ ] **Step 3: Create CustomScheduleEditor component**

Add at the end of FixedAssets.tsx (or extract to separate file):

```tsx
function CustomScheduleEditor({
  schedule,
  cost,
  onChange,
}: {
  schedule: { period_type: 'monthly' | 'yearly'; lines: Array<{period: number, rate: number | null, amount: number | null}> };
  cost: number;
  onChange: (schedule: typeof schedule) => void;
}) {
  const addLine = () => {
    const nextPeriod = schedule.lines.length + 1;
    onChange({
      ...schedule,
      lines: [...schedule.lines, { period: nextPeriod, rate: null, amount: null }],
    });
  };

  const removeLine = (period: number) => {
    const newLines = schedule.lines
      .filter(l => l.period !== period)
      .map((l, i) => ({ ...l, period: i + 1 }));
    onChange({ ...schedule, lines: newLines });
  };

  const updateLine = (period: number, field: 'rate' | 'amount', value: number | null) => {
    const newLines = schedule.lines.map(l => {
      if (l.period !== period) return l;
      if (field === 'rate') {
        const amount = value !== null ? Math.round(cost * value / 100 * 100) / 100 : null;
        return { ...l, rate: value, amount: l.amount !== null ? amount : null };
      } else {
        const rate = value !== null && cost > 0 ? Math.round(value / cost * 100 * 100) / 100 : null;
        return { ...l, amount: value, rate: l.rate !== null ? rate : null };
      }
    });
    onChange({ ...schedule, lines: newLines });
  };

  return (
    <div className="space-y-3">
      {/* Period type selector */}
      <div className="flex gap-2">
        <label className="text-sm">{tr('Period:', '期間:', '期间:')}</label>
        <select
          value={schedule.period_type}
          onChange={e => onChange({...schedule, period_type: e.target.value as 'monthly' | 'yearly'})}
          className="px-2 py-1 border rounded text-sm"
        >
          <option value="yearly">{tr('Yearly', '每年', '每年')}</option>
          <option value="monthly">{tr('Monthly', '每月', '每月')}</option>
        </select>
      </div>

      {/* Schedule table */}
      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted">
              <th className="px-3 py-2 text-left">{tr('Period', '期間', '期间')}</th>
              <th className="px-3 py-2 text-left">{tr('Rate (%)', '比率 (%)', '比率 (%)')}</th>
              <th className="px-3 py-2 text-left">{tr('Amount (HKD)', '金額 (HKD)', '金额 (HKD)')}</th>
              <th className="px-3 py-2 w-10"></th>
            </tr>
          </thead>
          <tbody>
            {schedule.lines.map((line) => (
              <tr key={line.period} className="border-t">
                <td className="px-3 py-2">
                  {schedule.period_type === 'yearly'
                    ? tr(`Year ${line.period}`, `第 ${line.period} 年`, `第 ${line.period} 年`)
                    : tr(`Month ${line.period}`, `第 ${line.period} 月`, `第 ${line.period} 月`)}
                </td>
                <td className="px-3 py-2">
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="100"
                    value={line.rate ?? ''}
                    onChange={e => updateLine(line.period, 'rate', e.target.value ? Number(e.target.value) : null)}
                    placeholder="0.00"
                    className="w-20 px-2 py-1 border rounded text-sm"
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={line.amount ?? ''}
                    onChange={e => updateLine(line.period, 'amount', e.target.value ? Number(e.target.value) : null)}
                    placeholder="0.00"
                    className="w-24 px-2 py-1 border rounded text-sm"
                  />
                </td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => removeLine(line.period)}
                    className="text-destructive hover:text-destructive/80"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <button
        type="button"
        onClick={addLine}
        className="flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <Plus className="h-3 w-3" />
        {tr('Add Period', '新增期間', '新增期间')}
      </button>

      {cost > 0 && (
        <p className="text-xs text-muted-foreground">
          {tr(
            `Enter a rate (%) to auto-calculate amount, or enter a fixed amount (HKD).`,
            '輸入比率 (%) 自動計算金額，或輸入固定金額 (HKD)。',
            '输入比率 (%) 自动计算金额，或输入固定金额 (HKD)。'
          )}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Build and verify no TypeScript errors**

Run: `cd frontend && npm run build`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/FixedAssets.tsx
git commit -m "feat(frontend): add tabbed depreciation UI with custom schedule editor"
```

---

### Task 5: Integration Test

**Files:**
- Create: `tests/depreciation-custom-integration.test.ts`

**Interfaces:**
- Consumes: All previous tasks

- [ ] **Step 1: Write integration test**

```typescript
// tests/depreciation-custom-integration.test.ts
// Run: npx tsx tests/depreciation-custom-integration.test.ts
import {
  validateCustomSchedule,
  calculateCustomPeriodDepreciation,
  calculateMonthlyDepreciation,
  CustomSchedule,
} from '../api/src/lib/depreciation';

let pass = 0, fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) { pass++; } else { fail++; console.error(`FAIL: ${label}`); }
}

// ── Scenario: 3-year asset with custom Year 1 high depreciation ──
// Cost: 100,000, Salvage: 10,000, Depreciable: 90,000
// Custom: Year 1 = 40%, Year 2 = 30%, Year 3 = 30%

const schedule3yr: CustomSchedule = {
  period_type: 'yearly',
  lines: [
    { period: 1, rate: 40, amount: null },
    { period: 2, rate: 30, amount: null },
    { period: 3, rate: 30, amount: null },
  ],
};

const validation = validateCustomSchedule(schedule3yr, 90000);
ok(validation.valid === true, '3-year schedule valid');
ok(calculateCustomPeriodDepreciation(schedule3yr, 1, 100000) === 40000, 'Year 1: 40% of 100k = 40k');
ok(calculateCustomPeriodDepreciation(schedule3yr, 2, 100000) === 30000, 'Year 2: 30% of 100k = 30k');
ok(calculateCustomPeriodDepreciation(schedule3yr, 3, 100000) === 30000, 'Year 3: 30% of 100k = 30k');
ok(calculateCustomPeriodDepreciation(schedule3yr, 4, 100000) === null, 'Year 4: beyond schedule');

// ── Scenario: Monthly custom schedule ──
const monthlySchedule: CustomSchedule = {
  period_type: 'monthly',
  lines: [
    { period: 1, rate: 5, amount: null },
    { period: 2, rate: 4, amount: null },
  ],
};

ok(validateCustomSchedule(monthlySchedule, 50000).valid === true, 'monthly schedule valid');
ok(calculateCustomPeriodDepreciation(monthlySchedule, 1, 50000) === 2500, 'Month 1: 5% of 50k = 2.5k');
ok(calculateCustomPeriodDepreciation(monthlySchedule, 2, 50000) === 2000, 'Month 2: 4% of 50k = 2k');

// ── Scenario: Mixed rate and amount ──
const mixedSchedule: CustomSchedule = {
  period_type: 'yearly',
  lines: [
    { period: 1, rate: 25, amount: null },
    { period: 2, rate: null, amount: 15000 },
    { period: 3, rate: null, amount: 10000 },
  ],
};

ok(validateCustomSchedule(mixedSchedule, 80000).valid === true, 'mixed schedule valid');
ok(calculateCustomPeriodDepreciation(mixedSchedule, 1, 60000) === 15000, 'Year 1: 25% of 60k = 15k');
ok(calculateCustomPeriodDepreciation(mixedSchedule, 2, 60000) === 15000, 'Year 2: fixed 15k');
ok(calculateCustomPeriodDepreciation(mixedSchedule, 3, 60000) === 10000, 'Year 3: fixed 10k');

// ── Scenario: Validation errors ──
const overDepreciation: CustomSchedule = {
  period_type: 'yearly',
  lines: [{ period: 1, rate: null, amount: 100000 }],
};
ok(validateCustomSchedule(overDepreciation, 50000).valid === false, 'over-depreciation detected');

const emptySchedule: CustomSchedule = {
  period_type: 'yearly',
  lines: [],
};
ok(validateCustomSchedule(emptySchedule, 50000).valid === false, 'empty schedule invalid');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run integration test**

Run: `npx tsx tests/depreciation-custom-integration.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/depreciation-custom-integration.test.ts
git commit -m "test: add custom depreciation integration tests"
```

---

### Task 6: Deploy

**Files:**
- None (deployment only)

- [ ] **Step 1: Deploy API**

Run: `cd api && npx wrangler deploy`

- [ ] **Step 2: Build and deploy frontend**

Run: `cd frontend && npm run build && npx wrangler pages deploy dist --project-name=opcc-crm --branch=production --commit-dirty=true`

- [ ] **Step 3: Verify on production**

1. Navigate to Fixed Assets page
2. Click "Add Asset"
3. Verify tabs appear: "Constant" | "Custom"
4. Click "Custom" tab
5. Add a period row
6. Enter a rate — verify amount auto-calculates
7. Enter an amount — verify rate auto-calculates
8. Create asset with custom schedule
9. Run depreciation — verify correct amount posted

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: custom depreciation scheduling — complete"
```
