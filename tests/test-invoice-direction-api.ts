/**
 * Automated API test: Invoice direction detection for BILL_IN sample files
 *
 * Uploads BILL_IN_* PDFs from test-samples-generated-demo-company,
 * runs import-document, and verifies direction = 'incoming'.
 *
 * Usage: npx tsx tests/test-invoice-direction-api.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const API_BASE = 'https://opcc-crm-api.ruhan-farhan.workers.dev/api';
const SAMPLE_DIR = path.resolve(__dirname, '..', '..', '..', 'test-samples-generated-demo-company');

interface TestResult {
  file: string;
  uploaded: boolean;
  fileId?: string;
  folder?: string;
  category?: string;
  docType?: string;
  invoiceId?: string;
  invoiceNumber?: string;
  direction?: string;
  vendorName?: string;
  needsDirectionReview?: boolean;
  companyNotDetected?: boolean;
  error?: string;
  passed: boolean;
}

const RESULTS: TestResult[] = [];

async function api(
  p: string,
  options: { method?: string; body?: any; token?: string; baseUrl?: string } = {}
): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`;

  const url = `${options.baseUrl || API_BASE}${p}`;
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  BILL_IN Invoice Direction — Automated Test');
  console.log('═══════════════════════════════════════════════\n');

  // 1. Login
  console.log('1. Logging in...');
  let token: string;
  let loginEmail: string;

  const credentials = [
    { email: 'muhammadruhan.farhan25@gmail.com', password: 'Ruhan123' },
    { email: 'admin@techconnect.com', password: 'Test1234' },
  ];

  for (const cred of credentials) {
    try {
      const login = await api('/auth/login', {
        method: 'POST',
        body: { email: cred.email, password: cred.password },
      });
      token = login.token;
      loginEmail = cred.email;
      console.log(`   ✅ Logged in as ${cred.email}\n`);
      break;
    } catch (e: any) {
      console.log(`   ⚠️  ${cred.email} failed: ${e.message}`);
    }
  }

  if (!token!) {
    console.error('❌ Could not log in with any known credentials.');
    process.exit(1);
  }

  // 2. Find BILL_IN PDFs (exclude receipts)
  console.log('2. Scanning for BILL_IN sample PDFs...');
  const allFiles = fs.readdirSync(SAMPLE_DIR)
    .filter(f => f.startsWith('BILL_IN_') && f.endsWith('.pdf') && !f.includes('RECEIPT'))
    .sort();
  console.log(`   Found ${allFiles.length} BILL_IN files:`);
  allFiles.forEach(f => console.log(`     - ${f}`));
  console.log();

  // Also include the receipt file as a separate test
  const receiptFiles = fs.readdirSync(SAMPLE_DIR)
    .filter(f => f.startsWith('BILL_IN_RECEIPT') && f.endsWith('.pdf'))
    .sort();

  const filesToTest = allFiles; // Just the invoice/bill/PO ones

  // 3. Process each file
  let idx = 0;
  for (const file of filesToTest) {
    idx++;
    const filePath = path.join(SAMPLE_DIR, file);
    console.log(`── [${idx}/${filesToTest.length}] ${file} ──`);

    try {
      // Read & encode
      const buffer = fs.readFileSync(filePath);
      const base64 = buffer.toString('base64');
      const fileSize = buffer.length;

      // Upload
      console.log(`   📤 Uploading (${(fileSize / 1024).toFixed(0)} KB)...`);
      const upload = await api('/file-storage/upload', {
        method: 'POST',
        token: token!,
        body: {
          filename: file,
          original_name: file,
          file_type: 'application/pdf',
          file_size: fileSize,
          file_data: base64,
        },
      });
      const fileId = upload.id;
      console.log(`   ✅ Uploaded: id=${fileId}, folder=${upload.folder}, category=${upload.category}`);

      // Import via import-document
      console.log(`   🔍 Running import-document...`);
      let importResult: any;
      try {
        importResult = await api(`/file-storage/${fileId}/import-document`, {
          method: 'POST',
          token: token!,
        });
      } catch (e: any) {
        if (e.message?.includes('already')) {
          console.log(`   ⚠️  Duplicate: ${e.message}`);
          RESULTS.push({
            file, uploaded: true, fileId, folder: upload.folder, category: upload.category,
            passed: true, error: `Duplicate: ${e.message}`,
          });
          continue;
        }
        throw e;
      }

      const docType = importResult.type;
      console.log(`   📋 Type: ${docType}, invoiceId: ${importResult.invoice_id || 'N/A'}`);
      console.log(`   📋 needs_direction_review: ${importResult.needs_direction_review || false}`);
      console.log(`   📋 company_not_detected: ${importResult.company_not_detected || false}`);
      console.log(`   📋 ocr_text preview: ${(importResult.ocr_text || '').slice(0, 150)}`);

      if (importResult.invoice_id) {
        // Fetch the created invoice
        const invoice = await api(`/invoices/${importResult.invoice_id}`, { token: token! });
        console.log(`   📄 Invoice: #${invoice.invoice_number}  direction=${invoice.direction}  vendor=${invoice.vendor_name || invoice.supplier_name || 'N/A'}  total=${invoice.currency} ${invoice.total}`);

        const passed = invoice.direction === 'incoming';
        const icon = passed ? '✅ PASS' : '❌ FAIL (expected incoming, got ' + invoice.direction + ')';
        console.log(`   ${icon}`);

        RESULTS.push({
          file, uploaded: true, fileId, folder: upload.folder, category: upload.category,
          docType,
          invoiceId: importResult.invoice_id,
          invoiceNumber: invoice.invoice_number,
          direction: invoice.direction,
          vendorName: invoice.vendor_name || invoice.supplier_name || undefined,
          needsDirectionReview: importResult.needs_direction_review,
          companyNotDetected: importResult.company_not_detected,
          passed,
        });
      } else {
        console.log('   ⚠️  No invoice created (unexpected)');
        RESULTS.push({
          file, uploaded: true, fileId, folder: upload.folder, category: upload.category,
          docType, passed: false, error: 'No invoice_id in import result',
        });
      }
    } catch (e: any) {
      console.log(`   ❌ Error: ${e.message}`);
      RESULTS.push({ file, uploaded: false, passed: false, error: e.message });
    }

    console.log();
  }

  // 4. Summary
  console.log('═══════════════════════════════════════════════');
  console.log('  Results Summary');
  console.log('═══════════════════════════════════════════════\n');

  const passed = RESULTS.filter(r => r.passed);
  const failed = RESULTS.filter(r => !r.passed);

  for (const r of RESULTS) {
    const icon = r.passed ? '✅' : '❌';
    const dir = r.direction || 'N/A';
    const vendor = r.vendorName || '-';
    const warn = r.needsDirectionReview ? ' ⚠️REVIEW' : '';
    const noComp = r.companyNotDetected ? ' ⚠️NO-COMPANY' : '';
    console.log(`  ${icon} ${r.file.padEnd(55)} dir=${dir.padEnd(9)} vendor=${vendor.slice(0, 30)}${warn}${noComp}`);
  }

  console.log(`\n  Total: ${RESULTS.length} | Passed: ${passed.length} | Failed: ${failed.length}`);

  if (failed.length > 0) {
    console.log('\n  Failed:');
    for (const r of failed) {
      console.log(`    ❌ ${r.file}: ${r.error || `direction=${r.direction}`}`);
    }
  }

  // 5. Server-side direction filter check
  console.log('\n── Server-side direction filter check ──');
  try {
    const incoming = await api('/invoices?direction=incoming&limit=5', { token: token! });
    const outgoing = await api('/invoices?direction=outgoing&limit=5', { token: token! });
    console.log(`   incoming count: ${incoming.total} | outgoing count: ${outgoing.total}`);
  } catch (e: any) {
    console.log(`   ❌ Filter test failed: ${e.message}`);
  }

  console.log('\nDone.');
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
