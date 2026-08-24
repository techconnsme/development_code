// COA hierarchy utilities — mirrors the backend parent-detection rule
// (zero-stripped stem, see api/src/routes/bank-statements.ts PATCH guard):
// HK charts are fixed-length, so '66200' is a parent of '66201..' because its
// stem '662' is shared; plain prefix matching would miss '11000' -> '111xx'.

export interface CoaAccount {
  account_code: string;
  account_name: string;
  [key: string]: any;
}

export interface CoaNode {
  account: CoaAccount;
  /** 0 = root, +1 per ancestor level */
  depth: number;
  /** Shares its zero-stripped stem with another code — category header, not postable */
  isParent: boolean;
}

export function stemOfCode(code: string): string {
  return code.replace(/0+$/, '') || code.slice(0, 1);
}

/** Parking accounts created by the engine (暫記收入 Temporary Revenue / 暫記支出 Temporary Expenses). */
export function isTemporaryAccount(accountName: string | null | undefined): boolean {
  return !!accountName && /temporary|暫記|暂记/i.test(accountName);
}

/**
 * Parent = some OTHER active code starts with this code's zero-stripped stem
 * ('66200'→'662' sees '66201..'; '11000'→'11' sees '111xx'). Mirrors the SQL
 * guard in api/src/routes/bank-statements.ts PATCH /transactions/:id.
 */
export function isParentCode(code: string, allCodes: string[]): boolean {
  const stem = stemOfCode(code);
  return allCodes.some(c => c !== code && c.startsWith(stem));
}

/**
 * Flat depth-first ordering: each parent immediately followed by its
 * descendants (siblings sorted by code); standalone leaves sit at root level.
 */
export function buildCoaTree(accounts: CoaAccount[]): CoaNode[] {
  const allCodes = accounts.map(a => a.account_code);
  const isParent = (code: string) => isParentCode(code, allCodes);

  // Direct parent = the ancestor with the LONGEST stem that prefixes this code
  // ('11101' nests under '11000'[stem '11'] rather than '10000'[stem '1'])
  const parentAccounts = accounts.filter(a => isParent(a.account_code));
  const directParent = new Map<string, string>();
  for (const a of accounts) {
    let best: { code: string; len: number } | null = null;
    for (const p of parentAccounts) {
      if (p.account_code === a.account_code) continue;
      const ps = stemOfCode(p.account_code);
      if (!a.account_code.startsWith(ps)) continue;
      if (!best || ps.length > best.len) best = { code: p.account_code, len: ps.length };
    }
    if (best) directParent.set(a.account_code, best.code);
  }

  const childrenOf = new Map<string, CoaAccount[]>();
  const roots: CoaAccount[] = [];
  for (const a of accounts) {
    const d = directParent.get(a.account_code);
    if (d) {
      if (!childrenOf.has(d)) childrenOf.set(d, []);
      childrenOf.get(d)!.push(a);
    } else {
      roots.push(a);
    }
  }
  const byCode = (x: CoaAccount, y: CoaAccount) => x.account_code.localeCompare(y.account_code);
  roots.sort(byCode);
  childrenOf.forEach(arr => arr.sort(byCode));

  const out: CoaNode[] = [];
  const walk = (nodes: CoaAccount[], depth: number) => {
    for (const n of nodes) {
      out.push({ account: n, depth, isParent: isParent(n.account_code) });
      const kids = childrenOf.get(n.account_code);
      if (kids && kids.length) walk(kids, depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

/** Postable accounts only (leaves), in hierarchy order. */
export function filterLeafAccounts(accounts: CoaAccount[]): CoaAccount[] {
  return buildCoaTree(accounts).filter(n => !n.isParent).map(n => n.account);
}
