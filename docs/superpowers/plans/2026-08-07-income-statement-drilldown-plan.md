# Income Statement Transaction Drill-Down — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add transaction-level drill-down to the Income Statement. Clicking a COA account code opens a 400px slide-panel from the right showing all journal entries (newest first) followed by unposted bank transactions with a pink "Post →" button that navigates to the bank statement detail with the target transaction highlighted.

**Architecture:** New API endpoint fetches transaction detail per account code. Slide panel is a reusable component. AccountTransactionPanel handles data fetching and rendering. BankStatements gains query-param support for auto-expanding and highlighting.

**Tech Stack:** Hono (API), React + TanStack Query + Tailwind CSS (frontend), D1 (database)

## Global Constraints

- All user-visible strings use the `tr(en, zh, cn)` trilingual helper
- API routes are mounted under `/api/bookkeeping`
- Frontend API calls use the `api(path)` helper from `../lib/api`
- Toast notifications via `useToast()` hook
- Use `useTranslation()` for i18n reactivity
- Panel width: 400px default, with `transform: translateX` transition of `0.3s ease`
- Pink button color: `#ec4899` (Tailwind `bg-pink-500`)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `api/src/routes/bookkeeping.ts` | New endpoint `GET /income-statement/:code/transactions` |
| `frontend/src/components/SlidePanel.tsx` | Reusable slide-from-right overlay panel |
| `frontend/src/components/AccountTransactionPanel.tsx` | P&L drill-down content: fetch + render transactions |
| `frontend/src/pages/Bookkeeping.tsx` | Make COA account rows clickable, integrate panel |
| `frontend/src/pages/BankStatements.tsx` | Handle `?statement=&highlight=` query params |
| `frontend/src/index.css` | `pulseHighlight` keyframes + `.highlight-pulse` class |

---

### Task 1: API — Transaction Detail Endpoint

**Files:**
- Modify: `api/src/routes/bookkeeping.ts` (add new route before line 1544 `export`)

**Interfaces:**
- Produces: `GET /bookkeeping/income-statement/:account_code/transactions?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD`
- Response: `{ account_code: string; account_name: string; total: number; journal_entries: JournalEntryItem[]; unposted_bank_transactions: UnpostedBankTx[]; period: { start: string; end: string } }`

- [ ] **Step 1: Add the new endpoint**

Insert before the `export { bookkeeping as bookkeepingRoutes };` line (currently line 1544):

```typescript
// ── Transaction-level drill-down for Income Statement ──
bookkeeping.get('/income-statement/:account_code/transactions', async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const accountCode = c.req.param('account_code');
  const startDate = c.req.query('start_date') || '2000-01-01';
  const endDate = c.req.query('end_date') || new Date().toISOString().split('T')[0];

  // 1. Fetch journal lines for this account_code (excluding stale entries)
  const journalLines = await db.prepare(
    `SELECT jl.id as line_id, jl.entry_id, jl.account_code, jl.account_name,
            jl.debit, jl.credit, jl.description as line_description,
            je.entry_number, je.entry_date, je.description as entry_description,
            je.reference_type, je.reference_id
     FROM journal_lines jl
     JOIN journal_entries je ON jl.entry_id = je.id
     WHERE je.user_id = ? AND je.entry_date >= ? AND je.entry_date <= ?
       AND jl.account_code = ? AND je.status != 'stale'
     ORDER BY je.entry_date DESC, jl.sort_order`
  ).bind(tenantId, startDate, endDate, accountCode).all<{
    line_id: string; entry_id: string; account_code: string; account_name: string;
    debit: number; credit: number; line_description: string | null;
    entry_number: string; entry_date: string; entry_description: string;
    reference_type: string | null; reference_id: string | null;
  }>();

  // 2. Resolve linked documents for each journal entry
  //    reference_type can be 'invoice', 'bank_transaction', 'bill', 'expense', 'journal'
  const journalEntries: any[] = [];
  for (const jl of (journalLines?.results || [])) {
    const amount = jl.credit > 0 ? jl.credit : -jl.debit;
    const direction = jl.credit > 0 ? 'credit' : 'debit';
    const entry: any = {
      type: 'journal',
      line_id: jl.line_id,
      entry_id: jl.entry_id,
      entry_number: jl.entry_number,
      entry_date: jl.entry_date,
      description: jl.line_description || jl.entry_description,
      amount: Math.abs(amount),
      direction,
      reference_type: jl.reference_type,
      reference_id: jl.reference_id,
      linked_documents: [] as { type: string; id: string; label: string }[],
    };

    // Resolve invoice link
    if (jl.reference_type === 'invoice' && jl.reference_id) {
      const inv = await db.prepare(
        'SELECT id, invoice_number, total FROM invoices WHERE id = ? AND user_id = ?'
      ).bind(jl.reference_id, tenantId).first<{ id: string; invoice_number: string; total: number }>();
      if (inv) {
        entry.invoice_number = inv.invoice_number;
        entry.invoice_total = inv.total;
        entry.linked_documents.push({ type: 'invoice', id: inv.id, label: inv.invoice_number });
      }
    }

    // Resolve bank statement link (via bank_transactions reference or directly)
    if (jl.reference_type === 'bank_transaction' && jl.reference_id) {
      const bt = await db.prepare(
        `SELECT bt.id, bt.bank_statement_id, bs.statement_year, bs.statement_month, bs.bank_name
         FROM bank_transactions bt
         JOIN bank_statements bs ON bt.bank_statement_id = bs.id
         WHERE bt.id = ? AND bt.user_id = ?`
      ).bind(jl.reference_id, tenantId).first<{
        id: string; bank_statement_id: string;
        statement_year: number; statement_month: number; bank_name: string;
      }>();
      if (bt) {
        entry.bank_statement_id = bt.bank_statement_id;
        entry.bank_statement_period = `${bt.statement_year}-${String(bt.statement_month).padStart(2, '0')}`;
        entry.linked_documents.push({
          type: 'bank_statement', id: bt.bank_statement_id,
          label: `${bt.bank_statement_id} · ${bt.statement_year}-${String(bt.statement_month).padStart(2, '0')} · ${bt.bank_name}`,
        });
      }
    }

    journalEntries.push(entry);
  }

  // 3. Fetch unposted bank transactions (have account_code but NOT journalized)
  const unpostedBankTx = await db.prepare(
    `SELECT bt.id as transaction_id, bt.transaction_date, bt.description,
            CASE WHEN bt.deposit_amount > 0 THEN bt.deposit_amount ELSE bt.withdrawal_amount END as amount,
            CASE WHEN bt.deposit_amount > 0 THEN 'credit' ELSE 'debit' END as direction,
            bt.account_code, bt.bank_statement_id,
            bs.statement_year, bs.statement_month, bs.bank_name
     FROM bank_transactions bt
     JOIN bank_statements bs ON bt.bank_statement_id = bs.id
     LEFT JOIN journal_entries je ON je.reference_id = bt.id AND je.reference_type = 'bank_transaction'
     WHERE bt.user_id = ? AND bt.transaction_date >= ? AND bt.transaction_date <= ?
       AND bt.account_code = ? AND bt.deleted_at IS NULL
       AND je.id IS NULL
     ORDER BY bt.transaction_date DESC`
  ).bind(tenantId, startDate, endDate, accountCode).all<{
    transaction_id: string; transaction_date: string; description: string;
    amount: number; direction: string; account_code: string;
    bank_statement_id: string; statement_year: number; statement_month: number; bank_name: string;
  }>();

  const unposted: any[] = (unpostedBankTx?.results || []).map(bt => ({
    type: 'bank',
    transaction_id: bt.transaction_id,
    transaction_date: bt.transaction_date,
    description: bt.description,
    amount: bt.amount,
    direction: bt.direction,
    account_code: bt.account_code,
    bank_statement_id: bt.bank_statement_id,
    bank_statement_period: `${bt.statement_year}-${String(bt.statement_month).padStart(2, '0')}`,
    has_voucher: false,
    linked_documents: [{
      type: 'bank_statement', id: bt.bank_statement_id,
      label: `${bt.bank_statement_id} · ${bt.statement_year}-${String(bt.statement_month).padStart(2, '0')} · ${bt.bank_name}`,
    }],
  }));

  // Get account name
  const acctInfo = await db.prepare(
    'SELECT account_name FROM accounts WHERE account_code = ? AND user_id = ? LIMIT 1'
  ).bind(accountCode, tenantId).first<{ account_name: string }>();

  const total = journalEntries.reduce((s, je) => s + je.amount, 0) +
                unposted.reduce((s, bt) => s + bt.amount, 0);

  return c.json({
    account_code: accountCode,
    account_name: acctInfo?.account_name || accountCode,
    total,
    journal_entries: journalEntries,
    unposted_bank_transactions: unposted,
    period: { start: startDate, end: endDate },
  });
});
```

- [ ] **Step 2: Deploy API and verify**

```bash
cd api && CLOUDFLARE_ACCOUNT_ID=8c00cc4647a9cf5d8deb5d6a354001e0 npx wrangler deploy
```

- [ ] **Step 3: Test the endpoint manually**

Query a known account code from the deployed API to confirm the shape:

```bash
curl -H "Authorization: Bearer <token>" \
  "https://opcc-crm-api.ruhan-farhan.workers.dev/api/bookkeeping/income-statement/40001/transactions?start_date=2026-01-01&end_date=2026-12-31"
```

Expected: JSON with `account_code`, `account_name`, `journal_entries` array, `unposted_bank_transactions` array. Journal entries sorted newest first. Unposted only includes bank tx NOT linked to a journal entry.

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/bookkeeping.ts
git commit -m "feat: add GET /income-statement/:code/transactions endpoint for P&L drill-down

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: SlidePanel Component

**Files:**
- Create: `frontend/src/components/SlidePanel.tsx`

**Interfaces:**
- Produces: `<SlidePanel open onClose title width? children>`
- Consumes: nothing from other tasks

- [ ] **Step 1: Create SlidePanel.tsx**

```tsx
import React, { useEffect, useCallback } from 'react';
import { X } from 'lucide-react';

interface SlidePanelProps {
  open: boolean;
  onClose: () => void;
  title: string;
  width?: number; // default 400
  children: React.ReactNode;
}

export default function SlidePanel({ open, onClose, title, width = 400, children }: SlidePanelProps) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  useEffect(() => {
    if (open) {
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [open, handleKeyDown]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 z-40 transition-opacity duration-300"
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className="fixed top-0 right-0 h-full z-50 bg-card border-l shadow-2xl flex flex-col"
        style={{
          width: `${width}px`,
          maxWidth: '100vw',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 0.3s ease',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
          <h3 className="font-semibold text-sm truncate">{title}</h3>
          <button
            onClick={onClose}
            className="p-1 hover:bg-muted rounded transition-colors"
            aria-label="Close panel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto">
          {children}
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/SlidePanel.tsx
git commit -m "feat: add reusable SlidePanel component (slide-from-right)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: AccountTransactionPanel Component

**Files:**
- Create: `frontend/src/components/AccountTransactionPanel.tsx`

**Interfaces:**
- Consumes: `SlidePanel` (Task 2), `api()` from `../lib/api`, `useToast()` from `../components/Toast`
- Produces: `<AccountTransactionPanel accountCode accountName startDate endDate onPostClick onClose>`
- `onPostClick(bankStatementId, transactionId)` — parent navigates to bank statements

- [ ] **Step 1: Create AccountTransactionPanel.tsx**

```tsx
import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import { tr } from '../lib/i18nHelpers';
import { FileText, FileDigit, AlertTriangle } from 'lucide-react';

interface DocLink {
  type: string;
  id: string;
  label: string;
}

interface JournalEntryItem {
  type: 'journal';
  line_id: string;
  entry_id: string;
  entry_number: string;
  entry_date: string;
  description: string;
  amount: number;
  direction: 'credit' | 'debit';
  reference_type: string | null;
  reference_id: string | null;
  invoice_number?: string;
  invoice_total?: number;
  bank_statement_id?: string;
  bank_statement_period?: string;
  linked_documents: DocLink[];
}

interface UnpostedBankTx {
  type: 'bank';
  transaction_id: string;
  transaction_date: string;
  description: string;
  amount: number;
  direction: string;
  account_code: string;
  bank_statement_id: string;
  bank_statement_period: string;
  has_voucher: boolean;
  linked_documents: DocLink[];
}

interface TransactionData {
  account_code: string;
  account_name: string;
  total: number;
  journal_entries: JournalEntryItem[];
  unposted_bank_transactions: UnpostedBankTx[];
  period: { start: string; end: string };
}

interface Props {
  accountCode: string;
  accountName: string;
  startDate: string;
  endDate: string;
  onClose: () => void;
  onPostClick: (bankStatementId: string, transactionId: string) => void;
}

function formatHKD(n: number): string {
  return 'HKD ' + (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2 });
}

function docLink(doc: DocLink, key: string) {
  const icon = doc.type === 'invoice' ? '📎' : '📄';
  const href = doc.type === 'invoice'
    ? `/invoices?highlight=${doc.id}`
    : `/bank-statements?statement=${doc.id}`;
  return (
    <a
      key={key}
      href={href}
      className="text-blue-600 hover:text-blue-800 text-[10px] font-medium whitespace-nowrap"
      title={doc.label}
      onClick={e => e.stopPropagation()}
    >
      {icon} {doc.label}
    </a>
  );
}

export default function AccountTransactionPanel({
  accountCode, accountName, startDate, endDate, onClose, onPostClick,
}: Props) {
  const toast = useToast();

  const { data, isLoading, error } = useQuery({
    queryKey: ['account-transactions', accountCode, startDate, endDate],
    queryFn: () =>
      api(`/bookkeeping/income-statement/${encodeURIComponent(accountCode)}/transactions?start_date=${startDate}&end_date=${endDate}`),
    enabled: !!accountCode && !!startDate,
  });

  const txData = data as TransactionData | undefined;

  // Error state
  React.useEffect(() => {
    if (error) {
      toast.error('Failed to load transactions for account ' + accountCode);
      onClose();
    }
  }, [error, accountCode, onClose, toast]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
        {tr('Loading...', '載入中...', '载入中...')}
      </div>
    );
  }

  if (!txData) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
        {tr('No data available', '沒有數據', '没有数据')}
      </div>
    );
  }

  const hasJournal = txData.journal_entries.length > 0;
  const hasUnposted = txData.unposted_bank_transactions.length > 0;
  const isEmpty = !hasJournal && !hasUnposted;

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
        <div className="flex items-center justify-between">
          <div>
            <span className="font-mono text-sm font-semibold">{txData.account_code}</span>
            <span className="text-sm ml-2">{txData.account_name}</span>
          </div>
          <span className="font-bold text-emerald-700">
            {formatHKD(txData.total)}
          </span>
        </div>
        <div className="text-[10px] text-muted-foreground mt-1">
          {txData.period.start} – {txData.period.end}
          {' · '}
          {hasJournal && `${txData.journal_entries.length} journal entries`}
          {hasJournal && hasUnposted && ' + '}
          {hasUnposted && `${txData.unposted_bank_transactions.length} unposted bank tx`}
        </div>
      </div>

      {isEmpty ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4 justify-center">
          <FileText className="h-4 w-4" />
          {tr(
            'No transactions found for this account in the selected period',
            '所選期間內此科目沒有交易',
            '所选期间内此科目没有交易'
          )}
        </div>
      ) : (
        <>
          {/* ── Journal Entries Section ── */}
          {hasJournal && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <span className="w-2 h-2 rounded-full bg-green-500" />
                <span className="text-[11px] font-semibold text-muted-foreground uppercase">
                  {tr('Journal Entries', '日記帳分錄', '日记账分录')} ({txData.journal_entries.length})
                </span>
              </div>
              <div className="space-y-1.5">
                {txData.journal_entries.map((je) => (
                  <div
                    key={je.line_id}
                    className="border border-border rounded-md overflow-hidden bg-background"
                  >
                    <div className="flex items-center justify-between px-3 py-2 bg-muted/20">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono text-[11px] font-semibold shrink-0">
                          {je.entry_number}
                        </span>
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {je.entry_date}
                        </span>
                      </div>
                      <span className={`font-mono text-xs font-semibold shrink-0 ml-2 ${
                        je.direction === 'credit' ? 'text-green-600' : 'text-red-600'
                      }`}>
                        {formatHKD(je.amount)}
                      </span>
                    </div>
                    <div className="px-3 py-1.5 flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground truncate min-w-0">
                        {je.description}
                      </span>
                      {je.linked_documents.length > 0 && (
                        <span className="flex items-center gap-1.5 shrink-0">
                          {je.linked_documents.map((doc, i) =>
                            docLink(doc, `je-${je.line_id}-doc-${i}`)
                          )}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Divider ── */}
          {hasJournal && hasUnposted && (
            <div className="relative border-t-2 border-dashed border-amber-300 my-4">
              <span className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-amber-50 text-amber-800 text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap border border-amber-300">
                ⚠ {tr('UNPOSTED BANK TRANSACTIONS', '未過賬銀行交易', '未过账银行交易')} ({txData.unposted_bank_transactions.length})
              </span>
            </div>
          )}

          {/* ── Unposted Bank Transactions Section ── */}
          {hasUnposted && (
            <div>
              <div className="space-y-1.5">
                {txData.unposted_bank_transactions.map((bt) => (
                  <div
                    key={bt.transaction_id}
                    className="border border-red-200 rounded-md overflow-hidden bg-red-50/30"
                  >
                    <div className="flex items-center justify-between px-3 py-2 bg-red-50/50">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {bt.transaction_date}
                        </span>
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-medium shrink-0">
                          {tr('bank', '銀行', '银行')}
                        </span>
                      </div>
                      <span className={`font-mono text-xs font-semibold shrink-0 ml-2 ${
                        bt.direction === 'credit' ? 'text-green-600' : 'text-red-600'
                      }`}>
                        {formatHKD(bt.amount)}
                      </span>
                    </div>
                    <div className="px-3 py-1.5 flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground truncate min-w-0">
                        {bt.description}
                      </span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        {bt.linked_documents.map((doc, i) =>
                          docLink(doc, `bt-${bt.transaction_id}-doc-${i}`)
                        )}
                        <button
                          onClick={() => onPostClick(bt.bank_statement_id, bt.transaction_id)}
                          className="px-2 py-0.5 text-[10px] font-semibold text-white bg-pink-500 hover:bg-pink-600 rounded transition-colors whitespace-nowrap"
                        >
                          {tr('Post', '過賬', '过账')} →
                        </button>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/AccountTransactionPanel.tsx
git commit -m "feat: add AccountTransactionPanel for P&L transaction drill-down

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Integrate Slide Panel into P&L Tab

**Files:**
- Modify: `frontend/src/pages/Bookkeeping.tsx`

**Interfaces:**
- Consumes: `SlidePanel` (Task 2), `AccountTransactionPanel` (Task 3)
- Modifies: account rows in `revenue_accounts` and `expense_accounts` tables to be clickable

- [ ] **Step 1: Add imports**

At the top of Bookkeeping.tsx (after existing imports, around line 8):

```typescript
import SlidePanel from '../components/SlidePanel';
import AccountTransactionPanel from '../components/AccountTransactionPanel';
```

- [ ] **Step 2: Add state variables**

After the existing `expandedPL` state (line 51), add:

```typescript
const [selectedAccountCode, setSelectedAccountCode] = useState<string | null>(null);
const [selectedAccountName, setSelectedAccountName] = useState<string>('');
const [panelOpen, setPanelOpen] = useState(false);
```

- [ ] **Step 3: Add navigation handler for Post button**

After the state declarations, add:

```typescript
const handlePostClick = (bankStatementId: string, transactionId: string) => {
  navigate(`/bank-statements?statement=${encodeURIComponent(bankStatementId)}&highlight=${encodeURIComponent(transactionId)}`);
};
```

Note: `navigate` is from `useNavigate` — check if it's already imported. If not, add:

```typescript
import { useNavigate } from 'react-router-dom';
// and in the component:
const navigate = useNavigate();
```

- [ ] **Step 4: Make revenue account rows clickable**

Replace the `<tr>` on lines 617-624 with:

```tsx
{(incomeStatement.revenue_accounts || []).map((acct: any) => (
  <tr
    key={acct.account_code}
    className="border-b border-muted/20 hover:bg-muted/30 cursor-pointer group"
    onClick={() => {
      setSelectedAccountCode(acct.account_code);
      setSelectedAccountName(acct.account_name || acct.account_code);
      setPanelOpen(true);
    }}
  >
    <td className="py-1.5 px-4 font-mono text-xs group-hover:text-primary">{acct.account_code}</td>
    <td className="py-1.5 px-4 group-hover:text-primary">{acct.account_name}</td>
    <td className="py-1.5 px-4 text-right font-mono text-green-600 flex items-center justify-end gap-1">
      HKD {(acct.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
      <ChevronRight className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
    </td>
  </tr>
))}
```

- [ ] **Step 5: Make expense account rows clickable**

Replace the `<tr>` on lines 670-677 with the same pattern (adjusting for red text on expenses):

```tsx
{(incomeStatement.expense_accounts || []).map((acct: any) => (
  <tr
    key={acct.account_code}
    className="border-b border-muted/20 hover:bg-muted/30 cursor-pointer group"
    onClick={() => {
      setSelectedAccountCode(acct.account_code);
      setSelectedAccountName(acct.account_name || acct.account_code);
      setPanelOpen(true);
    }}
  >
    <td className="py-1.5 px-4 font-mono text-xs group-hover:text-primary">{acct.account_code}</td>
    <td className="py-1.5 px-4 group-hover:text-primary">{acct.account_name}</td>
    <td className="py-1.5 px-4 text-right font-mono text-red-600 flex items-center justify-end gap-1">
      HKD {(acct.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
      <ChevronRight className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
    </td>
  </tr>
))}
```

- [ ] **Step 6: Add the SlidePanel at the end of the P&L tab**

After the closing `</div>` of the P&L container (the `</div>` on line 695 that closes the `bg-card border rounded-xl` div), add:

```tsx
{/* Transaction drill-down slide panel */}
<SlidePanel
  open={panelOpen}
  onClose={() => setPanelOpen(false)}
  title={`${tr('Account Transactions', '科目交易', '科目交易')}: ${selectedAccountCode} — ${selectedAccountName}`}
>
  {selectedAccountCode && panelOpen && (
    <AccountTransactionPanel
      accountCode={selectedAccountCode}
      accountName={selectedAccountName}
      startDate={startDate}
      endDate={endDate}
      onClose={() => setPanelOpen(false)}
      onPostClick={handlePostClick}
    />
  )}
</SlidePanel>
```

- [ ] **Step 7: Build and verify**

```bash
cd frontend && npm run build
```

Fix any TypeScript errors. The `navigate` and `useNavigate` may need importing. The `startDate`/`endDate` variables are already available in scope from the existing P&L code.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/Bookkeeping.tsx
git commit -m "feat: integrate drill-down slide panel into Income Statement P&L

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: BankStatements Query Param Support

**Files:**
- Modify: `frontend/src/pages/BankStatements.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks (independent feature)
- Produces: reads `?statement=&highlight=` from URL, auto-expands, scrolls, highlights

- [ ] **Step 1: Add useSearchParams import**

At the top of BankStatements.tsx, add to the react-router-dom import:

```typescript
import { useNavigate, useSearchParams } from 'react-router-dom';
```

- [ ] **Step 2: Read query params and auto-expand on mount**

After the existing state declarations (around line 54), add:

```typescript
const [searchParams, setSearchParams] = useSearchParams();
const highlightTxRef = React.useRef<string | null>(null);

// Auto-expand statement and highlight transaction from query params
React.useEffect(() => {
  const statementId = searchParams.get('statement');
  const highlightId = searchParams.get('highlight');
  if (statementId) {
    setExpandedId(statementId);
    highlightTxRef.current = highlightId;
  }
}, []); // Run once on mount
```

- [ ] **Step 3: Scroll to and highlight transaction after detail loads**

Add a second useEffect that triggers when the detail query completes:

```typescript
// Scroll to highlighted transaction after detail loads
React.useEffect(() => {
  if (highlightTxRef.current && detail && !detailQuery.isLoading) {
    const txId = highlightTxRef.current;
    // Small delay to let DOM render
    setTimeout(() => {
      const el = document.getElementById(`tx-${txId}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('highlight-pulse');
        // Clear highlight after 5 seconds
        setTimeout(() => {
          el.classList.remove('highlight-pulse');
        }, 5000);
      }
      highlightTxRef.current = null;
    }, 300);
  }
}, [detail, detailQuery.isLoading]);
```

- [ ] **Step 4: Add id attribute to transaction rows**

In the transaction map (around line 412), add an `id` to the `<tr>`:

```tsx
<tr key={tx.id} id={`tx-${tx.id}`} className={...}>
```

- [ ] **Step 5: Clear query params after consumption**

At the end of the scroll useEffect, clear the params so they don't persist on refresh:

```typescript
// Clear highlight param after consumption
if (highlightTxRef.current === null) {
  const newParams = new URLSearchParams(searchParams);
  if (newParams.has('highlight') || newParams.has('statement')) {
    newParams.delete('highlight');
    newParams.delete('statement');
    setSearchParams(newParams, { replace: true });
  }
}
```

Add this inside a useEffect that reacts after `highlightTxRef.current` has been set to null (combine with the scroll effect above, placing it after the setTimeout):

```typescript
// After scrolling/highlighting, clear the URL params
setTimeout(() => {
  const newParams = new URLSearchParams(searchParams);
  if (newParams.has('highlight') || newParams.has('statement')) {
    newParams.delete('highlight');
    newParams.delete('statement');
    setSearchParams(newParams, { replace: true });
  }
}, 1000);
```

- [ ] **Step 6: Build and verify**

```bash
cd frontend && npm run build
```

Fix any TypeScript errors. The `setSearchParams` import is from `useSearchParams`.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/BankStatements.tsx
git commit -m "feat: support ?statement=&highlight= query params for auto-expand and highlight

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: CSS — Highlight Animation

**Files:**
- Modify: `frontend/src/index.css`

**Interfaces:**
- Produces: `.highlight-pulse` CSS class and `@keyframes pulseHighlight`

- [ ] **Step 1: Add animation CSS**

Append to the end of `frontend/src/index.css`:

```css
/* Transaction highlight pulse (BankStatements deep-link) */
@keyframes pulseHighlight {
  0%   { background-color: #fef3c7; }
  50%  { background-color: #fde68a; }
  100% { background-color: #fef3c7; }
}

.highlight-pulse {
  animation: pulseHighlight 1s ease-in-out 3;
  border: 2px solid #fbbf24;
  border-radius: 4px;
  scroll-margin-top: 100px; /* offset for smooth scrollIntoView */
}
```

- [ ] **Step 2: Build and verify**

```bash
cd frontend && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/index.css
git commit -m "feat: add pulseHighlight animation for bank transaction deep-link

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: End-to-End Verification & Deploy

**Files:**
- No new files — verify all changes work together

- [ ] **Step 1: Deploy API**

```bash
cd api && CLOUDFLARE_ACCOUNT_ID=8c00cc4647a9cf5d8deb5d6a354001e0 npx wrangler deploy
```

- [ ] **Step 2: Deploy frontend**

```bash
cd frontend && npm run build && CLOUDFLARE_ACCOUNT_ID=8c00cc4647a9cf5d8deb5d6a354001e0 npx wrangler pages deploy dist --project-name=opcc-crm-testing --branch=main
```

- [ ] **Step 3: Manual smoke test**

1. Navigate to `https://de620785.opcc-crm-testing.pages.dev/bookkeeping`
2. Select the **P&L** tab
3. Click an account code under Revenue or Expenses
4. **Verify:** Slide panel opens from right with journal entries sorted newest-first
5. **Verify:** Unposted bank transactions appear below the dashed divider
6. **Verify:** Pink "Post →" button visible on unposted tx
7. Click a pink "Post →" button
8. **Verify:** Navigates to `/bank-statements?statement=BS-xxx&highlight=bt-xxx`
9. **Verify:** Target statement auto-expands, transaction is highlighted with yellow pulse
10. **Verify:** Close panel via X, Escape key, and backdrop click
11. **Verify:** URL params cleared after highlight animation

- [ ] **Step 4: Commit any final fixes**

```bash
git add -A
git commit -m "chore: final adjustments for income statement drill-down feature

Co-Authored-By: Claude <noreply@anthropic.com>"
```
