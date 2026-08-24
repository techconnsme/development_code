# Multi-Invoice (1:N) Bank Transaction ↔ Invoice Matching — Design

**Date:** 2026-08-24
**Status:** Approved in review (chunks 1–3 signed off 2026-08-24)
**Related:** `docs/superpowers/specs/2026-08-22-bank-charge-auto-linking-design.md`, `Tech_Connect_SME/test-sample-real/LINKS_REPORT.txt` §4 (ground-truth audit), `regression-tests/REGRESSION_SUITE.md`

## 1. Problem

The bank↔invoice auto-matcher (`api/src/lib/bank-matcher.ts` + `POST /bank-statements/auto-match`) is strictly 1:1: every bank transaction is scored against individual invoice totals and returns one best invoice. Combined payments — one bank transaction settling several invoices — can never be linked correctly:

| Bank tx (PnR account) | Amount | Ground truth | Observed live behaviour (2026-08-24 Playwright run, tenant `u-83161e0c`) |
|---|---|---|---|
| 19 Sep 2025 PASTEL TECH | 57,580.80 | #001414 (15,300) + #001417v2 (42,280.80) | Suggested #001441 (40,050) low-confidence — wrong invoice, belongs to the 55,000 combo |
| 5 Nov 2025 PASTEL TECH | 55,000.00 | #001441 (40,050) + #001442 (14,950) | No suggestion at all — its candidate was consumed by the wrong match above |
| 5 Feb 2026 PASTEL TECH | 27,544.00 | #001458v2 (5,200) + #001467-v2 (4,150) + #001484-v2 (18,194) | Suggested #001500 (13,350) low-confidence — ruled-out coincidence |

All suggestions came from the counterparty-name tier; the exact-sum combination of invoices is never considered. The starvation cascade (wrong single consumes another combo's member) is the structural bug this design fixes.

## 2. Scope decisions (locked during brainstorming)

- **Staged pipeline with revised ordering:** narration / exact / near 1:1 tiers first → **exact-sum groups second** → name-tier singles **last**, on leftover invoices only (see §6).
- **Exact-sum only:** a group must sum to the tx amount within ±0.01. No fuzzy group sums.
- **Full re-scan semantics preserved:** every auto-match click rescans all unmatched txs against all unpaid invoices; already-confirmed matches are never torn apart or reused.
- **"Paid" = `invoices.status='paid'`** (+ `paid_date`); confirmed bank match writes it today and keeps doing so.
- **Show both alternatives:** if a tx has both a low-confidence 1:1 single and an exact-sum group, both appear as separate rows in the review modal.
- **Side-by-side PDFs for groups:** statement + every member invoice visible at once (N+1 panes).
- **Ship 1:N now; N:1 split payments are a fast-follow.** The junction schema below is direction-agnostic so N:1 needs **no new migration** — only detection, a `partially_paid` status, and UI. Per-member unlink and partial-payment state are explicitly out of scope this round.

## 3. Data model

One migration `api/src/db/migration-bank-transaction-invoice-links.sql` (+ `schema.sql` updated):

```sql
CREATE TABLE bank_transaction_invoice_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,   -- bank_transactions.id
  invoice_id TEXT NOT NULL,       -- invoices.id
  allocated_amount REAL NOT NULL, -- this invoice's slice of the tx
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_btil_tx ON bank_transaction_invoice_links(transaction_id);
CREATE INDEX idx_btil_inv ON bank_transaction_invoice_links(invoice_id);
```

Semantics:

- **1:1 matches keep using `bank_transactions.invoice_id` exactly as today** — zero behaviour change.
- A **group match** = `match_status='confirmed'` on the tx + N junction rows, with `tx.invoice_id` left NULL. Invariant: *NULL `invoice_id` on a confirmed tx = "it's a group, read the links"*.
- `allocated_amount` equals the invoice total this round (full settlement per member). The N:1 fast-follow reuses the same rows with `allocated_amount < total`.

## 4. Matching stage — `findInvoiceGroupMatch(tx, invoices, excludeIds)`

New pure function in `api/src/lib/bank-matcher.ts`, appended after the existing tier logic:

1. **Pool:** unpaid invoices, same currency, same counterparty name as resolved by the 1:1 tiers (supplier for AP withdrawals / customer for AR deposits), not in `excludeIds`. Fewer than 2 in the pool → no group.
2. **Narration fast-path:** if ≥ 2 invoice numbers from the pool appear in the tx narration/reference, return exactly those as a `high`-confidence group (no subset search). Never fires on current HSBC data; future-proofs banks that put references in narrations.
3. **Exact-sum search:** sort pool by total desc; enumerate subsets of size 2–4 whose sum equals the tx amount within ±0.01; prune branches once the running sum exceeds the tx amount; cap the pool per counterparty at ~30 invoices (bigger → skip grouping).
4. **Date gate (loose):** tx date ≥ (oldest member's issue date − 15d) and ≤ (newest member's due date + 120d). Validated against all three ground truths — e.g. #001414 issued 8 Jun, paid 19 Sep (~due+103d) passes; a strict due+45d window would reject that real case.
5. **Result:** `{ invoices, confidence: 'medium' ('high' via narration fast-path), reason: "Combined payment: 15,300.00 + 42,280.80 = 57,580.80" }`.

## 5. Pipeline ordering rule (anti-starvation)

Compute in this order:

1. Narration / exact / near 1:1 tiers (high & medium confidence singles)
2. Exact-sum groups (`findInvoiceGroupMatch`) over invoices not yet consumed
3. Name-tier singles **last**, using whatever invoices remain

A tx may therefore yield two suggestions (its group plus a name-tier single against a leftover invoice) or none-plus-one; **groups always win consumption conflicts** — a name-tier single may not take an invoice reserved by any group. This preserves "amount-based 1:1 before 1:N" while making groups findable; it directly removes the observed cascade where 57,580.80's wrong single starved 55,000.

## 6. Confirm endpoint — `PATCH /transactions/:id/match`

Gains optional body field `invoice_ids: string[]`. The existing `invoice_id` path is unchanged.

Group confirm validates everything **before writing anything**:

1. ≥ 2 ids; each invoice exists in tenant, not soft-deleted, status not `paid`/`cancelled`
2. Direction guard per invoice (withdrawal → AP incoming only; deposit → AR outgoing only)
3. Currency: every invoice == statement currency
4. Exact sum: |Σ invoice totals − tx amount| ≤ 0.02 (same constant as the existing single check)
5. Idempotency: already-confirmed tx → 409 ("unlink first"), as today

Writes run as one `db.batch()` (atomic in D1): tx → `match_status='confirmed'`, `match_confidence='manual'`, `invoice_id` stays NULL · insert N junction rows (`allocated_amount` = each invoice total) · each invoice → `status='paid'`, `paid_date = tx.transaction_date` · each invoice's file → `file_records.payment_status='matched'`.

## 7. GL payment entry — allocation lines in ONE journal entry

`postPaymentToGl` (`api/src/lib/post-payment.ts`) reads junction rows when `bt.invoice_id IS NULL AND bt.match_status='confirmed'`; otherwise falls back to today's single-invoice query — zero change for 1:1. Idempotency key unchanged (`reference_type='payment'`, `reference_id=txId`).

Line shape changes from one Dr/Cr pair to N contra lines + one bank line. AP example (55,000 = #001441 + #001442):

```
JE-PMT-MULTI-<txId8>            (groups; 1:1 keeps JE-PMT-<invoice_number>)
  Dr Trade Creditors   40,050   #001441
  Dr Trade Creditors   14,950   #001442
  Cr Bank              55,000
```

AR mirror: Dr Bank (total) / Cr Trade Debtors per-invoice slice. Each allocation line carries its own invoice number so ledger drill-down shows which slice settled which bill. The legacy `POST /bookkeeping/post-payment/:txId` route inherits the fix (same helper).

## 8. Unlink / reject — group-aware atomic revert

Unlink/reject reads junction rows for the tx; when present it reverts everything in one batch: delete all N link rows · un-pay all N invoices (`status='sent'`, guarded by current `='paid'`; `paid_date=NULL`) · reset their files to `payment_status='unmatched'` · delete the single payment JE · reset tx (`invoice_id=NULL`, `match_confidence=NULL`, `match_status='unmatched'`).

No per-member unlink this round (that machinery belongs to the N:1 follow-up); the UI offers whole-group unlink only.

**Known parity note:** soft-deleting an invoice that sits inside a confirmed group behaves exactly like the 1:1 case today (payment JE tombstoned via `tombstoneInvoiceJournal`, link rows left in place). No new logic.

## 9. API response & UI

### Auto-match response

Group suggestions are separate entries alongside singles (never merged into them):

```json
{ "transaction_id": "…", "invoice_ids": ["a","b"],
  "invoices": [{"invoice_number":"#001414","total":15300,"file_id":"f1"},
               {"invoice_number":"#001417v2","total":42280.80,"file_id":"f2"}],
  "amount": 57580.80, "confidence": "medium",
  "reason": "Combined payment: 15,300.00 + 42,280.80 = 57,580.80",
  "direction": "withdrawal→AP", "stmt_file_id": "…" }
```

Singles keep today's shape (`invoice_id`, singular fields) byte-for-byte.

### Review modal (`frontend/src/components/AutoMatchReviewModal.tsx`, additive)

- Group row header: `COMBINED` badge beside the confidence chip; invoice numbers joined (`#001414 + #001417v2`); sum breakdown in `reason`.
- Expanded pane: statement PDF left + N labelled invoice panes right; invoice panes get `min-width` inside a horizontally scrollable flex row so 3-invoice groups stay readable at the fixed height. Same always-mounted iframe technique as today.
- Row Confirm sends the group; Reject unchanged (`txId` only).
- Alternatives resolve themselves: pending-row filtering keys on `transaction_id`, so confirming either of a tx's two rows auto-dismisses the other.

### Wiring

`onConfirm` grows an optional third arg `(txId, invoiceId, invoiceIds?)`. The shared confirm helper sends `{action:'confirm', invoice_ids}` when present, else today's `{action:'confirm', invoice_id}`. Four call sites pass through: `BankStatements.tsx`, `AP.tsx`, `AR.tsx`, `FileStorage.tsx`. Pages that never receive groups behave identically to today.

## 10. Error handling

- All-or-nothing confirm: any validation failure → no writes; specific 400/409 messages mirroring today's wording (direction/currency/already-paid/sum mismatch/already-confirmed).
- Group confirm failure surfaces in the modal exactly as single failures do today (row stays pending; parent surfaces error toast).
- Unlink of a tx with no junction rows takes the existing 1:1 path.

## 11. Testing

Unit (`tests/bank-matcher.test.ts` extension):
- Three ground truths return correct groups (57,580.80 → {15,300 + 42,280.80}; 55,000 → {40,050 + 14,950}; 27,544 → {5,200 + 4,150 + 18,194}) — asserted to fail (no groups) before implementation, pass after (TDD).
- Anti-starvation: with all six invoices unpaid, 57,580.80's group forms and #001441 remains available for the 55,000 group; the wrong name-tier single is not chosen for either tx.
- Narration fast-path returns the referenced pair at `high` without subset search.
- Date-gate boundaries: issue−15d accepted, due+120d accepted (incl. the #001414 due+103d real case), beyond rejected.
- ±0.01 rule: sum off by 0.02 → no group.

Endpoint:
- Group confirm happy path → tx confirmed, N links written, N invoices paid, files matched, JE has N+1 lines with per-invoice amounts.
- Sum mismatch (off by > 0.02) → 409, nothing written; already-paid member → 409; direction violation → 400; currency mismatch → 409.
- Unlink after group confirm → full revert verified (links gone, invoices `sent`, JE deleted, tx unmatched).
- 1:1 regression: existing confirm/unlink tests unchanged and green.

Live verification: rerun `tests/auto-link-onetomany.spec.ts` (`SKIP_UPLOAD=1`) against tenant `u-83161e0c` (7 component invoices live; 3 combined txs unmatched) — expect the three combined amounts suggested with 2–3 `invoice_ids` each; update `REGRESSION_SUITE.md` multi-invoice section accordingly.

## 12. Out of scope (fast-follow, no migration required)

- N:1 split payments (VEII 2025006 pattern): symmetric detection stage, `partially_paid` status, partial JEs, per-slice unlink.
- Manual group assembly UI (hand-picking invoices into a group).
- Per-member unlink of a confirmed group.
- Regenerating `LINKS_REPORT.xlsx`.
