# File Storage — Relative Upload Time Display

**Date:** 2026-08-13
**Status:** Approved (Approach B)

## Problem

The File Storage page (`frontend/src/pages/FileStorage.tsx`) shows each document's upload date in its folder-tree row, but:

1. It shows **date only** — no time of upload.
2. It displays the **raw UTC string** from the database (`created_at.slice(0, 10)`), which is off by up to a day for Hong Kong evening uploads.

The user wants each document to show its upload **date and time** as a **relative time** (e.g. "2 hours ago"), with the full timestamp available on hover.

## Decision

**Approach B — `Intl.RelativeTimeFormat`** (browser-native localization).

- Relative strings ("2 hours ago" / "2 小時前" / "2小时前") and pluralization come free from `Intl.RelativeTimeFormat` — no hand-maintained translation matrix.
- Locale mapping: `en` → `en`, `zh-Hant` → `zh-HK`, `zh-Hans` → `zh-CN`.
- Older files (≥ 7 days) keep a plain date, but converted to local time.
- No backend change — the API already returns `created_at` on every file record.

## Components

### 1. Pure helper — `frontend/src/lib/time.ts` (new)

```ts
export type RelativeBucket =
  | { kind: 'relative'; unit: 'second' | 'minute' | 'hour' | 'day'; value: number }
  | { kind: 'date'; date: string }      // ≥ 7 days old: local YYYY-MM-DD
  | { kind: 'invalid'; raw: string };   // unparseable — caller renders raw

export function relativeTimeBucket(createdAt: string, now: Date = new Date()): RelativeBucket
```

- Parses `created_at` as **UTC**: `"2026-08-13 09:32:42"` → `"2026-08-13T09:32:42Z"` (space → `T`, append `Z`).
- `diff = now - parsed`, `Math.floor` on each unit boundary.
- Buckets: `< 60s` → seconds · `< 60m` → minutes · `< 24h` → hours · `< 7d` → days · else → date kind.
- Parse failure → `{ kind: 'invalid', raw: createdAt }`.
- `now` is injectable for deterministic tests.

### 2. UI — `frontend/src/pages/FileStorage.tsx` (line ~159)

Replace the subline span `{f.created_at?.slice(0, 10)}` with:

- **relative kind**: `<Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-value, unit)>` — e.g. "2 hours ago", "2 小時前", "2小时前".
- **date kind**: local `YYYY-MM-DD`.
- **invalid kind**: the raw string as today.
- **Tooltip** (`title`): full local timestamp in the Audit Log style — `toLocaleString('en-HK', { hour12: false })` → e.g. `13/8/2026, 17:32:05`.
- Locale comes from `i18n.language`; the component already subscribes via `useTranslation()`, so the text re-renders on language toggle.

## Error handling

- Invalid/unparseable `created_at` → render raw value (never crash).
- Missing `created_at` → render nothing (same as today).

## Testing (TDD)

1. **Unit-style** — `tests/relative-time.spec.ts` imports `relativeTimeBucket` directly and asserts with fixed `now` values:
   - UTC parsing: `created "2026-08-13 23:30:00", now 2026-08-14 00:30 UTC` → 1 hour.
   - Boundaries: 59s → seconds; 60s → 1 minute; 23h59m → hours; 24h → 1 day; 7d → date kind.
   - `invalid` kind for garbage input.
   - No browser needed — deterministic.
2. **E2E smoke** — extend an upload flow test: fresh upload → File Storage row shows "seconds ago" / "秒前" (en runs) within seconds of upload.
3. RED first against a missing helper, GREEN after implementation.

## Deploy

- Build → `wrangler pages deploy dist --project-name=opcc-crm-testing --branch=main`.
- Report both URLs (frontend + API) after deploy, per standing instruction.

## Out of scope

- Other pages' timestamp formats (Audit Log, Chatbot) stay as-is.
- No changes to the API or database.
- No "seen on" tracking — relative time is computed from `created_at` only.
