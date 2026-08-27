// Tests for the server-side HK MPF port.
// Run: npx tsx tests/payroll-mpf.test.ts
import { computeMpf, MPF_MAX_CONTRIBUTION } from '../api/src/lib/mpf';

let pass = 0, fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) { pass++; } else { fail++; console.error(`FAIL: ${label}`); }
}

// Regression table from spec docs/superpowers/specs/2026-08-20-payroll-demo-design.md:98-106
ok(computeMpf(6000).employee === 0, 'below min: employee 0');
ok(computeMpf(6000).employer === 300, 'below min: employer 5% of 6,000');
ok(computeMpf(9500).net === 9025, '9,500 net = 9,025');
ok(computeMpf(22500).employee === 1125 && computeMpf(22500).employer === 1125, '22,500 → 1,125 both');
ok(computeMpf(28000).employee === 1400 && computeMpf(28000).employer === 1400, '28,000 → 1,400 both');
ok(computeMpf(35000).employee === MPF_MAX_CONTRIBUTION, '35,000 employee capped 1,500');
ok(computeMpf(45000).employer === 1500, '45,000 employer capped 1,500');
ok(computeMpf(0).employee === 0 && computeMpf(0).employer === 0, 'zero salary → zeros');
ok(computeMpf(-5).employee === 0 && computeMpf(-5).employer === 0, 'negative clamps to 0');

console.log(`payroll-mpf: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
