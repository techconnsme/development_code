# File Upload → Always File Storage + Per-File Status Badges in File Storage

**Date:** 2026-08-20
**Status:** Approved

## Problem

1. After uploading files on the File Upload page, the system redirects users to bookkeeping subpages (`/bank-statements`, `/card-statements`, `/invoices`, `/expense-receipts`) or to review pages (`/bank-statements/review/:id`, `/invoices/review/:id`, etc.). Product wants uploads to always land on **File Storage** instead.
2. File Storage currently shows only a few status hints per file (payment status for invoices, an "Edited" flag, an "Encrypted" badge). Product wants each uploaded document to show its **status** — a summary badge plus the underlying record's status.

## Requirements

### 1. Uploads always land on File Storage (`frontend/src/pages/FileUpload.tsx`)

- Remove all navigation to review pages and bookkeeping subpages after upload:
  - The inline `nav(...)` calls in `uploadFile()` that go to `/bank-statements/review/:id`, `/card-statements/review/:id`, `/invoices/review/:id`.
  - The `reviewCount > 0` branch in `handleUpload()` that navigates to the first queued review page (`FileUpload.tsx:581-602`).
  - The `defaultRoute` logic (`FileUpload.tsx:609-613`) — replaced by a single unconditional `nav('/file-storage')`.
- Treat every upload like the existing batch flow: `uploadFile()` is always called with `skipNavigation = true`, so any file that needs review is pushed into the session review queue (`sessionStorage.reviewQueue`) instead of being navigated to directly. This applies to the mismatch-dialog "switch" path and the channel-based review routing too.
- `handleUpload()` no longer branches on `reviewCount`. It always finishes by calling `nav('/file-storage')` (after the success toast). Files that need review are reported in the success toast and appear under the File Storage queue banner.
- Result: after upload, the user always lands on `/file-storage`. The existing amber "📋 N file(s) queued for review" banner on File Storage (`FileStorage.tsx:858-883`) becomes the entry point to review anything that needs it.
- Keep all other File Upload behavior unchanged (mismatch dialog, encrypted-PDF modal, duplicate handling, petty-cash auto-entry, token usage, toasts).

### 2. Per-file status badges in File Storage (`frontend/src/pages/FileStorage.tsx`)

The backend list endpoint (`GET /file-storage`) already returns everything needed — `ocr_status`, `invoice_status`, `invoice_needs_review`, `stmt_status`, `card_status`, `statement_id`, `card_statement_id`, `invoice_id` (`api/src/routes/file-storage.ts:2019-2032`). No backend/API change required.

For each file row in the folder tree, add two badges:

**Summary badge** (derived, priority order):

| Condition | Badge (color) |
|---|---|
| `ocr_status` = `encrypted` | 🔒 Encrypted (amber) — keep existing clickable unlock |
| `ocr_status` = `processing` or `pending` | Processing (blue) |
| `ocr_status` = `failed` or `unclear` | Could not read (red) |
| linked invoice with `invoice_needs_review` or `invoice_status` = `pending_review` | Needs Review (amber) |
| linked statement with `stmt_status` = `draft` or `pending_review`; linked card with `card_status` = `draft` | Needs Review (amber) |
| linked record exists and otherwise clean | Processed (green) |
| no linked record | Stored (gray) |

**Underlying record badge** (secondary, small): the linked record's status, e.g. invoice `draft` / `pending_review` / `active` / `sent` / `paid`, bank statement `draft` / `pending_review` / `active`, card statement `draft` / `active`. Omitted when no linked record.

Existing badges (payment status, "Edited", Sales/Purchase direction toggle) stay unchanged. Existing labels are trilingual (English / Traditional Chinese / Simplified Chinese); new badges follow the same `tr()` pattern.

## Out of scope

- Any change to File Storage's own inline upload flow (uploads initiated from the File Storage page itself keep today's behavior).
- Backend changes (no DB migration, no API changes).
- Review page changes.

## Testing

- Frontend build must pass (`cd frontend && npm run build`).
- Manual QA path: upload a single clean invoice → lands on File Storage with "Processed" badge; upload a file with OCR mismatch → lands on File Storage with "Needs Review" badge + queue banner; upload an encrypted PDF → "Encrypted" badge; upload an unsupported/blurry file → "Could not read" badge.
- If a Playwright regression suite exists for the upload flow, update affected navigation assertions (see `regression-tests/`).

## Deploy

- Pages deploy only (no API change): `cd frontend && export CLOUDFLARE_ACCOUNT_ID=8c00cc4647a9cf5d8deb5d6a354001e0 && npm run build && npx wrangler pages deploy dist --project-name=opcc-crm-testing --branch=main`