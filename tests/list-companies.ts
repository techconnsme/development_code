const API = 'https://opcc-crm-api.ruhan-farhan.workers.dev/api';

async function main() {
  const login = await fetch(API + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'memonruhan731@gmail.com', password: 'Hamdan123' })
  }).then(r => r.json());
  const token = login.token;

  const users = await fetch(API + '/admin/users', {
    headers: { 'Authorization': 'Bearer ' + token }
  }).then(r => r.json());

  console.log('Companies in DB:');
  console.log('─'.repeat(80));
  for (const u of (users.data || users || [])) {
    const name = (u.company_name || u.name || 'N/A').slice(0, 40);
    console.log(`${u.id.padEnd(14)} ${u.email.padEnd(45)} ${name.padEnd(42)} ${u.role}`);
  }
  console.log('─'.repeat(80));
  console.log('Total:', (users.data || users).length);
}

main().catch(e => console.error(e.message || e));
