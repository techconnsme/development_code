// Tests for the tenant-aware bank account resolver.
// Run: npx tsx tests/bank-resolver.test.ts
import { matchKnownBank, resolveBankAccountCode } from '../api/src/lib/transaction-categorizer';

interface AcctRow { user_id: string; account_code: string; account_name: string }
interface Inserted { user_id: string; account_code: string; account_name: string; parent_code: string | null }

function mockDb(accounts: AcctRow[]) {
  const inserted: Inserted[] = [];
  return {
    inserted,
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          const first = async () => {
            if (/MAX\(CAST/.test(sql)) {
              const uid = args[0];
              const mx = Math.max(0, ...accounts
                .filter(a => a.user_id === uid && a.account_code.length === 5 && a.account_code.startsWith('1110'))
                .map(a => parseInt(a.account_code, 10)));
              return { mx: mx > 0 ? mx : null };
            }
            if (/LIKE/.test(sql) && /SELECT account_code FROM accounts/.test(sql)) {
              const [uid, en, zh] = args;
              const hit = accounts.find(a => a.user_id === uid
                && (a.account_name.includes(String(en).replace(/%/g, ''))
                  || a.account_name.includes(String(zh).replace(/%/g, ''))));
              return hit ? { account_code: hit.account_code } : null;
            }
            if (/SELECT id FROM accounts WHERE user_id = \? AND account_code = \?/.test(sql)) {
              const [uid, code] = args;
              return accounts.find(a => a.user_id === uid && a.account_code === code) ? { id: 'x' } : null;
            }
            return null;
          };
          const all = async () => {
            // ensureMissingAccounts: SELECT account_code ... WHERE user_id = ? AND account_code IN (...)
            const [uid, ...codes] = args;
            return { results: accounts.filter(a => a.user_id === uid && codes.includes(a.account_code)) };
          };
          const run = async () => {
            if (/INSERT INTO accounts/.test(sql)) {
              // ensureMissingAccounts: (id, user_id, code, name, type, parent) | resolver: (id, user_id, code, name, parent)
              const isEnsure = args.length === 6;
              inserted.push({
                user_id: args[1],
                account_code: args[2],
                account_name: args[3],
                parent_code: isEnsure ? args[5] : args[4],
              });
            }
            return { success: true };
          };
          return { first, all, run };
        },
      };
    },
  };
}

let pass = 0, fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) { pass++; } else { fail++; console.error(`FAIL: ${label}`); }
}

// ── matchKnownBank (pure) ──
ok(matchKnownBank('Hang Seng Bank')?.name === '恒生銀行 Hang Seng Bank', 'match: Hang Seng Bank');
ok(matchKnownBank('HANG SENG BANK, LTD.')?.name === '恒生銀行 Hang Seng Bank', 'match: HANG SENG uppercase');
ok(matchKnownBank('Bank of China (HK)')?.name === '中國銀行 Bank of China', 'match: BOC (HK)');
ok(matchKnownBank('Bank of China (Hong Kong)')?.name === '中國銀行 Bank of China', 'match: BOC (Hong Kong)');
ok(matchKnownBank('BOC Hong Kong')?.name === '中國銀行 Bank of China', 'match: BOC prefix');
ok(matchKnownBank('Standard Chartered Bank (HK) Ltd')?.name === '渣打銀行 Standard Chartered', 'match: StanChart');
ok(matchKnownBank('MAYBANK') === null, 'match: unknown bank → null');
ok(matchKnownBank(null) === null, 'match: null → null');
ok(matchKnownBank('HSBC Business Direct') === null, 'match: HSBC not a "known non-HSBC" bank');

// ── resolveBankAccountCode ──
(async () => {
  const U = 'u-test';

  // HSBC variants → canonical 11102, no db interaction needed
  ok(await resolveBankAccountCode(mockDb([]) as any, U, 'HSBC') === '11102', 'resolve: HSBC → 11102');
  ok(await resolveBankAccountCode(mockDb([]) as any, U, 'The Hongkong and Shanghai Banking Corporation Limited') === '11102', 'resolve: full HSBC name → 11102');
  ok(await resolveBankAccountCode(mockDb([]) as any, U, ' HSBC') === '11102', 'resolve: padded HSBC → 11102');

  // Known bank, tenant already has the account (name match) → reuse its code
  const db1 = mockDb([
    { user_id: U, account_code: '11101', account_name: '庫存現金 Cash on Hand' },
    { user_id: U, account_code: '11104', account_name: '恒生銀行 Hang Seng Bank' },
  ]);
  ok(await resolveBankAccountCode(db1 as any, U, 'Hang Seng Bank') === '11104', 'resolve: reuses existing Hang Seng account');
  ok(db1.inserted.length === 0, 'resolve: reuse inserts nothing');

  // Known bank, missing → create next sequential leaf under 11100
  const db2 = mockDb([
    { user_id: U, account_code: '11100', account_name: '現金及銀行存款 Cash & Bank' },
    { user_id: U, account_code: '11101', account_name: '庫存現金 Cash on Hand' },
    { user_id: U, account_code: '11102', account_name: '匯豐銀行 HSBC' },
    { user_id: U, account_code: '11103', account_name: '其他銀行 Other Bank' },
  ]);
  ok(await resolveBankAccountCode(db2 as any, U, 'Bank of China (HK)') === '11104', 'resolve: creates 11104 for BOC');
  const ins2 = db2.inserted.find(i => i.account_code === '11104');
  ok(!!ins2 && ins2.account_name === '中國銀行 Bank of China' && ins2.parent_code === '11100', 'resolve: BOC leaf name + parent');

  // Ordering rule with 11104 taken by another bank → next free code
  const db3 = mockDb([
    { user_id: U, account_code: '11100', account_name: '現金及銀行存款 Cash & Bank' },
    { user_id: U, account_code: '11101', account_name: '庫存現金 Cash on Hand' },
    { user_id: U, account_code: '11102', account_name: '匯豐銀行 HSBC' },
    { user_id: U, account_code: '11103', account_name: '其他銀行 Other Bank' },
    { user_id: U, account_code: '11104', account_name: '中國銀行 Bank of China' },
  ]);
  ok(await resolveBankAccountCode(db3 as any, U, 'Hang Seng Bank') === '11105', 'resolve: 11104 taken → 11105');

  // Tenant missing parents → chain ensured (10000/11000/11100 created)
  const db4 = mockDb([
    { user_id: U, account_code: '11101', account_name: '庫存現金 Cash on Hand' },
  ]);
  ok(await resolveBankAccountCode(db4 as any, U, 'Standard Chartered') === '11104', 'resolve: no-parent tenant still gets leaf');
  const ensuredParents = db4.inserted.filter(i => ['10000', '11000', '11100'].includes(i.account_code));
  ok(ensuredParents.length === 3, 'resolve: parent chain 10000/11000/11100 created');

  // Unknown bank → generic Other Bank
  ok(await resolveBankAccountCode(mockDb([]) as any, U, 'Citibank N.A.') === '11103', 'resolve: unknown → 11103');

  console.log(`${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
