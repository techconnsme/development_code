# Task 1: Backend — Add dry_run to /auto-generate-entries

**Files:**
- Modify: `api/src/routes/bookkeeping.ts:1618-1755`

**Interfaces:**
- Consumes: `categorizeTransaction`, `resolveBankAccountCode`, `getTemporaryAccount`, `collectTransactionCodes`, `ensureMissingAccounts`, `generateVoucher`
- Produces: `{ suggestions: Suggestion[], total_unposted, skipped_noise }` when `dry_run=true`

## Steps

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
