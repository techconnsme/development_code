# Payroll Demo Page — Design Spec

**Date:** 2026-08-20
**Status:** Approved (user review pending)
**Scope:** Demo-only, frontend-only. Replaces the `/payroll` stub page.

## Goal

A payroll subpage for Tech Connect SME showing a sample staff list. Clicking a staff member extends an animated detail region on the right (within the same card surface) showing that staff's monthly salary payment status, full payslip figures (gross / employee MPF / employer MPF / net), and the corresponding HK COA debit/credit entries for each month. Demo-only: all data is a hardcoded frontend sample; nothing is posted to the GL.

## Out of scope

- Backend API, D1 tables, or any persistence
- The separate `/mpf` stub page (untouched)
- Real payroll runs, posting journal entries to the GL
- Feature-flag gating (the `/payroll` route already works for all tenants)

## Current state

- `frontend/src/App.tsx:193` — `/payroll` routes to `StubPage title="Payroll" zhHant="薪資" zhHans="薪资"`
- `frontend/src/components/Layout.tsx:46` — sidebar already has a "Payroll" entry
- House stack: React + TypeScript + Vite + Tailwind, react-router, `tr()` trilingual helper (en / zh-Hant / zh-Hans), shadcn-style theme vars, lucide-react icons

## Files

| Action | File | Purpose |
|---|---|---|
| NEW | `frontend/src/lib/mpf.ts` | Pure `computeMpf(gross)` — no React imports |
| NEW | `frontend/src/data/samplePayroll.ts` | Sample staff + 12-month status data + per-staff salary account |
| NEW | `frontend/src/pages/Payroll.tsx` | The page (internal components: list, detail region, month row, JE blocks) |
| MOD | `frontend/src/App.tsx` | One-line swap: `StubPage` → `Payroll` at `/payroll` |

No backend changes. No new npm dependencies.

## Data model

### `samplePayroll.ts`

```ts
export interface SampleStaff {
  id: string;            // e.g. 'EMP-0001'
  name: string;          // en name
  nameZh: string;        // 中文名, for tr() display
  title: string;         // en job title
  titleZh: string;
  gender: 'M' | 'F';
  maritalStatus: 'single' | 'married';
  monthlySalary: number; // HKD gross
  salaryAccount: string; // COA debit code, default '61201'
}

export type MonthStatus = 'paid' | 'pending' | 'scheduled';

export interface SamplePayrollData {
  staff: SampleStaff[];
  months: string[];              // ['2026-01' … '2026-12']
  statuses: Record<string, Record<string, MonthStatus>>; // staffId → month → status
}
```

### Staff roster (7 fictional sample people, chosen to exercise every MPF rule)

| Staff No. | Name | Title | Gender | Marital | Salary | Rule exercised |
|---|---|---|---|---|---|---|
| EMP-0001 | Chan Tai Man | Senior Developer | M | married | 45,000 | Above cap → 1,500 |
| EMP-0002 | Lee Siu Ming | Accountant | F | single | 28,000 | Normal 5% band |
| EMP-0003 | Wong Ka Yan | Marketing Executive | F | married | 22,500 | Normal 5% band |
| EMP-0004 | Ng Man Wai | Office Assistant | M | single | 9,500 | Normal band, near minimum |
| EMP-0005 | Cheung Mei Ling | Part-time Clerk | F | married | 6,000 | Below min → ee MPF = 0, er still 5% |
| EMP-0006 | Ho Chi Wai | Director | M | married | 60,000 | Capped; debits `61102` 管理層薪金 |
| EMP-0007 | Tam Siu Fung | Project Consultant | M | single | 35,000 | Capped; debits `51201` 項目人員薪酬 |

Salary debit accounts: EMP-0006 → `61102`, EMP-0007 → `51201`, all others → `61201`.

### Month statuses (pre-baked)

- 2026-01 … 2026-07 → `paid`
- 2026-08 → `pending`
- 2026-09 … 2026-12 → `scheduled`

## MPF calculation — `mpf.ts`

```ts
export interface MpfResult { employee: number; employer: number; net: number; }
export function computeMpf(grossMonthly: number): MpfResult;
```

Current in-force HK rules (verified 2026-08-20):

- Both sides 5% of relevant income.
- Minimum relevant income HK$7,100/month: below it, **employee** contribution = 0; **employer** still pays 5%.
- Maximum relevant income HK$30,000/month: caps each side at **HK$1,500/month**.
- The proposed HK$40,000 / HK$2,000 cap is under consultation, not in force — do not use it.
- Rounding: `Math.round` to whole HKD. Net = gross − employee MPF.

**Expected outputs (regression table):**

| Gross | Employee | Employer | Net |
|---|---|---|---|
| 6,000 | 0 | 300 | 6,000 |
| 9,500 | 475 | 475 | 9,025 |
| 22,500 | 1,125 | 1,125 | 21,375 |
| 28,000 | 1,400 | 1,400 | 26,600 |
| 35,000 | 1,500 | 1,500 | 33,500 |
| 45,000 | 1,500 | 1,500 | 43,500 |
| 60,000 | 1,500 | 1,500 | 58,500 |

Sources: [PAT CPA — MPF 供款 2025/26 上下限 (2026 updated)](https://patcpa.com.hk/blog/%e3%80%90mpf%e4%be%9b%e6%ac%be%e3%80%91%e5%bc%b7%e7%a9%8d%e9%87%91%e4%be%9b%e6%ac%be%e5%b8%b8%e8%a6%8b%e7%96%91%e5%95%8f%ef%bc%9a%e5%b9%be%e5%a4%9a%e9%8c%a2%e8%a6%81%e4%be%9bmpf%ef%bc%9f/), [mpf.hk — 供款上限擬分階段調高](https://mpf.hk/mpf-contribution-to-be-increased-in-stages/)

## UI spec

### Layout — one continuous card

- Page header: `tr('Payroll', '薪資', '薪资')` + subtitle, plus a small **"Demo data"** chip so nobody mistakes it for live payroll.
- Below it, **a single card surface** containing two regions:
  - **Left:** staff list (name, job title, staff no., gender, marital status, salary). Selected row highlighted.
  - **Right:** the detail region — the **same card surface**, blank when nothing is selected. No placeholder, no muted box. A thin vertical divider between the two regions fades in only when the detail is open.
- Empty state on load: full-width list, right region blank. **No pre-selection.**

### Animation

- On selecting a staff row: detail region animates width `0 → ~480px` (`transition-[width]`, 300ms ease-out); content slides in (`translate-x-8 → 0`) and fades in simultaneously. The staff list flexes narrower at the same rate — reads as the card physically extending.
- Switching staff: panel stays open; content crossfades (fade + 8px slide, keyed on staff id).
- Collapse: ✕ button in the detail header **and** clicking the already-selected row again (toggle). Collapse reverses the animation, restoring the full-width list.
- Month rows: accordion (chevron; smooth max-height + opacity transition) expanding to reveal the COA entry.
- Responsive: below ~768px the detail region becomes a full-width overlay sliding in from the right instead of squeezing the list.

### Detail region content

1. Header: name, job title, staff no., gender, marital status, monthly salary. ✕ close.
2. Summary row of 4 cards: **Gross**, **Employee MPF**, **Employer MPF**, **Net pay** — the staff's monthly figures (constant across all 12 months, since salary is fixed in the sample data).
3. Monthly table Jan–Dec 2026: Month | Status badge | Gross | Employee MPF | Employer MPF | Net.
   - Status colors: paid → green, pending → amber, scheduled → grey.
4. Expanding a month row reveals the COA debit/credit entry, rendered **inside the expanded row**.

### i18n

Every visible label via `tr()` with en / zh-Hant / zh-Hans, matching existing pages. Statuses, months, and JE block titles are all translated.

## COA debit/credit display

Expanding a month row shows **two balanced JE blocks**, with account codes taken from the app's real HK COA (`api/src/db/coa-hk.sql`):

**Block 1 — Salary payment (payday to staff)** — balances: gross = net + employee MPF

| Dr/Cr | Code | Account | Amount |
|---|---|---|---|
| Dr | `{salaryAccount}` | e.g. 員工薪金 Staff Salaries | gross |
| Cr | 11102 | 匯豐銀行 HSBC | net |
| Cr | 21204 | 應付強積金 MPF Payable | employee MPF |

**Block 2 — MPF remittance (to trustee)** — balances: employee + employer = total remitted

| Dr/Cr | Code | Account | Amount |
|---|---|---|---|
| Dr | 61202 | 強積金僱主供款 MPF Employer Contribution | employer MPF |
| Dr | 21204 | 應付強積金 MPF Payable | employee MPF |
| Cr | 11102 | 匯豐銀行 HSBC | employee + employer MPF |

Account names shown bilingually (en + 中文), as in the COA file. Every block shows a Dr = Cr total row.

## Error handling

Static data — no fetch/loading/error states. `computeMpf` is defensive: clamps negative input to 0, rounds to whole HKD. Sample data is assumed valid.

## Verification plan (no test framework exists in this repo)

1. `computeMpf` checked against the regression table above (7 cases) — throwaway node check during implementation, not committed.
2. Every JE block Dr = Cr for all 7 staff × 12 months — throwaway node check, not committed.
3. `npm run build` (frontend) clean.
4. Visual pass via running the app: click each staff (extension animation), switch staff (crossfade), collapse (✕ and row re-click), expand month rows (accordion), check status colors, check responsive overlay, check all three locales render.

## Follow-ups (explicitly deferred)

- Interactive demo (mark-paid actions)
- Dynamic COA lookup from the tenant's live chart via `/coa`
- Real backend (D1 tables, API, posting payroll entries to the GL)
- Building out the `/mpf` stub
