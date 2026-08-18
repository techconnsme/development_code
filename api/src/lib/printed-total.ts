/**
 * Printed Grand-Total Extraction
 *
 * Extracts the printed "Total Amount Due" / "總額" figure from OCR text
 * (EN + ZH labels for HK bilingual invoices). Pure, unit-testable.
 *
 * The bare TOTAL alternative is kept for invoices that only print "Total",
 * but a negative lookahead rejects digits followed by month/day context so
 * lines like "Monthly Total 1 Jan 2025 – 30 Apr 2025" are never read as a
 * grand total (real failure observed 2026-08-18 on the Pastel pdf-text OCR).
 */

const MONTH_GUARD = /(?!\s*(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|月|日))/;

const LABELS =
  'TOTAL\\s*AMOUNT\\s*DUE|GRAND\\s*TOTAL|TOTAL\\s*DUE|AMOUNT\\s*DUE|TOTAL|' +
  '應付總額|應付金額|應繳金額|應繳總額|到期應付|付款總額|總金額|總計|總額|合計|合共|共計|總數|總價|總款項|' +
  '应付总额|应付金额|应缴金额|应缴总额|到期应付|付款总额|总金额|总计|总额|合计|合共|共计|总数|总价|总款项';

const RE = new RegExp(
  `(?:${LABELS})[\\s:：]*[$HKD]*\\s*(?:港幣|港元)?\\s*([\\d,]+\.?\\d*)${MONTH_GUARD.source}`,
  'i',
);

export function extractPrintedTotal(ocrText: string): number | null {
  if (!ocrText) return null;
  const m = ocrText.match(RE);
  return m ? parseFloat(m[1].replace(/,/g, '')) : null;
}
