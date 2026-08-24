# Regression Test Suite — PNR Sample Documents

## Quick Start

```bash
# 1. Reset test data + run API verification
npx tsx tests/run-regression-api.ts

# 2. Run browser UI verification
npx playwright test tests/regression-full-flow.spec.ts --headed

# 3. View results in this document (update ⬜ → ✅/❌ after each run)
```

## Setup

| Item | Value |
|------|-------|
| Test user | `joseph.lin@pnr.hk` (PNR Company) |
| Admin (for reset) | `memonruhan731@gmail.com` / `Hamdan123` |
| API base | `https://opcc-crm-api.ruhan-farhan.workers.dev/api` |
| Frontend base | `https://main.opcc-crm.pages.dev` |
| Samples dir | `../../test-sample-real/PNR/` |

**Before each run:**
```bash
curl -X POST https://opcc-crm-api.ruhan-farhan.workers.dev/api/admin/hard-reset-data \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"u-83161e0c"}'
```

---

## Bank Statements

Source: `test-sample-real/PNR/estatement/`

| File | Bank | Account | Period | Txn Count | Opening | Closing | API | UI |
|------|------|---------|--------|-----------|---------|---------|-----|----|
| `eStatement 20250228.pdf` | HSBC | 126-310175-503327 | 2025-02-01 → 2025-02-28 | ≥1 | ≠0 | ≠0 | ⬜ | ⬜ |
| `eStatement 20250128.pdf` | HSBC | 126-310175-503327 | 2025-01-01 → 2025-01-28 | ≥1 | — | — | ⬜ | ⬜ |
| `eStatement 20250331.pdf` | HSBC | 126-310175-503327 | 2025-03-01 → 2025-03-31 | ≥1 | — | — | ⬜ | ⬜ |

---

## AP Invoices (Incoming — bills PNR received)

| File | Direction | Vendor | Invoice # | Total | API | UI |
|------|-----------|--------|-----------|-------|-----|----|
| `Pastel/01383 - invoice#001397.pdf` | incoming (AP) | Pastel Tech | ≠null | >0 | ⬜ | ⬜ |
| `Pastel/01383 - invoice#001414.pdf` | incoming (AP) | Pastel Tech | ≠null | >0 | ⬜ | ⬜ |
| `Pastel/01383 - invoice#001547-v3.pdf` | incoming (AP) | Pastel Tech | ≠null | >0 | ⬜ | ⬜ |
| `Muselab/INV022-1319 @$500...pdf` | incoming (AP) | MuseLabs | ≠null | >0 | ⬜ | ⬜ |
| `Respect/I0105 Proficiency And Reliance.pdf` | incoming (AP) | Respect | ≠null | >0 | ⬜ | ⬜ |

---

## AR Invoices (Outgoing — bills PNR issued)

| File | Direction | Customer | Invoice # | Total | API | UI |
|------|-----------|----------|-----------|-------|-----|----|
| `VEII/Invoice 2025001.pdf` | outgoing (AR) | Contains "Proficient" | ≠null | >0 | ⬜ | ⬜ |
| `VEII/Invoice 2026001.pdf` | outgoing (AR) | Contains "Proficient" | ≠null | >0 | ⬜ | ⬜ |
| `EHSIA/Invoice #E2025501.pdf` | outgoing (AR) | Contains "Proficient" | ≠null | >0 | ⬜ | ⬜ |

---

## Receipts

| File | Receipt # | Total | Links To | API | UI |
|------|-----------|-------|----------|-----|----|
| `Pastel/001397-receipt#001260.pdf` | ≠null | >0 | invoice #001397 | ⬜ | ⬜ |
| `Pastel/001414, 001417-receipt#001281.pdf` | ≠null | >0 | invoice #001414 | ⬜ | ⬜ |
| `VEII/Receipt 2025001.pdf` | ≠null | >0 | invoice #2025001 | ⬜ | ⬜ |
| `EHSIA/Receipt #E2025001.pdf` | ≠null | >0 | invoice #E2025501 | ⬜ | ⬜ |

---

## Cross-Document Links

### Receipt → Invoice Links (10 expected)

| Receipt | Receipt # | Links To Invoice | API | UI |
|---------|-----------|-----------------|-----|----|
| `Pastel/001397-receipt#001260.pdf` | 001260 | invoice #001397 | ⬜ | ⬜ |
| `Pastel/001414, 001417-receipt#001281.pdf` | 001281 | invoice #001414 | ⬜ | ⬜ |
| `Pastel/001441, 001442-receipt#001294.pdf` | 001294 | invoice #001441 | ⬜ | ⬜ |
| `Pastel/001473-receipt#001316.pdf` | 001316 | invoice #001473 | ⬜ | ⬜ |
| `Pastel/001500-receipt#001355.pdf` | 001355 | invoice #001500 | ⬜ | ⬜ |
| `Pastel/001507v2-receipt#001356.pdf` | 001356 | invoice #001507 | ⬜ | ⬜ |
| `Pastel/001511-receipt#001347.pdf` | 001347 | invoice #001511 | ⬜ | ⬜ |
| `Pastel/001521-receipt#001358.pdf` | 001358 | invoice #001521 | ⬜ | ⬜ |
| `VEII/Receipt 2025001.pdf` | 2025001 | invoice 2025001 | ⬜ | ⬜ |
| `VEII/Receipt 2025002.pdf` | 2025002 | invoice 2025002 | ⬜ | ⬜ |

### Bank Statement Continuity (2 pairs)

| From | To | Expected | API | UI |
|------|----|----------|-----|----|
| eStatement 20250128 | eStatement 20250228 | closing→opening matched | ⬜ | ⬜ |
| eStatement 20250228 | eStatement 20250331 | closing→opening matched | ⬜ | ⬜ |

### Auto-Match Candidates

| Check | Min Expected | API | UI |
|-------|-------------|-----|----|
| `POST /bank-statements/auto-match` (bank→invoice) | ≥1 candidate | ⬜ | ⬜ |
| `POST /invoices/auto-match-receipts?direction=incoming` | ≥5 candidates (from 10 receipt pairs) | ⬜ | ⬜ |

---

## Summary

| Category | Total | ✅ API | ❌ API | ✅ UI | ❌ UI |
|----------|-------|--------|--------|-------|-------|
| Bank Statements | 3 | — | — | — | — |
| AP Invoices | 5 | — | — | — | — |
| AR Invoices | 3 | — | — | — | — |
| Receipts | 4 | — | — | — | — |
| Receipt→Invoice Links | 10 | — | — | — | — |
| Bank Continuity | 2 | — | — | — | — |
| Auto-Match | 2 | — | — | — | — |
| **TOTAL** | **29** | — | — | — | — |

---

## Skipped (not in this suite)

- `Travel Expense/Shanghai-Nanjing/*` — 32 expense receipt photos (separate expense test needed)
- `Gov/*` — business registration documents
- `VTC/*` — donation receipts (edge case)
- `*.docx` — PDF duplicates
- `*.xlsx` — spreadsheet reference files
- `*.png` — receipt photos (no OCR yet)

## Notes

- Card statements: no samples in `test-sample-real/` — use `test-samples-generated-demo-company/CARD_*.pdf` for card tests
- Travel expenses: the 32 PNG/JPG receipt photos need a separate image-OCR test
- PNR→EHSIA invoices: `PNR/EHSIA/` contains invoices PNR issued TO EHSIA (AR for PNR)
- EHSIA→PNR invoices: `EHSIA/PnR/` contains invoices EHSIA issued TO PNR (AP for PNR when logged in as EHSIA user)

---

## Multi-Invoice (1:N) Combined Payments — ✅ PASSING 2026-08-25, auto 1:N live-verified

The three PNR Pastel combined payments are suggested as GROUP rows by `POST /bank-statements/auto-match` on production (`invoice_ids` sizes 2 / 2 / 3, confidence=medium):

| Bank tx amount | Suggested group | Reason |
|----------------|-----------------|--------|
| 57,580.80 | 2 invoices (#001414 15,300 + #001417v2 42,280.80) | "Combined payment: 15,300.00 + 42,280.80 = 57,580.80" |
| 55,000.00 | 2 invoices (#001441 40,050 + #001442 14,950) | "Combined payment: 40,050.00 + 14,950.00 = 55,000.00" |
| 27,544.00 | 3 invoices (#001458v2 5,200 + #001467-v2 4,150 + #001484-v2 18,194) | "Combined payment: 5,200.00 + 4,150.00 + 18,194.00 = 27,544.00" |

End-to-end (55,000 group): confirm → both invoices `paid`, payment JE `JE-PMT-MULTI-*` with 3 lines (2× Dr 21101 per-invoice allocations + Cr 11102 bank); unlink → invoices back to `sent`, tx back to `unmatched`. Reviewer edge case: confirm with `invoice_ids: []` → HTTP 400.

Checks: browser spec `tests/auto-link-onetomany.spec.ts` (SKIP_UPLOAD=1 HOLD_MS=30000) + deterministic API script `tests/verify-onetomany-live.ts`. The detailed suite table for these checks lives in `regression-tests/REGRESSION_SUITE.md` § Multi-Invoice Bank Transactions.
