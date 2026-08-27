// Server-side port of frontend/src/lib/mpf.ts (HK MPF, rules in force 2026-08).
// 5% each side; relevant income below HK$7,100 → employee exempt (0), employer still 5%;
// maximum relevant income HK$30,000 → cap HK$1,500 per side.

export const MPF_MIN_MONTHLY_INCOME = 7100;
export const MPF_MAX_MONTHLY_INCOME = 30000;
export const MPF_RATE = 0.05;
export const MPF_MAX_CONTRIBUTION = 1500;

export interface MpfResult {
  employee: number;
  employer: number;
  net: number;
}

export function computeMpf(grossMonthly: number): MpfResult {
  const gross = Math.max(0, grossMonthly);
  const employer = Math.min(Math.round(gross * MPF_RATE), MPF_MAX_CONTRIBUTION);
  const employee =
    gross < MPF_MIN_MONTHLY_INCOME ? 0 : Math.min(Math.round(gross * MPF_RATE), MPF_MAX_CONTRIBUTION);
  return { employee, employer, net: gross - employee };
}
