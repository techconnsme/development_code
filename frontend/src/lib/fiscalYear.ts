// Shared fiscal year utilities — used by DateFilterContext and all pages

export interface FiscalYearOption {
  label: string;      // e.g. "2025-26 (Apr 2025 – Mar 2026)"
  startDate: string;  // e.g. "2025-04-01"
  endDate: string;    // e.g. "2026-03-31"
  value: string;      // e.g. "2025-2026"
}

const MONTH_NAMES_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Format month number (1-12) to short name, e.g. 4 → "Apr" */
export function monthName(month: number): string {
  return MONTH_NAMES_EN[month - 1] || String(month);
}

/** Build 6 fiscal year options (current + 5 prior) based on company fiscal calendar */
export function buildFiscalYearOptions(
  fiscalStartMD: string,  // e.g. "04-01" or "2026-04-01"
  fiscalEndMD: string,    // e.g. "03-31" or "2027-03-31"
): FiscalYearOption[] {
  // Normalize: handle both "04-01" and "2026-04-01" formats
  const startParts = fiscalStartMD.split('-').map(Number);
  const endParts = fiscalEndMD.split('-').map(Number);
  const sm = startParts.length >= 3 ? startParts[1] : startParts[0]; // start month
  const sd = startParts.length >= 3 ? startParts[2] : startParts[1]; // start day
  const em = endParts.length >= 3 ? endParts[1] : endParts[0];       // end month
  const ed = endParts.length >= 3 ? endParts[2] : endParts[1];       // end day

  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  let baseYear = now.getFullYear();
  if (currentMonth < sm) baseYear--;

  const startMonthName = monthName(sm);
  const endMonthName = monthName(em);

  const opts: FiscalYearOption[] = [];
  for (let i = 5; i >= 0; i--) {
    const sy = baseYear - i;
    // Fiscal year crosses calendar year if end month <= start month
    const ey = em <= sm ? sy + 1 : sy;
    const sD = `${sy}-${String(sm).padStart(2, '0')}-${String(sd).padStart(2, '0')}`;
    const eD = `${ey}-${String(em).padStart(2, '0')}-${String(ed).padStart(2, '0')}`;
    const shortSy = String(sy).slice(2);
    const shortEy = String(ey).slice(2);

    if (em <= sm) {
      // Cross-year fiscal year: e.g. Apr 2025 – Mar 2026
      opts.push({
        label: `${shortSy}-${shortEy} (${startMonthName} ${sy} – ${endMonthName} ${ey})`,
        startDate: sD,
        endDate: eD,
        value: `${sy}-${ey}`,
      });
    } else {
      // Same-year fiscal year: e.g. Jan 2025 – Dec 2025
      opts.push({
        label: `${sy} (${startMonthName} – ${endMonthName} ${sy})`,
        startDate: sD,
        endDate: eD,
        value: `${sy}-${sy}`,
      });
    }
  }
  return opts;
}
