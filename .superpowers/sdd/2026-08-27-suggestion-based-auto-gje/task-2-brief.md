# Task 2: Backend — Add /confirm-suggestion endpoint

**Files:**
- Modify: `api/src/routes/bookkeeping.ts` (add after the `/auto-generate-entries` handler)

**Interfaces:**
- Consumes: `categorizeTransaction`, `resolveBankAccountCode`, `getTemporaryAccount`, `generateVoucher`
- Produces: `{ entry_id, voucher_number }`

## Steps

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
