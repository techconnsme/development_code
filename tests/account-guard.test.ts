// Tests for api/src/lib/account-guard.ts — zero-stripped-stem leaf guard.
// Run: npx --yes tsx tests/account-guard.test.ts
import { findParentAccountError, isNumericCoaCode, stemOfCode } from '../api/src/lib/account-guard';

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; } else { failed++; console.error(`FAIL: ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
}

// Fake D1: returns the row configured per test via `childRow`
function fakeDb(childRow: any) {
  return {
    prepare(_q: string) {
      return {
        bind(..._v: unknown[]) {
          return { first: async () => childRow };
        },
      };
    },
  };
}

// stemOfCode basics
check('stem strips trailing zeros', stemOfCode('66200'), '662');
check('stem of parent with mid zeros', stemOfCode('11000'), '11');
check('stem of pure leaf keeps code', stemOfCode('11101'), '11101');
check('stem of all-zero falls back to first digit', stemOfCode('00000'), '0');

// isNumericCoaCode
check('numeric ok', isNumericCoaCode('65101'), true);
check('non-numeric rejected', isNumericCoaCode('AB101'), false);
check('too long rejected', isNumericCoaCode('123456'), false);

(async () => {
  // Parent detection: children exist on the stem
  check(
    'parent with active children -> error',
    await findParentAccountError(fakeDb({ account_code: '66201' }), 'u-1', '66200'),
    '66200 is a parent account with child accounts — select a leaf account',
  );

  // Leaf: no other account on its stem (SQL would return null)
  check('leaf -> null', await findParentAccountError(fakeDb(null), 'u-1', '11101'), null);

  // Parent whose only children are inactive (SQL filters is_active=1 -> null)
  check('children all inactive -> postable again', await findParentAccountError(fakeDb(null), 'u-1', '11000'), null);

  // Non-numeric codes bypass the guard entirely (no stem rule applies)
  check('non-numeric -> null without querying', await findParentAccountError(fakeDb({ account_code: 'X' }), 'u-1', 'ALPHA'), null);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
