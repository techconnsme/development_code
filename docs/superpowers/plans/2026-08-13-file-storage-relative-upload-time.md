# File Storage — Relative Upload Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each File Storage document's upload time as a localized relative string ("2 hours ago" / "2 小時前" / "2小时前") with the full local timestamp on hover.

**Architecture:** A pure, `now`-injectable helper `relativeTimeBucket()` parses the API's UTC `created_at` and returns a discriminated union (relative unit+value / local date / invalid). The FileStorage folder-tree row renders it via `Intl.RelativeTimeFormat` with a locale mapped from `i18n.language`. No backend change — `created_at` is already returned by `GET /file-storage`.

**Tech Stack:** TypeScript, React, react-i18next, `Intl.RelativeTimeFormat`, Playwright (`./tests`).

## Global Constraints

- All user-facing strings must be trilingual (en / zh-Hant / zh-Hans) — here handled natively by `Intl.RelativeTimeFormat` with locale map `{ en: 'en', 'zh-Hant': 'zh-HK', 'zh-Hans': 'zh-CN' }`.
- TDD: every behavior change gets a failing test first; run it and watch it fail before implementing.
- Playwright config: `testDir: ./tests`, `baseURL` = `TEST_BASE_URL || https://opcc-crm-testing.pages.dev`, 1 worker, per-test timeout 300s. E2E tests run against the **deployed** Pages app.
- Deploy: `cd frontend && export CLOUDFLARE_ACCOUNT_ID=8c00cc4647a9cf5d8deb5d6a354001e0 && npm run build && npx wrangler pages deploy dist --project-name=opcc-crm-testing --branch=main`.
- After any deploy, report both URLs: new Pages URL + `https://opcc-crm-api.ruhan-farhan.workers.dev`.
- Commit steps below are pending the user's go-ahead on commits.

---

### Task 1: Pure helper `relativeTimeBucket` + deterministic tests

**Files:**
- Create: `frontend/src/lib/time.ts`
- Test: `tests/relative-time.spec.ts` (pure Node tests, no browser fixture)

**Interfaces:**
- Produces:
  ```ts
  export type RelativeBucket =
    | { kind: 'relative'; unit: 'second' | 'minute' | 'hour' | 'day'; value: number }
    | { kind: 'date'; date: string }      // ≥ 7 days old: local YYYY-MM-DD
    | { kind: 'invalid'; raw: string };   // unparseable — caller renders raw

  export function relativeTimeBucket(createdAt: string, now?: Date): RelativeBucket;
  export function parseCreatedAt(createdAt: string): Date | null;
  ```
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

Create `tests/relative-time.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { relativeTimeBucket, parseCreatedAt } from '../frontend/src/lib/time';

test.describe('relativeTimeBucket', () => {
  const NOW = new Date('2026-08-14T00:30:00Z');

  test('parses DB UTC string and computes hours across midnight', () => {
    // created 23:30 UTC Aug 13, now 00:30 UTC Aug 14 → 1 hour
    expect(relativeTimeBucket('2026-08-13 23:30:00', NOW))
      .toEqual({ kind: 'relative', unit: 'hour', value: 1 });
  });

  test('59 seconds stays in seconds; 60 seconds becomes 1 minute', () => {
    expect(relativeTimeBucket('2026-08-14 00:29:01', NOW))
      .toEqual({ kind: 'relative', unit: 'second', value: 59 });
    expect(relativeTimeBucket('2026-08-14 00:29:00', NOW))
      .toEqual({ kind: 'relative', unit: 'minute', value: 1 });
  });

  test('23h59m is hours; 24h becomes 1 day', () => {
    const yesterday = new Date('2026-08-13T00:30:00Z');
    expect(relativeTimeBucket('2026-08-13 00:30:00', NOW))
      .toEqual({ kind: 'relative', unit: 'day', value: 1 });
    expect(relativeTimeBucket('2026-08-14 00:29:00', new Date('2026-08-15T00:28:59Z')))
      .toEqual({ kind: 'relative', unit: 'hour', value: 23 });
  });

  test('7 days or older returns local date', () => {
    expect(relativeTimeBucket('2026-08-07 00:00:00', NOW))
      .toEqual({ kind: 'date', date: '2026-08-07' });
  });

  test('unparseable input returns invalid with raw value', () => {
    expect(relativeTimeBucket('not-a-date', NOW))
      .toEqual({ kind: 'invalid', raw: 'not-a-date' });
  });

  test('parseCreatedAt converts space-separated UTC to Date', () => {
    expect(parseCreatedAt('2026-08-13 09:32:42')?.toISOString())
      .toBe('2026-08-13T09:32:42.000Z');
    expect(parseCreatedAt('garbage')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/Users/samue/Documents/Pastel/Tech_Connect_SME/Development_code/latest_code && npx playwright test tests/relative-time.spec.ts`
Expected: FAIL — module `../frontend/src/lib/time` cannot be resolved / exports undefined.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/lib/time.ts`:

```ts
export type RelativeBucket =
  | { kind: 'relative'; unit: 'second' | 'minute' | 'hour' | 'day'; value: number }
  | { kind: 'date'; date: string }
  | { kind: 'invalid'; raw: string };

/** Parse the DB's UTC "YYYY-MM-DD HH:MM:SS" into a Date (null if unparseable). */
export function parseCreatedAt(createdAt: string): Date | null {
  const iso = createdAt.includes('Z') ? createdAt : `${createdAt.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** Classify upload age for relative display. `now` injectable for tests. */
export function relativeTimeBucket(createdAt: string, now: Date = new Date()): RelativeBucket {
  const parsed = parseCreatedAt(createdAt);
  if (!parsed) return { kind: 'invalid', raw: createdAt };

  const diffMs = now.getTime() - parsed.getTime();
  if (diffMs < 0) {
    // Clock skew — treat as just uploaded
    return { kind: 'relative', unit: 'second', value: 0 };
  }
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return { kind: 'relative', unit: 'second', value: seconds };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { kind: 'relative', unit: 'minute', value: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { kind: 'relative', unit: 'hour', value: hours };
  const days = Math.floor(hours / 24);
  if (days < 7) return { kind: 'relative', unit: 'day', value: days };

  const y = parsed.getFullYear();
  const m = String(parsed.getMonth() + 1).padStart(2, '0');
  const d = String(parsed.getDate()).padStart(2, '0');
  return { kind: 'date', date: `${y}-${m}-${d}` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx playwright test tests/relative-time.spec.ts`
Expected: PASS (7 tests, no browser needed).

- [ ] **Step 5: Commit (pending user OK)**

```bash
git add frontend/src/lib/time.ts tests/relative-time.spec.ts
git commit -m "feat: relativeTimeBucket helper for File Storage upload times"
```

---

### Task 2: Render relative time in File Storage + e2e smoke

**Files:**
- Modify: `frontend/src/pages/FileStorage.tsx` (subline at ~line 157-159, imports at top)
- Test: `tests/file-storage-relative-time.spec.ts`

**Interfaces:**
- Consumes: `relativeTimeBucket`, `parseCreatedAt` from `../frontend/src/lib/time` (Task 1).
- Produces: `FileTimeLabel` component (local to FileStorage.tsx) rendering the relative string + tooltip.

- [ ] **Step 1: Write the failing e2e test**

Create `tests/file-storage-relative-time.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

const BASE = process.env.TEST_BASE_URL || 'https://opcc-crm-testing.pages.dev';
const LOGIN_EMAIL = process.env.TEST_EMAIL || 'muhammadruhan.farhan25@nixorcollege.edu.pk';
const LOGIN_PASSWORD = process.env.TEST_PASSWORD || 'password';
const SAMPLES = process.env.TEST_SAMPLES_DIR || 'C:/Users/samue/Documents/Pastel/Tech_Connect_SME/test-samples-generated-demo-company';

async function login(page: any) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', LOGIN_EMAIL);
  await page.fill('input[type="password"]', LOGIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 30000 });
  await page.evaluate(() => {
    localStorage.removeItem('activeClient');
    localStorage.setItem('i18nextLng', 'en'); // deterministic English selectors
  });
}

test('TC-TIME-01: fresh upload shows relative time in File Storage', async ({ page }) => {
  const uniqueName = `TIME_TEST_${Date.now()}.pdf`;
  const tmpPath = path.join(os.tmpdir(), uniqueName);
  fs.copyFileSync(path.join(SAMPLES, 'BANK_HSBC_BusinessDirect_2026-08_Aug.pdf'), tmpPath);

  try {
    await login(page);
    await page.goto(`${BASE}/file-upload`);
    await expect(page.locator('h2').filter({ hasText: 'File Upload' }).first()).toBeVisible({ timeout: 10000 });

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(tmpPath);
    await page.getByText('Upload & Analyze').click();

    // Wait for OCR/import to finish (page navigates away to /bank-statements)
    await page.waitForFunction(() => !window.location.href.includes('/file-upload'), { timeout: 240000 });

    await page.goto(`${BASE}/file-storage`);
    // Expand the "Bank Statements" folder in the tree (folder button shows a file count)
    await page.locator('button').filter({ hasText: 'Bank Statements (' }).first().click();

    // The fresh upload's row must show a relative age, not a bare date
    const row = page.locator('div').filter({ hasText: uniqueName }).first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await expect(row).toContainText(/ago|now/, { timeout: 15000 });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test tests/file-storage-relative-time.spec.ts`
Expected: FAIL — the row shows the bare date `2026-08-13` (current deployed app), which matches neither `ago` nor `now`.

- [ ] **Step 3: Implement the UI change**

In `frontend/src/pages/FileStorage.tsx`:

Add imports (top of file, alongside existing imports):
```ts
import i18n from '../i18n';
import { relativeTimeBucket, parseCreatedAt } from '../lib/time';
```

Add the locale map + label component above `function FolderTree`:
```ts
const RELATIVE_LOCALE: Record<string, string> = { en: 'en', 'zh-Hant': 'zh-HK', 'zh-Hans': 'zh-CN' };

function FileTimeLabel({ createdAt }: { createdAt: string }) {
  const parsed = parseCreatedAt(createdAt);
  if (!parsed) return <span>{createdAt}</span>;

  const bucket = relativeTimeBucket(createdAt);
  const locale = RELATIVE_LOCALE[i18n.language] || 'en';
  const text = bucket.kind === 'date'
    ? bucket.date
    : new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-bucket.value, bucket.unit);
  const full = parsed.toLocaleString('en-HK', { hour12: false });

  return <span title={full}>{text}</span>;
}
```

Replace the date span inside the file-row subline (currently `frontend/src/pages/FileStorage.tsx` ~line 159):
```tsx
<span>{f.created_at?.slice(0, 10)}</span>
```
with:
```tsx
{f.created_at && <FileTimeLabel createdAt={f.created_at} />}
```

- [ ] **Step 4: Build and deploy**

Run: `cd frontend && export CLOUDFLARE_ACCOUNT_ID=8c00cc4647a9cf5d8deb5d6a354001e0 && npm run build && npx wrangler pages deploy dist --project-name=opcc-crm-testing --branch=main`
Expected: build succeeds (tsc + vite), deployment URL printed.

- [ ] **Step 5: Run e2e test to verify it passes**

Run: `npx playwright test tests/file-storage-relative-time.spec.ts`
Expected: PASS — fresh upload row shows "X seconds ago" / "1 minute ago" / "now".

- [ ] **Step 6: Re-run Task 1 tests (no regression)**

Run: `npx playwright test tests/relative-time.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit (pending user OK)**

```bash
git add frontend/src/pages/FileStorage.tsx tests/file-storage-relative-time.spec.ts
git commit -m "feat: relative upload time in File Storage list"
```

---

## Self-Review Notes

- Spec coverage: UTC parsing ✅ (Task 1), buckets ✅ (Task 1), date fallback ≥7d ✅ (Task 1), invalid fallback ✅ (Task 1 + FileTimeLabel guard), tooltip full timestamp ✅ (Task 2 Step 3), language reactivity via FolderTree's existing `useTranslation()` re-render ✅, deploy + both URLs ✅ (Global Constraints + Task 2 Steps 4-5).
- Placeholder scan: none.
- Type consistency: `RelativeBucket`, `relativeTimeBucket(createdAt, now?)`, `parseCreatedAt(createdAt)` signatures match across tasks; `FileTimeLabel` consumes both as specified.
