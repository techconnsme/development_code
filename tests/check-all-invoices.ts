const API = 'https://opcc-crm-api.ruhan-farhan.workers.dev/api';

async function main() {
  const login = await fetch(API + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'muhammadruhan.farhan25@gmail.com', password: 'Ruhan123' })
  }).then(r => r.json());
  const token = login.token;

  // Check company name
  const cs = await fetch(API + '/company', {
    headers: { 'Authorization': 'Bearer ' + token }
  }).then(r => r.json());
  console.log('Company:', cs.name);

  // Check all invoices
  const invs = await fetch(API + '/invoices?limit=50&status=pending_review,draft,active,sent,paid', {
    headers: { 'Authorization': 'Bearer ' + token }
  }).then(r => r.json());
  console.log('\nTotal invoices:', invs.total);
  console.log('─'.repeat(80));

  for (const i of (invs.data || [])) {
    const icon = i.direction === 'incoming' ? '📥 AP' : i.direction === 'outgoing' ? '📤 AR' : '❓';
    const exp = i.vendor_name?.includes('FedEx') || i.vendor_name?.includes('PwC') ? 'incoming' :
                i.vendor_name?.includes('TechGear') || i.vendor_name?.includes('StarNet') ? 'outgoing' : '?';
    const ok = i.direction === exp ? '✅' : '❌';
    console.log(`${ok} ${icon} ${i.invoice_number.padEnd(15)} dir=${i.direction.padEnd(9)} status=${i.status.padEnd(10)} vendor=${(i.vendor_name||'N/A').slice(0,35)}`);
  }
}

main().catch(e => console.error(e.message || e));
