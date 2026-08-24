// Tests for lib/bank-journal.ts validatePostingLines (pure double-entry checks).
// Run: npx --yes tsx tests/posting-validate.test.ts
import { validatePostingLines } from '../api/src/lib/bank-journal';

let passed = 0, failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++; else { failed++; console.error(`FAIL: ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`); }
}

check('valid single line', validatePostingLines([{ account_code: '62101', amount: 100 }], 100),
  { ok: true, lines: [{ account_code: '62101', amount: 100 }] });

check('valid multi-line split', validatePostingLines(
  [{ account_code: '62101', amount: 70 }, { account_code: '62401', amount: 30 }], 100),
  { ok: true, lines: [{ account_code: '62101', amount: 70 }, { account_code: '62401', amount: 30 }] });

check('rounding tolerance within cent', validatePostingLines(
  [{ account_code: '62101', amount: 33.33 }, { account_code: '62401', amount: 33.34 }], 66.67).ok,
  true);

check('unbalanced rejected', validatePostingLines([{ account_code: '62101', amount: 90 }], 100),
  { ok: false, error: 'Allocated total 90.00 must equal transaction amount 100.00' });

check('over-allocated rejected', validatePostingLines(
  [{ account_code: '62101', amount: 60 }, { account_code: '62401', amount: 60 }], 100).ok,
  false);

check('zero amount rejected', validatePostingLines([{ account_code: '62101', amount: 0 }], 100).ok,
  false);

check('negative amount rejected', validatePostingLines([{ account_code: '62101', amount: -5 }], 100).ok,
  false);

check('parent-style code format still passes format check', validatePostingLines([{ account_code: '62000', amount: 100 }], 100).ok,
  true); // leaf-vs-parent is a DB check (account-guard), not a format check

check('non-numeric code rejected', validatePostingLines([{ account_code: 'RENT', amount: 100 }]).ok ?? false,
  false);

check('empty array rejected', validatePostingLines([], 100),
  { ok: false, error: 'At least one posting line is required' });

check('non-array rejected', validatePostingLines('nope', 100),
  { ok: false, error: 'At least one posting line is required' });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
