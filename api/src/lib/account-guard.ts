// Shared COA leaf-account guard — mirrors the zero-stripped-stem rule used by
// the frontend pickers (frontend/src/lib/coa-hierarchy.ts).
//
// HK charts are fixed-length numeric codes: '66200' is a PARENT of '66201..'
// because its stem ('662') prefixes them; plain equality/prefix of the full
// code would miss it.

/** Numeric HK-style chart code (1–5 digits). Non-numeric codes are not guarded. */
export function isNumericCoaCode(code: string): boolean {
  return /^\d{1,5}$/.test(code);
}

export function stemOfCode(code: string): string {
  return code.replace(/0+$/, '') || code.slice(0, 1);
}

interface MinimalDb {
  prepare(query: string): {
    bind(...values: unknown[]): { first(): Promise<any> };
  };
}

/**
 * Returns an error message when `code` is a parent account that still has
 * active child accounts (i.e. it must never receive postings/B-F balances),
 * or null when the code is postable / not applicable.
 */
export async function findParentAccountError(
  db: MinimalDb,
  userId: string,
  code: string,
): Promise<string | null> {
  const submitted = String(code ?? '');
  if (!isNumericCoaCode(submitted)) return null;
  const stem = stemOfCode(submitted);
  const childRow = await db.prepare(
    `SELECT account_code FROM accounts WHERE user_id = ? AND is_active = 1
     AND account_code != ? AND substr(account_code, 1, length(?)) = ?
     LIMIT 1`
  ).bind(userId, submitted, stem, stem).first();
  if (!childRow) return null;
  return `${submitted} is a parent account with child accounts — select a leaf account`;
}
