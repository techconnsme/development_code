// LIVE round-trip test for expanded GJE modal feature (Task 11).
// Login → create journal entry → verify auto-numbering → verify entry in list → cleanup.
// Run: npx tsx tests/manual-booking-live.ts
// PARTIAL=1 → read-only run: stops after login + next-number probe (no mutations).
const WORKER_API_BASE = process.env.WORKER_API_BASE || 'https://opcc-crm-api.ruhan-farhan.workers.dev/api';
const EMAIL = 'joseph.lin@pnr.hk';
const PASSWORD = 'Test1234';

let token = '';
let createdEntryId = '';
let failedSteps = 0;

async function call(path: string, method: string, body?: unknown) {
  const res = await fetch(`${WORKER_API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, json };
}

function pass(step: string, detail: string) { console.log(`PASS ${step} — ${detail}`); }
function fail(step: string, detail: string) { failedSteps++; console.log(`FAIL ${step} — ${detail}`); }
function finish(label = 'DONE') {
  if (failedSteps > 0) {
    console.log(`DONE_WITH_FAILURES (${failedSteps} FAIL)`);
    process.exitCode = 1;
  } else {
    console.log(label);
  }
}

async function main() {
  // ── Step 1: login ──
  let r = await call('/auth/login', 'POST', { email: EMAIL, password: PASSWORD });
  if (r.status === 200 && (r.json as any)?.token) {
    token = (r.json as any).token;
    pass('login', `status=200 user=${(r.json as any).user?.id}`);
  } else {
    return fail('login', `status=${r.status} raw=${JSON.stringify(r.json)}`);
  }

  // ── Step 2: get next voucher number ──
  const today = new Date().toISOString().split('T')[0];
  r = await call(`/bookkeeping/entries/next-number?date=${today}`, 'GET');
  if (r.status === 200 && (r.json as any)?.entry_number) {
    const nextNumber = (r.json as any).entry_number;
    pass('next-number', `status=200 entry_number=${nextNumber}`);
    
    // Verify format MJ-YYYYMM-###
    if (/^MJ-\d{6}-\d{3}$/.test(nextNumber)) {
      pass('next-number-format', `entry_number=${nextNumber} matches MJ-YYYYMM-###`);
    } else {
      fail('next-number-format', `entry_number=${nextNumber} does not match MJ-YYYYMM-###`);
    }
  } else {
    return fail('next-number', `status=${r.status} raw=${JSON.stringify(r.json)}`);
  }

  // PARTIAL run stops here — everything above is read-only.
  if (process.env.PARTIAL === '1') {
    finish('PARTIAL RUN COMPLETE (no create/delete performed)');
    return;
  }

  // ── Step 3: ensure accounts exist ──
  const accountsToEnsure = ['63101', '21101'];
  for (const code of accountsToEnsure) {
    r = await call('/bookkeeping/accounts/ensure', 'POST', { code });
    if (r.status === 200 || r.status === 201) {
      const created = (r.json as any)?.created || [];
      const skipped = (r.json as any)?.skipped || [];
      if (created.length > 0) {
        pass(`ensure-account-${code}`, `created=${created.join(',')}`);
      } else if (skipped.length > 0) {
        pass(`ensure-account-${code}`, `skipped=${skipped.join(',')} (already exists)`);
      } else {
        pass(`ensure-account-${code}`, `status=${r.status}`);
      }
    } else {
      fail(`ensure-account-${code}`, `status=${r.status} raw=${JSON.stringify(r.json)}`);
    }
  }

  // ── Step 5: create journal entry ──
  const testEntry = {
    entry_date: today,
    description: 'Test entry for expanded GJE modal feature',
    lines: [
      {
        account_code: '63101',
        account_name: 'Audit Fee',
        description: 'Audit fee expense',
        debit: 1000,
        credit: 0,
      },
      {
        account_code: '21101',
        account_name: 'Accounts Payable',
        description: 'Audit fee payable',
        debit: 0,
        credit: 1000,
      },
    ],
  };

  r = await call('/bookkeeping/entries', 'POST', testEntry);
  if (r.status === 201 && (r.json as any)?.id) {
    createdEntryId = (r.json as any).id;
    const entryNumber = (r.json as any).entry_number;
    pass('create-entry', `status=201 id=${createdEntryId} entry_number=${entryNumber}`);
    
    // Verify auto-numbering
    if (/^MJ-\d{6}-\d{3}$/.test(entryNumber)) {
      pass('auto-numbering', `entry_number=${entryNumber} matches MJ-YYYYMM-###`);
    } else {
      fail('auto-numbering', `entry_number=${entryNumber} does not match MJ-YYYYMM-###`);
    }
    
    // Verify lines
    const lines = (r.json as any).lines || [];
    if (lines.length === 2) {
      pass('entry-lines', `lines_count=${lines.length}`);
    } else {
      fail('entry-lines', `expected 2 lines got ${lines.length}`);
    }
    
    // Verify balanced entry
    const totalDebit = lines.reduce((sum: number, l: any) => sum + (l.debit || 0), 0);
    const totalCredit = lines.reduce((sum: number, l: any) => sum + (l.credit || 0), 0);
    if (Math.abs(totalDebit - totalCredit) < 0.001) {
      pass('balanced-entry', `total_debit=${totalDebit} total_credit=${totalCredit}`);
    } else {
      fail('balanced-entry', `total_debit=${totalDebit} total_credit=${totalCredit}`);
    }
  } else {
    return fail('create-entry', `status=${r.status} raw=${JSON.stringify(r.json)}`);
  }

  // ── Step 6: verify entry in list ──
  r = await call('/bookkeeping/entries/manual', 'GET');
  if (r.status === 200) {
    const entries = (r.json as any)?.data || [];
    const found = entries.find((e: any) => e.id === createdEntryId);
    if (found) {
      pass('entry-in-list', `found entry ${found.entry_number} in manual entries list`);
      
      // Verify created_by field
      if (found.created_by && found.created_by.id) {
        pass('created-by', `created_by.id=${found.created_by.id}`);
      } else {
        fail('created-by', `created_by not set or invalid: ${JSON.stringify(found.created_by)}`);
      }
      
      // Verify files array exists
      if (Array.isArray(found.files)) {
        pass('files-array', `files_count=${found.files.length}`);
      } else {
        fail('files-array', `files not an array: ${typeof found.files}`);
      }
      
      // Verify reversed field exists
      if (typeof found.reversed === 'boolean') {
        pass('reversed-field', `reversed=${found.reversed}`);
      } else {
        fail('reversed-field', `reversed not a boolean: ${typeof found.reversed}`);
      }
    } else {
      fail('entry-in-list', `entry ${createdEntryId} not found in manual entries list`);
    }
  } else {
    fail('entry-in-list', `status=${r.status} raw=${JSON.stringify(r.json)}`);
  }

  // ── Step 7: get entry by ID ──
  r = await call(`/bookkeeping/entries/${createdEntryId}`, 'GET');
  if (r.status === 200 && (r.json as any)?.id === createdEntryId) {
    pass('get-entry', `status=200 id=${(r.json as any).id}`);
  } else {
    fail('get-entry', `status=${r.status} raw=${JSON.stringify(r.json)}`);
  }

  // ── Step 8: get audit trail ──
  r = await call(`/bookkeeping/entries/${createdEntryId}/audit-trail`, 'GET');
  if (r.status === 200 && Array.isArray(r.json)) {
    const audit = r.json as any[];
    pass('audit-trail', `status=200 entries=${audit.length}`);
    
    // Verify create action logged
    const createLog = audit.find((a: any) => a.action === 'create');
    if (createLog) {
      pass('audit-create-log', `action=${createLog.action} entity_type=${createLog.entity_type}`);
    } else {
      fail('audit-create-log', `create action not found in audit trail`);
    }
  } else {
    fail('audit-trail', `status=${r.status} raw=${JSON.stringify(r.json)}`);
  }

  // ── Step 9: cleanup — delete the test entry ──
  try {
    r = await call(`/bookkeeping/entries/${createdEntryId}`, 'DELETE');
    if (r.status === 200 && (r.json as any)?.success) {
      pass('delete-entry', `status=200 success=true`);
    } else {
      fail('delete-entry', `status=${r.status} raw=${JSON.stringify(r.json)}`);
    }
  } catch (e: any) {
    fail('delete-entry-cleanup', `BEST-EFFORT DELETE THREW: ${e?.stack || String(e)} — entry ${createdEntryId} may need manual cleanup`);
  }

  // ── Step 10: verify entry is deleted (soft delete) ──
  r = await call(`/bookkeeping/entries/${createdEntryId}`, 'GET');
  if (r.status === 404) {
    pass('entry-deleted', `status=404 (entry soft-deleted)`);
  } else if (r.status === 200 && (r.json as any)?.deleted_at) {
    pass('entry-deleted', `status=200 but deleted_at=${(r.json as any).deleted_at}`);
  } else {
    fail('entry-deleted', `expected 404 or deleted_at, got status=${r.status} raw=${JSON.stringify(r.json)}`);
  }

  // ── Step 11: verify entry not in manual entries list ──
  r = await call('/bookkeeping/entries/manual', 'GET');
  if (r.status === 200) {
    const entries = (r.json as any)?.data || [];
    const found = entries.find((e: any) => e.id === createdEntryId);
    if (!found) {
      pass('entry-not-in-list', `entry ${createdEntryId} not found in manual entries list (deleted)`);
    } else {
      fail('entry-not-in-list', `entry ${createdEntryId} still in manual entries list`);
    }
  } else {
    fail('entry-not-in-list', `status=${r.status} raw=${JSON.stringify(r.json)}`);
  }

  finish();
}

main().catch(e => { fail('fatal', e?.stack || String(e)); process.exitCode = 1; });