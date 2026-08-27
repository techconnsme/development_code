# File Upload: merge Cash Payment into Others — Design

Date: 2026-08-27
Status: Approved (design dialogue completed in session)
Scope: frontend only — `frontend/src/pages/FileUpload.tsx` + Playwright specs

## 1. Problem

The File Upload page (`/file-upload`) exposes 7 channel tabs. The OCR/import
backend only ever detects 3 document types (`bank_statement`, `card_statement`,
`invoice`) — the remaining tabs are pure intent declarations layered on one
shared pipeline. In particular:

- **Cash Payment** tab creates no upload-time journal entry. It skips the
  mismatch dialog when OCR detects an invoice and routes straight to
  `/invoices/review/:id`; the Cr/Dr (Dr expense / Cr Trade Creditors, via
  Expense Category on the review page → `postInvoiceToGl`) happens at review
  confirm like any other AP bill.
- **Others** tab saves the file with no special routing; a mismatch dialog
  ("detected as Invoice") still offers Switch/Force/Cancel, which keeps the
  invoice-review path reachable.

Users rarely need Cash Payment as a distinct entry point.

## 2. Decisions (from design dialogue)

1. Merge **Cash Payment into Others**; drop the Cash Payment tab.
2. **Petty Cash keeps its own tab unchanged**, including its instant JE
   (Dr 67001 Petty Cash Expenses / Cr 11101 Cash on Hand).
3. New label wording — EN: `Others (Receipts, Cash Payments etc.)`,
   繁: `其他（收據、現金付款等）`, 简: `其他（收据、现金付款等）`
   (full-tab label variant chosen over helper-text under the tabs;
   Petty Cash deliberately not listed since it has its own tab).
4. Merged Others behaves exactly like today's Others (save-only routing,
   mismatch safety net). No attempt to auto-skip the dialog for invoices.
5. **No backend changes.**

## 3. UI after change

Tab strip (6 tabs, default remains Bank Statement):

```
Bank Statement | Card Statement | Sales Invoice | Purchase Invoice | Petty Cash | Others (Receipts, Cash Payments etc.)
```

- The long label scrolls horizontally within the existing
  `overflow-x-auto whitespace-nowrap` tab row — same mechanism other tabs use.
- The amber hint "(will auto-create expense under Petty Cash)" on the Petty
  Cash tab is untouched.

## 4. Code touchpoints

All in `frontend/src/pages/FileUpload.tsx`:

| Location | Change |
|---|---|
| L16 | Remove `'cash_invoice'` from the `UploadChannel` union |
| L33 | Delete the `cash_invoice` ChannelDef entry |
| L35 | Rename others labels to the §2 wording (folder `Others`, category `general` stay) |
| L352 | `isInvoiceChannel`: drop `|| channel === 'cash_invoice'` |
| L402 | `forcedType` ternary already reduces to sales/purchase once cash_invoice is gone from the union — verify no leftover reference |
| L436 | Routing condition becomes `(channel === 'sales_invoice' || channel === 'purchase_invoice') && result?.invoice_id` |

Compile-time guarantee: TypeScript flags any missed `cash_invoice` reference
because the union type narrows.

## 5. Behavior matrix after merge

| Upload under | OCR detects | Outcome |
|---|---|---|
| Others (merged) | invoice/receipt | Mismatch dialog → user may *Switch* → `/invoices/review/:id` → Cr/Dr posted at confirm (old Cash Payment path preserved through the dialog) |
| Others (merged) | bank/card statement | Dialog → switch routes to respective review page |
| Others (merged) | anything / none | File saved, land on File Storage |

Known pre-existing quirk, explicitly out of scope: forcing "as Others"
still re-runs server-side type scoring because `forcedType='others'` is not
in the backend whitelist (api/src/routes/file-storage.ts:3614).

## 6. Out of scope

- Expenses page tabs (Receipts | Petty Cash | Others) and their forms.
- Backend import pipeline, GL posting, folders of historical files.
- Expenses → Petty Cash form (unaffected alternative for petty-cash booking).

## 7. Testing (TDD per AGENTS.md)

1. **RED** — extend `tests/upload-channels.spec.ts` with DOM-only assertions
   against the tab strip: exactly six channel tabs, no `/^Cash Payment$/`
   button, merged label visible. Run against current build → must fail.
2. **GREEN** — apply §4 edits until green.
3. Update `tests/TEST_PLAN.md` TC-UC-06 wording if it names the old label.
4. Regression guard: rerun `tests/upload-channels.spec.ts` and
   `tests/expenses-tabs.spec.ts` (the latter guards the untouched Expenses
   page naming overlap).
5. Live credentials/samples: pnr-context test account and sample-document
   directories; Playwright tests accept `TEST_BASE_URL`/`TEST_EMAIL`/
   `TEST_PASSWORD` env overrides.

No unit-test runner exists for the frontend (no vitest/jest config) —
Playwright is the project's test convention, so TDD uses Playwright specs.
