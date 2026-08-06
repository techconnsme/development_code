// Hard-delete all invoices + file records for the demo user, then re-test
const API = 'https://opcc-crm-api.ruhan-farhan.workers.dev/api';

async function main() {
  // Login
  const login = await fetch(API + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'muhammadruhan.farhan25@gmail.com', password: 'Ruhan123' })
  }).then(r => r.json());
  const token = login.token;
  console.log('Logged in as', login.user?.email || login.email);

  // Step 1: Fetch ALL invoices (including pending_review)
  console.log('\n--- Fetching all invoices ---');
  const all = await fetch(API + '/invoices?limit=500&status=pending_review,draft,active,sent,paid', {
    headers: { 'Authorization': 'Bearer ' + token }
  }).then(r => r.json());
  console.log('Total invoices found:', all.total);

  // Step 2: Delete each invoice
  let deleted = 0;
  for (const inv of (all.data || [])) {
    try {
      await fetch(API + '/invoices/' + inv.id, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + token }
      });
      deleted++;
    } catch (e) {
      console.log('Failed to delete', inv.id, inv.invoice_number);
    }
  }
  console.log('Deleted invoices:', deleted);

  // Step 3: Also clean up file_records
  console.log('\n--- Fetching all file records ---');
  const files = await fetch(API + '/file-storage?limit=500', {
    headers: { 'Authorization': 'Bearer ' + token }
  }).then(r => r.json());
  console.log('Total files found:', files.total || files.data?.length || 0);

  let filesDeleted = 0;
  for (const f of (files.data || [])) {
    try {
      await fetch(API + '/file-storage/' + f.id, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + token }
      });
      filesDeleted++;
    } catch (e) {
      // ignore
    }
  }
  console.log('Deleted files:', filesDeleted);

  console.log('\n✅ Cleanup done. Ready for fresh test.');
}

main().catch(e => console.error('FATAL:', e.message || e));
