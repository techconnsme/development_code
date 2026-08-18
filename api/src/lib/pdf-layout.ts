/**
 * PDF text-item joining
 *
 * pdf.js returns page text as many small TextItems; numbers in particular
 * get fragmented ("3 4 , 2 00.00" instead of "34,200.00"). Rebuild lines
 * from item coordinates: join adjacent fragments without a space, insert a
 * space on real gaps (relative to font size), break lines on y-changes and
 * hasEOL. Pure + unit-testable.
 */

export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  hasEOL: boolean;
}

export function buildTextFromItems(items: PdfTextItem[]): string {
  const usable = items.filter((i) => typeof i.str === 'string' && i.str.trim() !== '');
  if (usable.length === 0) return '';

  // pdf.js y is the baseline; sort lines top-to-bottom, items left-to-right.
  const sorted = [...usable].sort((a, b) =>
    a.y !== b.y ? b.y - a.y : a.x - b.x,
  );

  const lines: string[] = [];
  let line = '';
  let lastY: number | null = null;
  let lastXEnd: number | null = null;
  let prevHasEOL = false;
  let lastH = 10;

  for (const item of sorted) {
    const h = item.height || lastH;
    const newLine = lastY !== null && (prevHasEOL || Math.abs(item.y - lastY) > 1.5);
    if (newLine) {
      lines.push(line.trim());
      line = '';
      lastXEnd = null;
    }
    if (lastXEnd !== null && item.x - lastXEnd > h * 0.25) {
      line += ' ';
    }
    line += item.str;
    lastY = item.y;
    lastXEnd = item.x + (item.width || 0);
    lastH = h;
    prevHasEOL = item.hasEOL;
  }
  if (line.trim()) lines.push(line.trim());

  return lines.join('\n').trim();
}
