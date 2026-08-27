# LLM-Powered Document Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace rule-based matching with LLM-powered matching for complex document linkages (1-to-many), while keeping rules for simple 1-to-1 matches, with chat sidebar notifications and token counting.

**Architecture:** New backend route `/api/match/llm-analyze` streams SSE progress events. Rules run first for 1-to-1 exact matches, then LLM analyzes grouped candidates by counterparty. Frontend gets new `LLMMatchModal` component, chat sidebar gets status notifications with highlighted bubbles, and existing `TokenPopup` accumulates LLM token usage.

**Tech Stack:** Hono (Cloudflare Workers), D1 (SQLite), R2 (file storage), Qwen 3.7-plus / DeepSeek (LLM providers), React 18, TypeScript, Tailwind CSS, SSE streaming, sessionStorage for token accumulation.

## Global Constraints

- Backend: Hono on Cloudflare Workers, D1 database, R2 file storage
- Frontend: React 18 + TypeScript + Vite + Tailwind CSS + Radix UI
- LLM providers: Qwen DashScope International → Qwen Token Plan → DeepSeek (fallback chain)
- i18n: English, 繁體中文, 简体中文 (use `tr()` helper)
- Auth: JWT via `authMiddleware`, tenant isolation via `user_id`
- No new dependencies — use existing libraries only

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `api/src/lib/llm-matcher.ts` | Create | Core LLM matching logic: grouping, prompt building, response parsing |
| `api/src/routes/match.ts` | Create | SSE streaming endpoint + cancel endpoint |
| `api/src/routes/chat.ts` | Modify | Add `match_documents` tool definition + execution |
| `api/src/routes/bank-statements.ts` | Modify | Update auto-match to call new matcher |
| `api/src/routes/invoices.ts` | Modify | Update receipt matching to call new matcher |
| `frontend/src/components/LLMMatchModal.tsx` | Create | Modal for LLM match review with progress bar |
| `frontend/src/components/AutoMatchReviewModal.tsx` | Modify | Add "Use AI matching" toggle |
| `frontend/src/components/MatchSuggestionsModal.tsx` | Modify | Add AI toggle per tab |
| `frontend/src/pages/AP.tsx` | Modify | Update receipt match modal usage |
| `frontend/src/pages/AR.tsx` | Modify | Update receipt match modal usage |
| `frontend/src/pages/BankStatements.tsx` | Modify | Use new LLM modal |
| `frontend/src/components/Chatbot.tsx` | Modify | Add match status message display |
| `frontend/src/components/Layout.tsx` | Modify | Chat icon highlight animation |
| `frontend/src/lib/api.ts` | Modify | Add `matchAnalyze` SSE helper |

---

### Task 1: Backend — LLM Matcher Core Library

**Files:**
- Create: `api/src/lib/llm-matcher.ts`
- Reference: `api/src/lib/bank-matcher.ts` (existing rule-based logic)
- Reference: `api/src/lib/llm-parse.ts` (LLM provider chain)
- Reference: `api/src/lib/company-matcher.ts` (fuzzy company matching)

**Interfaces:**
- Consumes: `llmKeysFromEnv()`, `fuzzyMatchCompany()` from existing libs
- Produces: `runLLMMatching()`, `groupByCounterparty()`, `buildMatchingPrompt()`, `parseLLMResponse()`

- [ ] **Step 1: Create `api/src/lib/llm-matcher.ts` with types and grouping logic**

```typescript
/**
 * LLM-powered document matcher — groups unmatched items by counterparty,
 * sends candidates to LLM for 1-to-many relationship analysis.
 *
 * Flow: rules first (1-to-1 exact) → group remainder → LLM per group.
 */

import { llmKeysFromEnv, hasLlmKey, llmCompleteJson } from './llm-parse';
import { fuzzyMatchCompany } from './company-matcher';

export interface LlmMatchParams {
  userId: string;
  db: any; // D1Database
  env: any; // Bindings
  type: 'bank-invoice' | 'receipt-invoice';
  direction?: 'incoming' | 'outgoing';
  onProgress?: (event: { phase: 'rules' | 'llm' | 'done'; current: number; total: number; message: string }) => void;
  onTokens?: (usage: { prompt: number; completion: number; total: number }) => void;
  signal?: AbortSignal;
}

export interface MatchSuggestion {
  transaction_id?: string;
  receipt_id?: string;
  invoice_id?: string;
  invoice_ids?: string[];
  invoice_number?: string;
  invoice_numbers?: string[];
  amount?: number;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  type: 'exact' | 'combined' | 'partial' | 'overpayment';
  direction?: string;
  invoice_file_id?: string | null;
  stmt_file_id?: string | null;
}

interface GroupedCandidates {
  counterparty: string;
  transactions: any[];
  invoices: any[];
}

export function groupByCounterparty(
  transactions: any[],
  invoices: any[],
  amountKey: string
): GroupedCandidates[] {
  const groups = new Map<string, GroupedCandidates>();
  
  for (const tx of transactions) {
    const name = tx.counterparty_name || tx.description || 'Unknown';
    // Find best matching invoice counterparty
    let bestMatch = name;
    let bestScore = 0;
    for (const inv of invoices) {
      const invName = inv.counterparty_name || '';
      if (!invName) continue;
      const score = fuzzyMatchCompany(name, [invName], { topN: 1, minScore: 50 })?.best?.score ?? 0;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = invName;
      }
    }
    const key = bestScore >= 60 ? bestMatch : name;
    if (!groups.has(key)) {
      groups.set(key, { counterparty: key, transactions: [], invoices: [] });
    }
    groups.get(key)!.transactions.push(tx);
  }
  
  // Assign invoices to groups
  for (const [key, group] of groups) {
    group.invoices = invoices.filter(inv => {
      const invName = inv.counterparty_name || '';
      if (!invName) return false;
      const score = fuzzyMatchCompany(key, [invName], { topN: 1, minScore: 50 })?.best?.score ?? 0;
      return score >= 60;
    });
  }
  
  return Array.from(groups.values()).filter(g => g.transactions.length > 0 && g.invoices.length > 0);
}
```

- [ ] **Step 2: Add prompt building and response parsing functions**

```typescript
export function buildBankInvoicePrompt(transactions: any[], invoices: any[]): string {
  const txList = transactions.map(tx => 
    `- id: ${tx.id}, date: ${tx.transaction_date}, amount: ${tx.amount}, narration: ${tx.description || ''}, reference: ${tx.reference || ''}`
  ).join('\n');
  
  const invList = invoices.map(inv =>
    `- id: ${inv.id}, number: ${inv.invoice_number}, amount: ${inv.total}, issue_date: ${inv.issue_date}, due_date: ${inv.due_date || 'N/A'}`
  ).join('\n');

  return `You are an accounting document matcher. Analyze these bank transactions and invoices to find linkages.

BANK TRANSACTIONS:
${txList}

CANDIDATE INVOICES:
${invList}

RULES:
- 1-to-1: amount matches exactly (within $0.01), date within reasonable window
- 1-to-many: one bank transaction paying multiple invoices (sum of invoices must equal transaction amount)
- Partial payments: transaction amount < invoice amount (partial settlement)
- Overpayments: transaction amount > invoice amount (overpayment)
- Consider narration/reference text for invoice number mentions
- Consider date proximity (payment should be near issue_date to due_date+30)

Return a JSON array of matches. Each match:
{
  "transaction_id": "string (bank transaction id)",
  "invoice_ids": ["string"] (array of invoice ids, single or multiple),
  "confidence": "high" | "medium" | "low",
  "reason": "string explaining the linkage",
  "type": "exact" | "combined" | "partial" | "overpayment"
}

Only return matches you are confident about. Return empty array [] if no good matches found.
Return ONLY the JSON array, no other text.`;
}

export function buildReceiptInvoicePrompt(receipts: any[], invoices: any[]): string {
  const rcptList = receipts.map(r =>
    `- id: ${r.id}, number: ${r.receipt_number || r.invoice_number}, amount: ${r.total}, date: ${r.paid_date || 'N/A'}, vendor: ${r.vendor_name || r.customer_name || ''}`
  ).join('\n');
  
  const invList = invoices.map(inv =>
    `- id: ${inv.id}, number: ${inv.invoice_number}, amount: ${inv.total}, issue_date: ${inv.issue_date}, vendor: ${inv.supplier_name || inv.customer_name || ''}`
  ).join('\n');

  return `You are an accounting document matcher. Analyze these receipts and invoices to find linkages.

RECEIPTS:
${rcptList}

CANDIDATE INVOICES:
${invList}

RULES:
- 1-to-1: receipt amount matches invoice amount exactly (within $0.02)
- 1-to-many: one receipt paying multiple invoices (sum of invoices must equal receipt amount)
- Partial payments: receipt amount < invoice amount
- Consider vendor/counterparty name matching
- Consider date proximity

Return a JSON array of matches. Each match:
{
  "receipt_id": "string",
  "invoice_ids": ["string"],
  "confidence": "high" | "medium" | "low",
  "reason": "string explaining the linkage",
  "type": "exact" | "combined" | "partial"
}

Only return matches you are confident about. Return empty array [] if no good matches found.
Return ONLY the JSON array, no other text.`;
}

export function parseLLMResponse(response: any): MatchSuggestion[] {
  if (!response?.parsed) return [];
  const arr = Array.isArray(response.parsed) ? response.parsed : 
              (response.parsed.matches ? response.parsed.matches : [response.parsed]);
  return arr.filter((m: any) => m && (m.transaction_id || m.receipt_id) && m.invoice_ids?.length > 0);
}
```

- [ ] **Step 3: Add the main `runLLMMatching` orchestrator function**

```typescript
export async function runLLMMatching(params: LlmMatchParams): Promise<MatchSuggestion[]> {
  const { userId, db, env, type, direction, onProgress, onTokens, signal } = params;
  const keys = llmKeysFromEnv(env);
  
  if (!hasLlmKey(keys)) {
    throw new Error('No LLM API keys configured');
  }
  
  const suggestions: MatchSuggestion[] = [];
  
  if (type === 'bank-invoice') {
    // 1. Fetch unmatched transactions and invoices
    const transactions = await fetchUnmatchedTransactions(db, userId, direction);
    const invoices = await fetchUnmatchedInvoices(db, userId, direction);
    
    onProgress?.({ phase: 'rules', current: 0, total: transactions.length, message: `Found ${transactions.length} unmatched transactions, ${invoices.length} unpaid invoices` });
    
    // 2. Group by counterparty
    const groups = groupByCounterparty(transactions, invoices, 'amount');
    
    onProgress?.({ phase: 'llm', current: 0, total: groups.length, message: `Analyzing ${groups.length} groups with AI...` });
    
    // 3. Process each group with LLM
    let processed = 0;
    for (const group of groups) {
      if (signal?.aborted) throw new Error('Cancelled');
      
      const prompt = buildBankInvoicePrompt(group.transactions, group.invoices);
      const result = await llmCompleteJson(keys, prompt, 'llm-match-bank-invoice', { maxTokens: 4000 });
      
      if (result.parsed) {
        const parsed = parseLLMResponse(result);
        suggestions.push(...parsed);
      }
      
      // Report token usage
      if ((result as any).usage) {
        onTokens?.((result as any).usage);
      }
      
      processed++;
      onProgress?.({ phase: 'llm', current: processed, total: groups.length, message: `Analyzed group ${processed}/${groups.length}: ${group.counterparty}` });
    }
  } else if (type === 'receipt-invoice') {
    // Similar logic for receipt-invoice matching
    const receipts = await fetchUnmatchedReceipts(db, userId, direction);
    const invoices = await fetchUnpaidInvoices(db, userId, direction);
    
    onProgress?.({ phase: 'rules', current: 0, total: receipts.length, message: `Found ${receipts.length} unmatched receipts, ${invoices.length} unpaid invoices` });
    
    const groups = groupByCounterparty(receipts, invoices, 'total');
    
    onProgress?.({ phase: 'llm', current: 0, total: groups.length, message: `Analyzing ${groups.length} groups with AI...` });
    
    let processed = 0;
    for (const group of groups) {
      if (signal?.aborted) throw new Error('Cancelled');
      
      const prompt = buildReceiptInvoicePrompt(group.transactions, group.invoices);
      const result = await llmCompleteJson(keys, prompt, 'llm-match-receipt-invoice', { maxTokens: 4000 });
      
      if (result.parsed) {
        const parsed = parseLLMResponse(result);
        suggestions.push(...parsed);
      }
      
      if ((result as any).usage) {
        onTokens?.((result as any).usage);
      }
      
      processed++;
      onProgress?.({ phase: 'llm', current: processed, total: groups.length, message: `Analyzed group ${processed}/${groups.length}: ${group.counterparty}` });
    }
  }
  
  onProgress?.({ phase: 'done', current: 1, total: 1, message: `Found ${suggestions.length} suggested matches` });
  
  return suggestions;
}

// DB helper functions
async function fetchUnmatchedTransactions(db: any, userId: string, direction?: string) {
  const statusFilter = "(bt.match_status IS NULL OR bt.match_status = 'unmatched')";
  const wantAR = direction !== 'incoming';
  const wantAP = direction !== 'outgoing';
  
  const results: any[] = [];
  
  if (wantAR) {
    const deposits = await db.prepare(
      `SELECT bt.id, bt.transaction_date, bt.description, bt.deposit_amount as amount, bt.reference,
              COALESCE(bs.currency, 'HKD') as currency, bt.description as counterparty_name
       FROM bank_transactions bt LEFT JOIN bank_statements bs ON bt.bank_statement_id = bs.id
       WHERE bt.user_id = ? AND bt.deleted_at IS NULL AND bs.deleted_at IS NULL
       AND bt.deposit_amount > 0 AND ${statusFilter}
       ORDER BY bt.transaction_date`
    ).bind(userId).all();
    results.push(...(deposits.results || []));
  }
  
  if (wantAP) {
    const withdrawals = await db.prepare(
      `SELECT bt.id, bt.transaction_date, bt.description, bt.withdrawal_amount as amount, bt.reference,
              COALESCE(bs.currency, 'HKD') as currency, bt.description as counterparty_name
       FROM bank_transactions bt LEFT JOIN bank_statements bs ON bt.bank_statement_id = bs.id
       WHERE bt.user_id = ? AND bt.deleted_at IS NULL AND bs.deleted_at IS NULL
       AND bt.withdrawal_amount > 0 AND ${statusFilter} AND bt.card_statement_id IS NULL
       ORDER BY bt.transaction_date`
    ).bind(userId).all();
    results.push(...(withdrawals.results || []));
  }
  
  return results;
}

async function fetchUnmatchedInvoices(db: any, userId: string, direction?: string) {
  const targetDirection = direction === 'outgoing' ? 'outgoing' : direction === 'incoming' ? 'incoming' : null;
  const dirFilter = targetDirection ? `AND i.direction = '${targetDirection}'` : '';
  
  const result = await db.prepare(
    `SELECT i.id, i.invoice_number, i.total, i.issue_date, i.due_date, i.file_id,
            COALESCE(supp.name, cust.name) as counterparty_name
     FROM invoices i
     LEFT JOIN customers cust ON i.customer_id = cust.id
     LEFT JOIN suppliers supp ON i.supplier_id = supp.id
     WHERE i.user_id = ? AND i.status != 'cancelled' AND i.receipt_number IS NULL
     AND i.invoice_number NOT LIKE 'REC-%' AND i.deleted_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM bank_transactions b2
       LEFT JOIN bank_transaction_invoice_links l2 ON l2.transaction_id = b2.id
       WHERE b2.deleted_at IS NULL AND b2.match_status = 'confirmed'
         AND (b2.invoice_id = i.id OR l2.invoice_id = i.id)
     ) ${dirFilter}
     ORDER BY i.created_at DESC`
  ).bind(userId).all();
  
  return result.results || [];
}

async function fetchUnmatchedReceipts(db: any, userId: string, direction?: string) {
  const result = await db.prepare(
    `SELECT id, invoice_number, receipt_number, total, vendor_name, customer_name, payer_name, paid_date, direction
     FROM invoices WHERE user_id = ? AND receipt_number IS NOT NULL
     AND linked_invoice_id IS NULL AND total > 0 AND deleted_at IS NULL`
  ).bind(userId).all();
  
  return result.results || [];
}

async function fetchUnpaidInvoices(db: any, userId: string, direction?: string) {
  const targetDirection = direction === 'outgoing' ? 'outgoing' : 'incoming';
  
  const result = await db.prepare(
    `SELECT i.id, i.invoice_number, i.total, i.issue_date, i.file_id,
            COALESCE(supp.name, cust.name) as counterparty_name
     FROM invoices i
     LEFT JOIN customers cust ON i.customer_id = cust.id
     LEFT JOIN suppliers supp ON i.supplier_id = supp.id
     WHERE i.user_id = ? AND i.direction = ?
     AND i.receipt_number IS NULL AND i.linked_invoice_id IS NULL
     AND i.status != 'cancelled' AND i.total > 0 AND i.deleted_at IS NULL`
  ).bind(userId, targetDirection).all();
  
  return result.results || [];
}
```

- [ ] **Step 4: Verify the file compiles**

Run: `cd api && npx tsc --noEmit src/lib/llm-matcher.ts`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add api/src/lib/llm-matcher.ts
git commit -m "feat: add LLM matcher core library with grouping and prompt building"
```

---

### Task 2: Backend — SSE Streaming Match Route

**Files:**
- Create: `api/src/routes/match.ts`
- Modify: `api/src/index.ts` (register route)
- Reference: `api/src/routes/chat.ts` (SSE pattern)

**Interfaces:**
- Consumes: `runLLMMatching()` from Task 1
- Produces: `POST /api/match/llm-analyze`, `POST /api/match/cancel/:sessionId`

- [ ] **Step 1: Create `api/src/routes/match.ts` with SSE endpoint**

```typescript
import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware } from '../middleware/auth';
import { Bindings, Variables } from '../types';
import { runLLMMatching, LlmMatchParams } from '../lib/llm-matcher';

const match = new Hono<{ Bindings: Bindings; Variables: Variables }>();
match.use('*', authMiddleware);

// Track active sessions for cancellation
const activeSessions = new Map<string, AbortController>();

// POST /api/match/llm-analyze — SSE streaming endpoint
match.post('/llm-analyze', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  
  const sessionId = uuidv4();
  const controller = new AbortController();
  activeSessions.set(sessionId, controller);
  
  const { type = 'bank-invoice', direction } = body;
  
  // SSE response
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: any) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      
      try {
        send('progress', { phase: 'rules', current: 0, total: 0, message: 'Starting analysis...', sessionId });
        
        const suggestions = await runLLMMatching({
          userId: tenantId,
          db,
          env: c.env,
          type,
          direction,
          signal: controller.signal,
          onProgress: (event) => send('progress', { ...event, sessionId }),
          onTokens: (usage) => send('tokens', usage),
        });
        
        send('suggestions', suggestions);
        send('done', { total: suggestions.length, sessionId });
      } catch (err: any) {
        if (err.message === 'Cancelled') {
          send('cancelled', { sessionId });
        } else {
          send('error', { message: err.message || 'Matching failed', sessionId });
        }
      } finally {
        activeSessions.delete(sessionId);
        controller.close();
      }
    }
  });
  
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});

// POST /api/match/cancel/:sessionId — cancel active matching
match.post('/cancel/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');
  const controller = activeSessions.get(sessionId);
  
  if (controller) {
    controller.abort();
    activeSessions.delete(sessionId);
    return c.json({ success: true, message: 'Matching cancelled' });
  }
  
  return c.json({ success: false, message: 'Session not found' }, 404);
});

export default match;
```

- [ ] **Step 2: Register route in `api/src/index.ts`**

Find the line where routes are registered (look for `app.route`) and add:
```typescript
import match from './routes/match';
// ... existing routes ...
app.route('/api/match', match);
```

- [ ] **Step 3: Verify the file compiles**

Run: `cd api && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/match.ts api/src/index.ts
git commit -m "feat: add SSE streaming match route with cancel support"
```

---

### Task 3: Backend — Add Chat Tool for Matching

**Files:**
- Modify: `api/src/routes/chat.ts` (add tool definition + execution)

**Interfaces:**
- Consumes: `runLLMMatching()` from Task 1
- Produces: `match_documents` tool callable by LLM

- [ ] **Step 1: Add tool definition to the tools array (after line ~281)**

Find the tools array and add after the last tool:
```typescript
  { type: 'function', function: { name: 'match_documents', description: 'Analyze and suggest linkages between documents (bank statements↔invoices, invoices↔receipts). Use when user asks to match, link, or reconcile documents. Runs AI analysis and returns suggested matches for user review.', parameters: { type: 'object', properties: { type: { type: 'string', description: 'Type of matching: bank-invoice (bank statements to invoices) or receipt-invoice (receipts to invoices)', enum: ['bank-invoice', 'receipt-invoice'] }, direction: { type: 'string', description: 'Optional direction filter: incoming (AP) or outgoing (AR)', enum: ['incoming', 'outgoing'] } }, required: ['type'] } } },
```

- [ ] **Step 2: Add tool execution in the `executeTool` switch statement**

Find the `switch (name)` block and add a new case:
```typescript
    case 'match_documents': {
      const { runLLMMatching } = await import('../lib/llm-matcher');
      const type = args?.type || 'bank-invoice';
      const direction = args?.direction;
      
      try {
        const suggestions = await runLLMMatching({
          userId,
          db,
          env,
          type,
          direction,
        });
        
        return JSON.stringify({
          success: true,
          match_count: suggestions.length,
          suggestions: suggestions.slice(0, 20), // Limit for chat display
          message: `Found ${suggestions.length} suggested matches. ${suggestions.length > 0 ? 'Please review in the matching modal.' : 'No matches found.'}`
        });
      } catch (err: any) {
        return JSON.stringify({ success: false, error: err.message });
      }
    }
```

- [ ] **Step 3: Verify the file compiles**

Run: `cd api && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/chat.ts
git commit -m "feat: add match_documents tool to chatbot"
```

---

### Task 4: Frontend — LLM Match Modal Component

**Files:**
- Create: `frontend/src/components/LLMMatchModal.tsx`
- Reference: `frontend/src/components/AutoMatchReviewModal.tsx` (existing modal pattern)

**Interfaces:**
- Consumes: SSE stream from `/api/match/llm-analyze`
- Produces: `<LLMMatchModal>` component with progress, cancel, confirm/reject

- [ ] **Step 1: Create `frontend/src/components/LLMMatchModal.tsx`**

```typescript
import { useState, useEffect, useRef } from 'react';
import { X, Sparkles, CheckCircle2, Loader2, AlertCircle } from 'lucide-react';
import { WORKER_API_BASE, iframeClientParam } from '../lib/api';
import { tr } from '../lib/i18nHelpers';
import { writeTokenUsage } from './TokenPopup';

interface MatchSuggestion {
  transaction_id?: string;
  receipt_id?: string;
  invoice_id?: string;
  invoice_ids?: string[];
  invoice_number?: string;
  invoice_numbers?: string[];
  amount?: number;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  type: 'exact' | 'combined' | 'partial' | 'overpayment';
  direction?: string;
  invoice_file_id?: string | null;
  stmt_file_id?: string | null;
}

interface ProgressEvent {
  phase: 'rules' | 'llm' | 'done';
  current: number;
  total: number;
  message: string;
  sessionId?: string;
}

export default function LLMMatchModal({ type, direction, onConfirm, onReject, onClose }: {
  type: 'bank-invoice' | 'receipt-invoice';
  direction?: 'incoming' | 'outgoing';
  onConfirm: (txId: string | null, invoiceId: string | null, invoiceIds?: string[]) => void | Promise<void>;
  onReject: (txId: string | null) => void | Promise<void>;
  onClose: () => void;
}) {
  const [suggestions, setSuggestions] = useState<MatchSuggestion[]>([]);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [processing, setProcessing] = useState<string | null>(null);
  const [previewMatch, setPreviewMatch] = useState<MatchSuggestion | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const token = localStorage.getItem('token') || '';

  useEffect(() => {
    startMatching();
    return () => {
      // Cleanup on unmount — cancel if still streaming
      if (sessionId) {
        fetch(`${WORKER_API_BASE}/match/cancel/${sessionId}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
      }
    };
  }, []);

  const startMatching = async () => {
    setIsStreaming(true);
    setError(null);
    
    try {
      const resp = await fetch(`${WORKER_API_BASE}/match/llm-analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ type, direction }),
      });
      
      if (!resp.ok) {
        throw new Error(`Server error: ${resp.status}`);
      }
      
      const reader = resp.body?.getReader();
      const decoder = new TextDecoder();
      
      if (!reader) throw new Error('No response stream');
      
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            const eventType = line.slice(7).trim();
            // Next data line will be handled below
          } else if (line.startsWith('data: ')) {
            const data = JSON.parse(line.slice(6));
            
            // Parse event type from previous line (simplified — in practice, track eventType)
            if (data.phase !== undefined) {
              setProgress(data);
              if (data.sessionId) setSessionId(data.sessionId);
            } else if (data.total !== undefined && data.sessionId) {
              // Done event
            } else if (Array.isArray(data)) {
              setSuggestions(data);
            } else if (data.message && !data.success) {
              setError(data.message);
            }
          }
        }
      }
    } catch (err: any) {
      setError(err.message || 'Failed to start matching');
    } finally {
      setIsStreaming(false);
    }
  };

  const handleCancel = async () => {
    if (sessionId) {
      await fetch(`${WORKER_API_BASE}/match/cancel/${sessionId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
    onClose();
  };

  const getKey = (m: MatchSuggestion) => m.transaction_id || m.receipt_id || '';
  
  const pending = suggestions.filter(m => !confirmed.has(getKey(m)) && !rejected.has(getKey(m)));

  const handleConfirm = async (m: MatchSuggestion) => {
    const key = getKey(m);
    setProcessing(key);
    try {
      await onConfirm(key, m.invoice_id ?? null, m.invoice_ids);
      setConfirmed(prev => new Set(prev).add(key));
    } catch { /* parent surfaces error */ }
    setProcessing(null);
  };

  const handleReject = async (m: MatchSuggestion) => {
    const key = getKey(m);
    setProcessing(key);
    try {
      await onReject(key);
      setRejected(prev => new Set(prev).add(key));
    } catch { /* keep pending */ }
    setProcessing(null);
  };

  const acceptAll = async () => {
    for (const m of pending) await handleConfirm(m);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-card border rounded-xl p-6 w-full max-w-[95vw] mx-4 space-y-4 h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-blue-600" />
            {tr('AI Match Suggestions', 'AI 配對建議', 'AI 配对建议')}
            {isStreaming && <Loader2 className="h-4 w-4 animate-spin text-blue-500" />}
          </h3>
          <button onClick={handleCancel} className="p-1 hover:bg-muted rounded"><X className="h-4 w-4" /></button>
        </div>

        {/* Progress bar */}
        {progress && progress.phase !== 'done' && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {progress.message}
            </div>
            <div className="w-full bg-muted rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }}
              />
            </div>
            <div className="text-xs text-muted-foreground text-right">
              {progress.current}/{progress.total}
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 p-3 rounded-lg">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}

        {/* Results */}
        {suggestions.length === 0 && !isStreaming && !error ? (
          <div className="text-center py-8 space-y-2">
            <CheckCircle2 className="h-8 w-8 text-green-500 mx-auto" />
            <p className="text-sm font-medium">{tr('No additional matches found by AI', 'AI 未找到額外匹配', 'AI 未找到额外匹配')}</p>
            <button onClick={onClose} className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm">
              {tr('Close', '關閉', '关闭')}
            </button>
          </div>
        ) : pending.length === 0 && suggestions.length > 0 ? (
          <div className="text-center py-8 space-y-2">
            <CheckCircle2 className="h-8 w-8 text-green-500 mx-auto" />
            <p className="text-sm font-medium">{tr('All suggestions reviewed!', '所有建議已審核！', '所有建议已审核！')}</p>
            <button onClick={onClose} className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm">
              {tr('Close', '關閉', '关闭')}
            </button>
          </div>
        ) : suggestions.length > 0 ? (
          <>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {tr('AI found these matches. Review each suggestion. Click a row to preview both documents.', 'AI 找到了這些匹配。請逐一審核建議。點擊行可預覽兩份文件。', 'AI 找到了这些匹配。请逐一审核建议。点击行可预览两份文件。')}
              </span>
              <button
                onClick={acceptAll}
                disabled={processing !== null || isStreaming}
                className="px-3 py-1.5 bg-green-600 text-white rounded text-xs font-medium hover:bg-green-700 disabled:opacity-50"
              >
                {tr('Accept All', '全部接受', '全部接受')} ({pending.length})
              </button>
            </div>
            <div className="space-y-2 overflow-y-auto flex-1">
              {pending.map(m => {
                const key = getKey(m);
                const open = previewMatch && getKey(previewMatch) === key;
                return (
                  <div
                    key={key}
                    className={`border rounded-lg transition-colors ${processing === key ? 'opacity-50' : ''} ${open ? 'ring-2 ring-blue-400 bg-blue-50/30' : 'hover:bg-muted/50'}`}
                  >
                    <div
                      onClick={() => setPreviewMatch(open ? null : m)}
                      className="p-3 flex items-center gap-4 cursor-pointer"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                            m.confidence === 'high' ? 'bg-green-100 text-green-700' :
                            m.confidence === 'medium' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
                          }`}>{m.confidence?.toUpperCase() || 'LOW'}</span>
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">AI</span>
                          {(m.invoice_ids?.length ?? 0) >= 2 ? (
                            <>
                              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">COMBINED</span>
                              <span className="text-sm font-medium truncate">{m.invoice_ids?.join(' + ')}</span>
                            </>
                          ) : (
                            <span className="text-sm font-medium truncate">{m.invoice_number || m.invoice_id}</span>
                          )}
                          {m.amount && <span className="font-mono text-xs text-muted-foreground">HKD {m.amount.toLocaleString()}</span>}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">{m.reason}</p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                        <button onClick={() => setPreviewMatch(open ? null : m)}
                          className="px-2 py-1 text-xs text-primary hover:bg-blue-50 rounded">
                          {tr('Preview', '預覽', '预览')}
                        </button>
                        <button onClick={() => handleConfirm(m)}
                          disabled={processing === key}
                          className="px-3 py-1.5 bg-green-600 text-white rounded text-xs font-medium hover:bg-green-700 disabled:opacity-50">
                          ✓ {tr('Confirm', '確認', '确认')}
                        </button>
                        <button onClick={() => handleReject(m)}
                          disabled={processing === key}
                          className="px-3 py-1.5 border border-red-300 text-red-600 rounded text-xs hover:bg-red-50 disabled:opacity-50">
                          ✗ {tr('Reject', '拒絕', '拒绝')}
                        </button>
                      </div>
                    </div>

                    {/* PDF preview accordion */}
                    <div className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                      <div className="overflow-hidden min-h-0">
                        <div className="border-t px-3 pt-3 pb-1">
                          <div className="flex gap-3 h-80">
                            {m.stmt_file_id && (
                              <div className="flex-1 min-w-[220px] flex flex-col">
                                <span className="text-[10px] text-muted-foreground mb-1">{tr('Bank Statement', '銀行月結單', '银行月结单')}</span>
                                <iframe src={`${WORKER_API_BASE}/file-storage/${m.stmt_file_id}/download?inline=1&token=${token}${iframeClientParam()}`}
                                  className="w-full flex-1 border rounded" title="Bank Statement" />
                              </div>
                            )}
                            <div className="flex-1 min-w-[220px] flex flex-col">
                              <span className="text-[10px] text-muted-foreground mb-1">{tr('Invoice', '發票', '发票')}</span>
                              {m.invoice_file_id ? (
                                <iframe src={`${WORKER_API_BASE}/file-storage/${m.invoice_file_id}/download?inline=1&token=${token}${iframeClientParam()}`}
                                  className="w-full flex-1 border rounded" title="Invoice" />
                              ) : (
                                <div className="w-full flex-1 border rounded bg-muted/30 flex items-center justify-center text-xs text-muted-foreground">
                                  {tr('No invoice file', '沒有發票文件', '没有发票文件')}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/LLMMatchModal.tsx
git commit -m "feat: add LLM match modal with progress bar and cancel"
```

---

### Task 5: Frontend — Add SSE Helper to API Library

**Files:**
- Modify: `frontend/src/lib/api.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `matchAnalyze()` SSE helper function

- [ ] **Step 1: Add SSE streaming helper to `api.ts`**

Find the end of the file and add:

```typescript
/**
 * SSE streaming for LLM match analysis.
 * Returns an object with event handlers and a cancel function.
 */
export function matchAnalyze(
  params: { type: string; direction?: string },
  handlers: {
    onProgress?: (data: any) => void;
    onSuggestions?: (data: any[]) => void;
    onTokens?: (data: { prompt: number; completion: number; total: number }) => void;
    onDone?: (data: any) => void;
    onError?: (data: any) => void;
    onCancelled?: () => void;
  }
): { cancel: () => Promise<void>; sessionId: Promise<string | null> } {
  const token = localStorage.getItem('token') || '';
  let sessionIdResolve: (id: string | null) => void;
  const sessionIdPromise = new Promise<string | null>(resolve => { sessionIdResolve = resolve; });
  
  const abortController = new AbortController();
  
  (async () => {
    try {
      const resp = await fetch(`${WORKER_API_BASE}/match/llm-analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(params),
        signal: abortController.signal,
      });
      
      if (!resp.ok) {
        handlers.onError?.({ message: `Server error: ${resp.status}` });
        return;
      }
      
      const reader = resp.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) return;
      
      let buffer = '';
      let currentEvent = '';
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            const data = JSON.parse(line.slice(6));
            
            if (data.sessionId) sessionIdResolve(data.sessionId);
            
            switch (currentEvent) {
              case 'progress': handlers.onProgress?.(data); break;
              case 'suggestions': handlers.onSuggestions?.(data); break;
              case 'tokens': handlers.onTokens?.(data); break;
              case 'done': handlers.onDone?.(data); break;
              case 'error': handlers.onError?.(data); break;
              case 'cancelled': handlers.onCancelled?.(); break;
            }
          }
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        handlers.onError?.({ message: err.message });
      }
    }
  })();
  
  return {
    cancel: async () => {
      abortController.abort();
      const sid = await sessionIdPromise;
      if (sid) {
        await fetch(`${WORKER_API_BASE}/match/cancel/${sid}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
      }
    },
    sessionId: sessionIdPromise,
  };
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/api.ts
git commit -m "feat: add matchAnalyze SSE helper to API library"
```

---

### Task 6: Frontend — Chat Sidebar Notifications

**Files:**
- Modify: `frontend/src/components/Chatbot.tsx`
- Modify: `frontend/src/components/Layout.tsx`

**Interfaces:**
- Consumes: nothing
- Produces: Chat status messages, highlighted bubble, chat icon badge

- [ ] **Step 1: Add match status message support to Chatbot.tsx**

Add a new prop and state for match status messages:

```typescript
interface ChatbotPanelProps {
  onClose?: () => void;
  className?: string;
  matchStatus?: { message: string; phase: string } | null; // NEW
}
```

Add a useEffect to display match status as a system message:

```typescript
useEffect(() => {
  if (matchStatus) {
    setMessages(prev => {
      // Remove previous match status messages
      const filtered = prev.filter(m => !m.content.startsWith('[MATCH_STATUS]'));
      return [...filtered, { role: 'assistant', content: `[MATCH_STATUS] ${matchStatus.message}` }];
    });
  }
}, [matchStatus]);
```

Update the message rendering to style match status messages differently:

```typescript
{/* In the message rendering loop */}
{m.content.startsWith('[MATCH_STATUS]') ? (
  <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 my-2 animate-pulse">
    <div className="flex items-center gap-2 text-sm text-blue-700">
      <Sparkles className="h-4 w-4" />
      {m.content.replace('[MATCH_STATUS]', '')}
    </div>
  </div>
) : (
  // existing message rendering
)}
```

- [ ] **Step 2: Add chat icon highlight animation to Layout.tsx**

Find the desktop chat reopen button (line ~519-526) and add a highlight state:

```typescript
// Add state for match activity
const [hasMatchActivity, setHasMatchActivity] = useState(false);

// Pass to Chatbot
<Chatbot onClose={() => setChatDesktopOpen(false)} className="h-full" matchActivity={hasMatchActivity} />
```

Update the chat reopen button with highlight:

```typescript
{!chatDesktopOpen && (
  <button
    onClick={() => setChatDesktopOpen(true)}
    className={`hidden lg:flex fixed right-0 top-1/2 -translate-y-1/2 z-30 w-6 h-12 items-center justify-center bg-card border rounded-l-md hover:bg-muted cursor-pointer shadow-sm ${hasMatchActivity ? 'animate-pulse bg-blue-100 border-blue-300' : ''}`}
    title="展開 AI 對話">
    <MessageCircle className={`h-4 w-4 ${hasMatchActivity ? 'text-blue-600' : ''}`} />
    {hasMatchActivity && (
      <span className="absolute -top-1 -right-1 w-3 h-3 bg-blue-500 rounded-full animate-ping" />
    )}
  </button>
)}
```

- [ ] **Step 3: Verify the files compile**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/Chatbot.tsx frontend/src/components/Layout.tsx
git commit -m "feat: add chat sidebar match status notifications with highlight"
```

---

### Task 7: Frontend — Update Existing Modals with AI Toggle

**Files:**
- Modify: `frontend/src/components/AutoMatchReviewModal.tsx`
- Modify: `frontend/src/components/MatchSuggestionsModal.tsx`

**Interfaces:**
- Consumes: `LLMMatchModal` from Task 4
- Produces: AI toggle in existing modals

- [ ] **Step 1: Add AI toggle to AutoMatchReviewModal.tsx**

Add a new prop and state:

```typescript
export default function AutoMatchReviewModal({ matches, onConfirm, onReject, onClose, useAI = true, onToggleAI }: {
  matches: any[];
  onConfirm: (txId: string, invoiceId: string | null, invoiceIds?: string[]) => void | Promise<void>;
  onReject: (txId: string) => void | Promise<void>;
  onClose: () => void;
  useAI?: boolean;
  onToggleAI?: (enabled: boolean) => void;
}) {
```

Add a toggle button in the header area:

```typescript
{onToggleAI && (
  <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
    <input
      type="checkbox"
      checked={useAI}
      onChange={e => onToggleAI(e.target.checked)}
      className="rounded border-muted-foreground/30"
    />
    {tr('Use AI matching', '使用 AI 配對', '使用 AI 配对')}
  </label>
)}
```

- [ ] **Step 2: Add AI toggle to MatchSuggestionsModal.tsx**

Find the tabs section and add an AI toggle per tab:

```typescript
// Add state for AI matching
const [useAI, setUseAI] = useState(true);

// In each tab header, add toggle
<button
  onClick={() => setUseAI(!useAI)}
  className={`text-xs px-2 py-1 rounded ${useAI ? 'bg-blue-100 text-blue-700' : 'bg-muted text-muted-foreground'}`}
>
  {useAI ? 'AI On' : 'AI Off'}
</button>
```

- [ ] **Step 3: Verify the files compile**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/AutoMatchReviewModal.tsx frontend/src/components/MatchSuggestionsModal.tsx
git commit -m "feat: add AI matching toggle to existing modals"
```

---

### Task 8: Frontend — Integrate LLM Modal into Pages

**Files:**
- Modify: `frontend/src/pages/BankStatements.tsx`
- Modify: `frontend/src/pages/AP.tsx`
- Modify: `frontend/src/pages/AR.tsx`

**Interfaces:**
- Consumes: `LLMMatchModal` from Task 4, `matchAnalyze` from Task 5
- Produces: Pages use LLM modal when AI toggle is on

- [ ] **Step 1: Update BankStatements.tsx to use LLM modal**

Find the auto-match button handler and add LLM modal state:

```typescript
const [showLLMModal, setShowLLMModal] = useState(false);
const [matchType, setMatchType] = useState<'bank-invoice' | 'receipt-invoice'>('bank-invoice');

// In the auto-match button onClick:
const handleAutoMatch = () => {
  if (useAI) {
    setMatchType('bank-invoice');
    setShowLLMModal(true);
  } else {
    // Existing rule-based logic
    autoMatchMutation.mutate();
  }
};
```

Add the modal render:

```typescript
{showLLMModal && (
  <LLMMatchModal
    type={matchType}
    onConfirm={async (txId, invoiceId, invoiceIds) => {
      // Call existing confirm endpoint
      await confirmMatch(txId, invoiceId, invoiceIds);
    }}
    onReject={async (txId) => {
      // Call existing reject endpoint
      await rejectMatch(txId);
    }}
    onClose={() => setShowLLMModal(false)}
  />
)}
```

- [ ] **Step 2: Update AP.tsx to use LLM modal for receipt matching**

Similar pattern — add state for LLM modal, toggle between rule-based and AI matching.

- [ ] **Step 3: Update AR.tsx to use LLM modal for receipt matching**

Same pattern as AP.tsx.

- [ ] **Step 4: Verify the files compile**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/BankStatements.tsx frontend/src/pages/AP.tsx frontend/src/pages/AR.tsx
git commit -m "feat: integrate LLM match modal into BankStatements, AP, and AR pages"
```

---

### Task 9: Frontend — Token Counting Integration

**Files:**
- Modify: `frontend/src/components/LLMMatchModal.tsx` (from Task 4)

**Interfaces:**
- Consumes: `writeTokenUsage()` from `TokenPopup.tsx`
- Produces: Token counts accumulated in sessionStorage

- [ ] **Step 1: Add token accumulation to LLMMatchModal**

In the SSE stream handler, when tokens event is received:

```typescript
case 'tokens':
  handlers.onTokens?.(data);
  // Accumulate token usage like OCR does
  writeTokenUsage({
    prompt: data.prompt || 0,
    completion: data.completion || 0,
    total: data.total || 0,
  });
  break;
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/LLMMatchModal.tsx
git commit -m "feat: add token counting to LLM match modal"
```

---

### Task 10: Final Verification

**Files:**
- All modified files

**Interfaces:**
- Consumes: all tasks above
- Produces: working feature

- [ ] **Step 1: Run full TypeScript check for backend**

Run: `cd api && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Run full TypeScript check for frontend**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Test the API route manually**

Run: `curl -X POST http://localhost:8787/api/match/llm-analyze -H "Content-Type: application/json" -H "Authorization: Bearer <token>" -d '{"type":"bank-invoice"}'`
Expected: SSE stream with progress events

- [ ] **Step 4: Test the chat tool**

Send message to chatbot: "Match my bank statements to invoices"
Expected: AI calls match_documents tool, returns results

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete LLM-powered document matching feature"
```
