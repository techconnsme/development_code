/**
 * invoice-template.ts — Invoice/Quotation PDF template (pdf-lib)
 * Copied from pdf-single-template, adapted for OPCC CRM.
 */

import {
  rgb,
  PDFHexString,
  beginText,
  endText,
  setFontAndSize,
  moveText,
  showText,
  pushGraphicsState,
  popGraphicsState,
  PDFFont,
  PDFPage,
  PDFDocument,
} from 'pdf-lib';

type PNGImage = any;

export const PAGE_W = 595.28;
export const PAGE_H = 841.89;

const BLACK = rgb(0, 0, 0);
const THIN = 0.5;

const TBL = {
  L: 50,
  R: 527,
  NO_END: 90,
  QTY: 330,
  QTY_END: 370,
  PRICE_END: 447,
};

const Y = {
  logo:       PAGE_H - 100,
  company:    PAGE_H - 72,
  addr1:      PAGE_H - 93,
  addr2:      PAGE_H - 110,
  contact:    PAGE_H - 130,
  separator:  PAGE_H - 140,
  invoice:    PAGE_H - 165,
  custStart:  PAGE_H - 195,
  custStep:   20,
};

const HDR_H = 26;
const ROW_H = 36;
const FOOTER_BOTTOM = 314;
const PAGE_BOTTOM = 50;
const CONT_TABLE_TOP = PAGE_H - 80;
const FIRST_TABLE_TOP = Y.custStart - 3 * Y.custStep - 28;

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

function hasCJK(text: string) {
  return CJK_RE.test(text);
}

function createCJKFont(pdfDoc: PDFDocument, page: PDFPage) {
  const cjkFontDict = pdfDoc.context.obj({
    Type: 'Font',
    Subtype: 'Type0',
    BaseFont: 'PMingLiU',
    Encoding: 'UniCNS-UCS2-H',
    DescendantFonts: [pdfDoc.context.obj({
      Type: 'Font',
      Subtype: 'CIDFontType0',
      BaseFont: 'PMingLiU',
      CIDSystemInfo: pdfDoc.context.obj({
        Registry: 'Adobe',
        Ordering: 'CNS1',
        Supplement: 4,
      }),
    })],
  });
  const cjkFontRef = pdfDoc.context.register(cjkFontDict);
  return page.node.newFontDictionary('PMingLiU', cjkFontRef);
}

function cjkTextWidth(text: string, size: number) {
  let w = 0;
  for (const ch of text) {
    w += CJK_RE.test(ch) ? size : size * 0.5;
  }
  return w;
}

function drawCJKText(page: PDFPage, cjkFontKey: any, text: string, x: number, y: number, size: number, anchor = 'left') {
  const w = cjkTextWidth(text, size);
  let drawX = x;
  if (anchor === 'center') drawX = x - w / 2;
  else if (anchor === 'right') drawX = x - w;

  let hex = '';
  for (let i = 0; i < text.length; i++) {
    hex += text.charCodeAt(i).toString(16).padStart(4, '0');
  }
  const encoded = PDFHexString.of(hex);
  const contentStream = (page as any).getContentStream();
  contentStream.push(
    pushGraphicsState(),
    beginText(),
    setFontAndSize(cjkFontKey, size),
    moveText(drawX, y),
    showText(encoded),
    endText(),
    popGraphicsState(),
  );
}

function drawText(page: PDFPage, text: string, x: number, y: number, font: PDFFont, size: number, anchor = 'left', cjkFontKey?: any) {
  if (!text) return;
  if (hasCJK(text) && cjkFontKey) {
    drawCJKText(page, cjkFontKey, text, x, y, size, anchor);
    return;
  }
  const w = font.widthOfTextAtSize(text, size);
  let drawX = x;
  if (anchor === 'center') drawX = x - w / 2;
  else if (anchor === 'right') drawX = x - w;
  page.drawText(text, { x: drawX, y, font, size, color: BLACK });
}

function hLine(page: PDFPage, x1: number, x2: number, y: number, thickness = THIN) {
  page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color: BLACK });
}

function vLine(page: PDFPage, x: number, y1: number, y2: number, thickness = THIN) {
  page.drawLine({ start: { x, y: y1 }, end: { x, y: y2 }, thickness, color: BLACK });
}

function calcRows(tableTop: number, tableBottom: number) {
  return Math.max(0, Math.floor((tableTop - tableBottom - HDR_H) / ROW_H));
}

function paginateItems(items: any[]) {
  const firstRowsLast = calcRows(FIRST_TABLE_TOP, FOOTER_BOTTOM);
  const firstRowsCont = calcRows(FIRST_TABLE_TOP, PAGE_BOTTOM);
  const contRowsLast = calcRows(CONT_TABLE_TOP, FOOTER_BOTTOM);
  const contRowsCont = calcRows(CONT_TABLE_TOP, PAGE_BOTTOM);

  if (items.length <= firstRowsLast) {
    return [{ items: [...items], isFirst: true, isLast: true }];
  }

  const pages: any[] = [];
  const remaining = [...items];

  const firstCount = Math.min(remaining.length - 1, firstRowsCont);
  pages.push({ items: remaining.splice(0, firstCount), isFirst: true, isLast: false });

  while (remaining.length > 0) {
    if (remaining.length <= contRowsLast) {
      pages.push({ items: remaining.splice(0), isFirst: false, isLast: true });
    } else {
      const count = Math.min(remaining.length - 1, contRowsCont);
      pages.push({ items: remaining.splice(0, count), isFirst: false, isLast: false });
    }
  }
  return pages;
}

export interface InvoiceData {
  type?: string;
  invoice_no: string;
  invoice_date: string;
  customer_en: string;
  customer_zh?: string;
  attn?: string;
  tel?: string;
  address?: string;
  items: { no?: number; desc?: string; qty?: number; unit_price?: number }[];
  payment_terms?: string;
  company_name?: string;
  company_address1?: string;
  company_address2?: string;
  company_contact?: string;
  signatory_name?: string;
  bank_info?: string;
  bank_swift?: string;
  bank_name?: string;
  bank_address?: string;
}

export interface PdfAssets {
  logoImage?: PNGImage;
  signatureStampImage?: PNGImage;
  companyChopImage?: PNGImage;
}

export interface PdfFonts {
  arial: PDFFont;
  tnr: PDFFont;
}

function drawHeader(page: PDFPage, data: InvoiceData, fonts: PdfFonts, assets: PdfAssets, cjkFontKey: any) {
  if (assets.logoImage) {
    page.drawImage(assets.logoImage, { x: 57, y: Y.logo, width: 46, height: 37 });
  }
  const cx = PAGE_W / 2 - 50;
  drawText(page, data.company_name || '', cx, Y.company, fonts.arial, 13, 'center', cjkFontKey);
  drawText(page, data.company_address1 || 'Hong Kong', cx, Y.addr1, fonts.arial, 10, 'center', cjkFontKey);
  drawText(page, data.company_address2 || '', cx, Y.addr2, fonts.arial, 10, 'center', cjkFontKey);
  drawText(page, data.company_contact || '', cx, Y.contact, fonts.arial, 10, 'center', cjkFontKey);
  hLine(page, 50, 527, Y.separator);
  drawText(page, data.type === 'quotation' ? '報價單' : data.type === 'purchase-order' ? 'PURCHASE ORDER' : data.type === 'service-order' ? 'SERVICE ORDER' : 'INVOICE', cx, Y.invoice, fonts.arial, 18, 'center', cjkFontKey);
}

function drawContHeader(page: PDFPage, data: InvoiceData, fonts: PdfFonts, cjkFontKey: any, pageNum: number, totalPages: number) {
  const y0 = PAGE_H - 40;
  drawText(page, data.company_name || 'OPCC', PAGE_W / 2 - 50, y0, fonts.arial, 12, 'center', cjkFontKey);
  drawText(page, data.type === 'quotation' ? `Quotation No.: ${data.invoice_no}` : data.type === 'purchase-order' ? `PO No.: ${data.invoice_no}` : data.type === 'service-order' ? `SO No.: ${data.invoice_no}` : `Invoice No.: ${data.invoice_no}`, 53, y0 - 22, fonts.arial, 10, 'left', cjkFontKey);
  drawText(page, `Page ${pageNum} of ${totalPages}`, TBL.R, y0 - 22, fonts.arial, 10, 'right', cjkFontKey);
  hLine(page, 50, 527, y0 - 36);
}

function drawCustomerInfo(page: PDFPage, fonts: PdfFonts, data: InvoiceData, cjkFontKey: any) {
  const y0 = Y.custStart;
  const s = Y.custStep;

  drawText(page, 'Customer:', 52, y0, fonts.arial, 10, 'left', cjkFontKey);
  drawText(page, data.customer_en, 120, y0, fonts.arial, 10, 'left', cjkFontKey);
  const enW = fonts.arial.widthOfTextAtSize(data.customer_en, 10);
  drawText(page, data.customer_zh || '', 120 + enW + 4, y0, fonts.arial, 10, 'left', cjkFontKey);
  drawText(page, data.type === 'quotation' ? 'Quotation No. :' : 'Invoice No. :', 340, y0, fonts.arial, 10, 'left', cjkFontKey);
  drawText(page, data.invoice_no, 420, y0, fonts.arial, 10, 'left', cjkFontKey);

  const y1 = y0 - s;
  drawText(page, 'Attn:', 52, y1, fonts.arial, 10, 'left', cjkFontKey);
  drawText(page, data.attn || '', 120, y1, fonts.arial, 10, 'left', cjkFontKey);
  drawText(page, 'Date:', 340, y1, fonts.arial, 10, 'left', cjkFontKey);
  drawText(page, data.invoice_date, 420, y1, fonts.arial, 10, 'left', cjkFontKey);

  const y2 = y1 - s;
  drawText(page, 'Tel:', 52, y2, fonts.arial, 10, 'left', cjkFontKey);
  drawText(page, data.tel || '', 120, y2, fonts.arial, 10, 'left', cjkFontKey);
  drawText(page, 'E-mail:', 340, y2, fonts.arial, 10, 'left', cjkFontKey);

  const y3 = y2 - s;
  drawText(page, 'Add:', 52, y3, fonts.arial, 10, 'left', cjkFontKey);
  drawText(page, data.address || '', 120, y3, fonts.arial, 10, 'left', cjkFontKey);

  return y3;
}

function drawTable(page: PDFPage, fonts: PdfFonts, items: any[], cjkFontKey: any, tableTop: number) {
  const hdrBot = tableTop - HDR_H;
  const tableBot = hdrBot - items.length * ROW_H;

  hLine(page, TBL.L, TBL.R, tableTop);
  hLine(page, TBL.L, TBL.R, hdrBot);
  hLine(page, TBL.L, TBL.R, tableBot);

  const cols = [TBL.L, TBL.NO_END, TBL.QTY, TBL.QTY_END, TBL.PRICE_END, TBL.R];
  for (const x of cols) vLine(page, x, tableTop, tableBot);

  const yH = hdrBot + 7;
  drawText(page, 'No.', (TBL.L + TBL.NO_END) / 2, yH, fonts.arial, 10, 'center', cjkFontKey);
  drawText(page, 'Description', (TBL.NO_END + TBL.QTY) / 2, yH, fonts.arial, 10, 'center', cjkFontKey);
  drawText(page, 'Qty', (TBL.QTY + TBL.QTY_END) / 2, yH, fonts.arial, 10, 'center', cjkFontKey);
  drawText(page, 'Unit Price', (TBL.QTY_END + TBL.PRICE_END) / 2, yH, fonts.arial, 10, 'center', cjkFontKey);
  drawText(page, 'Subtotal', (TBL.PRICE_END + TBL.R) / 2, yH, fonts.arial, 10, 'center', cjkFontKey);

  let rowY = hdrBot;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const yD = rowY - ROW_H / 2 + 3;
    if (i > 0) hLine(page, TBL.L, TBL.R, rowY);

    drawText(page, String(item.no ?? i + 1), (TBL.L + TBL.NO_END) / 2, yD, fonts.arial, 10, 'center', cjkFontKey);
    drawText(page, (item.desc || '').replace(/\n/g, ''), TBL.NO_END + 6, yD, fonts.arial, 10, 'left', cjkFontKey);
    drawText(page, String(item.qty ?? ''), (TBL.QTY + TBL.QTY_END) / 2, yD, fonts.arial, 10, 'center', cjkFontKey);

    const price = item.unit_price != null ? Number(item.unit_price).toLocaleString('en-US') : '';
    drawText(page, price, TBL.PRICE_END - 4, yD, fonts.arial, 10, 'right', cjkFontKey);

    const sub = item.qty != null && item.unit_price != null ? Number(item.qty * item.unit_price).toLocaleString('en-US') : '';
    drawText(page, sub, TBL.R - 4, yD, fonts.arial, 10, 'right', cjkFontKey);

    rowY -= ROW_H;
  }
  return tableBot;
}

function drawFooter(page: PDFPage, data: InvoiceData, fonts: PdfFonts, assets: PdfAssets, cjkFontKey: any, tableBot: number, allItems: any[]) {
  let y = tableBot;

  y -= 26;
  const subtotal = allItems.reduce((s: number, it: any) => s + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0);
  drawText(page, 'Subtotal (HKD)', TBL.PRICE_END - 4, y, fonts.arial, 10, 'right', cjkFontKey);
  drawText(page, subtotal.toLocaleString('en-US'), TBL.R - 4, y, fonts.arial, 10, 'right', cjkFontKey);

  y -= 82;
  drawText(page, 'Remark:', 53, y, fonts.arial, 10, 'left', cjkFontKey);

  y -= 22;
  drawText(page, 'Payment Terms:', 53, y, fonts.arial, 10, 'left', cjkFontKey);
  drawText(page, data.payment_terms || '', 155, y, fonts.arial, 10, 'left', cjkFontKey);

  y -= 50;
  hLine(page, 53, 173, y + 7, 1.0);
  hLine(page, 330, 450, y + 7, 1.0);

  if (assets.signatureStampImage) {
    page.drawImage(assets.signatureStampImage, { x: 61, y: y - 33, width: 88, height: 97 });
  }
  if (assets.companyChopImage) {
    page.drawImage(assets.companyChopImage, { x: (PAGE_W - 55) / 2, y: y + 32, width: 55, height: 55 });
  }

  drawText(page, data.signatory_name || data.company_name || '', 53, y - 8, fonts.tnr, 10, 'left', cjkFontKey);

  y -= 18;
  drawText(page, '簽名並蓋公司印章', 53, y, fonts.arial, 10, 'left', cjkFontKey);
  drawText(page, '簽名並蓋公司印章', 330, y + 8, fonts.arial, 10, 'left', cjkFontKey);

  y -= 28;
  drawText(page, data.bank_info || '', 53, y, fonts.arial, 10, 'left', cjkFontKey);
  y -= 16;
  drawText(page, data.bank_swift || '', 53, y, fonts.arial, 10, 'left', cjkFontKey);
  y -= 16;
  drawText(page, data.bank_name || '', 53, y, fonts.arial, 10, 'left', cjkFontKey);
  y -= 16;
  drawText(page, data.bank_address || '', 53, y, fonts.arial, 10, 'left', cjkFontKey);
}

export function drawInvoice(pdfDoc: PDFDocument, data: InvoiceData, fonts: PdfFonts, assets: PdfAssets = {}) {
  const allItems = data.items || [];
  const pageBatches = paginateItems(allItems);

  for (let pi = 0; pi < pageBatches.length; pi++) {
    const batch = pageBatches[pi];
    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    const cjkFontKey = createCJKFont(pdfDoc, page);

    let tableTop: number;
    if (batch.isFirst) {
      drawHeader(page, data, fonts, assets, cjkFontKey);
      drawCustomerInfo(page, fonts, data, cjkFontKey);
      tableTop = FIRST_TABLE_TOP;
    } else {
      drawContHeader(page, data, fonts, cjkFontKey, pi + 1, pageBatches.length);
      tableTop = CONT_TABLE_TOP;
    }

    const tableBot = drawTable(page, fonts, batch.items, cjkFontKey, tableTop);

    if (batch.isLast) {
      drawFooter(page, data, fonts, assets, cjkFontKey, tableBot, allItems);
    }
  }
}
