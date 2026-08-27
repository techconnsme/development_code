# Task 7 Report: api() error payload + DocumentPickerModal

## What I Implemented

### Part 1: `api()` error payload
Modified `frontend/src/lib/api.ts` to attach the parsed JSON error body to thrown errors. The `!res.ok` branch now creates an error object with `e.body = err`, allowing callers to access the full server response (e.g., `error_code`, `similar_entries`).

### Part 2: DocumentPickerModal
Created `frontend/src/components/DocumentPickerModal.tsx` with:
- Fetches files from `GET /file-storage` via `api()` helper
- Client-side search (by filename/description) and type category filter
- Multi-select checkboxes with **10-attachment cap** (disabled at cap, "Max 10" note in footer)
- Preview pane using iframe (`WORKER_API_BASE/file-storage/{id}/download?inline=1`)
- Files already attached (`alreadyPicked`) shown as disabled + amber "attached" badge
- Named export `PickedFile { id: string; filename: string }`
- Bilingual UI (English/Traditional Chinese/Simplified Chinese) via `tr()`

## What I Tested

- `npm run build` (tsc + vite) — clean, no errors
- Manual review of both files against the plan spec

## Files Changed

| File | Change |
|------|--------|
| `frontend/src/lib/api.ts` | Added `e.body = err` to error branch (line 65-70) |
| `frontend/src/components/DocumentPickerModal.tsx` | New file (116 lines) |

## Self-Review Findings

1. **Cap enforcement missing in initial implementation** — The plan's code didn't enforce the 10-attachment cap in the `toggle` function. Fixed by adding `MAX_ATTACHMENTS = 10`, capping in `toggle`, disabling checkboxes at cap, and showing count + "Max 10" in footer.

2. **No other concerns** — Build passes, code follows existing modal patterns (MatchSuggestionsModal, etc.), and the component exports match what Task 8 expects.

## Commit

`1515053` — `feat(frontend): api() error body + document picker modal`
