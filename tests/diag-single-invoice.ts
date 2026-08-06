// Quick diagnostic: check OCR text and DeepSeek output for a single BILL_IN file
const API = 'https://opcc-crm-api.ruhan-farhan.workers.dev/api';
const fs = require('fs');
const path = require('path');

async function main() {
  // Login
  const login = await fetch(API + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'muhammadruhan.farhan25@gmail.com', password: 'Ruhan123' })
  }).then(r => r.json());
  const token = login.token;
  console.log('Logged in');

  const f = 'BILL_IN_BILL-TAX-2026-0720_PwC_Hong_Kong.pdf';
  const dir = 'C:/Users/samue/Documents/Pastel/Tech_Connect_SME/test-samples-generated-demo-company';
  const buf = fs.readFileSync(path.join(dir, f));
  const b64 = buf.toString('base64');

  // Upload
  const up = await fetch(API + '/file-storage/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ filename: f, original_name: f, file_type: 'application/pdf', file_size: buf.length, file_data: b64 })
  }).then(r => r.json());
  console.log('Uploaded:', up.folder, up.category, 'id:', up.id);

  // Import
  const imp = await fetch(API + '/file-storage/' + up.id + '/import-document', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }
  }).then(r => r.json());

  console.log('--- IMPORT RESULT ---');
  console.log('type:', imp.type);
  console.log('needs_direction_review:', imp.needs_direction_review);
  console.log('company_not_detected:', imp.company_not_detected);
  console.log('total_mismatch:', imp.total_mismatch);
  console.log('is_duplicate:', imp.is_duplicate);
  console.log('direction:', imp.direction);
  console.log('OCR text length:', (imp.ocr_text || '').length);
  console.log('OCR first 500 chars:');
  console.log((imp.ocr_text || '').slice(0, 500));

  if (imp.invoice_id) {
    const inv = await fetch(API + '/invoices/' + imp.invoice_id, {
      headers: { 'Authorization': 'Bearer ' + token }
    }).then(r => r.json());
    console.log('--- INVOICE ---');
    console.log('status:', inv.status);
    console.log('direction:', inv.direction);
    console.log('vendor_name:', inv.vendor_name);
    console.log('total:', inv.total);
    console.log('items:', (inv.items || []).length);
  }
}

main().catch(e => console.error('FATAL:', e.message || e));
