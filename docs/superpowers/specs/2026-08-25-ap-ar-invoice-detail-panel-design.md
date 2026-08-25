# Inline Invoice Detail Expansion for AP & AR — Design

**Date:** 2026-08-25
**Status:** Approved in review (2026-08-25)
**Related:** `docs/superpowers/specs/2026-08-24-multi-invoice-bank-matching-design.md` (junction table this panel reads), `api/src/lib/post-payment.ts` (payment JE creation), `frontend/src/pages/BankStatements.tsx` (the pattern being mirrored)

## 1. Problem

The bank statements page lets a user click a transaction row to expand an inline detail view (date, description, voucher no., Cr/Dr accounts). The AP and AR invoice lists have no equivalent: the eye-icon modal shows invoice fields and line items, but not the full picture — which bank transaction settled it, with what payment voucher number, or how it posted to the GL.

## 2. Scope decisions (locked during brainstorming)

- **Inline expansion, not a new route/modal**: clicking an invoice row slides open a detail panel beneath it (`SlideOpen`, same pattern as bank statements). The eye-icon PDF modal stays untouched.
- **View-only linked transactions** — rows in the panel are status chips with confirm/unlink actions, mirroring the bank page's non-navigating badge. No cross-navigation to the Bank Statements page.
- **Shared component** so AP and AR render identical panels; trivially reusable on the `/invoices` general page later (out of scope now).
- **No schema changes.** Everything needed already exists: `bank_transactions.invoice_id` (1:1), `bank_transaction_invoice_links` (group payments, live since 2026-08-24), `journal_entries`/`journal_lines`.

## 3. UX

Clicking an invoice row expands three sections:

1. **Line items** — description, qty, unit price, amount, total (from `invoice_items`; already displayed in the eye modal, repeated here so the panel is self-contained).
2. **Linked bank transactions** — one row per settling transaction: date · description · bank · amount · allocated amount (group slices only) · link type (`direct` / `group`) · match-confidence badge · payment voucher no. Each row carries:
   - green badge when `match_status='confirmed'`, yellow when `'suggested'`;
   - ✕ Unlink for confirmed rows; ✓ Confirm + ✕ for suggested rows — same endpoints as `BankStatements.tsx`.
   - Empty state: "No linked bank transactions".
3. **GL postings** — each **live** journal entry touching the invoice:
   - invoice leg (`reference_type='invoice'`) and payment leg (`reference_type='payment'` via its linked bank transaction), showing entry no. (`JE-INV-*` / `JE-PMT-*`), date, and Dr/Cr lines as account-code + name badges styled like the bank statements page;
   - "Not yet posted to GL" note when no live entries exist.

Row-click toggles expansion; action buttons inside the row (eye/edit/download/delete) do not trigger it. Bilingual labels via `tr()`.

## 4. Backend — extend `GET /invoices/:id`

Handler today (`api/src/routes/invoices.ts:111-122`) returns `{...invoice, items}` only. Two arrays are added to the same response, so the panel and the eye modal consume one payload:

### 4.1 `linked_transactions[]`

Union of both link paths, soft-deleted transactions excluded (`bt.deleted_at IS NULL`):

```sql
-- 1:1 direct links
SELECT bt.id, bt.transaction_date, bt.description, bs.bank_name,
       bt.amount, NULL AS allocated_amount,
       bt.invoice_id, bt.match_status, bt.match_confidence, 'direct' AS link_type
FROM bank_transactions bt
LEFT JOIN bank_statements bs ON bt.statement_id = bs.id
WHERE bt.invoice_id = ? AND bt.user_id = ? AND bt.deleted_at IS NULL
UNION ALL
-- group-payment links (1:N junction)
SELECT bt.id, bt.transaction_date, bt.description, bs.bank_name,
       bt.amount, btil.allocated_amount,
       bt.invoice_id, bt.match_status, bt.match_confidence, 'group' AS link_type
FROM bank_transaction_invoice_links btil
JOIN bank_transactions bt ON btil.transaction_id = bt.id
LEFT JOIN bank_statements bs ON bt.statement_id = bs.id
WHERE btil.invoice_id = ? AND bt.user_id = ? AND bt.deleted_at IS NULL
```

Payment voucher no. is derived per row from the payment JE (§4.2), matched by `entry.reference_id = tx.id`. Exact statement/transaction column names follow `bank-statements.ts:1138-1153` at implementation time.

### 4.2 `journal_entries[]`

Live entries only — filtered with the house convention `jeLive()` = `deleted_at IS NULL` (`api/src/lib/journal-filters.ts:45`):

- **Invoice leg:** `reference_type='invoice' AND reference_id=<invoice id>`
- **Payment leg:** `reference_type='payment' AND reference_id IN (<linked tx ids>)`

Each entry embeds nested `lines[]` from `journal_lines` (`account_code`, `account_name`, `debit`, `credit`, ordered by `sort_order`). Account name is denormalized on the line — no join needed.

## 5. Frontend

| Unit | Responsibility |
|---|---|
| `frontend/src/components/InvoiceDetailPanel.tsx` (new) | Renders the 3 sections from the `GET /invoices/:id` payload. Pure display + confirm/unlink mutations. Props: `invoiceId`. Uses query key `['invoice', invoiceId]`; if the eye modal's existing fetch uses a different key, align them during implementation so there is a single cached payload per invoice. |
| `frontend/src/pages/AP.tsx` | Adds `expandedId` state; row `<tr>` (:260) gets guarded onClick toggle; expansion rendered as a full-width second `<tr>` wrapping `<SlideOpen><InvoiceDetailPanel/></SlideOpen>`. |
| `frontend/src/pages/AR.tsx` | Identical wiring on its `<tr>` (:261); must not break the existing `?highlight=` deep-link effect (:153-175). |

`SlideOpen` (`frontend/src/components/SlideOpen.tsx`) takes `{open, duration?, className?, children}` — used as-is. Guard pattern: row onClick checks `(e.target as HTMLElement).closest('button,a')` before toggling.

## 6. Error handling / empty states

- Invoice fetch failure or 404 → existing toast path unchanged; panel simply isn't rendered.
- Unpopulated data renders explicit empty states ("No linked bank transactions", "Not yet posted to GL") — never blank space.
- Unlink/confirm reuse the bank page's endpoints, so their error handling and invalidations match `BankStatements.tsx` exactly.

## 7. Out of scope

- Editing postings from this view (view-only).
- The `/invoices` general page and receipts pages.
- N:1 split-payment semantics (`partially_paid` state) — the panel already shows `allocated_amount` per row, so it displays correctly if/when that fast-follow lands.
- Cross-navigation between invoice panel ↔ Bank Statements page.

## 8. Testing

Per house convention (no unit-test framework):

1. API typecheck stays at the established 24-error baseline.
2. Frontend build clean (`tsc` + `vite build`).
3. Playwright spec against the test deployment: expand an AP row and an AR row → line items, linked bank tx (incl. a group-payment slice with `allocated_amount`), and voucher numbers visible; confirm/unlink actions work from the panel.
4. Manual check on a paid invoice: both JE legs visible with correct Dr/Cr badges; unposted invoice shows the "Not yet posted to GL" note.
