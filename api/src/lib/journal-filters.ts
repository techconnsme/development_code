/**
 * Canonical SQL predicates for journal_entries visibility.
 *
 * Before this existed the codebase carried four competing conventions:
 *   `status != 'stale'`      (~35 sites — excluded tombstones but COUNTED drafts)
 *   `status = 'posted'`      (chat.ts only — also excluded reconciled)
 *   `status IN ('draft','stale')`  (review-queue badges)
 *   no filter at all         (dashboard recent-activity, bank reconciliation,
 *                             the AI assistant's P&L and balance sheet)
 *
 * The result was that entries explicitly marked "not finalised" contributed to
 * the dashboard, trial balance and P&L exactly as if they were posted, and two
 * endpoints could report different totals for the same books.
 *
 * Two orthogonal questions now have two separate answers:
 *   - does this entry still exist?      -> deleted_at IS NULL
 *   - is it final enough to count?      -> status IN ('posted','reconciled')
 *
 * Every predicate takes the table alias used by the calling query, defaulting
 * to `je`. Pass 'journal_entries' for unaliased statements.
 */

/**
 * Entries that count toward financial statements — trial balance, P&L, balance
 * sheet, ledger, dashboard tiles, year-end close, tax provision.
 *
 * Deliberately an ALLOWLIST. A denylist (`status != 'draft'`) would silently
 * include any status added later, quietly inflating the books; with an
 * allowlist a new status is excluded until someone opts it in.
 *
 * `reconciled` must be here: it comes AFTER posted in the lifecycle, so
 * filtering on `= 'posted'` alone would drop reconciled entries the moment
 * that stage is implemented.
 */
export const jePosted = (alias = 'je') =>
  `${alias}.deleted_at IS NULL AND ${alias}.status IN ('posted','reconciled')`;

/**
 * Entries that still exist, in any lifecycle state.
 *
 * For operational listings where drafts SHOULD be visible — the GJE table, the
 * account drill-down, account-code discovery. Never use this for a figure that
 * feeds a financial statement.
 */
export const jeLive = (alias = 'je') => `${alias}.deleted_at IS NULL`;

/**
 * Tombstoned entries — the recycle-bin view.
 *
 * For the soft-delete lifecycle only: marking on delete, clearing on restore,
 * hard-deleting past the retention window.
 */
export const jeDeleted = (alias = 'je') => `${alias}.deleted_at IS NOT NULL`;

/**
 * Entries awaiting review: live, but not yet finalised.
 *
 * Replaces the old `status IN ('draft','stale')` used by the review queue.
 * Note the behaviour change — tombstoned entries no longer appear in the review
 * queue, since a deleted entry is not something to review. Restoring a deleted
 * bank statement remains available through the recycle-bin flow.
 */
export const jeDraft = (alias = 'je') =>
  `${alias}.deleted_at IS NULL AND ${alias}.status = 'draft'`;
