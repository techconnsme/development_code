// Shared query builders for list endpoints — kept in lib so tests/list-filters.test.ts
// can exercise the SQL construction without a live D1.

export interface FileListOptions {
  tenantId: string;
  folder?: string;
  q?: string;
  limit?: number;
  /** Expenses → Others tab: only files with no invoice / statement / journal links */
  unlinked?: boolean;
}

export function buildFileListSql(opts: FileListOptions): { sql: string; params: unknown[] } {
  let sql = `SELECT fr.id, fr.folder, fr.filename, fr.original_name, fr.file_type, fr.file_size,
    fr.description, fr.ocr_status, fr.category, fr.direction, fr.payment_status, fr.amount,
    fr.created_at, fr.updated_at,
    i.id as invoice_id, i.invoice_number, i.status as invoice_status, i.needs_review as invoice_needs_review,
    i.vendor_name, i.direction as invoice_direction,
    c.name as customer_name,
    bs.id as statement_id, bs.bank_name as stmt_bank_name, bs.status as stmt_status,
    cs.id as card_statement_id, cs.card_issuer, cs.status as card_status
    FROM file_records fr
    LEFT JOIN invoices i ON i.file_id = fr.id AND i.user_id = fr.user_id AND i.deleted_at IS NULL
    LEFT JOIN customers c ON i.customer_id = c.id
    LEFT JOIN bank_statements bs ON bs.r2_key = fr.r2_key AND bs.user_id = fr.user_id AND bs.deleted_at IS NULL
    LEFT JOIN card_statements cs ON cs.r2_key = fr.r2_key AND cs.user_id = fr.user_id AND cs.deleted_at IS NULL
    WHERE fr.user_id = ? AND fr.deleted_at IS NULL`;
  const params: unknown[] = [opts.tenantId];
  if (opts.unlinked) {
    sql += ` AND i.id IS NULL AND bs.id IS NULL AND cs.id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM journal_entry_files jef
        JOIN journal_entries je2 ON je2.id = jef.entry_id AND je2.deleted_at IS NULL
        WHERE jef.file_record_id = fr.id
      )`;
  }
  if (opts.folder) { sql += ' AND fr.folder = ?'; params.push(opts.folder); }
  if (opts.q) { sql += ' AND (fr.filename LIKE ? OR fr.description LIKE ? OR fr.ocr_text LIKE ?)'; params.push(`%${opts.q}%`, `%${opts.q}%`, `%${opts.q}%`); }
  sql += ' ORDER BY fr.created_at DESC';
  if (opts.limit && opts.limit > 0) { sql += ' LIMIT ?'; params.push(opts.limit); }
  return { sql, params };
}

/** Optional reference_type filter for GET /bookkeeping/entries — absent param keeps the route's existing behavior. */
export function referenceTypeClause(refType?: string): { sql: string; params: string[] } {
  if (!refType) return { sql: '', params: [] };
  return { sql: ' AND je.reference_type = ?', params: [refType] };
}
