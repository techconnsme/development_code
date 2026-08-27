// Throwaway mock-db tests for manual statement entry + file linking
// Run: npx tsx tests/manual-statements.test.ts

import { buildFileListSql } from '../api/src/lib/list-filters';
import { buildFileLinks } from '../api/src/lib/manual-booking';

let passed = 0;
let failed = 0;
function assert(condition: boolean, msg: string) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── buildFileListSql OR-join tests ──
console.log('\nbuildFileListSql — OR-join for manual links');
{
  const { sql } = buildFileListSql({ tenantId: 't1' });
  assert(sql.includes('bs.source_file_id = fr.id'), 'bank statement OR-join includes source_file_id');
  assert(sql.includes('cs.source_file_id = fr.id'), 'card statement OR-join includes source_file_id');
  assert(sql.includes('bs.source'), 'SELECT includes stmt_source');
  assert(sql.includes('cs.source'), 'SELECT includes card_source');
  assert(sql.includes('i.source'), 'SELECT includes inv_source');
}

console.log('\nbuildFileListSql — unlinked filter still works');
{
  const { sql, params } = buildFileListSql({ tenantId: 't1', unlinked: true });
  assert(sql.includes('i.id IS NULL AND bs.id IS NULL AND cs.id IS NULL'), 'unlinked clause present');
  assert(params.includes('t1'), 'tenantId in params');
}

// ── buildFileLinks provenance tests ──
console.log('\nbuildFileLinks — provenance labels');
{
  const links = buildFileLinks(
    { statement_id: 'bs-1', stmt_bank_name: 'HSBC', stmt_source: 'manual' }, []
  );
  assert(links.length === 1, 'one link returned');
  assert(links[0].label.includes('manually entered'), 'manual provenance in label');
  assert(links[0].source === 'manual', 'source field is manual');
}
{
  const links = buildFileLinks(
    { statement_id: 'bs-2', stmt_bank_name: 'HSBC', stmt_source: 'ocr' }, []
  );
  assert(links[0].label.includes('from AI-OCR'), 'OCR provenance in label');
  assert(links[0].source === 'ocr', 'source field is ocr');
}
{
  const links = buildFileLinks(
    { card_statement_id: 'cs-1', card_issuer: 'Visa', card_source: 'manual' }, []
  );
  assert(links[0].label.includes('manually entered'), 'card manual provenance');
}
{
  const links = buildFileLinks(
    { card_statement_id: 'cs-2', card_issuer: 'Visa', card_source: 'ocr' }, []
  );
  assert(links[0].label.includes('from AI-OCR'), 'card OCR provenance');
}
{
  const links = buildFileLinks(
    { statement_id: 'bs-3', stmt_bank_name: 'HSBC' }, []
  );
  assert(links[0].label.includes('from AI-OCR'), 'default provenance is OCR');
  assert(links[0].source === 'ocr', 'default source is ocr');
}

// ── Summary ──
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
