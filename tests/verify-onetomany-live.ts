// LIVE 1:N verification against PRODUCTION worker (Task 8, deterministic API path).
// Login → auto-match → confirm the 55,000 group → verify paid + GL → unlink → verify reverted.
// Leaves tenant state as found: the mutating segment wraps confirm→verify in
// try/finally so unlink is attempted even if a verification step throws.
// Run: npx tsx tests/verify-onetomany-live.ts
// PARTIAL=1 → read-only run: stops after login + auto-match + invoice_ids:[] probe (no mutations).
const WORKER_API_BASE = process.env.WORKER_API_BASE || 'https://opcc-crm-api.ruhan-farhan.workers.dev/api';
const EMAIL = 'joseph.lin@pnr.hk';
const PASSWORD = 'Test1234';
const TARGET_AMOUNT = 55000;

let token = '';
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

  // ── Step 2: auto-match → find the 55,000 group row ──
  r = await call('/bank-statements/auto-match', 'POST');
  if (!r.ok || r.status !== 200) {
    return fail('auto-match', `status=${r.status} raw=${JSON.stringify(r.json).slice(0, 500)}`);
  }
  const matched = ((r.json as any).matched || []) as any[];
  console.log(`[raw] auto-match returned ${matched.length} suggestion(s); unmatched_count=${(r.json as any).unmatched_count}`);
  console.log('[raw] full suggestions JSON:');
  console.log(JSON.stringify(matched, null, 2));

  const group = matched.find(m => Array.isArray(m.invoice_ids) && m.amount === TARGET_AMOUNT);
  if (group && group.invoice_ids.length >= 2) {
    pass('auto-match-group', `amount=${group.amount} invoice_ids=[${group.invoice_ids.join(', ')}] (${group.invoice_ids.length} invoices) reason="${group.reason}"`);
  } else {
    return fail('auto-match-group', `no group row for amount=${TARGET_AMOUNT}; matched=${JSON.stringify(matched.filter((m: any) => m.amount === TARGET_AMOUNT))}`);
  }
  const txId: string = group.transaction_id;
  const invoiceIds: string[] = group.invoice_ids;

  // ── Step 3: reviewer target case — empty invoice_ids must be 400, not 500 ──
  r = await call(`/bank-statements/transactions/${txId}/match`, 'PATCH', { action: 'confirm', invoice_ids: [] });
  if (r.status === 400) pass('edge-empty-invoice-ids-400', `status=400 error=${JSON.stringify((r.json as any).error)}`);
  else fail('edge-empty-invoice-ids-400', `expected 400 got status=${r.status} raw=${JSON.stringify(r.json).slice(0, 300)}`);

  // PARTIAL run stops here — everything above is read-only or a rejected (400) probe.
  if (process.env.PARTIAL === '1') {
    finish('PARTIAL RUN COMPLETE (no confirm/unlink performed)');
    return;
  }

  // ── Steps 4–6: MUTATING segment — unlink runs in finally even if checks throw ──
  let groupConfirmed = false;
  let glEntryId = '';
  try {
    // Step 4: confirm the group
    r = await call(`/bank-statements/transactions/${txId}/match`, 'PATCH', { action: 'confirm', invoice_ids: invoiceIds });
    groupConfirmed = r.status === 200 && !!(r.json as any)?.success;
    if (groupConfirmed && !!(r.json as any)?.gl_entry_id) {
      glEntryId = (r.json as any).gl_entry_id;
      pass('confirm-group', `status=200 gl_entry_id=${glEntryId} invoice_status=${(r.json as any).invoice_status} paid_date=${(r.json as any).paid_date}`);
    } else {
      fail('confirm-group', `status=${r.status} raw=${JSON.stringify(r.json).slice(0, 500)}`);
    }

    if (!glEntryId) {
      // No cleanup needed for invoices/JE here; finally below still unlinks.
      fail('invoices-paid', 'skipped — confirm did not return gl_entry_id');
      fail('payment-je-shape', 'skipped — confirm did not return gl_entry_id');
    }
    if (glEntryId) {
      // Step 5: verify both invoices show paid
      let allPaid = true; const details: string[] = [];
      for (const invId of invoiceIds) {
        const ir = await call(`/invoices/${invId}`, 'GET');
        const inv = (ir.json as any)?.invoice || (ir.json as any);
        details.push(`${inv?.invoice_number ?? invId}: status=${inv?.status} payment_status=${inv?.payment_status ?? '-'}`);
        if (ir.status !== 200 || inv?.status !== 'paid') allPaid = false;
      }
      if (allPaid) pass('invoices-paid', details.join(' | '));
      else fail('invoices-paid', details.join(' | '));

      // Step 5b: payment JE shape — JE-PMT-MULTI-* with N+1 lines
      const jer = await call(`/bookkeeping/entries/${glEntryId}`, 'GET');
      const je = jer.json as any;
      const lines = (je?.lines || []) as any[];
      const jeOk = jer.status === 200
        && typeof je?.entry_number === 'string' && je.entry_number.startsWith('JE-PMT-MULTI-')
        && lines.length === invoiceIds.length + 1;
      if (jeOk) {
        pass('payment-je-shape', `entry_number=${je.entry_number} lines=${lines.length} (${lines.map((l: any) => `${l.account_code} D${l.debit}/C${l.credit}`).join(', ')})`);
      } else {
        fail('payment-je-shape', `status=${jer.status} entry=${JSON.stringify(je).slice(0, 400)}`);
      }
    }
  } catch (e: any) {
    fail('post-confirm-verify', e?.stack || String(e));
  } finally {
    if (groupConfirmed) {
      try {
        const ur = await call(`/bank-statements/transactions/${txId}/match`, 'PATCH', { action: 'unlink' });
        if (ur.ok && ur.status === 200) pass('unlink', `status=200 raw=${JSON.stringify(ur.json).slice(0, 300)}`);
        else fail('unlink', `cleanup unlink status=${ur.status} raw=${JSON.stringify(ur.json).slice(0, 300)} — tx ${txId} may need manual unlink`);
      } catch (e: any) {
        fail('unlink-cleanup', `BEST-EFFORT UNLINK THREW: ${e?.stack || String(e)} — tx ${txId} may need manual unlink`);
      }
    }
  }

  // ── Reversion gate: ALL of invoices unpaid AND tx unmatched AND tx.invoice_id cleared ──
  let allUnpaid = true; const afterDetails: string[] = [];
  for (const invId of invoiceIds) {
    const ir = await call(`/invoices/${invId}`, 'GET').catch(() => ({ status: 0, ok: false, json: {} as any }));
    const inv = (ir.json as any)?.invoice || (ir.json as any);
    afterDetails.push(`${inv?.invoice_number ?? invId}: status=${inv?.status} payment_status=${inv?.payment_status ?? '-'}`);
    if (ir.status !== 200 || inv?.status === 'paid' || !inv) allUnpaid = false;
  }
  const tr = await call('/bank-statements/transactions?limit=500', 'GET').catch(() => ({ status: 0, ok: false, json: {} as any }));
  let txOk = false;
  let txStatus = '(tx list fetch failed)';
  if (tr.ok) {
    const raw = (tr.json as any)?.data || (tr.json as any)?.transactions || (tr.json as any)?.results;
    const rows = Array.isArray(raw) ? raw : [];
    const row = rows.find(t => t.id === txId);
    if (row) {
      txStatus = `match_status=${row.match_status} invoice_id=${row.invoice_id ?? 'null'}`;
      txOk = row.match_status === 'unmatched' && row.invoice_id == null;
    } else {
      txStatus = 'tx not in list';
    }
  }
  if (allUnpaid && txOk) pass('reverted-unpaid', `${afterDetails.join(' | ')} | tx: ${txStatus}`);
  else fail('reverted-unpaid', `allUnpaid=${allUnpaid} txOk=${txOk} | ${afterDetails.join(' | ')} | tx: ${txStatus}`);

  finish();
}

main().catch(e => { fail('fatal', e?.stack || String(e)); process.exitCode = 1; });
