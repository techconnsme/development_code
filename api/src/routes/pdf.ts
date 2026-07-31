import { Hono } from 'hono';
import { Bindings, Variables } from '../types';
import { authMiddleware } from '../middleware/auth';
import { generateInvoicePDF } from '../lib/pdf-gen';
import type { InvoiceData } from '../lib/invoice-template';

const pdf = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const TYPE_CONFIG: Record<string, { table: string; itemsTable: string; fkCol: string; numCol: string; joinTable: string; joinCol: string }> = {
  invoice: { table: 'invoices', itemsTable: 'invoice_items', fkCol: 'invoice_id', numCol: 'invoice_number', joinTable: 'customers', joinCol: 'customer_id' },
  quotation: { table: 'quotations', itemsTable: 'quotation_items', fkCol: 'quotation_id', numCol: 'quotation_number', joinTable: 'customers', joinCol: 'customer_id' },
  'purchase-order': { table: 'purchase_orders', itemsTable: 'purchase_order_items', fkCol: 'po_id', numCol: 'po_number', joinTable: 'suppliers', joinCol: 'supplier_id' },
  'service-order': { table: 'service_orders', itemsTable: 'service_order_items', fkCol: 'so_id', numCol: 'so_number', joinTable: 'customers', joinCol: 'customer_id' },
};

const TYPE_LABELS: Record<string, string> = {
  invoice: 'invoice', quotation: 'quotation',
  'purchase-order': 'purchase-order', 'service-order': 'service-order',
};

function buildPayload(doc: Record<string, any>, items: any[], type: string): InvoiceData {
  const cfg = TYPE_CONFIG[type];
  const isSupplier = type === 'purchase-order';
  return {
    type: TYPE_LABELS[type] || type,
    invoice_no: doc[cfg.numCol] || '',
    invoice_date: (doc.issue_date || '').replace(/-/g, '/'),
    customer_en: isSupplier ? (doc.supplier_name || '') : (doc.customer_name || ''),
    customer_zh: isSupplier ? (doc.supplier_company || '') : (doc.customer_company || ''),
    attn: doc.attn || (isSupplier ? (doc.supplier_name || '') : (doc.customer_name || '')),
    tel: doc.customer_phone || (isSupplier ? (doc.supplier_phone || '') : (doc.customer_phone || '')),
    address: doc.customer_address || (isSupplier ? (doc.supplier_address || '') : (doc.customer_address || '')),
    items: items.map((it: any, idx: number) => ({
      no: idx + 1,
      desc: it.description || '',
      qty: Number(it.quantity || 0),
      unit_price: Number(it.unit_price || 0),
    })),
    payment_terms: doc.terms || 'COD',
  };
}

pdf.get('/:type/:id', async (c) => {
  const type = c.req.param('type');
  const id = c.req.param('id');
  const cfg = TYPE_CONFIG[type];
  if (!cfg) {
    return c.json({ error: 'Type must be invoice, quotation, purchase-order, or service-order' }, 400);
  }

  const db = c.env.DB;
  const joinAlias = type === 'purchase-order' ? 's' : 'c';

  const doc = await db.prepare(
    `SELECT d.*, ${joinAlias}.name as ${joinAlias}_name, ${joinAlias}.email as ${joinAlias}_email, ${joinAlias}.company_name as ${joinAlias}_company, ${joinAlias}.address as ${joinAlias}_address, ${joinAlias}.phone as ${joinAlias}_phone FROM ${cfg.table} d JOIN ${cfg.joinTable} ${joinAlias} ON d.${cfg.joinCol} = ${joinAlias}.id WHERE d.id = ?`
  ).bind(id).first();

  if (!doc) return c.json({ error: 'Not found' }, 404);

  const items = await db.prepare(
    `SELECT * FROM ${cfg.itemsTable} WHERE ${cfg.fkCol} = ? ORDER BY sort_order`
  ).bind(id).all();

  const userId = (doc as any).user_id;
  const company = await db.prepare("SELECT * FROM company_settings WHERE user_id = ? LIMIT 1").bind(userId).first<Record<string, string>>();
  const userFallback = await db.prepare("SELECT company_name, name FROM users WHERE id = ?").bind(userId).first<{ company_name: string | null; name: string }>();

  const payload = buildPayload(doc as Record<string, any>, items.results as any[], type);
  payload.company_name = (company as any)?.name || userFallback?.company_name || userFallback?.name || '';
  payload.company_address1 = (company as any)?.address || 'Hong Kong';
  payload.company_address2 = (company as any)?.address2 || (company as any)?.website || '';
  payload.company_contact = `Tel: ${(company as any)?.phone || ''}  Email: ${(company as any)?.email || ''}`;
  payload.signatory_name = (company as any)?.signatory_name || '';
  const legalName = (company as any)?.legal_name || (company as any)?.name || '';
  const bankAcc = (company as any)?.bank_account || '';
  const bankNam = (company as any)?.bank_name || '';
  payload.bank_info = bankNam ? `${legalName} \u2022 Acc#: ${bankAcc} \u2022 Bank: ${bankNam}` : '';
  payload.bank_swift = (company as any)?.bank_swift ? `BIC/SWIFT: ${(company as any).bank_swift}` : '';
  payload.bank_name = bankNam ? `Beneficiary Bank Name: ${bankNam}` : '';
  payload.bank_address = (company as any)?.bank_address ? `Beneficiary Bank Address: ${(company as any).bank_address}` : '';

  const num = doc[cfg.numCol] as string;

  try {
    const pdfBytes = await generateInvoicePDF(c.env.FILE_BUCKET, payload, (doc as any).user_id);
    const isInline = c.req.query('inline') !== null;
    return new Response(pdfBytes, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': isInline ? 'inline' : `attachment; filename="${encodeURIComponent(num || type)}.pdf"`,
      },
    });
  } catch (err: any) {
    return c.json({ error: 'PDF generation failed', details: err.message }, 500);
  }
});

export { pdf as pdfRoutes };
