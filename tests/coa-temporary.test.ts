/**
 * Temporary COA account tests — run: npx --yes tsx tests/coa-temporary.test.ts
 */
import assert from 'node:assert/strict';
import { pickTemporaryParent, nextLeafCode } from '../api/src/lib/coa-temporary';

let pass = 0, fail = 0;
function t(name: string, fn: () => void): void {
  try { fn(); pass++; console.log('ok   - ' + name); }
  catch (e: any) { fail++; console.error('FAIL - ' + name + '\n       ' + e.message); }
}

const acct = (code: string, type = 'expense', name?: string) => ({ account_code: code, account_type: type, account_name: name || code });

t('nextLeafCode appends after existing children (66200 → 66204)', () => {
  assert.equal(nextLeafCode('66200', ['66201', '66202', '66203', '62101', '60000']), '66204');
});
t('nextLeafCode with no children → prefix+01', () => {
  assert.equal(nextLeafCode('42900', ['41101', '42101']), '42901');
});
t('nextLeafCode skips collisions', () => {
  assert.equal(nextLeafCode('66200', ['66203', '66204']), '66205');
});

t('expense parent: name-matched sundry category wins over others', () => {
  const accounts = [
    acct('62000', 'expense', 'Office Costs'),
    acct('62100', 'expense', 'Rent'),
    acct('66200', 'expense', '雜項支出 Sundry Expenses'),
    acct('66100', 'expense', 'Depreciation'),
    acct('66203'),
  ];
  const p = pickTemporaryParent(accounts, 'expense');
  assert.equal(p?.code, '66200');
});

t('revenue parent: non-recurring/other income name match', () => {
  const accounts = [
    acct('41000', 'revenue', '營業收入 Operating Revenue'),
    acct('41100', 'revenue', '服務收入 Service Income'),
    acct('42000', 'revenue', '其他收入 Other Income'),
    acct('42200', 'revenue', '非經常性收入 Non-recurring Income'),
    acct('41101'), acct('42101'), acct('42202'),
  ];
  // Both 42000 and 42200 match; tie-break = most children then highest code → 42200 (2 children vs 1)
  const p = pickTemporaryParent(accounts, 'revenue');
  assert.equal(p?.code, '42200');
});

t('falls back to category with most leaf children when no name matches', () => {
  const accounts = [
    acct('50000', 'cost', 'Direct Costs'),
    acct('51000', 'cost', 'Subcontract'),
    acct('52000', 'cost', 'Materials'),
    acct('51001'), acct('51002'), acct('52101'),
  ];
  const p = pickTemporaryParent(accounts, 'expense');
  assert.equal(p?.code, '51000'); // 2 children beats 1
});

t('no categories of the type → null (never invent structure)', () => {
  const accounts = [acct('10000', 'asset', 'Cash'), acct('11101')];
  assert.equal(pickTemporaryParent(accounts, 'revenue'), null);
});

t('class headers (X0000) are never chosen as parents', () => {
  const accounts = [acct('60000', 'expense', 'Operating Expenses'), acct('66203')];
  const p = pickTemporaryParent(accounts, 'expense');
  assert.notEqual(p?.code, '60000');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
