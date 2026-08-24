# Multi-Account Inline Posting — 2026-08-24

## Goal
Replace single-COA-account editing on statement transactions with a click-to-expand inline panel showing the real debit/credit journal lines. Users split one transaction across multiple accounts with amounts; save validates double-entry. Applied to Bank Statements list, Bank Statement Review, Card Statements, Card Review.

## Decisions (user-approved)
1. Bank/card side FIXED: deposit ⇒ Dr(bank) locked, credits split across N accounts; withdrawal ⇒ Cr(bank) locked, debits split.
2. Storage = existing journal_entries/journal_lines (`reference_type='bank_transaction'`). New column `journal_entries.entry_source TEXT NOT NULL DEFAULT 'auto'`.
3. Account column kept — renders ALL posting-line codes as stacked badges.
4. Auto-mapping preserved; manual postings win (regen/auto-categorize skip them); "Reset to auto" with explicit override-warning dialog restores engine control.

## Backend
- Migration `api/src/db/migration-je-entry-source.sql` (+ schema.sql).
- `lib/bank-journal.ts`: `getStatementPostings()`, `replaceTransactionPosting()`, pure validator `validatePostingLines()`; generated entries marked `'auto'`; reset path re-runs engine for one tx.
- `routes/bank-statements.ts`: GET /:id attaches `posting` per tx; NEW PUT `/transactions/:id/posting` (contra-lines contract; guards: N/A rows, invoice-linked rows, reconciled statements, parent accounts via account-guard, zero/negative amounts, sum≠amount); PATCH regen + auto-categorize skip manual; `{reset_to_auto:true}` supported.
- `routes/card-statements.ts`: detail includes postings; same PUT shape (fixed side = card liability); post-to-GL marks 'auto' + skips manual.

## Frontend
- `components/TxPostingPanel.tsx`: locked bank row, editable lines [Dr/Cr badge · hierarchical leaf-only select · amount · ✕], "+ Add account" prefills remaining, live Allocated footer, Save/Cancel, Reset-to-auto + override modal; disabled states for N/A / invoice-linked / reconciled.
- Surfaces: BankStatements list (row expand; stacked code badges in Account column), BankStatementReview rows, CardStatements + CardStatementReview.
- Temp styling: `isTemporaryAccount(name)` helper; red-tinted rows + 暫記 badge in panel/AccountModal; `· 暫記` suffix on native selects.

## Verification
- tests/posting-validate.test.ts (~10 cases); existing suites stay green.
- QA: split reflects in ledger; auto-categorize skips manual; delete stales manual JE; restore round-trip.

## Deploy order
D1 ALTER → API deploy → frontend deploy (no backfill; DEFAULT covers existing).
