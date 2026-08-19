import { v4 as uuidv4 } from 'uuid';
import { buildAccountNameMap, BASE_HK_COA } from './coa-templates';

/**
 * Chart-of-accounts helpers, extracted from routes/bookkeeping.ts so that
 * lib/post-invoice.ts can reach them without importing a route module (which
 * would make bookkeeping.ts -> post-invoice.ts -> bookkeeping.ts circular).
 *
 * These depend only on coa-templates.ts, so the dependency runs lib -> lib.
 */

/** HK COA account name lookup — sourced from coa-templates.ts */
export const HK_COA_NAMES: Record<string, { name: string; type: string; parent: string | null }> =
  buildAccountNameMap(BASE_HK_COA) as Record<string, { name: string; type: string; parent: string | null }>;

export function getCodeType(code: string): string {
  if (code.startsWith('1')) return 'asset';
  if (code.startsWith('2')) return 'liability';
  if (code.startsWith('3')) return 'equity';
  if (code.startsWith('4')) return 'revenue';
  if (code.startsWith('5')) return 'cost';
  return 'expense';
}

/**
 * Create any of `codes` that the tenant's COA is missing, so a journal line can
 * reference them. `created` is a single-element counter the caller reads back.
 */
export async function ensureMissingAccounts(db: any, tenantId: string, codes: string[], created: number[]) {
  const existingRows = await db.prepare(
    `SELECT account_code FROM accounts WHERE user_id = ? AND account_code IN (${codes.map(() => '?').join(',')})`
  ).bind(tenantId, ...codes).all();
  const existingSet = new Set((existingRows.results as any[]).map(r => r.account_code));

  for (const code of codes) {
    if (existingSet.has(code)) continue;
    const info = HK_COA_NAMES[code];
    const name = info?.name || `${code} (${getCodeType(code)})`;
    const type = info?.type || getCodeType(code);
    const parentCode = info?.parent || null;
    await db.prepare(
      'INSERT INTO accounts (id, user_id, account_code, account_name, account_type, parent_code) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(`acc-${uuidv4().slice(0, 8)}`, tenantId, code, name, type, parentCode).run();
    created[0]++;
  }
}
