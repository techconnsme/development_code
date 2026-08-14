# Invoice Channel Split — Sales/Purchase Invoice + Cash Payment Rename

**Date:** 2026-08-13
**Status:** Approved

## Problem

The File Upload page has a `Bank-TXN Invoice` channel and a `Cash Invoice` channel. Product wants:

1. `Bank-TXN Invoice` split into **Sales Invoice** and **Purchase Invoice**, each carrying direction semantics (sales = outgoing, purchase = incoming), with wrong-document detection showing the respective detected name.
2. `Cash Invoice` renamed to **Cash Payment** — wording only, no behavior change.

## Requirements

### 1. Channels (`frontend/src/pages/FileUpload.tsx`)

| Channel | Key | Direction | Behavior |
|---|---|---|---|
| Sales Invoice 銷售發票 / 销售发票 | `sales_invoice` | forces `outgoing` | new |
| Purchase Invoice 採購發票 / 采购发票 | `purchase_invoice` | forces `incoming` | new |
| Cash Payment 現金付款 / 现金付款 | `cash_invoice` (key unchanged) | none | label rename only; identical to today's Cash Invoice |

Folder stays `Invoices` for all three. The old `bank_invoice` key is removed (frontend-only key — no API/DB references exist).

### 2. Wrong-document detection (direction-based)

After import, when the channel is `sales_invoice` or `purchase_invoice` and the OCR result has a `direction` that contradicts the channel's direction:

- Show the existing mismatch dialog: *uploaded as "Sales Invoice" but OCR detected "Purchase Invoice"* (detected label = the opposing invoice channel), with the OCR inferred-values table.
- **Switch** → accept OCR's direction; navigate to the review page as today.
- **Force** → re-import the document with the chosen direction (see API change below), then proceed as today's force path does.
- **Cancel** → existing rollback (DELETE `/file-storage/{id}`).
- If the result has no `direction` → no dialog (today's lenient invoice behavior).

`cash_invoice` keeps today's lenient behavior (any invoice detection is compatible, no dialog).

### 3. API: direction override on import (`api/src/routes/file-storage.ts`)

- `POST /file-storage/:id/import-document` accepts an optional `direction` query param (`outgoing` | `incoming`), valid only for invoice imports; ignored otherwise.
- `importInvoiceFromFile` uses the override when present (instead of the detected direction) and treats the direction as user-declared (`needs_direction_review` not raised for it).
- No DB migration — `invoices.direction` already exists.

### 4. Regression tests (`regression-tests/`)

- Update every `Bank-TXN Invoice` reference: samples named `INV_OUT_*` → **Sales Invoice**; `BILL_IN_*` → **Purchase Invoice**.
- New spec `regression-tests/regression-invoice-direction.spec.ts`:
  1. Upload a purchase-direction invoice sample with **Sales Invoice** selected → assert the mismatch dialog appears and shows "Purchase Invoice" as the detected name.
  2. **Cancel** → assert the file was rolled back (not in `/api/file-storage`).

## Out of scope

- Any behavior change to Cash Payment beyond its label.
- InvoiceReview page changes.
- File Storage list changes (it already displays direction badges).

## Testing

- TDD: the new regression spec runs RED first against the current deployment (no Sales Invoice tab exists), then GREEN after implementation + deploy.
- After implementation: build + deploy Pages (`opcc-crm-testing`), run the `regression-tests/` suite, debug failures to green.

## Deploy

- Same as standing: `cd frontend && export CLOUDFLARE_ACCOUNT_ID=8c00cc4647a9cf5d8deb5d6a354001e0 && npm run build && npx wrangler pages deploy dist --project-name=opcc-crm-testing --branch=main`
- API change requires `cd api && ... npx wrangler deploy` as well.
- Report both URLs after deploy.
