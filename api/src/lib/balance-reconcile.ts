// ── Balance-reconciliation guard for DeepSeek-parsed bank transactions ──
//
// HSBC-style statements print transactions in a two-column Deposit/Withdrawal
// layout that DeepSeek occasionally transposes (an amount ends up in the wrong
// column). The statement also prints a running "Balance" after (some of) the
// rows — those printed balances are anchors that pin the true running total.
//
// Algorithm: between each pair of consecutive anchor rows, the signed sum of
// the batch (deposit − withdrawal) must equal the anchor difference. If it
// doesn't, find the smallest set of rows whose direction flip makes it match.

export interface ParsedTx {
  transaction_date?: string;
  description?: string;
  deposit_amount?: number;
  withdrawal_amount?: number;
  balance?: number | null;
  [key: string]: unknown;
}

const EPS = 0.01;

function* combinations(n: number, k: number): Generator<number[]> {
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    yield idx.slice();
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

export function reconcileDirections(
  txs: ParsedTx[],
  opening: number | null,
  closing: number | null,
): ParsedTx[] {
  const rows = txs.map((t, i) => ({
    ...t,
    deposit_amount: Number(t.deposit_amount) || 0,
    withdrawal_amount: Number(t.withdrawal_amount) || 0,
    balance: typeof t.balance === 'number' ? t.balance : null,
    _i: i,
  })) as (ParsedTx & { deposit_amount: number; withdrawal_amount: number; balance: number | null; _i: number })[];

  // Anchor indices = rows carrying a printed running balance
  const anchors: number[] = [];
  rows.forEach((r, i) => { if (r.balance != null) anchors.push(i); });
  if (anchors.length < 2) return stripInternal(rows);

  const signed = (r: typeof rows[number]) => r.deposit_amount - r.withdrawal_amount;

  let flips = 0;
  const flip = (r: typeof rows[number]) => {
    const d = r.deposit_amount;
    r.deposit_amount = r.withdrawal_amount;
    r.withdrawal_amount = d;
    flips++;
  };

  const checkBatch = (from: number, to: number, needed: number): void => {
    const batch = rows.slice(from + 1, to + 1);
    if (batch.length === 0) return;
    const sum = batch.reduce((s, r) => s + signed(r), 0);
    if (Math.abs(sum - needed) <= EPS) return;

    const flippable = batch.filter(r => Math.abs(r.deposit_amount - r.withdrawal_amount) > EPS);
    if (flippable.length === 0 || flippable.length > 12) return; // keep brute force bounded

    for (let size = 1; size <= flippable.length; size++) {
      for (const combo of combinations(flippable.length, size)) {
        const comboSet = new Set(combo);
        const flippedSum = batch.reduce((acc, r, idx) => {
          const f = flippable[idx];
          if (f && comboSet.has(idx)) {
            return acc - 2 * signed(f);
          }
          return acc;
        }, sum);
        if (Math.abs(flippedSum - needed) <= EPS) {
          for (const idx of combo) flip(flippable[idx]);
          console.log(`[BALANCE-GUARD] flipped ${combo.length} row(s) to reconcile anchors (needed diff ${needed})`);
          return;
        }
      }
    }
  };

  // Batch checks between consecutive anchors (sections are contiguous in order)
  for (let a = 0; a < anchors.length - 1; a++) {
    const from = anchors[a];
    const to = anchors[a + 1];
    checkBatch(from, to, rows[to].balance! - rows[from].balance!);
  }

  // Tail batch: last anchor → closing balance (if closing is known)
  const lastAnchor = anchors[anchors.length - 1];
  if (closing != null && Math.abs(rows[lastAnchor].balance! - closing) > EPS) {
    const tail = rows.slice(lastAnchor + 1);
    const sum = tail.reduce((s, r) => s + signed(r), 0);
    const needed = closing - rows[lastAnchor].balance!;
    if (Math.abs(sum - needed) > EPS) {
      const flippable = tail.filter(r => Math.abs(r.deposit_amount - r.withdrawal_amount) > EPS);
      if (flippable.length > 0 && flippable.length <= 12) {
        for (let size = 1; size <= flippable.length; size++) {
          for (const combo of combinations(flippable.length, size)) {
            const comboSet = new Set(combo);
            const flippedSum = tail.reduce((acc, r, idx) =>
              flippable[idx] && comboSet.has(idx) ? acc - 2 * signed(flippable[idx]) : acc, sum);
            if (Math.abs(flippedSum - needed) <= EPS) {
              for (const idx of combo) flip(flippable[idx]);
              console.log(`[BALANCE-GUARD] flipped ${combo.length} tail row(s) to reconcile closing (needed diff ${needed})`);
              return stripInternal(rows);
            }
          }
        }
      }
    }
  }

  if (flips > 0) console.log(`[BALANCE-GUARD] total direction flips: ${flips}`);
  return stripInternal(rows);
}

function stripInternal(rows: any[]): ParsedTx[] {
  return rows.map((r: any) => {
    const { _i, ...rest } = r;
    return rest;
  });
}
