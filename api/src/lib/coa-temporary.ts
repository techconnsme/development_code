/**
 * Temporary Revenue / Temporary Expenses accounts.
 *
 * Per-client dynamic placement: instead of hardcoding template codes, we
 * inspect the TENANT's own COA to find the best-fitting CATEGORY-level
 * parent (prefer accounts whose own name signals sundry/misc/temporary/
 * non-recurring/other), then APPEND the new leaf code after that parent's
 * existing children (HK 5-digit scheme: parent XXX00 → children XXXnn).
 *
 * Falls back to the category with the most leaf children of the required
 * type when no name matches. Never invents a code colliding with an
 * existing one.
 */

import { v4 as uuidv4 } from 'uuid';
import { ensureMissingAccounts, HK_COA_NAMES } from './ensure-accounts';

export type TempKind = 'revenue' | 'expense';

export interface TempAccountInfo {
  code: string;
  name: string;
  kind: TempKind;
  created: boolean;
}

const NAMES: Record<TempKind, string> = {
  revenue: '暫記收入 Temporary Revenue',
  expense: '暫記支出 Temporary Expenses',
};

/** Account types eligible as temporary hosts per kind */
const TYPES: Record<TempKind, string[]> = {
  revenue: ['revenue'],
  expense: ['expense', 'cost'],
};

const MISC_NAME_RE = /SUNDRY|TEMP|MISC|OTHER|NON-RECURRING|NONRECURRING|暫|雜|其他/i;

/** Level-4 leaf = 5 digits NOT ending in 00; category parent = XXX00 but NOT the class header X0000. */
function isCategory(code: string): boolean {
  return /^\d{5}$/.test(code) && code.endsWith('00') && !/^\d0000$/.test(code);
}

function isLeaf(code: string): boolean {
  return /^\d{5}$/.test(code) && !code.endsWith('00');
}

/**
 * Pure: pick the best category-level parent from the tenant's accounts.
 * Preference order:
 *  1. category whose own NAME matches misc/sundry/temporary vocabulary
 *     (highest = most children, then highest code)
 *  2. category with the MOST leaf children
 *  3. null if the tenant has no categories of that type
 */
export function pickTemporaryParent(
  accounts: { account_code: string; account_name?: string | null; account_type: string }[],
  kind: TempKind
): { code: string; reason: string } | null {
  const types = new Set(TYPES[kind]);
  const leavesByCode = new Set(accounts.map(a => a.account_code).filter(isLeaf));

  const categories = accounts.filter(a => types.has(a.account_type) && isCategory(a.account_code));
  if (categories.length === 0) return null;

  const childCount = (code: string) =>
    [...leavesByCode].filter(l => l.startsWith(code.slice(0, 3))).length;

  const nameMatched = categories
    .filter(a => MISC_NAME_RE.test(a.account_name || ''))
    .sort((a, b) => childCount(b.account_code) - childCount(a.account_code)
      || b.account_code.localeCompare(a.account_code));
  if (nameMatched.length > 0) {
    return { code: nameMatched[0].account_code, reason: `name-matched ${nameMatched[0].account_name || ''}` };
  }

  const byChildren = [...categories].sort((a, b) => childCount(b.account_code) - childCount(a.account_code)
    || b.account_code.localeCompare(a.account_code));
  if (childCount(byChildren[0].account_code) > 0) {
    return { code: byChildren[0].account_code, reason: 'most-leaf-children' };
  }
  return null;
}

/**
 * Pure: next available leaf code under a parent given ALL existing tenant codes.
 * Parent 66200 → children 66201.. → returns 66204 when 66203 exists.
 * When no child exists yet, appends '01'.
 */
export function nextLeafCode(parentCode: string, allCodes: string[]): string {
  const prefix = parentCode.slice(0, 3);
  const children = allCodes.filter(c => isLeaf(c) && c.startsWith(prefix));
  if (children.length === 0) return `${prefix}01`;
  let candidate = String(Math.max(...children.map(Number)) + 1);
  while (allCodes.includes(candidate)) candidate = String(Number(candidate) + 1);
  return candidate;
}

// Per-isolate cache so one import batch doesn't re-query repeatedly
const cache = new Map<string, TempAccountInfo>();

function invalidate(tenantId: string): void {
  cache.delete(`${tenantId}:revenue`);
  cache.delete(`${tenantId}:expense`);
}

/**
 * Get (or lazily create) the tenant's temporary account for a kind.
 * Returns null only if the tenant COA has no usable category parent AND
 * creation of parents fails — callers treat null as "leave uncategorized".
 */
export async function getTemporaryAccount(db: any, tenantId: string, kind: TempKind): Promise<TempAccountInfo | null> {
  const key = `${tenantId}:${kind}`;
  const cached = cache.get(key);
  if (cached) return cached;

  try {
    const rows = await db.prepare(
      'SELECT account_code, account_name, account_type FROM accounts WHERE user_id = ? AND is_active = 1'
    ).bind(tenantId).all();
    const accounts = rows.results as { account_code: string; account_name?: string | null; account_type: string }[];
    const allCodes = accounts.map(a => a.account_code);

    // Already have it? (by exact name match)
    const wanted = NAMES[kind];
    const existing = accounts.find(a => (a.account_name || '').includes(wanted));
    if (existing) {
      const info: TempAccountInfo = { code: existing.account_code, name: existing.account_name || wanted, kind, created: false };
      cache.set(key, info);
      return info;
    }

    // Pick host category from THIS client's COA
    const picked = pickTemporaryParent(accounts, kind);

    if (!picked) {
      // No category-level account of this type exists in the tenant COA —
      // refuse to invent structure; caller leaves the transaction uncategorized.
      return null;
    }

    // Ensure the parent chain exists in this tenant (template names for missing ancestors)
    const parentCode = picked.code;
    const parents: string[] = [parentCode];
    const info0 = HK_COA_NAMES[parentCode];
    let cur = info0?.parent || null;
    while (cur) { parents.unshift(cur); cur = HK_COA_NAMES[cur]?.parent || null; }
    const created: number[] = [0];
    await ensureMissingAccounts(db, tenantId, Array.from(new Set(parents)), created);

    const code = nextLeafCode(parentCode, allCodes);
    await db.prepare(
      'INSERT OR IGNORE INTO accounts (id, user_id, account_code, account_name, account_type, parent_code, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)'
    ).bind(`acc-${uuidv4().slice(0, 8)}`, tenantId, code, wanted, TYPES[kind][0], parentCode).run();
    invalidate(tenantId);
    const info: TempAccountInfo = { code, name: wanted, kind, created: true };
    cache.set(key, info);
    return info;
  } catch {
    return null;
  }
}
