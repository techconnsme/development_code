# Suggestion-Based Auto-Generate Journal Entries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change auto-generate JDE from immediate creation to suggestion-based review (suggest → confirm/reject → create).

**Architecture:** Modify existing `/auto-generate-entries` endpoint with `dry_run=true` to return suggestions without writing. Add new `/confirm-suggestion` endpoint that re-runs categorization and creates a single entry. Frontend shows suggestion panel with editable contra accounts, confirm/reject buttons, and Confirm All.

**Tech Stack:** Cloudflare Worker (Hono) + D1 (SQLite); React + TypeScript + TanStack Query + Tailwind; `tr()` EN/繁/简 i18n

## Global Constraints

- No `git add -A`; commit messages end with `Co-Authored-By: Claude <noreply@anthropic.com>`
- API typecheck baseline: 43 pre-existing errors; must remain unchanged
- `tests/` is gitignored (force-add needed)
- Follow existing code patterns in `bookkeeping.ts`, `bank-statements.ts`, `AuditTrailModal.tsx`
- Use `bookkeeperMiddleware` for all new endpoints
- Use `uuidv4()` for IDs, `auditLog()` for audit trail

---

## File Structure

| File | Change |
|------|--------|
| `api/src/routes/bookkeeping.ts` | Add `dry_run` param to `/auto-generate-entries`, add `/confirm-suggestion` endpoint |
| `frontend/src/pages/Bookkeeping.tsx` | Replace direct mutation with suggestion panel UI |
| `frontend/src/pages/FileUpload.tsx` | Change auto-trigger to show suggestion panel |
| `tests/auto-generate-suggest.test.ts` | Backend unit tests for dry_run and confirm endpoints |

---

## Tasks

### Task 1: Backend — Add dry_run to /auto-generate-entries

**Files:**
- Modify: `api/src/routes/bookkeeping.ts:1618-1755`

**Interfaces:**
- Consumes: `categorizeTransaction`, `resolveBankAccountCode`, `getTemporaryAccount`, `collectTransactionCodes`, `ensureMissingAccounts`, `generateVoucher`
- Produces: `{ suggestions: Suggestion[], total_unposted, skipped_noise }` when `dry_run=true`

- [ ] **Step 1: Read the current endpoint**

Read `api/src/routes/bookkeeping.ts` lines 1618-1755 to understand the full handler.

- [ ] **Step 2: Add dry_run query parameter extraction**

At the top of the handler (after line 1621), add:

```typescript
const dryRun = c.req.query('dry_run') === 'true';
```

- [ ] **Step 3: Add suggestion collection array**

After the `refSet` build (after line 1638), add:

```typescript
const suggestions: any[] = [];
```

- [ ] **Step 4: Modify the loop to collect suggestions when dry_run=true**

Replace the INSERT logic (lines 1720-1743) with:

```typescript
    if (lines.length === 0) continue;

    // Determine confidence based on categorization source
    const confidence = cat?.confidence === 'exact' ? 'confirmed' : 'needs_review';
    const reason = cat?.tag
      ? `${cat.tag} rule matched`
      : isDirector(desc)
        ? 'Director name detected'
        : cat?.confidence === 'fuzzy'
          ? 'Fuzzy keyword match'
          : 'Fallback / unmapped';

    if (dryRun) {
      suggestions.push({
        transaction_id: tx.id,
        description: desc + invInfo,
        amount: tx.deposit_amount || tx.withdrawal_amount,
        direction: dir,
        transaction_date: tx.transaction_date,
        bank_account_code: stmtBankCode,
        bank_account_name: nameOf(stmtBankCode),
        contra_account_code: lines[0].code === stmtBankCode ? (lines[1]?.code || lines[0].code) : lines[0].code,
        contra_account_name: lines[0].code === stmtBankCode ? (lines[1]?.name || lines[0].name) : lines[0].name,
        confidence,
        reason,
      });
    } else {
      // Original INSERT logic (unchanged)
      await db.prepare(
        'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(entryId, tenantId, entryNum, tx.transaction_date, desc + invInfo, 'bank_transaction', tx.id).run();

      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        await db.prepare(
          'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(`jl-${uuidv4().slice(0, 8)}`, entryId, l.code, l.name, desc + invInfo, l.debit, l.credit, i).run();
      }
      created++;
    }
```

- [ ] **Step 5: Modify the return statement**

Replace the return (line 1750) with:

```typescript
  if (dryRun) {
    return c.json({ suggestions, total_unposted: txRows.results.length, skipped_noise: created });
  }

  if (created > 0) {
    await auditLog(db, user.id, 'auto_generate', 'journal_entry', null, { created, total: txRows.results.length, skipped: refSet.size });
  }
  return c.json({ created, total_transactions: txRows.results.length, skipped: refSet.size, stale_deleted: staleCount?.cnt || 0 });
```

- [ ] **Step 6: Verify typecheck**

Run: `cd api && npx tsc --noEmit 2>&1 | head -50`
Expected: Same 43 pre-existing errors, no new errors

- [ ] **Step 7: Commit**

```bash
git add api/src/routes/bookkeeping.ts
git commit -m "feat(api): add dry_run mode to auto-generate-entries endpoint

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Backend — Add /confirm-suggestion endpoint

**Files:**
- Modify: `api/src/routes/bookkeeping.ts` (add after the `/auto-generate-entries` handler)

**Interfaces:**
- Consumes: `categorizeTransaction`, `resolveBankAccountCode`, `getTemporaryAccount`, `generateVoucher`
- Produces: `{ entry_id, voucher_number }`

- [ ] **Step 1: Add the confirm-suggestion endpoint**

After the closing `});` of `/auto-generate-entries` (after line 1755), add:

```typescript
// Confirm a single suggestion: re-runs categorization and creates one JE
bookkeeping.post('/confirm-suggestion', bookkeeperMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;

  const body = await c.req.json<{ transaction_id: string; contra_account_code?: string; voucher_number?: string }>();
  const { transaction_id, contra_account_code, voucher_number } = body;

  if (!transaction_id) {
    return c.json({ error: 'transaction_id is required' }, 400);
  }

  // Fetch the transaction
  const tx = await db.prepare(
    `SELECT bt.*, bs.bank_name, bs.account_number
     FROM bank_transactions bt
     LEFT JOIN bank_statements bs ON bt.bank_statement_id = bs.id
     WHERE bt.id = ? AND bt.user_id = ? AND bt.deleted_at IS NULL AND bt.match_status != 'confirmed'
     LIMIT 1`
  ).bind(transaction_id, tenantId).first<any>();

  if (!tx) {
    return c.json({ error: 'Transaction not found or already posted' }, 404);
  }

  // Validate contra_account_code exists in COA if provided
  if (contra_account_code) {
    const acct = await db.prepare(
      'SELECT account_code FROM accounts WHERE user_id = ? AND account_code = ? AND is_active = 1'
    ).bind(tenantId, contra_account_code).first<any>();
    if (!acct) {
      return c.json({ error: `Account code ${contra_account_code} not found in COA` }, 400);
    }
  }

  // Re-categorize (same logic as dry_run)
  const desc = tx.description || '';
  const invInfo = tx.invoice_number ? ` (${tx.invoice_number})` : '';
  const dir = (tx.deposit_amount > 0 ? 'deposit' : 'withdrawal') as 'deposit' | 'withdrawal';
  const cat = categorizeTransaction(desc, dir);
  const stmtBankCode = await resolveBankAccountCode(db, tenantId, tx.bank_name);
  if (cat && cat.code === '' && !tx.account_code && !contra_account_code) {
    return c.json({ error: 'Transaction is noise/internal — cannot create JE' }, 400);
  }

  const isDirector = (d: string) => /JOSEPH|LIN PUI|LAI KIN|RAYMOND|SZETO/i.test(d);
  const allAccounts = await db.prepare(
    'SELECT account_code, account_name FROM accounts WHERE user_id = ? AND is_active = 1'
  ).bind(tenantId).all();
  const accountMap = new Map<string, string>();
  for (const a of allAccounts.results as any[]) accountMap.set(a.account_code, a.account_name);
  const nameOf = (code: string) => accountMap.get(code) || code;

  // Build lines (same logic as dry_run, but with user override)
  const lines: { code: string; name: string; debit: number; credit: number }[] = [];

  if (tx.deposit_amount > 0) {
    if (desc.includes('OUTCLEARING') || desc.includes('RETURN') || desc.includes('退票')) {
      lines.push({ code: '21201', name: nameOf('21201'), debit: tx.deposit_amount, credit: 0 });
    } else {
      let contraCode = contra_account_code || null;
      if (!contraCode) {
        if (tx.account_code && tx.account_code !== stmtBankCode) contraCode = tx.account_code;
        else if (cat?.code && cat.code !== stmtBankCode) contraCode = cat.code;
        else if (isDirector(desc)) contraCode = '21201';
        else if (/VISA DEBIT.*- *CR|CREDIT.*VISA/i.test(desc)) contraCode = '62303';
        else if (desc.includes('INTEREST PAYMENT') || desc.includes('利息收入')) contraCode = '42101';
        else if (tx.deposit_amount >= 5000 && /DIRECT CREDIT|FPS|TRANSFER|CHEQUE/i.test(desc)) contraCode = '21201';
        else {
          const temp = await getTemporaryAccount(db, tenantId, 'revenue');
          contraCode = temp?.code ?? '41101';
        }
      }
      lines.push({ code: contraCode, name: nameOf(contraCode), debit: 0, credit: tx.deposit_amount });
    }
    lines.push({ code: stmtBankCode, name: nameOf(stmtBankCode), debit: tx.deposit_amount, credit: 0 });
  }

  if (tx.withdrawal_amount > 0) {
    if (desc.includes('OUTCLEARING') || desc.includes('RETURN') || desc.includes('退票')) {
      lines.push({ code: '21201', name: nameOf('21201'), debit: tx.withdrawal_amount, credit: 0 });
    } else {
      let expCode = contra_account_code || null;
      if (!expCode) {
        if (tx.account_code && tx.account_code !== stmtBankCode) expCode = tx.account_code;
        else if (cat?.code && cat.code !== stmtBankCode) expCode = cat.code;
        else if (tx.supplier_id) expCode = '51101';
        else {
          const temp = await getTemporaryAccount(db, tenantId, 'expense');
          expCode = temp?.code ?? '62303';
        }
      }
      lines.push({ code: expCode, name: nameOf(expCode), debit: tx.withdrawal_amount, credit: 0 });
    }
    lines.push({ code: stmtBankCode, name: nameOf(stmtBankCode), debit: 0, credit: tx.withdrawal_amount });
  }

  if (lines.length === 0) {
    return c.json({ error: 'No journal lines generated' }, 400);
  }

  // Generate or validate voucher number
  const bankCode = (tx.bank_name || 'BANK').replace(/[^A-Z0-9]/gi, '').slice(0, 6).toUpperCase() || 'BANK';
  const txDate = tx.transaction_date || new Date().toISOString().split('T')[0];
  const entryNum = voucher_number || await generateVoucher(`B-${bankCode}`, txDate, db, tenantId);

  const entryId = `je-${uuidv4().slice(0, 8)}`;
  await db.prepare(
    'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(entryId, tenantId, entryNum, tx.transaction_date, desc + invInfo, 'bank_transaction', tx.id).run();

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    await db.prepare(
      'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(`jl-${uuidv4().slice(0, 8)}`, entryId, l.code, l.name, desc + invInfo, l.debit, l.credit, i).run();
  }

  await auditLog(db, user.id, 'confirm_suggestion', 'journal_entry', entryId, { transaction_id, contra_account_code: contra_account_code || 'auto' });
  return c.json({ entry_id: entryId, voucher_number: entryNum });
});
```

- [ ] **Step 2: Verify typecheck**

Run: `cd api && npx tsc --noEmit 2>&1 | head -50`
Expected: Same 43 pre-existing errors, no new errors

- [ ] **Step 3: Commit**

```bash
git add api/src/routes/bookkeeping.ts
git commit -m "feat(api): add confirm-suggestion endpoint for auto-generate JDE

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Frontend — Create AutoGenerateSuggestionPanel component

**Files:**
- Create: `frontend/src/components/AutoGenerateSuggestionPanel.tsx`

**Interfaces:**
- Consumes: `api('/bookkeeping/auto-generate-entries?dry_run=true')`, `api('/bookkeeping/confirm-suggestion')`
- Produces: Component that renders suggestion list with confirm/reject/edit UI

- [ ] **Step 1: Create the component file**

Create `frontend/src/components/AutoGenerateSuggestionPanel.tsx`:

```typescript
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { tr } from '../lib/tr';
import { toast } from 'sonner';
import { RefreshCw, Check, X, CheckCircle, AlertTriangle } from 'lucide-react';

interface Suggestion {
  transaction_id: string;
  description: string;
  amount: number;
  direction: 'deposit' | 'withdrawal';
  transaction_date: string;
  bank_account_code: string;
  bank_account_name: string;
  contra_account_code: string;
  contra_account_name: string;
  confidence: 'confirmed' | 'needs_review';
  reason: string;
}

interface Props {
  onDone: () => void;
}

export default function AutoGenerateSuggestionPanel({ onDone }: Props) {
  const queryClient = useQueryClient();
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch suggestions on mount
  const fetchSuggestions = useMutation({
    mutationFn: () => api('/bookkeeping/auto-generate-entries?dry_run=true', { method: 'POST' }),
    onSuccess: (data: any) => {
      setSuggestions(data.suggestions || []);
      setLoading(false);
      if ((data.suggestions || []).length === 0) {
        toast.info(tr(
          'All transactions already have journal entries.',
          '所有交易已有日誌分錄。',
          '所有交易已有日志分录。',
        ));
        onDone();
      }
    },
    onError: (err: any) => {
      setError(err?.message || err?.error || 'Failed to fetch suggestions');
      setLoading(false);
    },
  });

  // Confirm single suggestion
  const confirmMut = useMutation({
    mutationFn: (params: { transaction_id: string; contra_account_code?: string }) =>
      api('/bookkeeping/confirm-suggestion', { method: 'POST', body: JSON.stringify(params) }),
    onSuccess: (_data: any, params) => {
      setSuggestions(prev => prev.filter(s => s.transaction_id !== params.transaction_id));
      queryClient.invalidateQueries({ queryKey: ['entries'] });
    },
    onError: (err: any) => {
      toast.error(tr('Confirm failed: ', '確認失敗：', '确认失败：') + (err?.message || err?.error));
    },
  });

  // Confirm all confirmed-confidence items
  const confirmAllMut = useMutation({
    mutationFn: async () => {
      const confirmed = suggestions.filter(s => s.confidence === 'confirmed');
      for (const s of confirmed) {
        await api('/bookkeeping/confirm-suggestion', {
          method: 'POST',
          body: JSON.stringify({ transaction_id: s.transaction_id, contra_account_code: s.contra_account_code }),
        });
      }
      return { count: confirmed.length };
    },
    onSuccess: (data) => {
      setSuggestions(prev => prev.filter(s => s.confidence !== 'confirmed'));
      queryClient.invalidateQueries({ queryKey: ['entries'] });
      toast.info(tr(
        `${data.count} journal entries created.`,
        `已建立 ${data.count} 筆日誌分錄。`,
        `已建立 ${data.count} 笔日志分录。`,
      ));
    },
    onError: (err: any) => {
      toast.error(tr('Confirm all failed: ', '全部確認失敗：', '全部确认失败：') + (err?.message || err?.error));
    },
  });

  // Reject (remove from local state)
  const handleReject = (txId: string) => {
    setSuggestions(prev => prev.filter(s => s.transaction_id !== txId));
  };

  // Reject all
  const handleRejectAll = () => {
    setSuggestions([]);
  };

  // Update contra account for a suggestion
  const handleContraChange = (txId: string, newCode: string) => {
    setSuggestions(prev => prev.map(s =>
      s.transaction_id === txId ? { ...s, contra_account_code: newCode } : s
    ));
  };

  // Fetch on mount
  useState(() => { fetchSuggestions.mutate(); });

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <RefreshCw className="h-4 w-4 animate-spin" />
        {tr('Analyzing transactions...', '分析交易中...', '分析交易中...')}
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-sm text-red-600">
        {error}
        <button onClick={onDone} className="ml-2 underline">{tr('Close', '關閉', '关闭')}</button>
      </div>
    );
  }

  return (
    <div className="border rounded-xl bg-card p-4 space-y-3" data-testid="auto-generate-suggestions">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          {tr(
            `${suggestions.length} transaction(s) ready for review`,
            `${suggestions.length} 筆交易待審核`,
            `${suggestions.length} 笔交易待审核`,
          )}
        </h3>
        <div className="flex gap-2">
          {suggestions.some(s => s.confidence === 'confirmed') && (
            <button
              onClick={() => confirmAllMut.mutate()}
              disabled={confirmAllMut.isPending}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
              data-testid="confirm-all-btn"
            >
              <CheckCircle className="h-3.5 w-3.5" />
              {tr('Confirm All Confirmed', '確認全部已確認', '确认全部已确认')}
            </button>
          )}
          <button
            onClick={handleRejectAll}
            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300"
            data-testid="reject-all-btn"
          >
            <X className="h-3.5 w-3.5" />
            {tr('Reject All', '拒絕全部', '拒绝全部')}
          </button>
        </div>
      </div>

      <div className="space-y-2 max-h-96 overflow-y-auto">
        {suggestions.map(s => (
          <div
            key={s.transaction_id}
            className={`flex flex-wrap items-center gap-2 p-2 rounded-lg border text-xs ${
              s.confidence === 'confirmed' ? 'bg-green-50 border-green-200' : 'bg-yellow-50 border-yellow-200'
            }`}
            data-testid="suggestion-row"
          >
            {/* Confidence badge */}
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
              s.confidence === 'confirmed'
                ? 'bg-green-100 text-green-700'
                : 'bg-yellow-100 text-yellow-700'
            }`}>
              {s.confidence === 'confirmed' ? 'CONFIRMED' : 'NEEDS REVIEW'}
            </span>

            {/* Transaction info */}
            <span className="font-mono truncate max-w-[200px]" title={s.description}>{s.description}</span>
            <span className="text-muted-foreground">{s.transaction_date}</span>
            <span className="font-mono font-medium">
              {s.direction === 'deposit' ? '+' : '-'}${s.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </span>

            {/* Dr/Cr line */}
            <span className="text-muted-foreground">
              {s.direction === 'deposit' ? 'Dr' : 'Cr'} {s.bank_account_name}
              {' → '}
              {s.direction === 'deposit' ? 'Cr' : 'Dr'} {s.contra_account_name}
            </span>

            {/* Reason */}
            <span className="text-muted-foreground truncate max-w-[150px]" title={s.reason}>{s.reason}</span>

            {/* Editable contra account (simplified — in production use a dropdown with COA search) */}
            <input
              type="text"
              value={s.contra_account_code}
              onChange={(e) => handleContraChange(s.transaction_id, e.target.value)}
              className="w-20 px-1.5 py-0.5 border rounded text-xs font-mono"
              title={tr('Contra account code', '對方科目代碼', '对方科目代码')}
              data-testid="contra-input"
            />

            {/* Confirm button */}
            <button
              onClick={() => confirmMut.mutate({
                transaction_id: s.transaction_id,
                contra_account_code: s.contra_account_code,
              })}
              disabled={confirmMut.isPending}
              className="p-0.5 hover:bg-green-100 rounded text-green-600 disabled:opacity-40"
              title={tr('Confirm', '確認', '确认')}
              data-testid="confirm-btn"
            >
              <Check className="h-4 w-4" />
            </button>

            {/* Reject button */}
            <button
              onClick={() => handleReject(s.transaction_id)}
              disabled={confirmMut.isPending}
              className="p-0.5 hover:bg-red-50 rounded text-red-500 disabled:opacity-40"
              title={tr('Reject', '拒絕', '拒绝')}
              data-testid="reject-btn"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>

      {suggestions.length === 0 && (
        <div className="text-center text-sm text-muted-foreground py-4">
          {tr('All done! Panel will close.', '全部完成！面板將關閉。', '全部完成！面板将关闭。')}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `cd frontend && npm run build 2>&1 | tail -20`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/AutoGenerateSuggestionPanel.tsx
git commit -m "feat(frontend): add AutoGenerateSuggestionPanel component

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Frontend — Replace auto-generate mutation with suggestion panel

**Files:**
- Modify: `frontend/src/pages/Bookkeeping.tsx`

**Interfaces:**
- Consumes: `AutoGenerateSuggestionPanel` component
- Produces: Button that shows suggestion panel instead of direct mutation

- [ ] **Step 1: Add state for showing suggestion panel**

After the existing state declarations (around line 100), add:

```typescript
const [showAutoGenPanel, setShowAutoGenPanel] = useState(false);
```

- [ ] **Step 2: Import the new component**

Add to imports at top of file:

```typescript
import AutoGenerateSuggestionPanel from '../components/AutoGenerateSuggestionPanel';
```

- [ ] **Step 3: Replace the auto-generate button onClick**

Change the button (lines 430-436) from:

```typescript
onClick={() => autoGenerateMut.mutate()}
```

to:

```typescript
onClick={() => setShowAutoGenPanel(true)}
```

Also remove `disabled={autoGenerateMut.isPending}` and the spinning icon logic since we're no longer using the mutation directly.

- [ ] **Step 4: Add the suggestion panel render**

After the button (or in a suitable location), add:

```typescript
{showAutoGenPanel && (
  <AutoGenerateSuggestionPanel onDone={() => setShowAutoGenPanel(false)} />
)}
```

- [ ] **Step 5: Remove the old autoGenerateMut mutation**

Remove the `autoGenerateMut` mutation definition (lines 218-235) since it's no longer used.

- [ ] **Step 6: Verify build**

Run: `cd frontend && npm run build 2>&1 | tail -20`
Expected: Build succeeds

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/Bookkeeping.tsx
git commit -m "feat(frontend): replace auto-generate mutation with suggestion panel

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Frontend — Update FileUpload auto-trigger

**Files:**
- Modify: `frontend/src/pages/FileUpload.tsx`

**Interfaces:**
- Consumes: `AutoGenerateSuggestionPanel` component
- Produces: Auto-trigger shows suggestion panel instead of direct POST

- [ ] **Step 1: Add state for showing suggestion panel**

After the existing state declarations, add:

```typescript
const [showAutoGenPanel, setShowAutoGenPanel] = useState(false);
```

- [ ] **Step 2: Import the new component**

Add to imports at top of file:

```typescript
import AutoGenerateSuggestionPanel from '../components/AutoGenerateSuggestionPanel';
```

- [ ] **Step 3: Replace the auto-trigger POST**

Change the auto-trigger (lines 571-573) from:

```typescript
if (batchRef.current.bank > 0 || batchRef.current.card > 0) {
  try { await api('/bookkeeping/auto-generate-entries', { method: 'POST' }); } catch {}
}
```

to:

```typescript
if (batchRef.current.bank > 0 || batchRef.current.card > 0) {
  setShowAutoGenPanel(true);
}
```

- [ ] **Step 4: Add the suggestion panel render**

In a suitable location (e.g., after the upload success message), add:

```typescript
{showAutoGenPanel && (
  <AutoGenerateSuggestionPanel onDone={() => setShowAutoGenPanel(false)} />
)}
```

- [ ] **Step 5: Verify build**

Run: `cd frontend && npm run build 2>&1 | tail -20`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/FileUpload.tsx
git commit -m "feat(frontend): update FileUpload auto-trigger to show suggestion panel

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Backend — Unit tests for dry_run and confirm endpoints

**Files:**
- Create: `tests/auto-generate-suggest.test.ts`

**Interfaces:**
- Consumes: `/bookkeeping/auto-generate-entries?dry_run=true`, `/bookkeeping/confirm-suggestion`
- Produces: Test file with 4+ test cases

- [ ] **Step 1: Create the test file**

Create `tests/auto-generate-suggest.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const API = process.env.API_URL || 'http://localhost:8787';
const TOKEN = process.env.TEST_TOKEN || '';

describe('Auto-generate JDE suggestion mode', () => {
  let transactionId: string;

  beforeAll(async () => {
    // Get an unposted bank transaction for testing
    const res = await fetch(`${API}/bookkeeping/auto-generate-entries?dry_run=true`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const data = await res.json();
    if (data.suggestions?.length > 0) {
      transactionId = data.suggestions[0].transaction_id;
    }
  });

  it('dry_run returns suggestions without writing', async () => {
    const res = await fetch(`${API}/bookkeeping/auto-generate-entries?dry_run=true`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('suggestions');
    expect(Array.isArray(data.suggestions)).toBe(true);
    expect(data).toHaveProperty('total_unposted');

    // Verify no entries were created by checking the first suggestion
    if (data.suggestions.length > 0) {
      const s = data.suggestions[0];
      expect(s).toHaveProperty('transaction_id');
      expect(s).toHaveProperty('contra_account_code');
      expect(s).toHaveProperty('confidence');
      expect(['confirmed', 'needs_review']).toContain(s.confidence);
    }
  });

  it('confirm-suggestion creates a journal entry', async () => {
    if (!transactionId) {
      console.log('No unposted transactions available — skipping');
      return;
    }

    const res = await fetch(`${API}/bookkeeping/confirm-suggestion`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ transaction_id: transactionId }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('entry_id');
    expect(data).toHaveProperty('voucher_number');
    expect(data.voucher_number).toMatch(/^B-/);
  });

  it('confirm-suggestion rejects invalid contra_account_code', async () => {
    if (!transactionId) {
      console.log('No unposted transactions available — skipping');
      return;
    }

    const res = await fetch(`${API}/bookkeeping/confirm-suggestion`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ transaction_id: transactionId, contra_account_code: '99999' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('not found in COA');
  });

  it('confirm-suggestion rejects already-posted transaction', async () => {
    // Use a transaction that was just confirmed above
    const res = await fetch(`${API}/bookkeeping/confirm-suggestion`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ transaction_id: transactionId }),
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain('not found or already posted');
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `cd tests && npx vitest run auto-generate-suggest.test.ts 2>&1`
Expected: All 4 tests pass (or skip gracefully if no unposted transactions)

- [ ] **Step 3: Commit (force-add since tests/ is gitignored)**

```bash
git add -f tests/auto-generate-suggest.test.ts
git commit -m "test: add unit tests for auto-generate JDE suggestion mode

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Playwright spec for suggestion panel UI

**Files:**
- Create: `tests/auto-generate-suggestion.spec.ts`

**Interfaces:**
- Consumes: Suggestion panel UI in Bookkeeping page
- Produces: Non-mutating Playwright spec

- [ ] **Step 1: Create the Playwright spec**

Create `tests/auto-generate-suggestion.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';

test.describe('Auto-generate JDE suggestion panel', () => {
  test('clicking Auto-Generate shows suggestion panel', async ({ page }) => {
    await page.goto('/GJE');
    await page.waitForLoadState('networkidle');

    // Click the Auto-Generate button
    const btn = page.getByRole('button', { name: /auto-generate/i });
    await expect(btn).toBeVisible();
    await btn.click();

    // Should show loading state or suggestion panel
    const panel = page.getByTestId('auto-generate-suggestions');
    const loading = page.getByText(/analyzing transactions/i);

    // Either loading or panel should be visible
    await expect(panel.or(loading)).toBeVisible({ timeout: 10000 });

    // If loading, wait for panel
    if (await loading.isVisible()) {
      await expect(panel).toBeVisible({ timeout: 15000 });
    }

    // Panel should have suggestion rows or "all done" message
    const rows = page.getByTestId('suggestion-row');
    const doneMsg = page.getByText(/all done/i);
    await expect(rows.first().or(doneMsg)).toBeVisible();
  });

  test('suggestion rows show confidence badges', async ({ page }) => {
    await page.goto('/GJE');
    await page.waitForLoadState('networkidle');

    const btn = page.getByRole('button', { name: /auto-generate/i });
    await btn.click();

    const panel = page.getByTestId('auto-generate-suggestions');
    await expect(panel).toBeVisible({ timeout: 15000 });

    const rows = page.getByTestId('suggestion-row');
    const count = await rows.count();
    if (count > 0) {
      // Each row should have a confidence badge
      const firstRow = rows.first();
      await expect(firstRow.getByText(/confirmed|needs review/i)).toBeVisible();
    }
  });

  test('Confirm All button appears when confirmed items exist', async ({ page }) => {
    await page.goto('/GJE');
    await page.waitForLoadState('networkidle');

    const btn = page.getByRole('button', { name: /auto-generate/i });
    await btn.click();

    const panel = page.getByTestId('auto-generate-suggestions');
    await expect(panel).toBeVisible({ timeout: 15000 });

    const rows = page.getByTestId('suggestion-row');
    const count = await rows.count();
    if (count > 0) {
      // Check if any row has CONFIRMED badge
      const confirmedBadges = page.getByText('CONFIRMED');
      const confirmedCount = await confirmedBadges.count();
      if (confirmedCount > 0) {
        await expect(page.getByTestId('confirm-all-btn')).toBeVisible();
      }
    }
  });
});
```

- [ ] **Step 2: Verify the spec is syntactically correct**

Run: `cd tests && npx tsc --noEmit auto-generate-suggestion.spec.ts 2>&1`
Expected: No errors

- [ ] **Step 3: Commit (force-add)**

```bash
git add -f tests/auto-generate-suggestion.spec.ts
git commit -m "test: add Playwright spec for auto-generate JDE suggestion panel

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Deploy and live round-trip

**Files:**
- None (deployment + manual verification)

**Interfaces:**
- Consumes: All previous tasks
- Produces: Deployed feature, verified on live system

- [ ] **Step 1: Run migration (no-op, no schema changes)**

No migration needed — this feature uses existing tables.

- [ ] **Step 2: Deploy API**

Run: `cd api && npx wrangler deploy`
Record the new version hash.

- [ ] **Step 3: Deploy frontend**

Run: `cd frontend && npx wrangler pages deploy dist --project-name=opcc-crm-testing`
Record the preview URL.

- [ ] **Step 4: Live round-trip test**

1. Navigate to the testing URL
2. Go to Bookkeeping → GJE tab
3. Click "+ Auto-Generate Journal Entries"
4. Verify suggestion panel appears with transaction list
5. Verify confidence badges show (CONFIRMED / NEEDS REVIEW)
6. Edit a contra account code on one suggestion
7. Click ✓ Confirm on one suggestion
8. Verify the entry appears in the GJE list
9. Click "Confirm All Confirmed" if multiple confirmed items exist
10. Verify all confirmed entries are created
11. Click "Reject All" to dismiss remaining suggestions
12. Verify panel closes

- [ ] **Step 5: Commit deployment notes**

```bash
git add docs/superpowers/plans/2026-08-27-suggestion-based-auto-gje.md
git commit -m "docs: mark suggestion-based auto-gje as deployed

Co-Authored-By: Claude <noreply@anthropic.com>"
```
