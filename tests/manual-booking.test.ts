// Tests for manual booking helpers.
// Run: npx tsx tests/manual-booking.test.ts
import { nextManualVoucherNumber, hasSharedAccount, findSimilarEntryCandidates, buildFileLinks } from '../api/src/lib/manual-booking';

let capturedSql: string[] = [];

function mockDb(entryNumbers: string[], similarRows: any[] = []) {
  return {
    prepare(sql: string) {
      capturedSql.push(sql);
      return {
        bind(...args: any[]) {
          const first = async () => {
            if (/LIKE/.test(sql) && /entry_number/.test(sql)) {
              const like = String(args[1]);
              const matching = entryNumbers
                .filter(n => n.startsWith(like.slice(0, -1)))
                .sort();
              return matching.length ? { entry_number: matching[matching.length - 1] } : null;
            }
            return null;
          };
          const all = async () => {
            if (/GROUP_CONCAT/.test(sql)) return { results: similarRows };
            return { results: [] };
          };
          return { first, all, run: async () => ({ success: true }) };
        },
      };
    },
  };
}

let pass = 0, fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) { pass++; } else { fail++; console.error(`FAIL: ${label}`); }
}

(async () => {
  const U = 'u-test';

  // ── nextManualVoucherNumber ──
  ok(await nextManualVoucherNumber(mockDb([]), U, '2026-08-27') === 'MJ-202608-001', 'first number is MJ-202608-001');
  ok(await nextManualVoucherNumber(mockDb(['MJ-202608-003']), U, '2026-08-27') === 'MJ-202608-004', 'after 003 comes 004');
  ok(await nextManualVoucherNumber(mockDb(['MJ-202607-009']), U, '2026-08-27') === 'MJ-202608-001', 'month rollover restarts seq');
  ok(await nextManualVoucherNumber(mockDb(['MJ-202608-010']), U, '2026-08-01') === 'MJ-202608-011', 'padded comparison');
  capturedSql = [];
  await nextManualVoucherNumber(mockDb([]), U, '2026-08-27');
  ok(!capturedSql.some(s => /deleted_at/.test(s)), 'number scan includes tombstones (no deleted_at filter)');

  // ── hasSharedAccount ──
  ok(hasSharedAccount(['63101', '21101'], ['21101', '11102']) === true, 'shared code detected');
  ok(hasSharedAccount(['63101'], ['21101']) === false, 'no shared code');
  ok(hasSharedAccount([], ['21101']) === false, 'empty candidate codes');

  // ── findSimilarEntryCandidates ──
  const db = mockDb([], [
    { id: 'je-1', entry_number: 'MJ-202608-001', description: 'Audit fee', total_debit: 12000, codes: '63101,21101' },
    { id: 'je-2', entry_number: 'MJ-202608-002', description: 'Rent', total_debit: 5000, codes: null },
  ]);
  const cands = await findSimilarEntryCandidates(db, U, '2026-08-27', 12000);
  ok(cands.length === 2, 'two candidates mapped');
  ok(cands[0].line_codes.join(',') === '63101,21101', 'codes split on comma');
  ok(cands[1].line_codes.length === 0, 'null codes → empty array');

  // ── buildFileLinks ──
  const links1 = buildFileLinks({ invoice_id: 'inv-1', invoice_number: 'INV-001414', vendor_name: 'Pastel Tech', invoice_total: 15300 }, []);
  ok(links1.length === 1 && links1[0].kind === 'invoice' && /INV-001414/.test(links1[0].label), 'invoice link');
  const links2 = buildFileLinks({ invoice_id: 'inv-2', invoice_number: 'REC2608-001' }, []);
  ok(links2[0].kind === 'receipt', 'REC-prefixed number → receipt kind');
  const links3 = buildFileLinks({ statement_id: 'bs-1', stmt_bank_name: 'HSBC' }, []);
  ok(links3[0].kind === 'bank_statement' && /HSBC/.test(links3[0].label), 'bank statement link');
  const links4 = buildFileLinks({ card_statement_id: 'cs-1', card_issuer: 'Visa' }, []);
  ok(links4[0].kind === 'card_statement', 'card statement link');
  const links5 = buildFileLinks({}, [{ id: 'je-9', entry_number: 'MJ-202608-005', entry_date: '2026-08-27' }]);
  ok(links5[0].kind === 'journal_entry' && /MJ-202608-005/.test(links5[0].label), 'journal entry link');
  ok(buildFileLinks({}, []).length === 0, 'clean file → no links');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
