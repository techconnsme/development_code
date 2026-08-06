/**
 * Edge Case Test: Invoice direction with tricky filenames and mixed content
 * Tests content-based detection independent of filename hints.
 */
const API = 'https://opcc-crm-api.ruhan-farhan.workers.dev/api';
const fs = require('fs');
const path = require('path');

const EDGE_DIR = 'C:/Users/samue/Documents/Pastel/Tech_Connect_SME/test-samples-generated-demo-company/edge';

// Map each edge case file to expected direction
// BILL_IN = supplier bills company → incoming (AP)
// INV_OUT = company bills customer → outgoing (AR)
const TEST_CASES: { file: string; expectedDir: string; description: string }[] = [
  { file: 'scan_20260806_001.pdf', expectedDir: 'incoming', description: 'Random filename (FedEx bill → incoming)' },
  { file: 'IMG_8842.pdf', expectedDir: 'outgoing', description: 'Random filename (TechGear → outgoing)' },
  { file: 'tax_document', expectedDir: 'incoming', description: 'No extension (PwC bill → incoming)' },
  { file: 'receipt_copy', expectedDir: 'outgoing', description: 'No extension (StarNet → outgoing)' },
  { file: '供應商發票.pdf', expectedDir: 'incoming', description: 'Chinese filename (Pacific Office → incoming)' },
  { file: '客戶帳單.pdf', expectedDir: 'outgoing', description: 'Chinese filename (Bright Future → outgoing)' },
  { file: 'bank_statement_march.pdf', expectedDir: 'incoming', description: 'Misleading name (HKT bill → incoming)' },
  { file: 'credit_card_bill.pdf', expectedDir: 'outgoing', description: 'Misleading name (MediaPro → outgoing)' },
  { file: 'INVOICE_from_AIA_Hong_Kong_Insurance_Company_Limited_Ref_No_2026_0808_Final_Version_Approved.pdf', expectedDir: 'incoming', description: 'Long filename (AIA bill → incoming)' },
  { file: '2026_08_06_service_invoice_global_tech_project_alpha_milestone_3.pdf', expectedDir: 'outgoing', description: 'Descriptive filename (Global Tech → outgoing)' },
  { file: 'duplicate_fedex.pdf', expectedDir: 'incoming', description: 'Duplicate content (FedEx again → incoming, should flag duplicate)' },
];

async function main() {
  // Login
  const login = await fetch(API + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'muhammadruhan.farhan25@gmail.com', password: 'Ruhan123' })
  }).then(r => r.json());
  const token = login.token;
  console.log('Logged in');

  // Verify company name
  const cs = await fetch(API + '/company', { headers: { 'Authorization': 'Bearer ' + token } }).then(r => r.json());
  console.log('Company name:', cs.name, '\n');

  let passed = 0, failed = 0;
  const results: string[] = [];

  for (let i = 0; i < TEST_CASES.length; i++) {
    const tc = TEST_CASES[i];
    const filePath = path.join(EDGE_DIR, tc.file);
    if (!fs.existsSync(filePath)) {
      console.log(`[${i + 1}/${TEST_CASES.length}] ⚠️ ${tc.file} — file not found, skipping`);
      continue;
    }

    console.log(`[${i + 1}/${TEST_CASES.length}] ${tc.description}`);
    console.log(`  File: ${tc.file}`);

    try {
      const buf = fs.readFileSync(filePath);
      const b64 = buf.toString('base64');
      const mime = tc.file.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream';

      // Upload
      const up = await fetch(API + '/file-storage/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ filename: tc.file, original_name: tc.file, file_type: mime, file_size: buf.length, file_data: b64 })
      }).then(r => r.json());
      console.log(`  Uploaded: folder=${up.folder}, category=${up.category}`);

      // Import
      const imp = await fetch(API + '/file-storage/' + up.id + '/import-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }
      }).then(r => r.json());

      if (imp.invoice_id) {
        const inv = await fetch(API + '/invoices/' + imp.invoice_id, {
          headers: { 'Authorization': 'Bearer ' + token }
        }).then(r => r.json());

        const dirOk = inv.direction === tc.expectedDir;
        const icon = dirOk ? '✅' : '❌';
        const dirStr = `${inv.direction} (expected ${tc.expectedDir})`;
        const flags = [];
        if (imp.needs_direction_review) flags.push('review');
        if (imp.company_not_detected) flags.push('no-company');
        if (imp.is_duplicate) flags.push('duplicate');
        const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';

        console.log(`  ${icon} direction=${dirStr} vendor=${(inv.vendor_name || 'N/A').slice(0, 40)} status=${inv.status}${flagStr}`);

        if (dirOk) passed++; else failed++;
        results.push(`${icon} ${tc.file.padEnd(50)} ${dirStr.padEnd(30)} ${inv.vendor_name || 'N/A'}`);
      } else {
        console.log(`  ❌ No invoice created — type was ${imp.type}`);
        failed++;
        results.push(`❌ ${tc.file} — no invoice`);
      }
    } catch (e: any) {
      console.log(`  ❌ Error: ${e.message}`);
      failed++;
      results.push(`❌ ${tc.file} — ${e.message}`);
    }
    console.log();
  }

  // Summary
  console.log('═'.repeat(80));
  console.log('EDGE CASE RESULTS');
  console.log('═'.repeat(80));
  for (const r of results) console.log('  ' + r);
  console.log(`\nPassed: ${passed} | Failed: ${failed} | Total: ${passed + failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e.message || e); process.exit(1); });
