import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { hash } from 'bcryptjs';
import { Bindings, Variables } from '../types';
import { authMiddleware } from '../middleware/auth';

const admin = new Hono<{ Bindings: Bindings; Variables: Variables }>();
admin.use('*', authMiddleware);

// ── List all users with stats (admin only) ──
admin.get('/users', async (c) => {
  const user = c.get('user');
  if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);

  const db = c.env.DB;
  const rows = await db.prepare(
    `SELECT u.id, u.email, u.name, u.company_name, u.role, u.created_at,
            (SELECT COUNT(*) FROM customers WHERE user_id = u.id) as customer_count,
            (SELECT COUNT(*) FROM invoices WHERE user_id = u.id) as invoice_count,
            (SELECT COUNT(*) FROM quotations WHERE user_id = u.id) as quotation_count
     FROM users u ORDER BY u.created_at DESC`
  ).all();
  return c.json({ data: rows.results });
});

// ── Domain management ──
admin.get('/domains', async (c) => {
  const user = c.get('user');
  if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);

  const rows = await c.env.DB.prepare(
    'SELECT d.*, u.name as user_name, u.email as user_email FROM domains d JOIN users u ON d.user_id = u.id ORDER BY d.domain'
  ).all();
  return c.json({ data: rows.results });
});

admin.post('/domains', async (c) => {
  const user = c.get('user');
  if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);

  const body = await c.req.json();
  const db = c.env.DB;
  const id = `dm-${crypto.randomUUID().slice(0, 8)}`;

  await db.prepare(
    'INSERT OR REPLACE INTO domains (id, user_id, domain, is_primary) VALUES (?, ?, ?, ?)'
  ).bind(id, body.user_id, body.domain, body.is_primary || 0).run();

  return c.json({ id, domain: body.domain, user_id: body.user_id }, 201);
});

admin.delete('/domains/:id', async (c) => {
  const user = c.get('user');
  if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);

  await c.env.DB.prepare('DELETE FROM domains WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ success: true });
});

// ── Create account (any role) — admin only ──
// POST /api/admin/create-account
// Body: { email, password, name, role, company_name?, permission_tier?, link_to_firm_id? }
admin.post('/create-account', async (c) => {
  const adminUser = c.get('user');
  if (adminUser.role !== 'admin') return c.json({ error: 'Admin only' }, 403);

  const body = await c.req.json();
  const { email, password, name, role, company_name, permission_tier, link_to_firm_id } = body as any;

  if (!email || !password || !name || !role) {
    return c.json({ error: 'email, password, name, and role are required' }, 400);
  }
  if (password.length < 6) {
    return c.json({ error: 'password must be at least 6 characters' }, 400);
  }
  const validRoles = ['admin', 'supervisor', 'accountant', 'staff', 'viewer', 'auditor'];
  if (!validRoles.includes(role)) {
    return c.json({ error: `role must be one of: ${validRoles.join(', ')}` }, 400);
  }

  const db = c.env.DB;

  // Check email not already registered
  const existing = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) return c.json({ error: 'This email is already registered.' }, 409);

  const userId = `u-${uuidv4().slice(0, 8)}`;
  const passwordHash = await hash(password, 10);

  // Default permission tier by role
  const tier = permission_tier
    || (['admin', 'supervisor', 'accountant'].includes(role) ? 'higher' : 'normal');

  await db.prepare(
    `INSERT INTO users (id, email, password_hash, name, company_name, role, status, permission_tier)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`
  ).bind(userId, email, passwordHash, name, company_name || name, role, tier).run();

  // If a company_name is provided, create company_settings
  if (company_name) {
    const csId = `cs-${uuidv4().slice(0, 8)}`;
    try {
      await db.prepare(
        `INSERT OR IGNORE INTO company_settings (user_id, name, email)
         VALUES (?, ?, ?)`
      ).bind(userId, company_name, email).run();
    } catch { /* ignore if table missing */ }
  }

  // Auto-create a personal firm for the new user (unless linking to an existing firm)
  if (!link_to_firm_id) {
    const firmName = company_name || name;
    const firmId = `f-${uuidv4().slice(0, 8)}`;
    try {
      await db.prepare('INSERT INTO firms (id, name, owner_user_id) VALUES (?, ?, ?)')
        .bind(firmId, firmName, userId).run();
      await db.prepare('INSERT INTO firm_members (id, firm_id, user_id, role) VALUES (?, ?, ?, ?)')
        .bind(`fm-${uuidv4().slice(0, 8)}`, firmId, userId, 'admin').run();
    } catch (e: any) {
      console.log('[AUTO-FIRM] create-account firm creation failed:', e?.message);
    }
  }

  // If link_to_firm_id is provided, also create a firm_clients entry
  let firmClientId: string | null = null;
  if (link_to_firm_id) {
    const firm = await db.prepare('SELECT id FROM firms WHERE id = ?').bind(link_to_firm_id).first();
    if (!firm) return c.json({ error: `Firm ${link_to_firm_id} not found` }, 400);
    firmClientId = `fc-${uuidv4().slice(0, 8)}`;
    await db.prepare(
      'INSERT INTO firm_clients (id, firm_id, client_user_id, display_name) VALUES (?, ?, ?, ?)'
    ).bind(firmClientId, link_to_firm_id, userId, company_name || name).run();
  }

  // Seed COA from template
  try {
    const templateAccounts = await db.prepare(
      "SELECT account_code, account_name, account_type, parent_code, opening_balance FROM accounts WHERE user_id = 'u-hayson'"
    ).all();
    if (templateAccounts.results.length > 0) {
      const inserts = templateAccounts.results.map((a: any) =>
        db.prepare(
          'INSERT OR IGNORE INTO accounts (id, user_id, account_code, account_name, account_type, parent_code, opening_balance) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(`acc-${uuidv4().slice(0, 8)}`, userId, a.account_code, a.account_name, a.account_type, a.parent_code || null, a.opening_balance || 0)
      );
      if (typeof db.batch === 'function') {
        for (let i = 0; i < inserts.length; i += 100) {
          await db.batch(inserts.slice(i, i + 100));
        }
      } else {
        for (const s of inserts) await s.run();
      }
    }
  } catch { /* ignore */ }

  // Seed compliance templates
  try {
    const templates = await db.prepare('SELECT id FROM compliance_templates WHERE is_required = 1').all();
    if (templates.results.length > 0) {
      const stmts = templates.results.map((t: any) =>
        db.prepare(
          'INSERT OR IGNORE INTO member_compliance (id, user_id, template_id, status) VALUES (?, ?, ?, ?)'
        ).bind(`mc-${uuidv4().slice(0, 8)}`, userId, t.id, 'pending')
      );
      if (typeof db.batch === 'function') {
        await db.batch(stmts);
      } else {
        for (const s of stmts) await s.run();
      }
    }
  } catch { /* ignore */ }

  // Audit log
  try {
    await db.prepare(
      'INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, changes) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(`al-${uuidv4().slice(0, 8)}`, adminUser.id, 'create_account', 'user', userId,
      JSON.stringify({ email, name, role, company_name: company_name || null, link_to_firm_id: link_to_firm_id || null })
    ).run();
  } catch { /* ignore */ }

  return c.json({
    id: userId,
    email,
    name,
    role,
    company_name: company_name || null,
    permission_tier: tier,
    firm_client_id: firmClientId,
    password, // return plaintext so the admin can share it
  }, 201);
});

// ── One-click onboard: create user + domain + DNS + Pages ──
admin.post('/onboard', async (c) => {
  const adminUser = c.get('user');
  if (adminUser.role !== 'admin') return c.json({ error: 'Admin only' }, 403);

  const body = await c.req.json();
  const { domain, company_name, email, name } = body;
  if (!domain || !company_name || !email) {
    return c.json({ error: 'Missing required fields: domain, company_name, email' }, 400);
  }
  const db = c.env.DB;
  const steps: string[] = [];

  // Check email not already registered
  const existingUser = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existingUser) return c.json({ error: 'This email is already registered.' }, 409);

  // Auto-generate secure temporary password
  const tempPassword = `TCS${Math.random().toString(36).slice(2, 8).toUpperCase()}1!`;

  // 1. Create user as SUPERVISOR (not admin — only the platform owner is admin)
  const userId = `u-${uuidv4().slice(0, 8)}`;
  const passwordHash = await hash(tempPassword, 10);
  await db.prepare(
    `INSERT INTO users (id, email, password_hash, name, company_name, role, status, must_change_password, permission_tier)
     VALUES (?,?,?,?,?,?, 'active', 1, 'higher')`
  ).bind(userId, email, passwordHash, name || company_name, company_name, 'supervisor').run();
  steps.push('User account created (supervisor)');

  // 2. Create company_settings
  await db.prepare(
    `INSERT OR REPLACE INTO company_settings (user_id, name, email, website, address)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(userId, company_name, email, `https://${domain}`, 'Hong Kong').run();
  steps.push('Company settings configured');

  // 2b. Auto-create personal firm
  try {
    const firmId = `f-${uuidv4().slice(0, 8)}`;
    await db.prepare('INSERT INTO firms (id, name, owner_user_id) VALUES (?, ?, ?)')
      .bind(firmId, company_name, userId).run();
    await db.prepare('INSERT INTO firm_members (id, firm_id, user_id, role) VALUES (?, ?, ?, ?)')
      .bind(`fm-${uuidv4().slice(0, 8)}`, firmId, userId, 'admin').run();
    steps.push('Personal firm created');
  } catch (e: any) {
    steps.push(`⚠️ Firm creation: ${e.message}`);
  }

  // 3. Insert domain mapping
  const dmId = `dm-${uuidv4().slice(0, 8)}`;
  await db.prepare(
    'INSERT INTO domains (id, user_id, domain, is_primary) VALUES (?,?,?,1)'
  ).bind(dmId, userId, domain).run();
  steps.push('Domain mapping created');

  // 4. Try Cloudflare API: DNS + Pages domain
  const cfToken = c.env.CF_API_TOKEN || '';
  const accountId = c.env.CF_ACCOUNT_ID || '';
  const zoneId = c.env.CF_ZONE_ID || '';

  if (cfToken) {
    // DNS CNAME
    try {
      const dnsRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'CNAME', name: domain.split('.')[0], content: 'oppc-crm.pages.dev', ttl: 1, proxied: true }),
      });
      const dnsJson: any = await dnsRes.json();
      if (dnsJson.success) steps.push('DNS CNAME created');
      else steps.push(`DNS warning: ${dnsJson.errors?.[0]?.message || 'unknown error'}`);
    } catch (e: any) { steps.push(`⚠️ DNS failed: ${e.message}`); }

    // Pages domain
    try {
      const pagesRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/oppc-crm/domains`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: domain }),
      });
      const pagesJson: any = await pagesRes.json();
      if (pagesJson.success) steps.push('Pages domain added');
      else steps.push(`Pages warning: ${pagesJson.errors?.[0]?.message || 'unknown error'}`);
    } catch (e: any) { steps.push(`⚠️ Pages failed: ${e.message}`); }
  } else {
    steps.push('CF_API_TOKEN not configured. DNS/Pages must be added manually.');
  }

  return c.json({
    success: true,
    user: { id: userId, email, name: name || company_name, company: company_name },
    domain: `https://${domain}`,
    temp_password: tempPassword,
    steps,
  }, 201);
});

// ── APPLICATION MANAGEMENT ────────────────────────────────────────────────

// List all applications
admin.get('/applications', async (c) => {
  const adminUser = c.get('user');
  if (adminUser.role !== 'admin') return c.json({ error: 'Admin only' }, 403);
  const db = c.env.DB;
  const status = c.req.query('status') || '';
  let q = `SELECT * FROM applications ORDER BY created_at DESC`;
  if (status) q = `SELECT * FROM applications WHERE status = '${status}' ORDER BY created_at DESC`;
  const rows = await db.prepare(q).all();
  return c.json({ data: rows.results });
});

// Approve application → auto-create supervisor account + send welcome email
admin.post('/applications/:id/approve', async (c) => {
  const adminUser = c.get('user');
  if (adminUser.role !== 'admin') return c.json({ error: 'Admin only' }, 403);
  const db = c.env.DB;
  const appId = c.req.param('id');

  const app = await db.prepare('SELECT * FROM applications WHERE id = ?')
    .bind(appId).first<{ id: string; company_name: string; contact_name: string; email: string; phone: string; status: string }>();
  if (!app) return c.json({ error: 'Application not found' }, 404);
  if (app.status !== 'pending') return c.json({ error: 'Application is not pending' }, 400);

  // Check email not already registered
  const existing = await db.prepare('SELECT id FROM users WHERE email = ?').bind(app.email).first();
  if (existing) return c.json({ error: 'This email is already registered' }, 409);

  // Generate supervisor account
  const userId = `u-${uuidv4().slice(0, 8)}`;
  const tempPassword = `TCS${Math.random().toString(36).slice(2, 8).toUpperCase()}1!`;
  const passwordHash = await hash(tempPassword, 10);

  await db.prepare(
    `INSERT INTO users (id, email, password_hash, name, company_name, role, status, must_change_password, permission_tier)
     VALUES (?, ?, ?, ?, ?, 'supervisor', 'active', 1, 'higher')`
  ).bind(userId, app.email, passwordHash, app.contact_name, app.company_name).run();

  // Create company settings
  await db.prepare(
    `INSERT OR REPLACE INTO company_settings (id, user_id, name, email) VALUES (?, ?, ?, ?)`
  ).bind(`cs-${uuidv4().slice(0, 8)}`, userId, app.company_name, app.email).run();

  // Mark application as approved
  await db.prepare(
    `UPDATE applications SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now'),
     created_user_id = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(adminUser.id, userId, appId).run();

  // Send welcome email via Resend (or Mailgun fallback)
  const loginUrl = 'https://sme.techforliving.net/login';
  let emailSent = false;
  let emailError = '';

  // Try Resend first
  if (c.env.RESEND_API_KEY) {
    try {
      const emailResp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${c.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Tech Connect SME <noreply@techforliving.net>',
          to: app.email,
          subject: 'Your Tech Connect SME Account is Ready',
          text: `Hi ${app.contact_name},\n\nWelcome to Tech Connect SME!\n\nYour account for ${app.company_name} has been approved.\n\nLogin URL: ${loginUrl}\nEmail: ${app.email}\nTemporary Password: ${tempPassword}\n\nPlease log in and change your password immediately.\n\nTech Connect SME Team`,
        }),
      });
      const emailResult = await emailResp.json().catch(() => null);
      if (emailResp.ok) {
        emailSent = true;
        console.log('[EMAIL] Welcome email sent via Resend to', app.email);
      } else {
        emailError = `Resend API error ${emailResp.status}: ${JSON.stringify(emailResult)}`;
        console.error('[EMAIL] Resend failed:', emailError);
      }
    } catch (e: any) {
      emailError = `Resend exception: ${e?.message || String(e)}`;
      console.error('[EMAIL]', emailError);
    }
  }

  // Try Mailgun as fallback if Resend didn't work
  if (!emailSent && c.env.MAILGUN_API_KEY) {
    try {
      const mgDomain = 'techforliving.net';
      const formData = new URLSearchParams();
      formData.append('from', `Tech Connect SME <noreply@${mgDomain}>`);
      formData.append('to', app.email);
      formData.append('subject', 'Your Tech Connect SME Account is Ready');
      formData.append('text', `Hi ${app.contact_name},\n\nWelcome to Tech Connect SME!\n\nYour account for ${app.company_name} has been approved.\n\nLogin URL: ${loginUrl}\nEmail: ${app.email}\nTemporary Password: ${tempPassword}\n\nPlease log in and change your password immediately.\n\nTech Connect SME Team`);

      const mgResp = await fetch(`https://api.mailgun.net/v3/${mgDomain}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${btoa('api:' + c.env.MAILGUN_API_KEY)}` },
        body: formData,
      });
      if (mgResp.ok) {
        emailSent = true;
        emailError = '';
        console.log('[EMAIL] Welcome email sent via Mailgun to', app.email);
      } else {
        const mgResult = await mgResp.text().catch(() => '');
        emailError += ` | Mailgun error ${mgResp.status}: ${mgResult}`;
        console.error('[EMAIL] Mailgun also failed:', mgResult);
      }
    } catch (e: any) {
      emailError += ` | Mailgun exception: ${e?.message || String(e)}`;
      console.error('[EMAIL] Mailgun exception:', e);
    }
  }

  if (!emailSent && !c.env.RESEND_API_KEY && !c.env.MAILGUN_API_KEY) {
    emailError = 'No email API key configured (RESEND_API_KEY or MAILGUN_API_KEY). Use the Copy Credentials button to manually send login details.';
  }

  return c.json({
    success: true,
    user_id: userId,
    email: app.email,
    temp_password: tempPassword,
    email_sent: emailSent,
    email_error: emailError || undefined,
    message: emailSent
      ? `Supervisor account created for ${app.company_name}. Welcome email sent to ${app.email}.`
      : `Supervisor account created for ${app.company_name}. Email could NOT be sent — please use "Copy Credentials" to share login details manually.${emailError ? ' Error: ' + emailError : ''}`,
  }, 201);
});

// Reject application
admin.post('/applications/:id/reject', async (c) => {
  const adminUser = c.get('user');
  if (adminUser.role !== 'admin') return c.json({ error: 'Admin only' }, 403);
  const db = c.env.DB;
  const appId = c.req.param('id');
  await db.prepare(
    `UPDATE applications SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now'),
     updated_at = datetime('now') WHERE id = ?`
  ).bind(adminUser.id, appId).run();
  return c.json({ success: true });
});

// ── END APPLICATION MANAGEMENT ────────────────────────────────────────────

// ── Tenant data export (original, restored) ──
admin.get('/tenants/:userId/export', async (c) => {
  const adminUser = c.get('user');
  if (adminUser.role !== 'admin') return c.json({ error: 'Admin only' }, 403);

  const targetUserId = c.req.param('userId');
  const format = c.req.query('format') || 'json';
  const db = c.env.DB;

  // All user-scoped tables
  const tables = [
    'company_settings',
    'customers',
    'suppliers',
    'products',
    { name: 'invoices', children: 'invoice_items' },
    { name: 'quotations', children: 'quotation_items' },
    { name: 'journal_entries', children: 'journal_lines' },
    'accounts',
    'audit_log',
    'api_tokens',
    'workbuddy_config',
    'domains',
    'calendar_events',
    { name: 'services', children: 'service_bookings' },
    { name: 'conversations', children: 'messages' },
    'channels',
    'message_templates',
    'webhook_events',
    'wuzapi_sessions',
    'documents',
  ];

  const result: Record<string, any> = {
    exported_at: new Date().toISOString(),
    user_id: targetUserId,
  };

  // Get user info
  const userRow = await db.prepare(
    'SELECT id, email, name, company_name, role, created_at FROM users WHERE id = ?'
  ).bind(targetUserId).first();
  if (!userRow) return c.json({ error: 'User not found' }, 404);
  result.user = userRow;

  // Export each table
  for (const table of tables) {
    const tableName = typeof table === 'string' ? table : table.name;
    try {
      const rows = await db.prepare(
        `SELECT * FROM ${tableName} WHERE user_id = ?`
      ).bind(targetUserId).all();
      const data = rows.results as any[];

      // For tables with children, also export child rows
      if (typeof table !== 'string' && table.children && data.length > 0) {
        const childTable = table.children;
        const parentIds = data.map((r: any) => r.id);
        const parentIdCol = tableName === 'invoices' ? 'invoice_id'
          : tableName === 'quotations' ? 'quotation_id'
          : tableName === 'journal_entries' ? 'entry_id'
          : tableName === 'services' ? 'service_id'
          : 'conversation_id';

        try {
          const childRows = await db.prepare(
            `SELECT * FROM ${childTable} WHERE ${parentIdCol} IN (${parentIds.map(() => '?').join(',')})`
          ).bind(...parentIds).all();
          result[childTable] = childRows.results;
        } catch { /* child table may not exist yet */ }
      }

      result[tableName] = data;
    } catch { /* table may not exist yet for this schema version */ }
  }

  // CSV download for single table
  if (format === 'csv') {
    const targetTable = c.req.query('table');
    if (!targetTable || !result[targetTable]) {
      return c.json({ error: 'Specify ?table=xxx for CSV export' }, 400);
    }
    const rows = result[targetTable];
    if (!Array.isArray(rows) || rows.length === 0) {
      return c.text('No data', 200, { 'Content-Type': 'text/csv' });
    }
    const headers = Object.keys(rows[0]);
    let csv = headers.join(',') + '\n';
    for (const row of rows) {
      csv += headers.map(h => {
        const val = String(row[h] ?? '');
        return val.includes(',') || val.includes('"') ? `"${val.replace(/"/g, '""')}"` : val;
      }).join(',') + '\n';
    }
    return c.text(csv, 200, {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="${targetUserId}_${targetTable}.csv"`,
    });
  }

  // Full JSON download
  return c.json(result, 200, {
    'Content-Disposition': `attachment; filename="${targetUserId}_export.json"`,
  });
});

// ── Tenant data summary ──
admin.get('/tenants/:userId/summary', async (c) => {
  const adminUser = c.get('user');
  if (adminUser.role !== 'admin') return c.json({ error: 'Admin only' }, 403);

  const targetUserId = c.req.param('userId');
  const db = c.env.DB;

  const userRow = await db.prepare(
    'SELECT id, email, name, company_name, role, created_at FROM users WHERE id = ?'
  ).bind(targetUserId).first();
  if (!userRow) return c.json({ error: 'User not found' }, 404);

  const counts: Record<string, number> = {};
  const countTables = ['customers','suppliers','products','invoices','quotations',
    'journal_entries','calendar_events',
    'conversations','messages','documents'];
  for (const t of countTables) {
    try {
      const r = await db.prepare(`SELECT COUNT(*) as cnt FROM ${t} WHERE user_id = ?`)
        .bind(targetUserId).first<{cnt:number}>();
      counts[t] = r?.cnt || 0;
    } catch { counts[t] = 0; }
  }

  return c.json({ user: userRow, counts });
});

// ── DELETE INDIVIDUAL USER (for cleaning up legacy/test accounts) ──
admin.delete('/users/:userId', async (c) => {
  const adminUser = c.get('user');
  if (adminUser.role !== 'admin') return c.json({ error: 'Admin only' }, 403);

  const targetId = c.req.param('userId');
  const db = c.env.DB;

  const target = await db.prepare(
    'SELECT id, email, role, company_name FROM users WHERE id = ?'
  ).bind(targetId).first<{ id: string; email: string; role: string; company_name: string }>();
  if (!target) return c.json({ error: 'User not found' }, 404);
  if (target.role === 'admin') return c.json({ error: 'Cannot delete admin accounts' }, 403);

  // For supervisors, use the full deregister flow
  if (target.role === 'supervisor') {
    return c.json({ error: 'Use the deregister company endpoint for supervisor accounts' }, 400);
  }

  // For legacy user/staff/viewer accounts, just delete the user record
  try { await db.prepare('PRAGMA foreign_keys = OFF').run(); } catch {}
  await db.prepare('DELETE FROM users WHERE id = ?').bind(targetId).run();
  try { await db.prepare('PRAGMA foreign_keys = ON').run(); } catch {}

  // Clean up any related applications
  await db.prepare("DELETE FROM applications WHERE email = ? AND status NOT IN ('approved')").bind(target.email).run();

  return c.json({ success: true, message: `User ${target.email} (${target.role}) deleted.` });
});

// ── DEREGISTER COMPANY (delete all data + user) ──────────────────────────
admin.delete('/tenants/:userId', async (c) => {
  const adminUser = c.get('user');
  if (adminUser.role !== 'admin') return c.json({ error: 'Admin only' }, 403);

  const targetUserId = c.req.param('userId');
  const db = c.env.DB;

  // Verify user exists and is not admin
  const targetUser = await db.prepare(
    'SELECT id, email, name, company_name, role FROM users WHERE id = ?'
  ).bind(targetUserId).first<{ id: string; email: string; name: string; company_name: string; role: string }>();

  if (!targetUser) return c.json({ error: 'User not found' }, 404);
  if (targetUser.role === 'admin') return c.json({ error: 'Cannot delete admin accounts' }, 403);

  const deleted: string[] = [];

  // Delete all data in user-scoped tables (children first, then parents)
  const tables = [
    // Children first (foreign key dependents)
    'journal_lines', 'invoice_items', 'quotation_items', 'purchase_order_items',
    'service_order_items', 'chat_messages', 'bank_transactions', 'card_transactions',
    // Then parents
    'journal_entries', 'accounts', 'bank_statements', 'card_statements', 'invoices',
    'expense_receipts', 'file_records', 'customers', 'suppliers',
    'products', 'quotations', 'purchase_orders', 'service_orders',
    'chat_sessions', 'calendar_events', 'messages', 'conversations',
    'company_settings', 'audit_log', 'fixed_assets', 'closed_periods',
    'bank_reconciliations', 'todos', 'documents', 'subscriptions',
    'workbuddy_config', 'domains',
  ];

  for (const table of tables) {
    try {
      const result = await db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(targetUserId).run();
      if ((result?.meta?.changes || 0) > 0) deleted.push(`${table}: ${result.meta.changes} rows`);
    } catch { /* table may not exist */ }
  }

  // Clear application references to this user
  try {
    await db.prepare(
      `UPDATE applications SET created_user_id = NULL WHERE created_user_id = ?`
    ).bind(targetUserId).run();
  } catch { /* ignore */ }

  // Clear firm-related FK references (owner_user_id, client_user_id)
  try {
    await db.prepare('DELETE FROM firm_clients WHERE client_user_id = ?').bind(targetUserId).run();
  } catch { /* ignore */ }
  try {
    await db.prepare('DELETE FROM firm_members WHERE user_id = ?').bind(targetUserId).run();
  } catch { /* ignore */ }
  try {
    await db.prepare('DELETE FROM firms WHERE owner_user_id = ?').bind(targetUserId).run();
  } catch { /* ignore */ }

  // Delete staff accounts under this company
  try {
    await db.prepare('PRAGMA foreign_keys = OFF').run();
  } catch { /* D1 might not support this */ }

  try {
    const staffResult = await db.prepare('DELETE FROM users WHERE parent_user_id = ?').bind(targetUserId).run();
    if ((staffResult?.meta?.changes || 0) > 0) deleted.push(`staff accounts: ${staffResult.meta.changes}`);
  } catch { /* ignore */ }

  // Delete the user account itself
  try {
    await db.prepare('DELETE FROM users WHERE id = ?').bind(targetUserId).run();
    deleted.push('user account deleted');
  } catch {
    // If FK still blocks, null out references and retry
    try {
      await db.prepare(`UPDATE users SET parent_user_id = NULL WHERE parent_user_id = ?`).bind(targetUserId).run();
      await db.prepare('DELETE FROM users WHERE id = ?').bind(targetUserId).run();
      deleted.push('user account deleted (retry)');
    } catch (e: any) {
      deleted.push(`user delete failed: ${e?.message || 'FK constraint'}`);
    }
  }

  try {
    await db.prepare('PRAGMA foreign_keys = ON').run();
  } catch { /* ignore */ }
  try {
    const fileRecords = await db.prepare(
      'SELECT r2_key FROM file_records WHERE user_id = ?'
    ).bind(targetUserId).all();
    const r2Keys = (fileRecords.results || []).map((r: any) => r.r2_key).filter(Boolean);
    for (const key of r2Keys) {
      try { await c.env.FILE_BUCKET.delete(key); } catch { /* ignore */ }
    }
    if (r2Keys.length > 0) deleted.push(`R2 files: ${r2Keys.length}`);
  } catch { /* ignore */ }

  // Delete the user account itself
  await db.prepare('DELETE FROM users WHERE id = ?').bind(targetUserId).run();
  deleted.push('user account deleted');

  // Mark any related applications as deregistered
  try {
    await db.prepare(
      `UPDATE applications SET status = 'deregistered', updated_at = datetime('now') WHERE email = ?`
    ).bind(targetUser.email).run();
  } catch { /* ignore */ }

  // Audit log (on admin's account since tenant is gone)
  try {
    await db.prepare(
      'INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, changes) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(
      `al-${crypto.randomUUID().slice(0, 8)}`, adminUser.id, 'deregister_company', 'user', targetUserId,
      JSON.stringify({ company: targetUser.company_name, email: targetUser.email, deleted })
    ).run();
  } catch { /* ignore */ }

  return c.json({
    success: true,
    message: `Company "${targetUser.company_name}" (${targetUser.email}) has been deregistered. All data has been permanently deleted.`,
    deleted,
  });
});

// ── Audit statistics ──
admin.get('/audit-stats', async (c) => {
  const db = c.env.DB;

  // Total statements and those with source documents (via file_records r2_key match)
  const bankDocs = await db.prepare(
    `SELECT COUNT(*) as total, COUNT(fr.id) as with_docs
     FROM bank_statements bs
     LEFT JOIN file_records fr ON bs.r2_key = fr.r2_key AND fr.deleted_at IS NULL
     WHERE bs.deleted_at IS NULL`
  ).first<{ total: number; with_docs: number }>();
  const cardDocs = await db.prepare(
    `SELECT COUNT(*) as total, COUNT(fr.id) as with_docs
     FROM card_statements cs
     LEFT JOIN file_records fr ON cs.r2_key = fr.r2_key AND fr.deleted_at IS NULL
     WHERE cs.deleted_at IS NULL`
  ).first<{ total: number; with_docs: number }>();

  const totalStatements = (bankDocs?.total || 0) + (cardDocs?.total || 0);
  const statementsWithDocs = (bankDocs?.with_docs || 0) + (cardDocs?.with_docs || 0);
  const missingDocPct = totalStatements > 0
    ? Math.round(((totalStatements - statementsWithDocs) / totalStatements) * 1000) / 10
    : 0;

  // Receipt vs Expense ratio from journal entries (last 12 months)
  const receiptExpense = await db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN a.account_type = 'revenue' THEN jl.credit ELSE 0 END), 0) as total_receipts,
       COALESCE(SUM(CASE WHEN a.account_type = 'expense' THEN jl.debit ELSE 0 END), 0) as total_expenses
     FROM journal_lines jl
     JOIN accounts a ON jl.account_code = a.account_code
     JOIN journal_entries je ON jl.entry_id = je.id
     WHERE je.entry_date >= date('now', '-12 months')`
  ).first<{ total_receipts: number; total_expenses: number }>();

  const totalReceipts = receiptExpense?.total_receipts || 0;
  const totalExpenses = receiptExpense?.total_expenses || 0;
  const totalVolume = totalReceipts + totalExpenses;
  const receiptPct = totalVolume > 0 ? Math.round((totalReceipts / totalVolume) * 1000) / 10 : 50;
  const expensePct = totalVolume > 0 ? Math.round((totalExpenses / totalVolume) * 1000) / 10 : 50;

  return c.json({
    missing_doc_pct: missingDocPct,
    receipt_pct: receiptPct,
    expense_pct: expensePct,
    total_statements: totalStatements,
    statements_with_docs: statementsWithDocs,
    total_receipts: totalReceipts,
    total_expenses: totalExpenses,
  });
});

// POST /hard-reset-data — hard-delete ALL transactional data for a user (regression testing)
// Preserves: COA accounts, company settings, user account, compliance data
// Deletes: bank statements+txns, journal entries+lines, invoices+items,
//          card statements+txns, file records, customers, suppliers, products,
//          fixed assets, todos, expense receipts, purchase orders, quotations
admin.post('/hard-reset-data', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Authentication required' }, 401);
  // Allow admin, supervisor with firm_admin, or anyone with higher tier
  if (user.role !== 'admin' && user.firm_role !== 'admin') {
    const ok = await requireHigherTier(c);
    if (!ok) return c.json({ error: 'Admin or higher-tier access required' }, 403);
  }

  const targetUserId = (await c.req.json().catch(() => ({}))).user_id || user.id;
  const db = c.env.DB;
  const results: Record<string, number> = {};

  // Break circular FKs first
  await db.prepare('UPDATE invoices SET linked_invoice_id = NULL WHERE user_id = ?').bind(targetUserId).run();

  // Delete child tables (FK order)
  const r1 = await db.prepare('DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE user_id = ?)').bind(targetUserId).run();
  results.invoice_items = r1.meta?.changes || 0;

  const r2 = await db.prepare('DELETE FROM card_transactions WHERE user_id = ?').bind(targetUserId).run();
  results.card_transactions = r2.meta?.changes || 0;

  const r3 = await db.prepare('DELETE FROM bank_transactions WHERE user_id = ?').bind(targetUserId).run();
  results.bank_transactions = r3.meta?.changes || 0;

  const r4 = await db.prepare('DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE user_id = ?)').bind(targetUserId).run();
  results.journal_lines = r4.meta?.changes || 0;

  const r5 = await db.prepare('DELETE FROM journal_entries WHERE user_id = ?').bind(targetUserId).run();
  results.journal_entries = r5.meta?.changes || 0;

  // Delete main document tables
  const r6 = await db.prepare('DELETE FROM invoices WHERE user_id = ?').bind(targetUserId).run();
  results.invoices = r6.meta?.changes || 0;

  const r7 = await db.prepare('DELETE FROM bank_statements WHERE user_id = ?').bind(targetUserId).run();
  results.bank_statements = r7.meta?.changes || 0;

  const r8 = await db.prepare('DELETE FROM card_statements WHERE user_id = ?').bind(targetUserId).run();
  results.card_statements = r8.meta?.changes || 0;

  const r9 = await db.prepare('DELETE FROM file_records WHERE user_id = ?').bind(targetUserId).run();
  results.file_records = r9.meta?.changes || 0;

  const r10 = await db.prepare('DELETE FROM bank_reconciliations WHERE user_id = ?').bind(targetUserId).run();
  results.bank_reconciliations = r10.meta?.changes || 0;

  // Delete related entities
  const r11 = await db.prepare('DELETE FROM customers WHERE user_id = ?').bind(targetUserId).run();
  results.customers = r11.meta?.changes || 0;

  const r12 = await db.prepare('DELETE FROM suppliers WHERE user_id = ?').bind(targetUserId).run();
  results.suppliers = r12.meta?.changes || 0;

  const r13 = await db.prepare('DELETE FROM products WHERE user_id = ?').bind(targetUserId).run();
  results.products = r13.meta?.changes || 0;

  const r14 = await db.prepare('DELETE FROM fixed_assets WHERE user_id = ?').bind(targetUserId).run();
  results.fixed_assets = r14.meta?.changes || 0;

  const r15 = await db.prepare('DELETE FROM todos WHERE user_id = ?').bind(targetUserId).run();
  results.todos = r15.meta?.changes || 0;

  try { const r = await db.prepare('DELETE FROM expense_receipts WHERE user_id = ?').bind(targetUserId).run(); results.expense_receipts = r.meta?.changes || 0; } catch {}
  try { const r = await db.prepare('DELETE FROM purchase_orders WHERE user_id = ?').bind(targetUserId).run(); results.purchase_orders = r.meta?.changes || 0; } catch {}
  try { const r = await db.prepare('DELETE FROM quotations WHERE user_id = ?').bind(targetUserId).run(); results.quotations = r.meta?.changes || 0; } catch {}

  // Clear localStorage-persisted fiscal year for this user
  // (Can't do from API, but the client will reset on next load since data is gone)

  const totalDeleted = Object.values(results).reduce((a, b) => a + b, 0);
  return c.json({ success: true, user_id: targetUserId, total_deleted: totalDeleted, details: results });
});

export { admin as adminRoutes };
