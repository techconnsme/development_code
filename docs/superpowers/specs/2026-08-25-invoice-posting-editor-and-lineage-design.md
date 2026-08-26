# Invoice Posting Editor + Entry-Flow Lineage Map — Design

**Date:** 2026-08-25
**Status:** Approved in review (2026-08-25)
**Related:** `docs/superpowers/specs/2026-08-25-ap-ar-invoice-detail-panel-design.md` (the panel this extends), `api/src/lib/post-invoice.ts`, `api/src/lib/post-payment.ts`, `api/src/lib/bank-journal.ts` (`replaceTransactionPosting` — the pattern being mirrored)

## 1. Problem

Invoice GL classification is effectively frozen and mostly wrong-by-default:

- AP bills debit `66203 Miscellaneous Expenses` unless they match one of three hardcoded categories (`post-invoice.ts:70-76`); AR revenue is always hardcoded `41101` (`post-invoice.ts:104`).
- The trade ("holding") side is always `11201`/`21101` — a director-funded bill cannot be tracked through Director's Current Account.
- Editing a posted invoice leaves its JE stale (no re-post path exists anywhere).
- Nothing shows the money story: which bank transaction settled an invoice and how the two journal entries meet at the holding account.

## 2. Scope decisions (locked during brainstorming)

- **Both account sides editable**: label side (revenue/expense) AND holding side (trade debtor/creditor or any balance-sheet account), per invoice, full-total single pair (no splits).
- **Architecture A — JE-as-source-of-truth:** no schema changes; editing rewrites the invoice-leg JE; payment legs *read* the holding account from the invoice's live JE so propagation is structural, never synced.
- **Editor lives in the detail panel** (GL postings section), not the review page or bookkeeping page.
- **Lineage map, not event history:** a visual Entry 1 → Entry 2 flow (user explicitly chose lineage over the audit-log timeline). Shown on **both** sides: invoice panel + bank statement expansion.
- View-only lineage (no navigation), consistent with the panel's established philosophy.
- **Out of scope:** split/multi-line postings per invoice, editing unposted invoices, per-line-item accounts, bulk reclassification, audit-log timeline UI.

## 3. Feature A — Posting editor

### 3.1 Pair invariant & resolution rule

An invoice's live JE always has exactly one label line and one holding line, each for `invoices.total`. Roles are identified by **account type**, not position:

- holding line = the line whose `accounts.account_type` ∈ (`asset`, `liability`)
- label line = the line whose `accounts.account_type` ∈ (`revenue`, `expense`)

The editor enforces this shape, so downstream resolution never sees ambiguity.

### 3.2 Backend — `PUT /invoices/:id/posting`

Body: `{ label_account_code, holding_account_code }` or `{ reset_to_auto: true }`.

Validation (order matters, all 4xx with specific messages):

1. Invoice exists for tenant, soft-delete clean, has a **live** invoice JE (`reference_type='invoice'`, `deleted_at IS NULL`) — otherwise 409 "not posted yet".
2. Both codes exist as **leaf** accounts (reuse `findParentAccountError` convention).
3. Family check: label code is revenue/expense; holding code is asset/liability; codes differ.
4. Open accounting period for the JE date (same guard as `bookkeeping.ts` POST /entries).
5. If holding code differs from current: every parent statement of **confirmed** paying transactions must be `active` (not reconciled) — else 409 mirroring the bank page's reconciled-statement rule (`bank-statements.ts:1203`).

Action:

1. Resolve current holding code from the live JE (§3.1).
2. Tombstone the live invoice JE; insert a fresh one carrying a **new** `JE-INV-*` entry number — numeric `-R2`, `-R3`… suffix on the base number, required because `UNIQUE(user_id, entry_number)` holds even for tombstoned rows — with `entry_source='manual'`, `reference_type='invoice'`, `reference_id=invoice.id`. This mirrors `replaceTransactionPosting` (`bank-journal.ts:209-299`).
3. **Propagation** — if holding changed: for every confirmed transaction paying this invoice (direct `bt.invoice_id` or junction `bank_transaction_invoice_links`): rebuild that transaction's live payment JE. Direct matches rebuilt wholesale; **group** payments rebuilt with each member contributing its own current holding code (this requires extracting the line-building from `post-payment.ts` into a shared builder that takes per-member holding codes). Skip nothing silently — transactions whose statements are reconciled would have failed validation in step 5.
4. Audit-log the edit (house convention: `auditLog(db, user.id, 'update_posting', 'invoice', id, {from,to})`).
5. Respond with the same payload shape as `GET /invoices/:id` (panel refreshes in place).

`reset_to_auto`: tombstone the manual JE, re-run `postInvoiceToGl()` (standard classification), then run step 3 if the restored holding differs.

### 3.3 `post-payment.ts` — read holding from the invoice

Replace hardcoded `11201`/`21101` with per-invoice resolution: the paying invoice's live invoice-JE holding line (§3.1 rule); fall back to today's defaults when no live JE exists. Group path resolves **per member**. Consequence: future confirms automatically use whatever holding account the invoice currently carries — propagation without sync logic.

### 3.4 Frontend — editor in the GL postings section

- Pencil button in the section header → static lines become an inline editor: two leaf-account dropdowns (grouped COA tree, `filterLeafAccounts`, same select pattern as `TxPostingPanel`), labelled plainly: *"What kind of income / expense"* (label) and *"Where the debt / claim is tracked"* (holding). Amount fixed at invoice total; balance indicator always ✓.
- Save → `PUT .../posting`; invalidate `['invoice', id]`, `['invoices-ap']`, `['invoices-ar']`, `['invoices']`, `['entries']`, `['bank-statements']`.
- **Reset to auto** button visible only when the live JE has `entry_source === 'manual'` (TxPostingPanel precedent).
- Errors toast with server messages (409s included).

## 4. Feature B — Entry-flow lineage map

### 4.1 Invoice side (in the detail panel)

New display component `LineageMap.tsx` rendered at the top of the GL postings section. Pure visualization from data already in the `GET /invoices/:id` payload (one addition, §4.3):

```
ENTRY 1 — recorded                 ENTRY 2 — settled
┌──────────────────────┐          ┌───────────────────────────┐
│ #001414 · 15,300     │          │ ECQ 102872 · HSBC · 04 Feb│
│ Cr 41101 Prof Svc    │          │ JE-PMT-001414             │
│ Dr 11201 ◄────────┐  │          │ Dr 11201 ►┐               │
└──────────────────────┘  │   ┌──────┴───────────────────────┐
                          └──►│ 11201 Trade Debtors (pivot) │  ← shown once
   (group: N slices fan in,      └──────┬───────────────────────┘
    each with allocated amt)            │ more Step-2 cards as needed
```

- **Entry 1 card:** invoice number/total, its label line, `JE-INV-*` number.
- **Pivot badge:** the shared holding account, once.
- **Entry 2 cards:** each linked transaction (date · description · amount · allocated slice for groups) with its payment JE number and Dr/Cr lines; matched to transactions via `journal_entries.reference_type='payment'` + `reference_id`.
- Holding lines highlighted on both sides so a post-editor mismatch would be visually obvious.
- No clicks, no navigation.

### 4.2 Bank side ("Settles" strip)

In the expanded transaction row on Bank Statements, above the posting area: compact strip *"Settles: #001414 (15,300) · JE-PMT-…"* — one chip per linked invoice; group matches list all members with allocated amounts. Requires one backend addition (§4.3). Hidden entirely for unmatched transactions.

### 4.3 Backend additions (read-only)

1. `GET /invoices/:id`: attach `account_type` to each `journal_entries[].lines` element (join `accounts` on `account_code` + tenant) — powers §3.1-style role detection and pivot highlighting client-side.
2. `GET /bank-statements/:id`: for each transaction, include `linked_invoices[]` covering both paths (direct join already partially present; add junction members with `invoice_number`, `allocated_amount`) plus the live payment-JE `entry_number` per transaction.

No writes, no new endpoints beyond the editor's PUT.

## 5. Error handling / empty states

- Editor: unposted invoice → Edit button hidden (nothing to rewrite); 409s surface verbatim in toasts; invalid picks blocked client-side too (leaf filter + family labels).
- Lineage: unposted invoice → Entry 1 card shows "Not yet posted to GL", pivot hidden, Entry 2 cards still list linked transactions; unmatched tx on bank side → strip hidden.
- Regeneration failures during propagation abort the whole request (transactional semantics per statement: tombstone+insert within one D1 batch where possible; on failure return error, original state intact because tombstone+insert are batched).

## 6. Testing

House convention (no unit framework):

1. API typecheck stays at the **43-error pre-existing baseline**, none in touched files.
2. Frontend build clean.
3. Playwright, **non-mutating**: editor opens on a posted invoice; picking a parent (non-leaf) account surfaces the validation error; Cancel restores; lineage map renders on a known paid PnR invoice; "Settles" strip renders on a known matched transaction.
4. Manual checks (fixtures, shared DB — same waiver rationale as the panel feature): director-bill scenario end-to-end (edit holding → Director's Current Account → confirm bank payment → payment JE uses Director's account); reset-to-auto restores defaults; group-payment slice shows correct allocated amounts in lineage after a holding edit on one member.

## 7. Revision 2 (2026-08-25, approved in review): UX restructure - minimal inline + Audit Trail popup

User feedback after live review: the inline lineage duplicated the GL card for unpaid invoices and buried the story. This revision supersedes the PLACEMENT parts of section 3.4 (editor moves out of the panel) and section 4 (lineage moves into the popup). Backend sections 3.2/3.3/4.3 remain in force unchanged.

### 7.1 Inline AP/AR panel (simplified)

- GL postings section renders ONLY the invoice's own Dr/Cr pair (its live invoice JE = Entry 1), static. LineageMap and the inline editor are removed from the panel.
- Line items + linked bank transactions sections unchanged.
- New Audit Trail action on each AP/AR invoice row (actions cell, link icon) opens the popup (7.2) with that invoice as context.

### 7.2 Audit Trail popup (AuditTrailModal.tsx)

One modal, two entry points: AP/AR invoice rows, and Bank Statements expanded transaction rows (button beside the settles strip). Contents:

1. Chain - Bank Statement -> Transaction(s) -> Invoice(s) -> Receipt(s) with per-hop status: bank match (confirmed / suggested / unmatched, group slices with allocated amounts); receipt link (linked / not linked - the receipt system is binary, no richer status exists). Group payments fan out to N invoice chains under one transaction.
2. GL legs - the Entry 1 -> pivot -> Entry 2 flow: the existing LineageMap component, mounted in the modal (Not-yet-posted / Entry-1-only states preserved for unpaid invoices).
3. Edit posting - the editor (label/holding dropdowns, Save / Cancel / Reset-to-auto, cascade via the existing PUT /invoices/:id/posting) moves into the modal, targeting the invoice in context. For a transaction with multiple invoices, each invoice chain segment exposes its own editor.

Data strategy (no new endpoints beyond 7.3): the modal receives either { invoiceId } or { txContext, invoiceIds[] }; it fetches GET /invoices/:id per invoice (React Query cache shared with the panel) for legs, linked transactions (incl. bank names), and the new linked_receipt.

### 7.3 Backend addition (small)

GET /invoices/:id payload gains linked_receipt: { id, invoice_number, total, issue_date } | null - resolves linked_invoice_id when it points at a receipt row (receipt_number IS NOT NULL OR invoice_number LIKE 'REC-%', soft-delete clean). Read-only; everything else reuses shipped backend.

### 7.4 Testing (delta)

- Playwright updates: lineage testids now live inside the modal (open via the new action button); inline GL shows a single pair; editor assertions move to modal context; settles-strip test extended to open the popup from the bank side.
- Manual checks unchanged (director scenario + group slice), executed through the popup.
