# LLM-Powered Document Matching Design

## Overview

Replace rule-based matching with LLM-powered matching for complex document linkages, while keeping rules for simple 1-to-1 matches. The LLM reads actual document content from R2 to determine 1-to-many relationships (e.g., one bank transaction paying multiple invoices).

## Goals

1. **Accuracy** — LLM analyzes actual document content, not just structured metadata
2. **Cost efficiency** — Rules handle 1-to-1 matches (cheap), LLM handles complex cases
3. **UX continuity** — Same modal format, plus chat sidebar notifications
4. **Transparency** — Token counting like existing OCR pattern

## Architecture

### Entry Points

1. **Auto-Match Button** (Bank Statements page) — `POST /api/match/llm-analyze` with type `bank-invoice`
2. **Match Receipts Button** (AP/AR pages) — `POST /api/match/llm-analyze` with type `receipt-invoice`
3. **Chatbot Command** — User asks AI to match documents; AI uses `match_documents` tool which calls the same route

### Backend

#### New file: `api/src/lib/llm-matcher.ts`

Core matching logic:
- `runLLMMatching(params)` — orchestrates the full flow
- `groupByCounterparty(transactions, invoices)` — groups by company name using existing `company-matcher.ts`
- `extractDocumentText(r2Key)` — fetches and extracts text from R2 document
- `buildMatchingPrompt(group)` — constructs LLM prompt with transaction + invoice data
- `parseLLMResponse(response)` — parses LLM JSON output into match suggestions

#### New route: `api/src/routes/match.ts`

`POST /api/match/llm-analyze`

Request body:
```typescript
{
  type: 'bank-invoice' | 'receipt-invoice';
  direction?: 'incoming' | 'outgoing';  // for receipt-invoice only
  companyFilter?: string;
}
```

SSE stream events:
- `progress` — `{ phase: 'rules' | 'llm' | 'done', current: number, total: number, message: string }`
- `suggestions` — array of match suggestions
- `tokens` — `{ prompt: number, completion: number, total: number }` (per LLM call)
- `error` — error message

Cancellation: `POST /api/match/cancel/:sessionId`

#### New tool in `api/src/routes/chat.ts`

Add `match_documents` tool to existing chat tools:
```typescript
{
  name: "match_documents",
  description: "Analyze and suggest linkages between documents (bank statements↔invoices, invoices↔receipts). Use when user asks to match, link, or reconcile documents.",
  parameters: {
    type: { type: "string", enum: ["bank-invoice", "receipt-invoice"] },
    direction: { type: "string", enum: ["incoming", "outgoing"] }
  }
}
```

### Frontend

#### New component: `LLMMatchModal.tsx`

Extends existing modal pattern from `AutoMatchReviewModal.tsx`:
- Progress bar with phase indicator (Rules → LLM → Done)
- Cancel button (aborts SSE stream, calls cancel endpoint)
- Same row layout: confidence badge, document numbers, amounts, reason
- Confirm/reject per pair, Accept All
- Dual-PDF preview on expand (reuse existing iframe logic)

#### Chat sidebar integration

- When matching starts, post a system message:
  *"AI is analyzing 15 bank transactions against 42 invoices for multi-payment relationships..."*
- Message bubble gets a pulsing accent border (CSS animation)
- If sidebar collapsed, chat icon gets a badge with animation
- On completion, message updates: *"Analysis complete. Found 8 suggested matches."*
- Results link in chat opens the modal

#### Token counting (matching OCR pattern)

- Backend returns `tokens: { prompt, completion, total }` in SSE stream
- Frontend calls `writeTokenUsage()` from `TokenPopup.tsx` to accumulate
- Existing `TokenPopup` component displays cumulative usage in bottom-right corner
- Token counts persist in `sessionStorage` until page refresh

#### Existing modal updates

- `AutoMatchReviewModal.tsx` — add toggle for "Use AI matching" (default: on)
- `MatchSuggestionsModal.tsx` — same toggle per tab
- `ReceiptMatchReviewModal` — same toggle

### LLM Prompt Design

```
You are an accounting document matcher. Analyze these bank transactions and invoices to find linkages.

BANK TRANSACTIONS:
[{id, date, amount, narration, counterparty}]

CANDIDATE INVOICES (grouped by counterparty):
[{id, number, amount, issue_date, due_date, status}]

RULES:
- 1-to-1: amount matches exactly, date within reasonable window
- 1-to-many: one bank transaction paying multiple invoices (sum must match)
- Partial payments: transaction amount < invoice amount
- Overpayments: transaction amount > invoice amount

Return JSON array of matches:
[{
  "transaction_id": "string",
  "invoice_ids": ["string"],
  "confidence": "high" | "medium" | "low",
  "reason": "string explaining the linkage",
  "type": "exact" | "combined" | "partial" | "overpayment"
}]
```

### Revert/Cancel Logic

**On cancel:**
- SSE stream closed
- `POST /api/match/cancel/:sessionId` aborts any in-progress LLM calls
- Modal closes, no DB changes (suggestions are transient)

**On page refresh:**
- Frontend checks for any in-progress matching session
- Calls cancel endpoint
- Reverts any "suggested" matches back to unmatched
- Closes modal

**On confirm (per pair or Accept All):**
- Each confirmation is an atomic DB transaction
- Changes `bank_match_status` from "suggested" to "confirmed"
- Posts journal entries if applicable

### Cost Optimization

- Rules handle ~60-70% of matches (1-to-1 exact) — no LLM cost
- LLM only processes remaining ~30-40% grouped by counterparty
- Token estimate per group: ~500-1000 tokens input, ~200-500 output
- For 50 transactions with 30% needing LLM: ~15 groups × 1500 tokens = ~22,500 tokens
- Token counts displayed in `TokenPopup` for transparency

## Key Files

| File | Purpose |
|------|---------|
| `api/src/lib/llm-matcher.ts` | New — core LLM matching logic |
| `api/src/routes/match.ts` | New — SSE streaming endpoint |
| `api/src/routes/chat.ts` | Modify — add `match_documents` tool |
| `api/src/routes/bank-statements.ts` | Modify — update auto-match to use new matcher |
| `api/src/routes/invoices.ts` | Modify — update receipt matching to use new matcher |
| `frontend/src/components/LLMMatchModal.tsx` | New — modal for LLM match review |
| `frontend/src/components/AutoMatchReviewModal.tsx` | Modify — add AI toggle |
| `frontend/src/components/MatchSuggestionsModal.tsx` | Modify — add AI toggle |
| `frontend/src/pages/AP.tsx` | Modify — update receipt match modal |
| `frontend/src/pages/AR.tsx` | Modify — update receipt match modal |
| `frontend/src/pages/BankStatements.tsx` | Modify — use new modal |
| `frontend/src/components/Chatbot.tsx` | Modify — add match status display |
| `frontend/src/components/Layout.tsx` | Modify — chat icon highlight animation |
| `frontend/src/components/TokenPopup.tsx` | No change — reuse as-is |
