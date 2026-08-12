/**
 * Regression API Test — PNR Sample Documents
 *
 * Usage: npx tsx tests/run-regression-api.ts
 *
 * 1. Hard-resets Joseph Lin's test data
 * 2. Uploads sample documents via API
 * 3. Verifies OCR extraction against ground truth
 * 4. Runs auto-match and checks cross-document links
 * 5. Reports pass/fail summary
 */

import * as fs from 'fs';
import * as path from 'path';

const API = 'https://opcc-crm-api.ruhan-farhan.workers.dev/api';
const SAMPLES = path.resolve(__dirname, '../../../test-sample-real/PNR');
const GROUND_TRUTH = JSON.parse(fs.readFileSync(path.join(__dirname, 'regression-ground-truth.json'), 'utf-8'));

// ── Auth ──────────────────────────────────────────────────────────────────
let TOKEN = '';
let USER_ID = '';

async function loginAsAdmin() {
  // Try Joseph Lin first (firm_admin may have permission), fall back to demo supervisor
  for (const cred of [
    { email: 'joseph.lin@pnr.hk', password: 'Test1234' },
    { email: 'muhammadruhan.farhan25@nixorcollege.edu.pk', password: 'password' },
  ]) {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cred),
    });
    const data = await res.json();
    if (res.ok && data.token) return data.token;
  }
  throw new Error('No admin login worked');
}

async function loginAsTestUser() {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'joseph.lin@pnr.hk', password: 'Test1234' }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`User login failed: ${data.error}`);
  TOKEN = data.token;
  USER_ID = data.user?.id || '';
  console.log(`✅ Logged in as ${data.user?.email} (${data.user?.role})`);
}

// ── Helpers ───────────────────────────────────────────────────────────────
async function api(path: string, opts: { method?: string; body?: any } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path}: ${data.error || res.status}`);
  return data;
}

function readBase64(filePath: string): string {
  const buffer = fs.readFileSync(path.resolve(SAMPLES, filePath));
  return buffer.toString('base64');
}

interface TestResult {
  category: string;
  file: string;
  field: string;
  expected: any;
  actual: any;
  passed: boolean;
}

const results: TestResult[] = [];

function record(category: string, file: string, field: string, expected: any, actual: any): boolean {
  let passed: boolean;
  if (typeof expected === 'boolean') {
    passed = expected === !!actual;
  } else if (typeof expected === 'string' && expected.startsWith('contains:')) {
    passed = String(actual || '').toLowerCase().includes(expected.slice(9).toLowerCase());
  } else if (expected === 'non_null') {
    passed = actual != null && actual !== '';
  } else if (expected === 'non_zero') {
    passed = actual != null && Number(actual) !== 0;
  } else if (expected === 'gt_zero') {
    passed = Number(actual) > 0;
  } else {
    passed = String(actual) === String(expected);
  }
  results.push({ category, file, field, expected, actual, passed });
  const icon = passed ? '✅' : '❌';
  const displayExpected = typeof expected === 'string' && expected.length > 60 ? expected.slice(0, 57) + '...' : expected;
  const displayActual = String(actual).length > 60 ? String(actual).slice(0, 57) + '...' : actual;
  console.log(`  ${icon} ${field}: expected=${displayExpected}, actual=${displayActual}`);
  return passed;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  Regression API Test — PNR Sample Docs');
  console.log('═══════════════════════════════════════════\n');

  // 1. Login as admin for reset
  const adminToken = await loginAsAdmin();
  TOKEN = adminToken;

  // 2. Hard-reset test data (as admin)
  console.log('\n── Hard-resetting test data ──');
  const reset = await api('/admin/hard-reset-data', { method: 'POST', body: { user_id: 'u-83161e0c' } });
  console.log(`  Deleted ${reset.total_deleted} records across ${Object.keys(reset.details).length} tables`);

  // 3. Switch to Joseph Lin for all tests
  await loginAsTestUser();

  // 4. Upload and verify bank statements
  console.log('\n── Bank Statements ──');
  for (const bs of GROUND_TRUTH.bank_statements) {
    const filePath = path.resolve(SAMPLES, bs.file);
    if (!fs.existsSync(filePath)) {
      console.log(`  ⚠️ SKIP: ${bs.file} not found`);
      continue;
    }
    console.log(`\n  📄 ${bs.file}`);
    try {
      const base64 = readBase64(bs.file);
      const upload = await api('/file-storage/upload', {
        method: 'POST',
        body: { filename: path.basename(bs.file), file_type: 'application/pdf', file_data: base64, folder: 'bank_statements' },
      });
      const importResult = await api(`/file-storage/${upload.id}/import-document`, { method: 'POST' });
      if (!importResult.statement_id) {
        console.log('  ❌ Import failed — no statement created');
        continue;
      }
      const stmt = await api(`/bank-statements/${importResult.statement_id}`);
      const exp = bs.expected;
      record('bank_stmt', bs.file, 'doc_type_imported', true, !!stmt);
      if (exp.bank_name_contains) record('bank_stmt', bs.file, 'bank_name', `contains:${exp.bank_name_contains}`, stmt.bank_name || '');
      if (exp.bank_name) record('bank_stmt', bs.file, 'bank_name', exp.bank_name, stmt.bank_name);
      if (exp.account_number) record('bank_stmt', bs.file, 'account_number', exp.account_number, stmt.account_number);
      if (exp.period_start) record('bank_stmt', bs.file, 'period_start', exp.period_start, stmt.period_start);
      if (exp.period_end) record('bank_stmt', bs.file, 'period_end', exp.period_end, stmt.period_end);
      if (exp.has_transactions) record('bank_stmt', bs.file, 'transactions', 'gt_zero', stmt.transactions?.length || 0);
      if (exp.has_opening_balance) record('bank_stmt', bs.file, 'opening_balance', 'non_zero', stmt.opening_balance);
      if (exp.has_closing_balance) record('bank_stmt', bs.file, 'closing_balance', 'non_zero', stmt.closing_balance);
    } catch (e: any) {
      console.log(`  ❌ ERROR: ${e.message}`);
      results.push({ category: 'bank_stmt', file: bs.file, field: 'error', expected: 'success', actual: e.message, passed: false });
    }
  }

  // 5. Upload and verify AP invoices
  console.log('\n── AP Invoices (Incoming) ──');
  for (const inv of GROUND_TRUTH.ap_invoices) {
    const filePath = path.resolve(SAMPLES, inv.file);
    if (!fs.existsSync(filePath)) {
      console.log(`  ⚠️ SKIP: ${inv.file} not found`);
      continue;
    }
    console.log(`\n  📄 ${inv.file}`);
    try {
      const base64 = readBase64(inv.file);
      const upload = await api('/file-storage/upload', {
        method: 'POST',
        body: { filename: path.basename(inv.file), file_type: 'application/pdf', file_data: base64, folder: 'invoices' },
      });
      const importResult = await api(`/file-storage/${upload.id}/import-document`, { method: 'POST' });
      const invoiceId = importResult.invoice_id || importResult.id;
      if (!invoiceId) {
        console.log('  ❌ Import failed');
        continue;
      }
      const invoice = await api(`/invoices/${invoiceId}`);
      const exp = inv.expected;
      record('ap_invoice', inv.file, 'doc_type_imported', true, !!invoice);
      if (exp.direction) record('ap_invoice', inv.file, 'direction', exp.direction, invoice.direction);
      if (exp.vendor_name_contains) record('ap_invoice', inv.file, 'vendor_name', `contains:${exp.vendor_name_contains}`, invoice.vendor_name || '');
      record('ap_invoice', inv.file, 'has_invoice_number', exp.has_invoice_number, !!invoice.invoice_number);
      record('ap_invoice', inv.file, 'has_total', exp.has_total, invoice.total > 0);
    } catch (e: any) {
      console.log(`  ❌ ERROR: ${e.message}`);
      results.push({ category: 'ap_invoice', file: inv.file, field: 'error', expected: 'success', actual: e.message, passed: false });
    }
  }

  // 5. Upload and verify AR invoices
  console.log('\n── AR Invoices (Outgoing) ──');
  for (const inv of GROUND_TRUTH.ar_invoices) {
    const filePath = path.resolve(SAMPLES, inv.file);
    if (!fs.existsSync(filePath)) {
      console.log(`  ⚠️ SKIP: ${inv.file} not found`);
      continue;
    }
    console.log(`\n  📄 ${inv.file}`);
    try {
      const base64 = readBase64(inv.file);
      const upload = await api('/file-storage/upload', {
        method: 'POST',
        body: { filename: path.basename(inv.file), file_type: 'application/pdf', file_data: base64, folder: 'invoices' },
      });
      const importResult = await api(`/file-storage/${upload.id}/import-document`, { method: 'POST' });
      const invoiceId = importResult.invoice_id || importResult.id;
      if (!invoiceId) { console.log('  ❌ Import failed'); continue; }
      const invoice = await api(`/invoices/${invoiceId}`);
      const exp = inv.expected;
      record('ar_invoice', inv.file, 'doc_type_imported', true, !!invoice);
      if (exp.direction) record('ar_invoice', inv.file, 'direction', exp.direction, invoice.direction);
      if (exp.customer_name_contains) record('ar_invoice', inv.file, 'customer_name', `contains:${exp.customer_name_contains}`, invoice.customer_name || '');
      if (exp.vendor_name_contains) record('ar_invoice', inv.file, 'vendor_name', `contains:${exp.vendor_name_contains}`, invoice.vendor_name || '');
      record('ar_invoice', inv.file, 'has_invoice_number', exp.has_invoice_number, !!invoice.invoice_number);
      record('ar_invoice', inv.file, 'has_total', exp.has_total, invoice.total > 0);
    } catch (e: any) {
      console.log(`  ❌ ERROR: ${e.message}`);
      results.push({ category: 'ar_invoice', file: inv.file, field: 'error', expected: 'success', actual: e.message, passed: false });
    }
  }

  // 6. Upload and verify receipts
  console.log('\n── Receipts ──');
  for (const rct of GROUND_TRUTH.receipts) {
    const filePath = path.resolve(SAMPLES, rct.file);
    if (!fs.existsSync(filePath)) {
      console.log(`  ⚠️ SKIP: ${rct.file} not found`);
      continue;
    }
    console.log(`\n  📄 ${rct.file}`);
    try {
      const base64 = readBase64(rct.file);
      const upload = await api('/file-storage/upload', {
        method: 'POST',
        body: { filename: path.basename(rct.file), file_type: 'application/pdf', file_data: base64, folder: 'receipts' },
      });
      const importResult = await api(`/file-storage/${upload.id}/import-document`, { method: 'POST' });
      const invoiceId = importResult.invoice_id || importResult.id;
      if (!invoiceId) { console.log('  ❌ Import failed'); continue; }
      const invoice = await api(`/invoices/${invoiceId}`);
      const exp = rct.expected;
      record('receipt', rct.file, 'doc_type_imported', true, !!invoice);
      if (exp.has_receipt_number) record('receipt', rct.file, 'has_receipt_number', true, !!invoice.receipt_number);
      record('receipt', rct.file, 'has_total', exp.has_total, invoice.total > 0);
      if (exp.should_link_to_invoice_containing) {
        record('receipt', rct.file, 'linked_to_invoice', `contains:${exp.should_link_to_invoice_containing}`, invoice.linked_invoice_id || 'not_linked');
      }
    } catch (e: any) {
      console.log(`  ❌ ERROR: ${e.message}`);
      results.push({ category: 'receipt', file: rct.file, field: 'error', expected: 'success', actual: e.message, passed: false });
    }
  }

  // 7. Cross-document link verification
  console.log('\n── Cross-Document Links ──');
  try {
    const autoMatchInv = await api('/bank-statements/auto-match', { method: 'POST' });
    record('link', 'bank→invoice', 'auto_match_ran', true, !!autoMatchInv);
    console.log(`  Bank→Invoice matches found: ${autoMatchInv.matched?.length || 0}`);

    const autoMatchRcpt = await api('/invoices/auto-match-receipts?direction=incoming', { method: 'POST' });
    record('link', 'invoice→receipt', 'auto_match_ran', true, !!autoMatchRcpt);
    console.log(`  Invoice→Receipt matches found: ${autoMatchRcpt.matched?.length || 0}`);

    const continuity = await api('/bank-statements/continuity');
    record('link', 'continuity', 'has_groups', true, (continuity.groups?.length || 0) > 0);
    console.log(`  Continuity groups: ${continuity.groups?.length || 0}`);
  } catch (e: any) {
    console.log(`  ❌ Link check error: ${e.message}`);
  }

  // 8. Summary
  console.log('\n═══════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('═══════════════════════════════════════════');
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`  Total: ${results.length} | ✅ ${passed} passed | ❌ ${failed} failed\n`);

  if (failed > 0) {
    console.log('  FAILED TESTS:');
    for (const r of results.filter(r => !r.passed)) {
      console.log(`    ❌ [${r.category}] ${r.file} — ${r.field}`);
      console.log(`       Expected: ${r.expected}  |  Actual: ${r.actual}`);
    }
  }

  console.log('\n✅ Regression API test complete.');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('FATAL:', e.message || e);
  process.exit(1);
});
