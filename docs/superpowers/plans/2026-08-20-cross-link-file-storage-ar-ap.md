# Cross-link File Storage ↔ AP/AR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bidirectionally trace File Storage files to their linked AP/AR invoices (and bank/card statements): File Storage shows the invoice number and a "go to record" button that jumps to the AP/AR list with the row scrolled to and highlighted, and AP/AR rows with a linked file get an icon back to the file in File Storage.

**Architecture:** The File Storage API already returns `invoice_id`/`invoice_number` and statement ids per file (LEFT JOINs in `api/src/routes/file-storage.ts:2019-2031`). The invoices list endpoint gains an optional `highlight_id` param that computes the page on which the target invoice appears (direction + doc_type filters only, ignoring search/status/date), so the frontend can deep-link to the exact row regardless of pagination. The frontend pages read `?highlight=<id>` on mount, navigate to the right page, auto-expand (statements) or scroll+ring (AP/AR rows) the target. A shared scroll+ring effect mirrors the existing Bookkeeping `?entry=` pattern (`frontend/src/pages/Bookkeeping.tsx:66-91`).

**Tech Stack:** TypeScript, React, react-router-dom (`useSearchParams`), @tanstack/react-query, lucide-react, Hono (Cloudflare Workers). Verification is `npm run build` (runs `tsc -b && vite build`); no unit-test framework exists in this repo.

## Global Constraints

- All new user-facing strings trilingual via `tr('English', '繁體中文', '简体中文')`.
- No schema changes. No new dependencies.
- Do not touch unrelated uncommitted work on `main`; work only in the `upload-to-filestorage` worktree.
- Backend has no `build`/`typecheck` script and deps are not installed in the worktree — verify backend changes by careful diff review plus the frontend `npm run build` (TS catches frontend contract errors).
- Verification command: `cd frontend && npm run build` — must PASS before each commit.
- Follow existing ordering determinism: pagination uses `ORDER BY i.created_at DESC`; this plan adds an `id` tie-breaker so page computation is stable.
- Working tree already has pre-existing noise (`playwright-report/` deletions, untracked plan docs) — do not stage those.

---

### Task 1: Backend — `highlight_id` → `highlight_page` on `GET /invoices`

**Files:**
- Modify: `api/src/routes/invoices.ts:28-68`

**Interfaces:**
- Consumes: nothing new.
- Produces: `GET /invoices?highlight_id=<invoiceId>&...` now returns `{ data, total, page, limit, highlight_page }` where `highlight_page` is `number | null`. `highlight_page` is computed from the same `direction`/`doc_type`/`pending_review`-exclusion filters ONLY (search, status, start_date, end_date are ignored), using a deterministic `(created_at DESC, id DESC)` ordering.

- [ ] **Step 1: Add `highlight_id` query param and deterministic ordering**

In `api/src/routes/invoices.ts`, in the `GET /` handler after `const endDate = c.req.query('end_date') || '';` (line 35), add:

```ts
  const highlightId = c.req.query('highlight_id') || '';
```

Change line 52 from:

```ts
  query += ' ORDER BY i.created_at DESC LIMIT ? OFFSET ?';
```

to:

```ts
  query += ' ORDER BY i.created_at DESC, i.id DESC LIMIT ? OFFSET ?';
```

- [ ] **Step 2: Compute `highlight_page` after the count row**

Replace the return statement (line 68):

```ts
  return c.json({ data: rows.results, total: countRow?.count || 0, page, limit });
```

with:

```ts
  let highlight_page: number | null = null;
  if (highlightId) {
    const target = await db.prepare(
      'SELECT id, created_at FROM invoices WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    ).bind(highlightId, tenantId).first<{ id: string; created_at: string }>();
    if (target) {
      let hlQuery = 'SELECT COUNT(*) as cnt FROM invoices i WHERE i.user_id = ? AND i.deleted_at IS NULL' +
        " AND i.status != 'pending_review'" +
        (docType === 'receipt' ? ' AND i.receipt_number IS NOT NULL' : docType === 'invoice' ? ' AND i.receipt_number IS NULL' : '') +
        (direction === 'incoming' ? " AND i.direction = 'incoming'" : direction === 'outgoing' ? " AND i.direction = 'outgoing'" : '') +
        ' AND (i.created_at > ? OR (i.created_at = ? AND i.id > ?))';
      const hlParams: unknown[] = [tenantId, target.created_at, target.created_at, target.id];
      const hlRow = await db.prepare(hlQuery).bind(...hlParams).first<{ cnt: number }>();
      if (hlRow) highlight_page = Math.floor((hlRow.cnt || 0) / limit) + 1;
    }
  }

  return c.json({ data: rows.results, total: countRow?.count || 0, page, limit, highlight_page });
```

- [ ] **Step 3: Review the diff**

Run: `git diff api/src/routes/invoices.ts`
Expected: only the added `highlightId` block, the ORDER BY change, and the new return object. No other files changed.

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/invoices.ts
git commit -m "feat(invoices): return highlight_page for deep-link to exact row"
```

---

### Task 2: AP/AR — deep-link highlight + reverse link to File Storage

**Files:**
- Modify: `frontend/src/pages/AP.tsx` (query block :54-62, row render :222-267)
- Modify: `frontend/src/pages/AR.tsx` (query block :55-63, row render :223-268)

**Interfaces:**
- Consumes: Task 1's `highlight_page` field on the `GET /invoices` response; the invoices list already returns `i.*` so `file_id` is available on every row.
- Produces: AP/AR read `?highlight=<invoiceId>` on mount, clear search/status filters, bypass the fiscal-year date filter, jump to `highlight_page`, and scroll+ring the row (`#inv-row-<id>`). Rows with `inv.file_id` render a Link2 icon navigating to `/file-storage?highlight=<file_id>`.

- [ ] **Step 1: Add `useSearchParams` to AP and AR**

In `AP.tsx`, change line 2:

```ts
import { useNavigate } from 'react-router-dom';
```

to:

```ts
import { useNavigate, useSearchParams } from 'react-router-dom';
```

Do the same in `AR.tsx` (line 2). Both files already import `Link2` from lucide-react.

- [ ] **Step 2: Read the highlight param and compute effective dates**

In `AP.tsx`, after line 48 (`const { startDate, endDate } = useDateFilter();`), add:

```ts
  const [searchParams] = useSearchParams();
  const highlightId = searchParams.get('highlight') || null;
  // Deep-link highlight bypasses the fiscal-year date filter so the invoice is always found.
  const effStart = highlightId ? '' : startDate;
  const effEnd = highlightId ? '' : endDate;
```

Add the same in `AR.tsx` after its corresponding `useDateFilter()` line.

- [ ] **Step 3: Update the list query to pass `highlight_id` and clear filters**

In `AP.tsx`, replace the query block (:54-62):

```ts
  const { data, isLoading } = useQuery({
    queryKey: ['invoices-ap', search, status, page, startDate, endDate],
    queryFn: () => {
      const params = new URLSearchParams({ q: search, status, page: String(page), limit: '20', doc_type: 'invoice', direction: 'incoming' });
      if (startDate) params.set('start_date', startDate);
      if (endDate) params.set('end_date', endDate);
      return api(`/invoices?${params.toString()}`);
    },
  });
```

with:

```ts
  const { data, isLoading } = useQuery({
    queryKey: ['invoices-ap', search, status, page, effStart, effEnd, highlightId],
    queryFn: () => {
      const params = new URLSearchParams({ q: highlightId ? '' : search, status: highlightId ? '' : status, page: String(page), limit: '20', doc_type: 'invoice', direction: 'incoming' });
      if (effStart) params.set('start_date', effStart);
      if (effEnd) params.set('end_date', effEnd);
      if (highlightId) params.set('highlight_id', highlightId);
      return api(`/invoices?${params.toString()}`);
    },
  });
```

In `AR.tsx`, replace its query block (:55-63) identically, except:
- queryKey prefix `'invoices-ar'`
- `direction: 'outgoing'`

- [ ] **Step 4: Add the scroll+ring effect**

In `AP.tsx`, after the `invoices` derivation (line 139: `const invoices = data?.data || [];`), add:

```ts
  // Deep-link highlight: jump to the page that holds the invoice, then scroll + ring it.
  useEffect(() => {
    if (!highlightId || !data) return;
    const rows = (data.data || []) as any[];
    const found = rows.find((r: any) => r.id === highlightId);
    if (found) {
      const tryScroll = (retries: number) => {
        const row = document.getElementById(`inv-row-${highlightId}`);
        if (row) {
          row.scrollIntoView({ behavior: 'smooth', block: 'center' });
          row.classList.add('ring-2', 'ring-blue-400');
          setTimeout(() => row.classList.remove('ring-2', 'ring-blue-400'), 3000);
        } else if (retries > 0) {
          setTimeout(() => tryScroll(retries - 1), 150);
        }
      };
      tryScroll(5);
    } else if (data.highlight_page && data.highlight_page !== page) {
      setPage(data.highlight_page);
    }
  }, [highlightId, data, page]);
  // suppress exhaustive-deps: only re-run when the highlight param or page changes

```

Add the same effect in `AR.tsx` after its `const invoices = data?.data || [];`.

Add `useEffect` to the React import in both files if not already present (`import React, { useState } from 'react'` → `import React, { useState, useEffect } from 'react'`).

- [ ] **Step 5: Add row ids and the reverse file link**

In `AP.tsx`, change line 224:

```ts
                <tr key={inv.id} className="border-b hover:bg-muted/30">
```

to:

```ts
                <tr key={inv.id} id={`inv-row-${inv.id}`} className="border-b hover:bg-muted/30">
```

Do the same in `AR.tsx` on its `<tr key={inv.id}...>` line.

In `AP.tsx`'s actions cell (:254-264), add the reverse file link as the first button, right after `<td className="p-3 text-right">`:

```tsx
                    {inv.file_id && (
                      <button onClick={() => navigate(`/file-storage?highlight=${inv.file_id}`)} className="p-1 hover:bg-muted rounded mr-1" title={tr('View file in File Storage', '在文件庫查看檔案', '在文件库查看文件')}><Link2 className="h-4 w-4" /></button>
                    )}
```

Do the same in `AR.tsx`'s actions cell.

- [ ] **Step 6: Build to verify**

Run: `cd frontend && npm run build`
Expected: PASS (`tsc -b && vite build` completes with no errors).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/AP.tsx frontend/src/pages/AR.tsx
git commit -m "feat(ar-ap): deep-link highlight to exact invoice row + reverse link to file"
```

---

### Task 3: File Storage — invoice number, go-to-record button, highlight

**Files:**
- Modify: `frontend/src/pages/FileStorage.tsx` (imports :1-8, component state :316-330, file row render :209-302)

**Interfaces:**
- Consumes: `FileItem` already has `invoice_id`, `invoice_number`, `invoice_direction`, `statement_id`, `card_statement_id` (`FileStorage.tsx:115-128`).
- Produces: File Storage shows `invoice_number` on invoice-linked rows; a Link2 "Go to record" button per linked file targets `/ap|/ar|/bank-statements|/card-statements?highlight=<id>`; reading `?highlight=<file_id>` expands the target file's folder path and scrolls+rings `#file-row-<id>`.

- [ ] **Step 1: Add imports**

Change line 2:

```ts
import { useNavigate } from 'react-router-dom';
```

to:

```ts
import { useNavigate, useSearchParams } from 'react-router-dom';
```

Add `Link2` to the lucide-react import on line 8:

```ts
import { Upload, Download, Trash2, Search, Pencil, X, Check, File, FileText, FileSpreadsheet, Image, FolderOpen, Folder, ChevronRight, ChevronDown, Zap, Sparkles, CheckCircle2, Eye, Link2 } from 'lucide-react';
```

- [ ] **Step 2: Read the highlight param**

After line 322 (`const navigate = useNavigate();`), add:

```ts
  const [searchParams] = useSearchParams();
  const highlightFileId = searchParams.get('highlight') || null;
```

- [ ] **Step 3: Show the invoice number on invoice-linked rows**

In the file row metadata (`FileStorage.tsx:216-219`), after the `FileTimeLabel` line (218), add:

```tsx
                    {f.invoice_number && <span className="font-mono text-[10px] text-blue-600">{f.invoice_number}</span>}
```

- [ ] **Step 4: Add the "Go to record" Link2 button**

In the action cluster (`FileStorage.tsx:259-287`), immediately before the existing Review-button block (before line 261's `{(() => {` comment), add:

```tsx
                {/* Go-to-record button — cross-link to the AP/AR list or statement list */}
                {(() => {
                  if (f.invoice_id) {
                    const dir = f.invoice_direction || f.direction;
                    if (dir === 'outgoing') {
                      return (
                        <a href={`/ar?highlight=${f.invoice_id}`}
                          className="p-1 hover:bg-green-100 rounded text-green-600 inline-flex" title={tr('Go to AR record', '前往應收記錄', '前往应收记录')}>
                          <Link2 className="h-3.5 w-3.5" />
                        </a>
                      );
                    }
                    if (dir === 'incoming') {
                      return (
                        <a href={`/ap?highlight=${f.invoice_id}`}
                          className="p-1 hover:bg-green-100 rounded text-green-600 inline-flex" title={tr('Go to AP record', '前往應付記錄', '前往应付记录')}>
                          <Link2 className="h-3.5 w-3.5" />
                        </a>
                      );
                    }
                    return null; // direction unknown — not in AP/AR lists
                  }
                  if (f.statement_id) {
                    return (
                      <a href={`/bank-statements?highlight=${f.statement_id}`}
                        className="p-1 hover:bg-green-100 rounded text-green-600 inline-flex" title={tr('Go to bank statement', '前往銀行月結單', '前往银行月结单')}>
                        <Link2 className="h-3.5 w-3.5" />
                      </a>
                    );
                  }
                  if (f.card_statement_id) {
                    return (
                      <a href={`/card-statements?highlight=${f.card_statement_id}`}
                        className="p-1 hover:bg-green-100 rounded text-green-600 inline-flex" title={tr('Go to card statement', '前往信用卡月結單', '前往信用卡月结单')}>
                        <Link2 className="h-3.5 w-3.5" />
                      </a>
                    );
                  }
                  return null;
                })()}
```

- [ ] **Step 5: Add row id to file rows**

In the file row render (`FileStorage.tsx:210`), change:

```tsx
            <div key={f.id} className="flex items-center justify-between hover:bg-muted/30 rounded-md px-2 py-1.5"
```

to:

```tsx
            <div key={f.id} id={`file-row-${f.id}`} className="flex items-center justify-between hover:bg-muted/30 rounded-md px-2 py-1.5"
```

- [ ] **Step 6: Expand the folder path and scroll+ring the highlighted file**

After the `toggleFolder` definition (line 753-758), add:

```ts
  // Deep-link highlight: expand the target file's folder path, clear filters that would hide it, then scroll + ring it.
  useEffect(() => {
    if (!highlightFileId || !files?.data) return;
    const target = (files.data as any[]).find((f: any) => f.id === highlightFileId);
    if (target) {
      const parts = (target.folder || 'Other').split('/');
      const paths: string[] = [];
      let acc = '';
      for (const p of parts) {
        acc = acc ? `${acc}/${p}` : p;
        paths.push(acc);
      }
      setExpanded(prev => new Set([...prev, ...paths]));
      if (filterFolder && filterFolder !== target.folder) setFilterFolder('');
      if (searchQ) setSearchQ('');
    }
  }, [highlightFileId, files, filterFolder, searchQ]);

  useEffect(() => {
    if (!highlightFileId) return;
    const tryScroll = (retries: number) => {
      const row = document.getElementById(`file-row-${highlightFileId}`);
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.classList.add('ring-2', 'ring-blue-400');
        setTimeout(() => row.classList.remove('ring-2', 'ring-blue-400'), 3000);
      } else if (retries > 0) {
        setTimeout(() => tryScroll(retries - 1), 150);
      }
    };
    tryScroll(8);
  }, [highlightFileId, files, expanded]);
  // suppress exhaustive-deps: retry loop handles timing of folder expansion + data load
```

Ensure `useEffect` is imported (line 1 already imports `useEffect`).

- [ ] **Step 7: Build to verify**

Run: `cd frontend && npm run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/FileStorage.tsx
git commit -m "feat(file-storage): show invoice number + go-to-record link + deep-link highlight"
```

---

### Task 4: Bank/Card statement lists — deep-link highlight

**Files:**
- Modify: `frontend/src/pages/BankStatements.tsx` (imports, state :48, card render :232-270)
- Modify: `frontend/src/pages/CardStatements.tsx` (imports, state :57-77, card render :161-192)

**Interfaces:**
- Consumes: nothing new (statements load fully, no pagination).
- Produces: reading `?highlight=<id>` auto-expands that statement card (`setExpandedId(id)`) and scrolls+rings `#stmt-row-<id>` (bank) / `#card-row-<id>` (card).

- [ ] **Step 1: Add `useSearchParams` to both pages**

`BankStatements.tsx` line 2 and `CardStatements.tsx` line 3 both import `useNavigate`. Change them to:

```ts
import { useNavigate, useSearchParams } from 'react-router-dom';
```

- [ ] **Step 2: Read the highlight param in BankStatements**

In `BankStatements.tsx`, after line 48 (`const [expandedId, setExpandedId] = useState<string | null>(null);`), add:

```ts
  const [searchParams] = useSearchParams();
  const highlightStmtId = searchParams.get('highlight') || null;
```

- [ ] **Step 3: Add id to bank statement cards**

In `BankStatements.tsx` line 233, change:

```tsx
              <div key={s.id}>
```

to:

```tsx
              <div key={s.id} id={`stmt-row-${s.id}`}>
```

- [ ] **Step 4: Auto-expand + scroll + ring in BankStatements**

After the statements data is available (`const statements = ...` / `stmtsResp?.data`), add an effect. Place it after the statements query is declared:

```ts
  useEffect(() => {
    if (!highlightStmtId) return;
    setExpandedId(highlightStmtId);
    const tryScroll = (retries: number) => {
      const card = document.getElementById(`stmt-row-${highlightStmtId}`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.add('ring-2', 'ring-blue-400');
        setTimeout(() => card.classList.remove('ring-2', 'ring-blue-400'), 3000);
      } else if (retries > 0) {
        setTimeout(() => tryScroll(retries - 1), 150);
      }
    };
    tryScroll(8);
  }, [highlightStmtId, statements]);
```

- [ ] **Step 5: Read the highlight param in CardStatements**

In `CardStatements.tsx`, after the statements query, add:

```ts
  const [searchParams] = useSearchParams();
  const highlightStmtId = searchParams.get('highlight') || null;
```

- [ ] **Step 6: Add id to card statement cards**

In `CardStatements.tsx` line 167, change:

```tsx
              <div key={s.id} className="rounded-lg border bg-card overflow-hidden">
```

to:

```tsx
              <div key={s.id} id={`card-row-${s.id}`} className="rounded-lg border bg-card overflow-hidden">
```

- [ ] **Step 7: Auto-expand + scroll + ring in CardStatements**

After the statements query, add the same effect as Step 4 but targeting `card-row`:

```ts
  useEffect(() => {
    if (!highlightStmtId) return;
    setExpandedId(highlightStmtId);
    const tryScroll = (retries: number) => {
      const card = document.getElementById(`card-row-${highlightStmtId}`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.add('ring-2', 'ring-blue-400');
        setTimeout(() => card.classList.remove('ring-2', 'ring-blue-400'), 3000);
      } else if (retries > 0) {
        setTimeout(() => tryScroll(retries - 1), 150);
      }
    };
    tryScroll(8);
  }, [highlightStmtId, statements]);
```

Ensure `useEffect` is imported in both files (`CardStatements.tsx` line 1 is `import { useState } from 'react'` → change to `import { useState, useEffect } from 'react'`; check `BankStatements.tsx`'s React import).

- [ ] **Step 8: Build to verify**

Run: `cd frontend && npm run build`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/pages/BankStatements.tsx frontend/src/pages/CardStatements.tsx
git commit -m "feat(statements): deep-link highlight auto-expands statement card"
```

---

### Task 5: Reference doc + full verification

**Files:**
- Modify: `C:\Users\samue\Documents\Pastel\Tech_Connect_SME\personal_note\status-and-gl-reference.md` (append section)

**Interfaces:**
- Consumes: the final `?highlight=` contract from Tasks 1-4.
- Produces: a documented deep-link contract for future maintenance.

- [ ] **Step 1: Append the cross-link section to the reference doc**

Append to `C:\Users\samue\Documents\Pastel\Tech_Connect_SME\personal_note\status-and-gl-reference.md`:

```markdown
## Cross-link File Storage ↔ AP/AR (and statements)

Tracing between stored documents and their accounting records.

- File Storage shows each invoice-linked file's `invoice_number` inline.
- A Link2 "Go to record" button per linked file navigates to the owning module with a deep link:
  - invoice `outgoing` → `/ar?highlight=<invoice_id>`
  - invoice `incoming` → `/ap?highlight=<invoice_id>`
  - bank statement → `/bank-statements?highlight=<statement_id>`
  - card statement → `/card-statements?highlight=<card_statement_id>`
- The target page reads `?highlight=<id>` on mount and scrolls to the row with a blue ring:
  - AP/AR: clears search/status, bypasses the fiscal-year date filter, asks the API for `highlight_page`, jumps to that page, then scrolls+rings `#inv-row-<id>`.
  - Bank/Card statements: auto-expands the card (`setExpandedId`) and scrolls+rings `#stmt-row-<id>` / `#card-row-<id>`.
  - File Storage: expands the file's folder path, clears folder/search filters, scrolls+rings `#file-row-<id>`.
- Reverse: AP/AR rows with a `file_id` show a Link2 icon → `/file-storage?highlight=<file_id>`.

### Deep-link contract (`GET /invoices?highlight_id=`)

- `highlight_page` is computed with ONLY the direction + doc_type + pending_review-exclusion filters.
- search (`q`), `status`, `start_date`, `end_date` are IGNORED so the target invoice always lands.
- Ordering for the page calculation is deterministic: `ORDER BY i.created_at DESC, i.id DESC`.
- Returns `highlight_page: number | null` (null when the invoice is not found or excluded).
```

- [ ] **Step 2: Full build verification**

Run: `cd frontend && npm run build`
Expected: PASS.

- [ ] **Step 3: Full diff review**

Run: `git diff main...HEAD` and review every changed file: `api/src/routes/invoices.ts`, `frontend/src/pages/AP.tsx`, `AR.tsx`, `FileStorage.tsx`, `BankStatements.tsx`, `CardStatements.tsx`. Confirm:
- No unrelated changes staged.
- All new strings use `tr()`.
- The `?highlight=` param name is consistent everywhere.

- [ ] **Step 4: Commit (doc only)**

```bash
git add api/src/routes/invoices.ts frontend/src/pages/AP.tsx frontend/src/pages/AR.tsx frontend/src/pages/FileStorage.tsx frontend/src/pages/BankStatements.tsx frontend/src/pages/CardStatements.tsx
git commit -m "docs: cross-link file storage to AR/AP deep-link contract"
```

(Commit the code files together with the doc; the personal_note file is outside the repo and is not committed.)

- [ ] **Step 5: Manual QA checklist**

After deploy, verify on `https://opcc-crm-testing.pages.dev`:
1. Open File Storage → find an invoice-linked file → the invoice number is visible and the green Link2 icon appears.
2. Click it for an outgoing invoice → lands on AR with the row highlighted (blue ring), filters cleared.
3. Click it for an incoming invoice → lands on AP with the row highlighted.
4. Click the Link2 icon on an AP/AR row that has a file → lands in File Storage with the file's row highlighted and its folder expanded.
5. A bank-statement file's Link2 icon → Bank Statements page with that statement expanded + highlighted.
6. A card-statement file's Link2 icon → Card Statements page with that card expanded + highlighted.

---

## Self-Review

- **Spec coverage:** All 6 design points map to tasks: (1) invoice number display → Task 3 Step 3; (2) go-to-record button → Task 3 Step 4; (3) backend deep-link page → Task 1; (4) AP/AR highlight + reverse link → Task 2; (5) statement deep-links → Task 4; (6) doc + verification → Task 5. Bidirectional + always-land + scroll+ring only decisions all covered.
- **Placeholder scan:** No TBD/TODO; every step has concrete code or commands.
- **Type consistency:** `highlight_page` field name matches between Task 1 (backend return) and Task 2 (frontend `data.highlight_page`); row id selectors `inv-row-*`, `file-row-*`, `stmt-row-*`, `card-row-*` are consistent between the render steps and the scroll effects; `highlight_id` query param name is consistent across all files.