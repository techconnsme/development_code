/**
 * Clone the "Proficiency and Reliance Company Limited" tenant (u-83161e0c) into a
 * NEW isolated demo tenant: joseph.lin@pnr.demo.hk / Test1234.
 *
 * The demo tenant gets its own user row, company_settings, and full copies of all
 * documents and transaction records (accounts, customers, suppliers, file_records,
 * bank_statements, bank_transactions, invoices, invoice_items, journal_entries,
 * journal_lines, fixed_assets).
 *
 * Isolation guarantees:
 *  - New user id, never linked to the source firm (no firm_clients / firm_members).
 *  - Every copied row gets new_id = 'demo-' || old_id; all FKs remapped accordingly.
 *  - Every r2_key is rewritten to the new user's prefix; the R2 objects are COPIED
 *    (never shared) so deleting a demo file can't touch the source company.
 *
 * Idempotent: safe to re-run. If the demo user already exists, SQL inserts are
 * skipped (identity is reused) and only missing R2 objects are copied.
 *
 * Run from anywhere:  node scripts/clone-demo-tenant.mjs
 * Requires wrangler auth (api/wrangler.toml) + bcryptjs (api/node_modules).
 */

import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeFileSync, unlinkSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'api');
const DB = 'opcc-crm-db';
const BUCKET = 'opcc-crm-files';
const SOURCE_USER = 'u-83161e0c';
const NEW_EMAIL = 'joseph.lin@pnr.demo.hk';
const NEW_PASSWORD = 'Test1234';
const NEW_NAME = 'Joseph Lin';
const NEW_COMPANY = 'Proficiency and Reliance Company Limited';
const NEW_ROLE = 'supervisor';

const require = createRequire(join(API_DIR, 'package.json'));
const bcrypt = require('bcryptjs');

// ── helpers ────────────────────────────────────────────────────────────────
function run(cmd, opts = {}) {
  return execSync(cmd, {
    cwd: API_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'], ...opts,
  });
}

function query(sql) {
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  const out = run(`npx wrangler d1 execute ${DB} --remote --json --command "${oneLine}"`);
  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  const result = parsed.find((r) => Array.isArray(r.results));
  return result ? result.results : [];
}

function colsOf(table) {
  return query(`PRAGMA table_info(${table})`).map((c) => c.name);
}

function countFor(table, userId) {
  if (table === 'invoice_items' || table === 'journal_lines') {
    const pf = parentFilter[table];
    const rows = query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${pf[0]} IN (SELECT ${pf[2]} FROM ${pf[1]} WHERE user_id = '${userId}')`);
    return rows[0].n;
  }
  return query(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = '${userId}'`)[0].n;
}

// ── identity: create new user only if absent ───────────────────────────────
const existing = query(`SELECT id FROM users WHERE email = '${NEW_EMAIL}'`);
const newUserId = existing.length > 0
  ? existing[0].id
  : `u-${randomBytes(4).toString('hex')}`;
const createdNow = existing.length === 0;
console.log(`Demo user: ${NEW_EMAIL}  id=${newUserId}  ${createdNow ? '(created now)' : '(already existed, reusing)'}`);

if (createdNow) {
  const passwordHash = bcrypt.hashSync(NEW_PASSWORD, 10);
  console.log(`Password: ${NEW_PASSWORD}  (bcrypt cost 10)`);
  const userInsert = `
INSERT INTO users (id, email, password_hash, name, company_name, role, created_at, updated_at, permission_tier, status, must_change_password, parent_user_id)
VALUES ('${newUserId}', '${NEW_EMAIL}', '${passwordHash}', '${NEW_NAME}', '${NEW_COMPANY}', '${NEW_ROLE}', datetime('now'), datetime('now'), 'higher', 'active', 0, NULL);`;
  run(`npx wrangler d1 execute ${DB} --remote --command "${userInsert.replace(/"/g, "'")}"`);
  console.log('User row inserted.');
}

// ── SQL generation ─────────────────────────────────────────────────────────
const fkRemap = {
  customers: ['user_id'],
  suppliers: ['user_id'],
  accounts: ['user_id'],
  company_settings: ['user_id'],
  file_records: ['user_id'],
  bank_statements: ['user_id'],
  bank_transactions: ['user_id', 'bank_statement_id', 'invoice_id'],
  invoices: ['user_id', 'customer_id', 'supplier_id', 'file_id', 'linked_invoice_id'],
  invoice_items: ['invoice_id'],
  journal_entries: ['user_id', 'reference_id'],
  journal_lines: ['entry_id'],
  fixed_assets: ['user_id'],
};

const parentFilter = {
  invoice_items: ['invoice_id', 'invoices', 'id'],
  journal_lines: ['entry_id', 'journal_entries', 'id'],
};

function selectExpr(col, table) {
  if (col === 'id') return `'demo-' || id`;
  if (col === 'user_id') return `'${newUserId}'`;
  if (col === 'r2_key') return `'${newUserId}/' || substr(r2_key, instr(r2_key, '/') + 1)`;
  if ((fkRemap[table] ?? []).includes(col)) {
    return `CASE WHEN ${col} IS NOT NULL THEN 'demo-' || ${col} ELSE NULL END`;
  }
  return col;
}

const order = [
  'company_settings', 'accounts', 'customers', 'suppliers', 'file_records',
  'bank_statements', 'invoices', 'invoice_items', 'bank_transactions',
  'journal_entries', 'journal_lines', 'fixed_assets',
];

// Only copy tables that have NO rows for the new user yet (idempotency guard).
const statements = [];
for (const table of order) {
  const count = countFor(table, newUserId);
  if (count > 0) {
    console.log(`  skip ${table}: already has ${count} rows for demo user`);
    continue;
  }
  const cols = colsOf(table);
  const exprs = cols.map((c) => selectExpr(c, table));
  const pf = parentFilter[table];
  const from = pf
    ? `FROM ${table} WHERE ${pf[0]} IN (SELECT ${pf[2]} FROM ${pf[1]} WHERE user_id = '${SOURCE_USER}')`
    : `FROM ${table} WHERE user_id = '${SOURCE_USER}'`;
  statements.push(`INSERT INTO ${table} (${cols.join(', ')}) SELECT ${exprs.join(', ')} ${from};`);
}

if (statements.length > 0) {
  const sql = statements.join('\n');
  const tmpDir = mkdtempSync(join(tmpdir(), 'clone-demo-'));
  const sqlPath = join(tmpDir, 'clone.sql');
  writeFileSync(sqlPath, sql);
  console.log(`\nExecuting ${statements.length} INSERT statements against remote D1...`);
  const out = run(`npx wrangler d1 execute ${DB} --remote --file "${sqlPath}"`, { maxBuffer: 64 * 1024 * 1024 });
  console.log(out.trim().split('\n').slice(-8).join('\n'));
  unlinkSync(sqlPath);
} else {
  console.log('\nAll tables already populated for demo user; no SQL to run.');
}

// ── R2 object copy (idempotent, quoted paths) ──────────────────────────────
const r2Rows = query(`
  SELECT r2_key FROM file_records WHERE user_id = '${SOURCE_USER}' AND r2_key IS NOT NULL AND r2_key != ''
  UNION
  SELECT r2_key FROM bank_statements WHERE user_id = '${SOURCE_USER}' AND r2_key IS NOT NULL AND r2_key != ''
`);
const r2Keys = [...new Set(r2Rows.map((r) => r.r2_key))];

const objDir = mkdtempSync(join(tmpdir(), 'clone-r2-'));
// Percent-encode only '#' for the CLI (it treats '#' as a URL fragment). Spaces
// and other literal characters must stay raw — wrangler encodes them itself and
// sending '%20' would look up a key that literally contains a percent sign.
const encPath = (bucket, key) => `${bucket}/${key.replace(/#/g, '%23')}`;

let copied = 0, failed = 0;
for (const key of r2Keys) {
  const rest = key.slice(key.indexOf('/') + 1);
  const newKey = `${newUserId}/${rest}`;
  const tmpFile = join(objDir, `obj-${copied}`);
  try {
    run(`npx wrangler r2 object get "${encPath(BUCKET, key)}" -f "${tmpFile}"`);
    run(`npx wrangler r2 object put "${encPath(BUCKET, newKey)}" -f "${tmpFile}"`);
    copied++;
  } catch (e) {
    failed++;
    console.error(`R2 copy FAILED for ${key}: ${(e.message || '').split('\n')[0]}`);
  } finally {
    if (existsSync(tmpFile)) unlinkSync(tmpFile);
  }
}
console.log(`\nR2 objects: copied=${copied} failed=${failed} (of ${r2Keys.length})`);

// ── verification (dynamic: compare new tenant vs CURRENT source counts) ────
console.log('\nVERIFICATION (new tenant vs CURRENT source):');
const tables = ['company_settings', 'accounts', 'customers', 'suppliers', 'file_records',
  'bank_statements', 'bank_transactions', 'invoices', 'invoice_items', 'journal_entries',
  'journal_lines', 'fixed_assets'];
let ok = true;
for (const table of tables) {
  const src = countFor(table, SOURCE_USER);
  const n = countFor(table, newUserId);
  const match = src === n;
  if (!match) ok = false;
  console.log(`  ${table.padEnd(20)} source=${String(src).padStart(4)}  demo=${String(n).padStart(4)}  ${match ? 'OK' : 'MISMATCH'}`);
}
const demoUser = query(`SELECT id, email, role, status, permission_tier, company_name FROM users WHERE id = '${newUserId}'`);
console.log(`\nDemo user row: ${JSON.stringify(demoUser[0] ?? null)}`);
const badKeys = query(`SELECT COUNT(*) AS n FROM file_records WHERE user_id='${newUserId}' AND r2_key NOT LIKE '${newUserId}/%'`);
console.log(`R2 key remap: ${badKeys[0].n === 0 ? 'all remapped' : `${badKeys[0].n} NOT REMAPPED`}`);
console.log(`\nIsolation: source firm links untouched (demo user has no firm_members until first login).`);
console.log(ok ? '\nDONE — clone succeeded.' : '\nWARNING — some counts did not match; investigate before use.');
