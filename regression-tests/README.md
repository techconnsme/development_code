# Tech Connect SME — Regression Test Suite

Shared test suite for verifying OCR pipeline, direction detection, and cross-document linking for Proficient and Reliance Company Limited (PNR) sample documents.

---

## What's Included

| File | Purpose |
|------|---------|
| `REGRESSION_SUITE.md` | Master document — ground truth tables, pass/fail checklist |
| `REGRESSION_TEST_PLAN.md` | Detailed test plan with test cases and expected outcomes |
| `regression-ground-truth.json` | Machine-readable expected values for API verification |
| `run-regression-api.ts` | Automated API verification script (78 checks) |
| `regression-full-flow.spec.ts` | Playwright browser test (5 UI tests) |
| `regression-coa-expand.spec.ts` | Playwright test — COA auto-expand on load |
| `regression-language-switch.spec.ts` | Playwright test — language toggle preserves state |
| `regression-review-buttons.spec.ts` | Playwright test — Review Later/Save/Discard buttons |

---

## Prerequisites

- **Node.js** 18+
- **Playwright** (`npm install playwright @playwright/test`)
- **tsx** (`npm install -g tsx`)
- Access to the deployed API (`https://opcc-crm-api.ruhan-farhan.workers.dev`)

---

## Test Accounts

| Role | Email | Password |
|------|-------|----------|
| Test user (Joseph Lin / PNR) | `joseph.lin@pnr.hk` | `Test1234` |
| Admin (for hard-reset) | `memonruhan731@gmail.com` | `Hamdan123` |

---

## Sample Documents

Expected in `test-sample-real/PNR/` (sibling to this folder):

```
test-sample-real/PNR/
├── estatement/          # 18 HSBC bank statements
├── Pastel/              # 50 Pastel invoices + receipts
├── VEII/                # 58 VEII invoices + receipts
├── Muselab/             # MuseLabs invoices
├── Respect/             # Respect invoices
├── EHSIA/               # EHSIA invoices
├── Gov/                 # Government documents
├── VTC/                 # VTC documents
└── Travel Expense/
    └── Shanghai-Nanjing/  # 32 expense receipts
```

---

## Quick Start

```bash
# 1. Navigate to the project root (where this folder lives)
cd latest_code

# 2. Hard-reset test data (clean slate)
curl -X POST https://opcc-crm-api.ruhan-farhan.workers.dev/api/admin/hard-reset-data \
  -H "Authorization: Bearer $(curl -s -X POST https://opcc-crm-api.ruhan-farhan.workers.dev/api/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"email":"memonruhan731@gmail.com","password":"Hamdan123"}' | grep -o '"token":"[^"]*"' | cut -d'"' -f4)" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"u-83161e0c"}'

# 3. Run API verification (78 checks)
npx tsx regression-tests/run-regression-api.ts

# 4. Run browser UI tests
npx playwright test regression-tests/regression-full-flow.spec.ts --headed
```

---

## Current Results (2026-08-11)

**65/78 passing (83%)**

### ✅ Passing
- Bank statement account #, bank name, transactions, balances
- VEII invoices: direction, customer matching
- EHSIA/Respect/MuseLabs invoices: direction detection
- All receipts: import, receipt numbers, totals
- Cross-document: continuity chain, auto-match

### ❌ Known Failures (13) — OCR Quality
| Issue | Files affected |
|-------|---------------|
| DeepSeek misidentifies vendor as "Joseph Lin" | Pastel `#001414`, `#001547-v3` |
| Vendor empty (OCR missed) | Pastel `#001397`, MuseLabs `INV022-1319` |
| Total=0 (OCR missed amount) | Pastel `#001397`, Respect `I0105` |
| Receipts not auto-linked | 3 receipts |
| Bank name OCR variance | 1 statement (full legal name vs "HSBC") |

---

## OCR Pipeline (for context)

The system uses a dual-path OCR pipeline:

```
PDF → toMarkdown (Cloudflare AI) → DeepSeek parse → balance check
  ├── balance matches ✅ → use result (ocr_source: tomarkdown)
  └── balance MISMATCH ❌ → GLM-OCR retry → DeepSeek re-parse
       ├── passes → use GLM result (ocr_source: glm-ocr)
       └── fails → keep toMarkdown, flag for review
```

- **toMarkdown**: Fast, free, but loses column alignment → deposit/withdrawal swaps possible
- **GLM-OCR**: Preserves layout (HTML tables + position tags), but has daily rate limits
- **pdftotext -layout**: Also preserves columns (free, no rate limits) but needs Docker host

---

## Notes

- The API script hard-resets ALL of Joseph Lin's data before running — do NOT run on production data
- GLM-OCR requires an active z.ai API key with credits
- Sample documents are NOT included in this bundle — request them separately
- Paths in scripts assume this folder is at `latest_code/regression-tests/`
