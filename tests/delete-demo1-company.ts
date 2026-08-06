const API = 'https://opcc-crm-api.ruhan-farhan.workers.dev/api';

async function main() {
  // Login as admin
  const login = await fetch(API + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'memonruhan731@gmail.com', password: 'Hamdan123' })
  }).then(r => r.json());

  if (!login.token) {
    console.error('Admin login failed:', JSON.stringify(login).slice(0, 200));
    return;
  }
  const token = login.token;
  console.log('Admin logged in:', login.user?.email);

  const targetUserId = 'u-demo0001';

  // First try: use the deregister endpoint (with the expanded table list)
  // The FK error is likely from card_statements or card_transactions tables
  // that aren't in the admin endpoint's deletion list

  // Second try: manually clean up common FK offenders
  console.log('Attempting deregister via admin endpoint...');
  const del = await fetch(API + '/admin/tenants/' + targetUserId, {
    method: 'DELETE',
    headers: { 'Authorization': 'Bearer ' + token }
  }).then(r => r.json());

  if (del.success) {
    console.log('✅ Deleted successfully!');
    console.log('Deleted:', del.deleted);
    return;
  }

  console.log('Direct delete failed:', del.error);

  // Try logging in as the target user and cleaning up their data
  console.log('\nLogging in as target user to clean up...');
  const targetLogin = await fetch(API + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'muhammadruhan.farhan25@nixorcollege.edu.pk', password: 'password' })
  }).then(r => r.json());

  if (!targetLogin.token) {
    console.error('Target login failed:', JSON.stringify(targetLogin).slice(0, 200));
    return;
  }
  const targetToken = targetLogin.token;
  console.log('Target user logged in');

  // Delete all invoices
  console.log('\nDeleting invoices...');
  const invs = await fetch(API + '/invoices?limit=500&status=pending_review,draft,active,sent,paid', {
    headers: { 'Authorization': 'Bearer ' + targetToken }
  }).then(r => r.json());
  console.log('  Found:', invs.total || invs.data?.length || 0);
  for (const inv of (invs.data || [])) {
    await fetch(API + '/invoices/' + inv.id, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + targetToken }
    });
  }
  console.log('  Deleted invoices');

  // Delete file records
  console.log('\nDeleting file records...');
  const files = await fetch(API + '/file-storage?limit=500', {
    headers: { 'Authorization': 'Bearer ' + targetToken }
  }).then(r => r.json());
  console.log('  Found:', files.total || files.data?.length || 0);
  for (const f of (files.data || [])) {
    await fetch(API + '/file-storage/' + f.id, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + targetToken }
    });
  }
  console.log('  Deleted files');

  // Delete bank statements
  console.log('\nDeleting bank statements...');
  const bs = await fetch(API + '/bank-statements?limit=500', {
    headers: { 'Authorization': 'Bearer ' + targetToken }
  }).then(r => r.json());
  console.log('  Found:', bs.total || bs.data?.length || 0);
  for (const s of (bs.data || [])) {
    await fetch(API + '/bank-statements/' + s.id, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + targetToken }
    });
  }
  console.log('  Deleted bank statements');

  // Now retry admin delete
  console.log('\nRetrying admin deregister...');
  const del2 = await fetch(API + '/admin/tenants/' + targetUserId, {
    method: 'DELETE',
    headers: { 'Authorization': 'Bearer ' + token }
  }).then(r => r.json());

  if (del2.success) {
    console.log('✅ Deleted successfully!');
    console.log('Deleted:', del2.deleted);
  } else {
    console.log('Still failed:', del2.error);
  }
}

main().catch(e => console.error(e.message || e));
