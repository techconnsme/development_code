# Payroll Demo Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `/payroll` stub page with a demo payroll page: a staff list whose row click extends an animated detail region (within one continuous card) showing monthly payment status, gross / employee MPF / employer MPF / net figures, and balanced HK COA debit/credit entries.

**Architecture:** Frontend-only. A pure `computeMpf` module encodes the in-force HK MPF rules; a sample data module holds 7 staff, 12 months, statuses, and a pure JE builder; one page component renders the master-detail card with CSS transitions (no animation library). One line in `App.tsx` swaps the stub for the page. No backend, no new npm dependencies.

**Tech Stack:** React 18 + TypeScript 5.7 + Vite 6 + Tailwind 3 (JIT, shadcn-style `hsl(var(--…))` theme vars), react-i18next `tr()` helper, lucide-react, Playwright (chromium, repo-root config).

**Spec:** `docs/superpowers/specs/2026-08-20-payroll-demo-design.md` — the plan argues from the spec; read both.

## Global Constraints

- Frontend-only: **no backend files, no D1/API changes, no new npm dependencies.**
- MPF rules (in force 2026-08, verified): rate **5%**; min monthly income **HK$7,100** (below → employee 0, employer still 5%); max relevant income **HK$30,000** → cap **HK$1,500/side**. Round with `Math.round`. The proposed 40,000 / 2,000 figures are **not in force — do not use**.
- All visible labels go through `tr(en, zhHant, zhHans)`; the page must call `useTranslation()` so `tr()` stays reactive on language change.
- Statuses `paid` → emerald, `pending` → amber, `scheduled` → grey, as `bg-*-500/10` + `text-*-600 dark:text-*-400` badge pairs.
- No pre-selection on load; closed detail region is **blank** (width 0, no placeholder). Desktop animation: width `0 → 480px`, `transition-all duration-300 ease-out`; content slides in via `payroll-slide-in` keyframes; divider `opacity` fades. Mobile (<768px): full-width overlay via `translate-x`. Collapse via ✕ **and** re-clicking the selected row.
- Month rows are accordions (`max-h-0 opacity-0` → `max-h-[420px] opacity-100`, 300ms ease-out) revealing two JE blocks.
- COA codes (from `api/src/db/coa-hk.sql`, names bilingual): salary debit `61201` (default) / `61102` (director) / `51201` (consultant); `61202` MPF employer; `21204` MPF payable; `11102` HSBC. JE lines with amount 0 are hidden; each block shows a Dr = Cr total.
- `npm run build` in `frontend/` (`tsc -b && vite build`) must stay clean after every task.
- Commit messages end with `Co-Authored-By: Claude <noreply@anthropic.com>` (house rule). Repo: git root = `latest_code`, branch `main`.
- Throwaway check scripts are **deleted before committing** (spec: not committed).

---

### Task 1: `computeMpf` pure module

**Files:**
- Create: `frontend/src/lib/mpf.ts`
- Throwaway (delete before commit): `scripts/check-mpf.ts`

**Interfaces:**
- Produces: `computeMpf(grossMonthly: number): { employee: number; employer: number; net: number }` plus constants `MPF_MIN_MONTHLY_INCOME` (7100), `MPF_MAX_MONTHLY_INCOME` (30000), `MPF_RATE` (0.05), `MPF_MAX_CONTRIBUTION` (1500). Tasks 2 and 4 consume `computeMpf`.

- [ ] **Step 1: Commit the approved spec (uncommitted so far)**

```powershell
git add docs/superpowers/specs/2026-08-20-payroll-demo-design.md
git commit -m @'
docs: payroll demo design spec

Co-Authored-By: Claude <noreply@anthropic.com>
'@
```

- [ ] **Step 2: Write the throwaway check script (expect it to fail — module doesn't exist yet)**

Create `scripts/check-mpf.ts`:

```ts
import { computeMpf } from '../frontend/src/lib/mpf';

// Regression table from the spec §MPF calculation
const cases: Array<[number, number, number, number]> = [
  [6000, 0, 300, 6000],     // below minimum: employee 0, employer 5%
  [9500, 475, 475, 9025],   // normal band
  [22500, 1125, 1125, 21375],
  [28000, 1400, 1400, 26600],
  [35000, 1500, 1500, 33500], // capped
  [45000, 1500, 1500, 43500], // capped
  [60000, 1500, 1500, 58500], // capped
];

let failed = 0;
const assert = (cond: boolean, msg: string) => { if (!cond) { failed++; console.error('FAIL', msg); } };

for (const [gross, ee, er, net] of cases) {
  const r = computeMpf(gross);
  assert(r.employee === ee && r.employer === er && r.net === net,
    `gross=${gross} got ${JSON.stringify(r)} want ee=${ee} er=${er} net=${net}`);
}
assert(computeMpf(7100).employee === 355, 'exactly at minimum pays 5%');
assert(computeMpf(7099.99).employee === 0, 'below minimum pays 0');
assert(computeMpf(-100).net === 0, 'negative input clamps to 0');

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log('All mpf checks passed');
```

- [ ] **Step 3: Run it — verify it fails**

```powershell
npx -y -p typescript@5.7.3 tsc scripts/check-mpf.ts --outDir .check-mpf --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck
if ($?) { node .check-mpf/scripts/check-mpf.js }
```

Expected: compile error `Cannot find module '../frontend/src/lib/mpf'`.

- [ ] **Step 4: Write the implementation**

Create `frontend/src/lib/mpf.ts`:

```ts
// Pure Hong Kong MPF contribution calculation.
// Rules in force as of 2026-08 (see spec docs/superpowers/specs/2026-08-20-payroll-demo-design.md):
// 5% each side; minimum relevant income HK$7,100 (below → employee 0, employer still 5%);
// maximum relevant income HK$30,000 → cap HK$1,500 per side.
// NOTE: the proposed HK$40,000 / HK$2,000 cap is under consultation — do not use it.

export const MPF_MIN_MONTHLY_INCOME = 7100;
export const MPF_MAX_MONTHLY_INCOME = 30000;
export const MPF_RATE = 0.05;
export const MPF_MAX_CONTRIBUTION = 1500;

export interface MpfResult {
  employee: number;
  employer: number;
  net: number;
}

export function computeMpf(grossMonthly: number): MpfResult {
  const gross = Math.max(0, grossMonthly);
  const employer = Math.min(Math.round(gross * MPF_RATE), MPF_MAX_CONTRIBUTION);
  const employee =
    gross < MPF_MIN_MONTHLY_INCOME ? 0 : Math.min(Math.round(gross * MPF_RATE), MPF_MAX_CONTRIBUTION);
  return { employee, employer, net: gross - employee };
}
```

- [ ] **Step 5: Run the check again — verify it passes**

```powershell
npx -y -p typescript@5.7.3 tsc scripts/check-mpf.ts frontend/src/lib/mpf.ts --outDir .check-mpf --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck
if ($?) { node .check-mpf/scripts/check-mpf.js }
```

Expected: `All mpf checks passed`.

- [ ] **Step 6: Delete the throwaway artifacts, then commit**

```powershell
Remove-Item -Recurse -Force .check-mpf, scripts/check-mpf.ts
git add frontend/src/lib/mpf.ts
git commit -m @'
feat(payroll): add pure MPF calculation module

Co-Authored-By: Claude <noreply@anthropic.com>
'@
```

---

### Task 2: Sample payroll data module + JE builder

**Files:**
- Create: `frontend/src/data/samplePayroll.ts`
- Throwaway (delete before commit): `scripts/check-payroll-data.ts`

**Interfaces:**
- Consumes: `computeMpf` from Task 1.
- Produces (Tasks 3–4 consume):
  - `SampleStaff` — `{ id, name, nameZh, nameCn, title, titleZh, titleCn, gender: 'M'|'F', maritalStatus: 'single'|'married', monthlySalary: number, salaryAccount: string }`
  - `MonthStatus = 'paid' | 'pending' | 'scheduled'`
  - `STAFF: SampleStaff[]` (7 entries), `MONTHS: string[]` (`'2026-01'…'2026-12'`), `STATUSES: Record<string, Record<string, MonthStatus>>`
  - `COA_ACCOUNTS: Record<string, { code: string; name: string; nameZh: string; nameCn: string }>`
  - `JeLine = { dr: boolean; code: string; amount: number }`, `JeBlock = { id: string; title: string; titleZh: string; titleCn: string; lines: JeLine[]; total: number }`
  - `buildMonthlyJe(staff: SampleStaff): { salary: JeBlock; mpf: JeBlock }`

- [ ] **Step 1: Write the throwaway check script (expect compile failure first)**

Create `scripts/check-payroll-data.ts`:

```ts
import { STAFF, MONTHS, STATUSES, buildMonthlyJe } from '../frontend/src/data/samplePayroll';
import { computeMpf } from '../frontend/src/lib/mpf';

let failed = 0;
const assert = (cond: boolean, msg: string) => { if (!cond) { failed++; console.error('FAIL', msg); } };

assert(STAFF.length === 7, `expected 7 staff, got ${STAFF.length}`);
assert(MONTHS.length === 12, `expected 12 months, got ${MONTHS.length}`);

for (const s of STAFF) {
  assert(s.salaryAccount === (s.id === 'EMP-0006' ? '61102' : s.id === 'EMP-0007' ? '51201' : '61201'),
    `${s.id} unexpected salaryAccount ${s.salaryAccount}`);
  for (const m of MONTHS) {
    const i = MONTHS.indexOf(m);
    const want = i <= 6 ? 'paid' : i === 7 ? 'pending' : 'scheduled';
    assert(STATUSES[s.id]?.[m] === want, `${s.id} ${m} status ${STATUSES[s.id]?.[m]} != ${want}`);
    const je = buildMonthlyJe(s);
    for (const [name, block] of [['salary', je.salary], ['mpf', je.mpf]] as const) {
      const dr = block.lines.filter((l) => l.dr).reduce((a, l) => a + l.amount, 0);
      const cr = block.lines.filter((l) => !l.dr).reduce((a, l) => a + l.amount, 0);
      assert(dr === cr, `${s.id} ${m} ${name} JE unbalanced: Dr ${dr} vs Cr ${cr}`);
    }
    assert(je.salary.lines[0]?.code === s.salaryAccount, `${s.id} salary debit code`);
    assert(je.mpf.lines.some((l) => l.dr && l.code === '61202'), `${s.id} mpf employer debit missing`);
    assert(je.mpf.lines.some((l) => !l.dr && l.code === '11102'), `${s.id} mpf bank credit missing`);
  }
}
assert(computeMpf(6000).employee === 0, 'below-min employee MPF should be 0');

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log('All payroll data checks passed');
```

- [ ] **Step 2: Run it — verify it fails**

```powershell
npx -y -p typescript@5.7.3 tsc scripts/check-payroll-data.ts --outDir .check-payroll --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck
if ($?) { node .check-payroll/scripts/check-payroll-data.js }
```

Expected: compile error `Cannot find module '../frontend/src/data/samplePayroll'`.

- [ ] **Step 3: Write the data module**

Create `frontend/src/data/samplePayroll.ts`:

```ts
// Demo-only sample payroll data for the /payroll page.
// See spec: docs/superpowers/specs/2026-08-20-payroll-demo-design.md
import { computeMpf } from '../lib/mpf';

export type MonthStatus = 'paid' | 'pending' | 'scheduled';

export interface SampleStaff {
  id: string;
  name: string;
  nameZh: string;
  nameCn: string;
  title: string;
  titleZh: string;
  titleCn: string;
  gender: 'M' | 'F';
  maritalStatus: 'single' | 'married';
  monthlySalary: number; // HKD gross
  salaryAccount: string; // COA debit code for the salary
}

export const STAFF: SampleStaff[] = [
  { id: 'EMP-0001', name: 'Chan Tai Man', nameZh: '陳大文', nameCn: '陈大文', title: 'Senior Developer', titleZh: '高級開發工程師', titleCn: '高级开发工程师', gender: 'M', maritalStatus: 'married', monthlySalary: 45000, salaryAccount: '61201' },
  { id: 'EMP-0002', name: 'Lee Siu Ming', nameZh: '李小明', nameCn: '李小明', title: 'Accountant', titleZh: '會計師', titleCn: '会计师', gender: 'F', maritalStatus: 'single', monthlySalary: 28000, salaryAccount: '61201' },
  { id: 'EMP-0003', name: 'Wong Ka Yan', nameZh: '黃家欣', nameCn: '黄家欣', title: 'Marketing Executive', titleZh: '市場推廣主任', titleCn: '市场推广主任', gender: 'F', maritalStatus: 'married', monthlySalary: 22500, salaryAccount: '61201' },
  { id: 'EMP-0004', name: 'Ng Man Wai', nameZh: '吳文偉', nameCn: '吴文伟', title: 'Office Assistant', titleZh: '辦公室助理', titleCn: '办公室助理', gender: 'M', maritalStatus: 'single', monthlySalary: 9500, salaryAccount: '61201' },
  { id: 'EMP-0005', name: 'Cheung Mei Ling', nameZh: '張美玲', nameCn: '张美玲', title: 'Part-time Clerk', titleZh: '兼職文員', titleCn: '兼职文员', gender: 'F', maritalStatus: 'married', monthlySalary: 6000, salaryAccount: '61201' },
  { id: 'EMP-0006', name: 'Ho Chi Wai', nameZh: '何志偉', nameCn: '何志伟', title: 'Director', titleZh: '董事', titleCn: '董事', gender: 'M', maritalStatus: 'married', monthlySalary: 60000, salaryAccount: '61102' },
  { id: 'EMP-0007', name: 'Tam Siu Fung', nameZh: '譚兆豐', nameCn: '谭兆丰', title: 'Project Consultant', titleZh: '項目顧問', titleCn: '项目顾问', gender: 'M', maritalStatus: 'single', monthlySalary: 35000, salaryAccount: '51201' },
];

export const MONTHS: string[] = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);

// Jan–Jul paid, Aug pending, Sep–Dec scheduled
export const STATUSES: Record<string, Record<string, MonthStatus>> = {};
for (const s of STAFF) {
  STATUSES[s.id] = {};
  MONTHS.forEach((m, i) => {
    STATUSES[s.id][m] = i <= 6 ? 'paid' : i === 7 ? 'pending' : 'scheduled';
  });
}

// Bilingual account names from api/src/db/coa-hk.sql (en / zh-Hant / zh-Hans)
export const COA_ACCOUNTS: Record<string, { code: string; name: string; nameZh: string; nameCn: string }> = {
  '11102': { code: '11102', name: 'HSBC', nameZh: '匯豐銀行', nameCn: '汇丰银行' },
  '21204': { code: '21204', name: 'MPF Payable', nameZh: '應付強積金', nameCn: '应付强积金' },
  '51201': { code: '51201', name: 'Project Staff Salary', nameZh: '項目人員薪酬', nameCn: '项目人员薪酬' },
  '61102': { code: '61102', name: 'Management Salary', nameZh: '管理層薪金', nameCn: '管理层薪金' },
  '61201': { code: '61201', name: 'Staff Salaries', nameZh: '員工薪金', nameCn: '员工薪金' },
  '61202': { code: '61202', name: 'MPF Employer Contribution', nameZh: '強積金僱主供款', nameCn: '强积金雇主供款' },
};

export interface JeLine {
  dr: boolean;
  code: string;
  amount: number;
}

export interface JeBlock {
  id: string;
  title: string;
  titleZh: string;
  titleCn: string;
  lines: JeLine[];
  total: number; // Dr total = Cr total
}

// Two balanced entry blocks for one month (spec §COA debit/credit display):
// Salary payment: Dr {salaryAccount} gross / Cr 11102 net / Cr 21204 employee MPF
// MPF remittance: Dr 61202 employer / Dr 21204 employee / Cr 11102 total
export function buildMonthlyJe(staff: SampleStaff): { salary: JeBlock; mpf: JeBlock } {
  const { employee, employer, net } = computeMpf(staff.monthlySalary);
  return {
    salary: {
      id: 'salary',
      title: 'Salary Payment',
      titleZh: '薪金支付',
      titleCn: '薪金支付',
      lines: [
        { dr: true, code: staff.salaryAccount, amount: staff.monthlySalary },
        { dr: false, code: '11102', amount: net },
        { dr: false, code: '21204', amount: employee },
      ],
      total: staff.monthlySalary,
    },
    mpf: {
      id: 'mpf',
      title: 'MPF Remittance',
      titleZh: '強積金供款',
      titleCn: '强积金供款',
      lines: [
        { dr: true, code: '61202', amount: employer },
        { dr: true, code: '21204', amount: employee },
        { dr: false, code: '11102', amount: employee + employer },
      ],
      total: employee + employer,
    },
  };
}
```

- [ ] **Step 4: Run the check — verify it passes**

```powershell
npx -y -p typescript@5.7.3 tsc scripts/check-payroll-data.ts frontend/src/lib/mpf.ts frontend/src/data/samplePayroll.ts --outDir .check-payroll --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck
if ($?) { node .check-payroll/scripts/check-payroll-data.js }
```

Expected: `All payroll data checks passed`.

- [ ] **Step 5: Delete throwaway artifacts, then commit**

```powershell
Remove-Item -Recurse -Force .check-payroll, scripts/check-payroll-data.ts
git add frontend/src/data/samplePayroll.ts
git commit -m @'
feat(payroll): add sample payroll data module with JE builder

Co-Authored-By: Claude <noreply@anthropic.com>
'@
```

---

### Task 3: Payroll page — card, staff list, extension animation

**Files:**
- Create: `frontend/src/pages/Payroll.tsx`

**Interfaces:**
- Consumes: `STAFF`, `SampleStaff` from Task 2; `tr`, `cn` helpers; `useTranslation`.
- Produces: default-exported `Payroll` component; internal `DetailStub` placeholder that Task 4 replaces with `DetailPanel` (same props shape: `{ staff: SampleStaff; onClose: () => void }`).

- [ ] **Step 1: Write the page (complete file — detail content comes in Task 4)**

Create `frontend/src/pages/Payroll.tsx`:

```tsx
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { tr } from '../lib/i18nHelpers';
import { cn } from '../lib/utils';
import { STAFF, type SampleStaff } from '../data/samplePayroll';

const fmt = (n: number) => `HKD ${n.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

const GENDER_LABEL: Record<SampleStaff['gender'], [string, string, string]> = {
  M: ['Male', '男', '男'],
  F: ['Female', '女', '女'],
};
const MARITAL_LABEL: Record<SampleStaff['maritalStatus'], [string, string, string]> = {
  single: ['Single', '單身', '单身'],
  married: ['Married', '已婚', '已婚'],
};

// Minimal detail content for this task — Task 4 replaces this with the full DetailPanel.
function DetailStub({ staff, onClose }: { staff: SampleStaff; onClose: () => void }) {
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b" style={{ borderColor: 'hsl(var(--border))' }}>
        <div className="min-w-0">
          <div className="font-semibold">{tr(staff.name, staff.nameZh, staff.nameCn)}</div>
          <div className="text-xs text-muted-foreground">{tr(staff.title, staff.titleZh, staff.titleCn)} · {staff.id}</div>
        </div>
        <button onClick={onClose} aria-label="Close" className="p-1 rounded-md hover:bg-muted text-muted-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export default function Payroll() {
  useTranslation(); // keeps tr() reactive on language change
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = STAFF.find((s) => s.id === selectedId) || null;

  return (
    <div className="space-y-6">
      <style>{`@keyframes payroll-slide-in { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: none; } }`}</style>

      {/* Page header */}
      <div className="flex items-center gap-3">
        <div>
          <h2 className="text-2xl font-bold">{tr('Payroll', '薪資', '薪资')}</h2>
          <p className="text-muted-foreground mt-1">{tr('Sample payroll for demonstration.', '薪資演示樣本。', '薪资演示样本。')}</p>
        </div>
        <span className="ml-auto text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
          {tr('Demo data', '演示數據', '演示数据')}
        </span>
      </div>

      {/* One continuous card: staff list + extending detail region */}
      <div className="relative flex items-stretch bg-card border rounded-xl overflow-hidden" style={{ borderColor: 'hsl(var(--border))' }}>
        <div className="flex-1 min-w-0">
          {/* Column header */}
          <div className="grid grid-cols-[minmax(0,1fr)_90px_70px_90px_130px] gap-3 px-5 py-2.5 border-b text-[11px] uppercase tracking-wide text-muted-foreground font-semibold" style={{ borderColor: 'hsl(var(--border))' }}>
            <span>{tr('Staff', '員工', '员工')}</span>
            <span>{tr('Staff No.', '員工編號', '员工编号')}</span>
            <span>{tr('Gender', '性別', '性别')}</span>
            <span>{tr('Marital', '婚姻', '婚姻')}</span>
            <span className="text-right">{tr('Salary', '薪金', '薪金')}</span>
          </div>
          {/* Rows */}
          <div className="max-h-[560px] overflow-y-auto">
            {STAFF.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelectedId((prev) => (prev === s.id ? null : s.id))}
                className={cn(
                  'w-full grid grid-cols-[minmax(0,1fr)_90px_70px_90px_130px] gap-3 items-center px-5 py-3 text-left transition-colors border-b last:border-b-0',
                  'hover:bg-primary/5',
                  selectedId === s.id && 'bg-primary/5'
                )}
                style={{ borderColor: 'hsl(var(--border))' }}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-xs font-bold" style={{ background: 'hsl(var(--primary)/0.1)', color: 'hsl(var(--primary))' }}>
                    {s.name.split(' ').map((p) => p[0]).join('').slice(0, 2)}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold truncate">{tr(s.name, s.nameZh, s.nameCn)}</div>
                    <div className="text-xs text-muted-foreground truncate">{tr(s.title, s.titleZh, s.titleCn)}</div>
                  </div>
                </div>
                <span className="text-xs text-muted-foreground font-mono">{s.id}</span>
                <span className="text-xs text-muted-foreground">{tr(...GENDER_LABEL[s.gender])}</span>
                <span className="text-xs text-muted-foreground">{tr(...MARITAL_LABEL[s.maritalStatus])}</span>
                <span className="text-sm font-semibold font-mono text-right">{fmt(s.monthlySalary)}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Divider — fades in only when the detail is open (desktop) */}
        <div
          className={cn('hidden md:block w-px self-stretch transition-opacity duration-300', selected ? 'opacity-100' : 'opacity-0')}
          style={{ backgroundColor: 'hsl(var(--border))' }}
        />

        {/* Detail region — mobile: full-width overlay; md+: width extension */}
        <div
          className={cn(
            'absolute inset-y-0 right-0 z-20 w-full overflow-hidden transition-all duration-300 ease-out bg-card shadow-2xl',
            'md:static md:w-0 md:translate-x-0 md:z-auto md:shadow-none',
            selected ? 'translate-x-0 md:w-[480px]' : 'translate-x-full'
          )}
        >
          {selected && <DetailStub key={selected.id} staff={selected} onClose={() => setSelectedId(null)} />}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build — verify clean**

```powershell
Set-Location frontend; npm run build
```

Expected: `tsc -b && vite build` completes with no errors.

- [ ] **Step 3: Commit**

```powershell
Set-Location ..; git add frontend/src/pages/Payroll.tsx
git commit -m @'
feat(payroll): payroll page layout with extension animation

Co-Authored-By: Claude <noreply@anthropic.com>
'@
```

(Visual verification of the animation happens in Task 6 — the page is unreachable locally without the API for login, and the authoritative check is the Playwright spec against the deployed testing site.)

---

### Task 4: Detail panel content — summary, month table, accordion JE blocks

**Files:**
- Modify: `frontend/src/pages/Payroll.tsx`

**Interfaces:**
- Consumes: `MONTHS`, `STATUSES`, `COA_ACCOUNTS`, `buildMonthlyJe`, `MonthStatus` from Task 2; `computeMpf` from Task 1.
- Produces: `DetailPanel` replacing `DetailStub` (same props: `{ staff: SampleStaff; onClose: () => void }`).

- [ ] **Step 1: Update the imports**

Replace in `frontend/src/pages/Payroll.tsx`:

```tsx
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { tr } from '../lib/i18nHelpers';
import { cn } from '../lib/utils';
import { STAFF, type SampleStaff } from '../data/samplePayroll';
```

with:

```tsx
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, ChevronDown } from 'lucide-react';
import { tr } from '../lib/i18nHelpers';
import { cn } from '../lib/utils';
import { STAFF, MONTHS, STATUSES, COA_ACCOUNTS, buildMonthlyJe, type SampleStaff, type MonthStatus } from '../data/samplePayroll';
import { computeMpf } from '../lib/mpf';
```

- [ ] **Step 2: Replace `DetailStub` with the full detail components**

Delete the entire `DetailStub` function and in its place add these constants and components:

```tsx
const num = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2 });

const MONTH_LABELS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const STATUS_META: Record<MonthStatus, { cls: string; en: string; zh: string; cn: string }> = {
  paid: { cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400', en: 'Paid', zh: '已支付', cn: '已支付' },
  pending: { cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400', en: 'Pending', zh: '待支付', cn: '待支付' },
  scheduled: { cls: 'bg-gray-400/10 text-gray-500 dark:text-gray-400', en: 'Scheduled', zh: '已排程', cn: '已排程' },
};

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3" style={{ borderColor: 'hsl(var(--border))' }}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold font-mono mt-0.5">{value}</div>
    </div>
  );
}

function JeBlocks({ je }: { je: ReturnType<typeof buildMonthlyJe> }) {
  return (
    <div className="space-y-2">
      {[je.salary, je.mpf].map((b) => (
        <div key={b.id} className="rounded-lg border" style={{ borderColor: 'hsl(var(--border))' }}>
          <div className="px-3 py-1.5 border-b text-xs font-semibold" style={{ borderColor: 'hsl(var(--border))' }}>
            {tr(b.title, b.titleZh, b.titleCn)}
          </div>
          <div className="px-3 py-2 space-y-1.5">
            {b.lines
              .filter((l) => l.amount !== 0)
              .map((l, i) => {
                const acc = COA_ACCOUNTS[l.code];
                return (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className="w-7 shrink-0 font-semibold">{l.dr ? 'Dr' : 'Cr'}</span>
                    <span className="font-mono text-muted-foreground shrink-0">{acc.code}</span>
                    <span className="flex-1 min-w-0 truncate">{tr(acc.name, acc.nameZh, acc.nameCn)}</span>
                    <span className="font-mono shrink-0">{num(l.amount)}</span>
                  </div>
                );
              })}
            <div className="flex items-center gap-2 text-xs font-semibold border-t pt-1.5" style={{ borderColor: 'hsl(var(--border))' }}>
              <span className="w-7" />
              <span className="flex-1 text-muted-foreground">{tr('Total (Dr = Cr)', '合計（借 = 貸）', '合计（借 = 贷）')}</span>
              <span className="font-mono">{num(b.total)}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function MonthRow({ month, staff, open, onToggle }: { month: string; staff: SampleStaff; open: boolean; onToggle: () => void }) {
  const idx = MONTHS.indexOf(month);
  const status: MonthStatus = STATUSES[staff.id]?.[month] ?? 'scheduled';
  const meta = STATUS_META[status];
  const { employee, employer, net } = computeMpf(staff.monthlySalary);
  const je = buildMonthlyJe(staff);

  return (
    <div className="border-b last:border-b-0" style={{ borderColor: 'hsl(var(--border))' }}>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-1 px-3 py-2 hover:bg-primary/5 transition-colors text-left"
      >
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-300', open && 'rotate-180')} />
        <span className="text-xs font-medium w-14 shrink-0">{tr(`${MONTH_LABELS_EN[idx]} 2026`, `2026年${idx + 1}月`, `2026年${idx + 1}月`)}</span>
        <span className={cn('text-[9px] font-semibold px-1.5 py-0.5 rounded-full shrink-0', meta.cls)}>{tr(meta.en, meta.zh, meta.cn)}</span>
        <span className="flex-1" />
        <span className="w-16 text-right font-mono text-[11px]">{num(staff.monthlySalary)}</span>
        <span className="w-16 text-right font-mono text-[11px]">{num(employee)}</span>
        <span className="w-16 text-right font-mono text-[11px]">{num(employer)}</span>
        <span className="w-16 text-right font-mono text-[11px] font-medium">{num(net)}</span>
      </button>
      {/* Accordion — reveals the COA entries */}
      <div className={cn('overflow-hidden transition-all duration-300 ease-out', open ? 'max-h-[420px] opacity-100' : 'max-h-0 opacity-0')}>
        <div className="px-3 pb-3 pt-1">
          <JeBlocks je={je} />
        </div>
      </div>
    </div>
  );
}

function DetailPanel({ staff, onClose }: { staff: SampleStaff; onClose: () => void }) {
  const [openMonth, setOpenMonth] = useState<string | null>(null);
  const { employee, employer, net } = computeMpf(staff.monthlySalary);

  return (
    <div className="h-full flex flex-col animate-[payroll-slide-in_300ms_ease-out]">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b" style={{ borderColor: 'hsl(var(--border))' }}>
        <div className="min-w-0">
          <div className="font-semibold">{tr(staff.name, staff.nameZh, staff.nameCn)}</div>
          <div className="text-xs text-muted-foreground">{tr(staff.title, staff.titleZh, staff.titleCn)} · {staff.id}</div>
        </div>
        <button onClick={onClose} aria-label="Close" className="p-1 rounded-md hover:bg-muted text-muted-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        {/* Meta */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{tr('Gender', '性別', '性别')}: {tr(...GENDER_LABEL[staff.gender])}</span>
          <span>{tr('Marital Status', '婚姻狀況', '婚姻状况')}: {tr(...MARITAL_LABEL[staff.maritalStatus])}</span>
          <span>
            {tr('Monthly Salary', '月薪', '月薪')}:{' '}
            <span className="text-foreground font-semibold font-mono">{fmt(staff.monthlySalary)}</span>
          </span>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 gap-2">
          <SummaryCard label={tr('Gross Salary', '總薪金', '总薪金')} value={fmt(staff.monthlySalary)} />
          <SummaryCard label={tr('Employee MPF', '僱員強積金', '雇员强积金')} value={fmt(employee)} />
          <SummaryCard label={tr('Employer MPF', '僱主強積金', '雇主强积金')} value={fmt(employer)} />
          <SummaryCard label={tr('Net Pay', '實發薪金', '实发薪金')} value={fmt(net)} />
        </div>

        {/* Monthly table */}
        <div>
          <div className="text-sm font-semibold mb-2">{tr('Monthly Payment Status', '每月支付狀態', '每月支付状态')}</div>
          <div className="border rounded-lg overflow-hidden" style={{ borderColor: 'hsl(var(--border))' }}>
            <div className="flex items-center gap-1 px-3 py-1.5 border-b text-[9px] uppercase tracking-wide text-muted-foreground" style={{ borderColor: 'hsl(var(--border))' }}>
              <span className="pl-[18px] w-14 shrink-0">{tr('Month', '月份', '月份')}</span>
              <span className="w-14 shrink-0">{tr('Status', '狀態', '状态')}</span>
              <span className="flex-1" />
              <span className="w-16 text-right">{tr('Gross', '總額', '总额')}</span>
              <span className="w-16 text-right">{tr('EE MPF', '僱員MPF', '雇员MPF')}</span>
              <span className="w-16 text-right">{tr('ER MPF', '僱主MPF', '雇主MPF')}</span>
              <span className="w-16 text-right">{tr('Net', '實發', '实发')}</span>
            </div>
            {MONTHS.map((m) => (
              <MonthRow
                key={m}
                month={m}
                staff={staff}
                open={openMonth === m}
                onToggle={() => setOpenMonth((prev) => (prev === m ? null : m))}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
```

(Header-to-row column alignment is approximate by design — the badge width varies by locale; do not fight it.)

- [ ] **Step 3: Use `DetailPanel` in the page**

In the `Payroll` component, replace:

```tsx
          {selected && <DetailStub key={selected.id} staff={selected} onClose={() => setSelectedId(null)} />}
```

with:

```tsx
          {selected && <DetailPanel key={selected.id} staff={selected} onClose={() => setSelectedId(null)} />}
```

- [ ] **Step 4: Build — verify clean**

```powershell
Set-Location frontend; npm run build
```

Expected: no TypeScript or Vite errors.

- [ ] **Step 5: Commit**

```powershell
Set-Location ..; git add frontend/src/pages/Payroll.tsx
git commit -m @'
feat(payroll): detail panel with monthly COA entries

Co-Authored-By: Claude <noreply@anthropic.com>
'@
```

---

### Task 5: Wire the route

**Files:**
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: default-exported `Payroll` component from Task 3/4.

- [ ] **Step 1: Add the import**

In `frontend/src/App.tsx`, after `import PaymentPage from './pages/PaymentPage';` (line 45), add:

```tsx
import Payroll from './pages/Payroll';
```

- [ ] **Step 2: Swap the route**

Replace line 193:

```tsx
      <Route path="/payroll" element={<ProtectedRoute><StubPage title="Payroll" zhHant="薪資" zhHans="薪资" /></ProtectedRoute>} />
```

with:

```tsx
      <Route path="/payroll" element={<ProtectedRoute><Payroll /></ProtectedRoute>} />
```

(Do not remove the `StubPage` import — it is still used by `/mpf`, `/company/br`, `/company/ci` and the other stub routes.)

- [ ] **Step 3: Build — verify clean**

```powershell
Set-Location frontend; npm run build
```

Expected: no errors.

- [ ] **Step 4: Commit**

```powershell
Set-Location ..; git add frontend/src/App.tsx
git commit -m @'
feat(payroll): wire payroll page into the /payroll route

Co-Authored-By: Claude <noreply@anthropic.com>
'@
```

---

### Task 6: Playwright spec, deploy to testing site, verify, report

**Files:**
- Create: `tests/payroll-demo.spec.ts` (committed — follows house practice of committed Playwright specs)

**Interfaces:**
- Consumes: the deployed page at `/payroll` (login via the same credentials as `tests/regression-language-switch.spec.ts`).
- Produces: `playwright-report/payroll-demo.png` screenshot for human review.

- [ ] **Step 1: Write the spec (expect it to fail against the current deployment — the stub has no staff list)**

Create `tests/payroll-demo.spec.ts`:

```ts
import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.TEST_BASE_URL || 'https://opcc-crm-testing.pages.dev';
// Credentials proven in tests/regression-language-switch.spec.ts
const EMAIL = 'muhammadruhan.farhan25@gmail.com';
const PASSWORD = 'Ruhan123';

async function login(page: Page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 20000 });
}

test('payroll demo: list, extension, collapse, monthly COA entries', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/payroll`, { waitUntil: 'networkidle' });

  // 7 sample staff rows (row buttons carry the EMP-xxxx staff no.)
  const rows = page.locator('button', { hasText: /EMP-00/ });
  await expect(rows).toHaveCount(7);

  // Click a staff row → detail extends (names are locale-dependent, so match any)
  await rows.filter({ hasText: 'EMP-0001' }).click();
  await expect(page.getByText(/Chan Tai Man|陳大文|陈大文/).first()).toBeVisible();
  await expect(page.getByText(/Monthly Payment Status|每月支付狀態|每月支付状态/)).toBeVisible();

  // All 12 months render (first and last)
  await expect(page.getByText(/Jan 2026|2026年1月/).first()).toBeVisible();
  await expect(page.getByText(/Dec 2026|2026年12月/).first()).toBeVisible();

  // Expand January → both COA blocks with real codes
  await page.getByText(/Jan 2026|2026年1月/).first().click();
  await expect(page.getByText(/Salary Payment|薪金支付/)).toBeVisible();
  await expect(page.getByText(/MPF Remittance|強積金供款|强积金供款/)).toBeVisible();
  await expect(page.getByText('61201', { exact: true })).toBeVisible();
  await expect(page.getByText('21204', { exact: true }).first()).toBeVisible();

  // Screenshot for human review
  await page.screenshot({ path: 'playwright-report/payroll-demo.png', fullPage: true });

  // Collapse via close button
  await page.locator('button[aria-label="Close"]').click();
  await expect(page.getByText(/Monthly Payment Status|每月支付狀態|每月支付状态/)).toBeHidden();

  // Re-open via row click, then collapse by re-clicking the same row
  await rows.filter({ hasText: 'EMP-0001' }).click();
  await expect(page.getByText(/Monthly Payment Status|每月支付狀態|每月支付状态/)).toBeVisible();
  await rows.filter({ hasText: 'EMP-0001' }).click();
  await expect(page.getByText(/Monthly Payment Status|每月支付狀態|每月支付状态/)).toBeHidden();

  // Capped staff (45,000) shows the 1,500 MPF cap figures
  await rows.filter({ hasText: 'EMP-0001' }).click();
  await expect(page.getByText('1,500.00').first()).toBeVisible();
});
```

- [ ] **Step 2: Deploy the frontend to the testing site**

```powershell
Set-Location frontend; npm run deploy
```

Check the wrangler output for the deployed URL (house rule: after a `wrangler` deploy, always report the frontend testing URL). If the output doesn't show one, check memory `TeCS Deployment State` / `Post-Deploy Frontend URL` for the project URL.

- [ ] **Step 3: Run the spec against the deployed site**

```powershell
Set-Location ..; npx playwright test tests/payroll-demo.spec.ts
```

Expected: 1 passed. (If the deploy went to a URL other than `opcc-crm-testing.pages.dev`, re-run with `TEST_BASE_URL=<deployed-url> npx playwright test tests/payroll-demo.spec.ts`.)

- [ ] **Step 4: Commit the spec and push everything**

```powershell
git add tests/payroll-demo.spec.ts
git commit -m @'
test(payroll): add payroll demo Playwright spec

Co-Authored-By: Claude <noreply@anthropic.com>
'@
git push
```

- [ ] **Step 5: Report to the user**

Report: the deployed testing URL (e.g. `https://opcc-crm-testing.pages.dev/payroll`), the passing Playwright result, and the screenshot path `playwright-report/payroll-demo.png` for visual review. Also view the screenshot yourself and describe what it shows (extension open, month row expanded with both JE blocks).

---

## Verification checklist (final pass)

- [ ] `frontend`: `npm run build` clean (done in Tasks 3, 4, 5)
- [ ] `computeMpf` matches the 7-case regression table + boundary cases (Task 1 check)
- [ ] All 7 staff × 12 months JE blocks balance Dr = Cr (Task 2 check)
- [ ] Playwright spec passes against the deployed testing site (Task 6)
- [ ] All commits pushed to `main`; testing URL reported with screenshot
