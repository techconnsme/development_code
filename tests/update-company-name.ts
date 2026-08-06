const API = 'https://opcc-crm-api.ruhan-farhan.workers.dev/api';

async function main() {
  const login = await fetch(API + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'muhammadruhan.farhan25@gmail.com', password: 'Ruhan123' })
  }).then(r => r.json());
  const token = login.token;
  console.log('Logged in');

  // Update company name
  const r = await fetch(API + '/company', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ name: 'Demo Company Limited' })
  }).then(r => r.json());
  console.log('Updated:', r.name || r.message || JSON.stringify(r).slice(0, 200));

  // Verify
  const cs = await fetch(API + '/company', {
    headers: { 'Authorization': 'Bearer ' + token }
  }).then(r => r.json());
  console.log('Company name is now:', cs.name);
}

main().catch(e => console.error(e.message || e));
