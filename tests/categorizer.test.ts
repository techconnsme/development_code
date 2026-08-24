/**
 * Categorizer engine tests — run: npx --yes tsx tests/categorizer.test.ts
 * Corpus grounded in real HSBC Business Direct eStatements
 * (test-sample-real/EHSIA/eStatement + test-sample-real/PNR/estatement)
 * plus generated-sample formats (test-samples-generated/generate.py).
 */
import assert from 'node:assert/strict';
import {
  categorizeTransaction,
  normalizeDescription,
  resolveBankAccountCode,
} from '../api/src/lib/transaction-categorizer';

let pass = 0;
let fail = 0;
function t(name: string, fn: () => void): void {
  try { fn(); pass++; console.log('ok   - ' + name); }
  catch (e: any) { fail++; console.error('FAIL - ' + name + '\n       ' + e.message); }
}

// ── normalizeDescription ──
t('normalize strips cheque ref + date', () => {
  assert.equal(normalizeDescription('CHARGES\nHC12591979064879   19SEP'), 'CHARGES');
});
t('normalize strips transfer ref w/ bracketed date', () => {
  assert.equal(normalizeDescription('FROM PROFICIENCY & R\nSWEEP   (30MAY25)'), 'FROM PROFICIENCY & R SWEEP');
});
t('normalize keeps masked initials', () => {
  const n = normalizeDescription('LIN P** K**** J*****');
  assert.match(n, /LIN P\*+ K\*+ J\*+/);
});

// ── bank charges (the real-HSBC block) ──
t('bare CHARGES withdrawal -> 65101', () => {
  const r = categorizeTransaction('CHARGES\nHC125B0521391053   05NOV', 'withdrawal');
  assert.equal(r?.code, '65101'); assert.equal(r?.tag, 'bank_charge'); assert.equal(r?.confidence, 'exact');
});
t('MONTHLY SERVICE FEE -> 65101', () => {
  assert.equal(categorizeTransaction('MONTHLY SERVICE FEE', 'withdrawal')?.code, '65101');
});
t('PAPER STATEMENT FEE -> 65101', () => {
  assert.equal(categorizeTransaction('PAPER STATEMENT FEE', 'withdrawal')?.code, '65101');
});
t('two-line ACCOUNT APPLICATION FEE -> 65101', () => {
  assert.equal(categorizeTransaction('ACCOUNT APPLICATION\nFEE', 'withdrawal')?.code, '65101');
});
t('BLG CQBK FEE -> 65101', () => {
  assert.equal(categorizeTransaction('BLG CQBK FEE', 'withdrawal')?.code, '65101');
});
t('BANK CHARGES-MONTHLY FEE (generated format) -> 65101', () => {
  assert.equal(categorizeTransaction('BANK CHARGES-MONTHLY FEE', 'withdrawal')?.code, '65101');
});
t('FPS FEE -> 65101', () => {
  assert.equal(categorizeTransaction('FPS FEE', 'withdrawal')?.code, '65101');
});
t('WIRE TRANSFER FEE -> 65101', () => {
  assert.equal(categorizeTransaction('WIRE TRANSFER FEE', 'withdrawal')?.code, '65101');
});
t('HANG SENG CARD FEE -> 65101', () => {
  assert.equal(categorizeTransaction('HANG SENG CARD FEE', 'withdrawal')?.code, '65101');
});
t('HSBC CREDIT CARD FEE -> 65101', () => {
  assert.equal(categorizeTransaction('HSBC CREDIT CARD FEE', 'withdrawal')?.code, '65101');
});

// ── interest directionality ──
t('DEBIT INTEREST withdrawal -> 65102', () => {
  const r = categorizeTransaction('28MAY25 TO 27JUN25\nDEBIT INTEREST', 'withdrawal');
  assert.equal(r?.code, '65102'); assert.equal(r?.tag, 'interest_expense');
});
t('CREDIT INTEREST deposit -> 42101', () => {
  const r = categorizeTransaction('CREDIT INTEREST', 'deposit');
  assert.equal(r?.code, '42101'); assert.equal(r?.tag, 'interest_income');
});
t('INTEREST-SAVINGS ACCOUNT deposit -> 42101', () => {
  assert.equal(categorizeTransaction('INTEREST-SAVINGS ACCOUNT', 'deposit')?.code, '42101');
});
t('INTEREST CHARGE on card (wd) -> 65102 not 42101', () => {
  assert.equal(categorizeTransaction('INTEREST CHARGE', 'withdrawal')?.code, '65102');
});

// ── fee refund credits back ──
t('REFUND MONTHLY FEE deposit -> 65101 fee_refund', () => {
  const r = categorizeTransaction('REFUND MONTHLY FEE25\n0509163829754', 'deposit');
  assert.equal(r?.code, '65101'); assert.equal(r?.tag, 'fee_refund');
});

// ── ignore / internal transfers ──
t('B/F BALANCE -> ignore (empty code)', () => {
  const r = categorizeTransaction('25 Mar   B/F BALANCE', 'deposit');
  assert.equal(r?.code, ''); assert.equal(r?.tag, 'ignore');
});
t('SWEEP row -> internal_transfer (no posting)', () => {
  const r = categorizeTransaction('FROM PROFICIENCY & R\nSWEEP (30MAY25)', 'deposit');
  assert.equal(r?.code, ''); assert.equal(r?.tag, 'internal_transfer');
});
t('CR TO bare account number only -> internal_transfer', () => {
  const n = normalizeDescription('CR TO 147-162101-838\nNA0315859585(03OCT25)');
  assert.equal(n, 'CR TO');
  const r = categorizeTransaction('CR TO 147-162101-838\nNA0315859585(03OCT25)', 'withdrawal');
  assert.equal(r?.tag, 'internal_transfer');
});
t('CR TO WEB HOSTING is NOT internal transfer -> 62302', () => {
  assert.equal(categorizeTransaction('CR TO 484-485073-001\nWEB HOSTING (27OCT25)', 'withdrawal')?.code, '62302');
});

// ── tax ──
t('INLAND REVENUE truncated withdrawal -> 21301', () => {
  const r = categorizeTransaction('INLAND REVENUE DEPAR\nHC125A2277483689   22OCT', 'withdrawal');
  assert.equal(r?.code, '21301'); assert.equal(r?.tag, 'tax');
});
t('TAXI does not match TAX rule -> falls through (null)', () => {
  // "UBER TRIP" style; ensure \bTAX\b does not hit TAXI
  assert.notEqual(categorizeTransaction('TAXI RIDE', 'withdrawal')?.tag, 'tax');
});

// ── director deposits incl. masking ──
t('masked LIN P** K**** J***** cheque deposit -> 21201', () => {
  const r = categorizeTransaction('LIN P** K**** J*****\nHC12631017550327   10MAR', 'deposit');
  assert.equal(r?.code, '21201'); assert.equal(r?.tag, 'director');
});
t('SZETO CHI MAN ATM TRANSFER deposit -> 21201', () => {
  const r = categorizeTransaction('SZETO CHI MAN\nATM TRANSFER   (20MAR25)', 'deposit');
  assert.equal(r?.code, '21201'); assert.equal(r?.tag, 'director');
});

// ── income side ──
t('CHEQUE DEPOSIT MACHINE -> 41101', () => {
  const r = categorizeTransaction('REF:5849 0008\nCHEQUE DEPOSIT MACHINE\n(18SEP25)', 'deposit');
  assert.equal(r?.code, '41101'); assert.equal(r?.tag, 'income');
});
t('FPS INWARD-CUSTOMER PAYMENT -> 41101', () => {
  assert.equal(categorizeTransaction('FPS INWARD-CUSTOMER PAYMENT', 'deposit')?.code, '41101');
});
t('PASTEL TECH LIMITED deposit -> null (caller applies 41101 default)', () => {
  assert.equal(categorizeTransaction('PASTEL TECH LIMITED\nHC12620511998551   05FEB', 'deposit'), null);
});
t('PASTEL TECH withdrawal -> 51101 subcontractor', () => {
  assert.equal(categorizeTransaction('PASTEL TECH LIMITED', 'withdrawal')?.code, '51101');
});

// ── carried catalog spot checks ──
t('PAYROLL-AUGUST 2026 wd -> 61201', () => {
  assert.equal(categorizeTransaction('PAYROLL-AUGUST 2026', 'withdrawal')?.code, '61201');
});
t('AUTO DEBIT-HKT TELECOM wd -> 62301', () => {
  assert.equal(categorizeTransaction('AUTO DEBIT-HKT TELECOM', 'withdrawal')?.code, '62301');
});
t('GOOGLE ADS wd -> 64101 (not software)', () => {
  const r = categorizeTransaction('GOOGLE ADS', 'withdrawal');
  assert.equal(r?.code, '64101');
});
t('AWS AMAZON WEB SERVICES wd -> 62303', () => {
  assert.equal(categorizeTransaction('AWS AMAZON WEB SERVICES', 'withdrawal')?.code, '62303');
});
t('MTR CORPORATION wd -> 64301', () => {
  assert.equal(categorizeTransaction('MTR CORPORATION', 'withdrawal')?.code, '64301');
});
t('DELIVEROO FOOD DELIVERY wd -> 64202', () => {
  assert.equal(categorizeTransaction('DELIVEROO FOOD DELIVERY', 'withdrawal')?.code, '64202');
});
t('WELLCOME SUPERMARKET wd -> 62402', () => {
  assert.equal(categorizeTransaction('WELLCOME SUPERMARKET', 'withdrawal')?.code, '62402');
});
t('OFFICE SUPPLIES-WHSmith wd -> 62401', () => {
  assert.equal(categorizeTransaction('OFFICE SUPPLIES-WHSmith', 'withdrawal')?.code, '62401');
});
t('RENT-CENTRAL PROPERTY MGMT wd -> 62101', () => {
  assert.equal(categorizeTransaction('RENT-CENTRAL PROPERTY MGMT', 'withdrawal')?.code, '62101');
});
t('AUDIT FEE-DELOITTE wd -> 63101', () => {
  assert.equal(categorizeTransaction('AUDIT FEE-DELOITTE', 'withdrawal')?.code, '63101');
});

// ── direction guard ──
t('DEBIT INTEREST passed as deposit -> no interest_income match (null)', () => {
  const r = categorizeTransaction('DEBIT INTEREST', 'deposit');
  assert.ok(!r || r.code !== '42101');
});

// ── fuzzy tier ──
t('typo SERVCE FEE wd -> 65101 fuzzy', () => {
  const r = categorizeTransaction('SERVCE FEE', 'withdrawal');
  assert.equal(r?.code, '65101'); assert.equal(r?.confidence, 'fuzzy');
});
t('unlisted GATE FEES wd -> 65101 fuzzy via prefix', () => {
  const r = categorizeTransaction('GATE FEES', 'withdrawal');
  assert.equal(r?.code, '65101'); assert.equal(r?.confidence, 'fuzzy');
});
t('counterparty-only truncation SMART CITY CONSORTIU -> null (no silent guess)', () => {
  assert.equal(categorizeTransaction('SMART CITY CONSORTIU\nHC12561707588788   17JUN', 'deposit'), null);
});

// ── resolveBankAccountCode (async, tenant-aware — db-backed coverage in tests/bank-resolver.test.ts) ──
(async () => {
  try {
    assert.equal(await resolveBankAccountCode(null as any, 'u-x', 'HSBC'), '11102');
    assert.equal(await resolveBankAccountCode(null as any, 'u-x', 'The Hongkong and Shanghai Banking Corporation'), '11102');
    assert.equal(await resolveBankAccountCode(null as any, 'u-x', '滙豐銀行'), '11102');
    pass++; console.log('ok   - resolveBankAccountCode HSBC variants -> 11102');
  } catch (e: any) { fail++; console.error('FAIL - resolveBankAccountCode HSBC variants\n       ' + e.message); }
  try {
    assert.equal(await resolveBankAccountCode(null as any, '', 'Citibank N.A.'), '11103');
    assert.equal(await resolveBankAccountCode(null as any, '', null), '11103');
    assert.equal(await resolveBankAccountCode(null as any, '', undefined), '11103');
    pass++; console.log('ok   - resolveBankAccountCode unknown/null -> 11103');
  } catch (e: any) { fail++; console.error('FAIL - resolveBankAccountCode unknown/null\n       ' + e.message); }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
if (fail > 0) process.exit(1);
