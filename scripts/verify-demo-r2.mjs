import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'api');
const DB = 'opcc-crm-db';
const BUCKET = 'opcc-crm-files';
const USER = process.argv[2] || 'u-21e2a52a';

function run(cmd) {
  return execSync(cmd, { cwd: API_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}
function query(sql) {
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  const out = run(`npx wrangler d1 execute ${DB} --remote --json --command "${oneLine}"`);
  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  const r = parsed.find((x) => Array.isArray(x.results));
  return r ? r.results : [];
}

const rows = query(`
  SELECT DISTINCT r2_key FROM (
    SELECT r2_key FROM file_records WHERE user_id='${USER}' AND r2_key IS NOT NULL AND r2_key != ''
    UNION
    SELECT r2_key FROM bank_statements WHERE user_id='${USER}' AND r2_key IS NOT NULL AND r2_key != ''
  )`);
console.log(`Distinct keys for ${USER}: ${rows.length}`);

let exists = 0, missing = 0;
const missingList = [];
for (const r of rows) {
  const key = r.r2_key;
  try {
    run(`npx wrangler r2 object get "${BUCKET}/${key.replace(/#/g, '%23')}" -f "$TEMP/probe-${exists}${missing}"`);
    exists++;
  } catch {
    missing++;
    missingList.push(key);
  }
}
console.log(`EXISTS=${exists}  MISSING=${missing}`);
if (missingList.length) {
  console.log('Missing objects:');
  for (const k of missingList) console.log('  ' + k);
}