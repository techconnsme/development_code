export interface SimilarEntry {
  id: string; entry_number: string; description: string; total_debit: number;
}

export interface FileLink {
  kind: 'invoice' | 'receipt' | 'bank_statement' | 'card_statement' | 'journal_entry';
  id: string; label: string;
  source?: 'ocr' | 'manual';
}

export async function nextManualVoucherNumber(db: any, tenantId: string, date: string): Promise<string> {
  const ym = date.slice(0, 7).replace(/-/g, '');
  const row = await db.prepare(
    'SELECT entry_number FROM journal_entries WHERE user_id = ? AND entry_number LIKE ? ORDER BY entry_number DESC LIMIT 1'
  ).bind(tenantId, `MJ-${ym}-%`).first();
  let seq = 1;
  if (row?.entry_number) {
    const lastSeq = parseInt(row.entry_number.split('-').pop() || '', 10);
    if (!isNaN(lastSeq)) seq = lastSeq + 1;
  }
  return `MJ-${ym}-${String(seq).padStart(3, '0')}`;
}

export function hasSharedAccount(entryLineCodes: string[], newCodes: string[]): boolean {
  const set = new Set(entryLineCodes);
  return newCodes.some((c) => set.has(c));
}

export async function findSimilarEntryCandidates(
  db: any, tenantId: string, entryDate: string, totalDebit: number,
): Promise<(SimilarEntry & { line_codes: string[] })[]> {
  const rows = await db.prepare(
    `SELECT je.id, je.entry_number, je.description, SUM(jl.debit) AS total_debit,
            GROUP_CONCAT(DISTINCT jl.account_code) AS codes
     FROM journal_entries je
     JOIN journal_lines jl ON jl.entry_id = je.id
     WHERE je.user_id = ? AND je.deleted_at IS NULL AND je.entry_date = ?
     GROUP BY je.id
     HAVING ABS(SUM(jl.debit) - ?) <= 0.01`
  ).bind(tenantId, entryDate, totalDebit).all();
  return (rows.results as any[]).map((r) => ({
    id: r.id, entry_number: r.entry_number, description: r.description,
    total_debit: r.total_debit, line_codes: (r.codes || '').split(',').filter(Boolean),
  }));
}

export function buildFileLinks(fileRow: any, jeRows: any[]): FileLink[] {
  const links: FileLink[] = [];
  if (fileRow?.invoice_id) {
    const isReceipt = (fileRow.invoice_number || '').toUpperCase().startsWith('REC');
    const bits = [
      fileRow.invoice_number,
      fileRow.vendor_name || fileRow.customer_name,
      fileRow.invoice_total ? `HK$${Number(fileRow.invoice_total).toLocaleString()}` : '',
    ].filter(Boolean);
    links.push({
      kind: isReceipt ? 'receipt' : 'invoice', id: fileRow.invoice_id,
      label: `${isReceipt ? 'Receipt' : 'Invoice'} ${bits.join(' — ')}`,
    });
  }
  if (fileRow?.statement_id) {
    const provenance = fileRow.stmt_source === 'manual' ? ' (manually entered)' : ' (from AI-OCR)';
    links.push({
      kind: 'bank_statement', id: fileRow.statement_id,
      label: `Bank statement${fileRow.stmt_bank_name ? ` — ${fileRow.stmt_bank_name}` : ''}${provenance}`,
      source: fileRow.stmt_source || 'ocr',
    });
  }
  if (fileRow?.card_statement_id) {
    const provenance = fileRow.card_source === 'manual' ? ' (manually entered)' : ' (from AI-OCR)';
    links.push({
      kind: 'card_statement', id: fileRow.card_statement_id,
      label: `Card statement${fileRow.card_issuer ? ` — ${fileRow.card_issuer}` : ''}${provenance}`,
      source: fileRow.card_source || 'ocr',
    });
  }
  for (const je of jeRows || []) {
    links.push({ kind: 'journal_entry', id: je.id, label: `Journal entry ${je.entry_number} (${je.entry_date})` });
  }
  return links;
}
