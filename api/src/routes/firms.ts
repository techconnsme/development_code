import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { hash } from 'bcryptjs';
import { Bindings, Variables } from '../types';
import { authMiddleware } from '../middleware/auth';
import { getCoaTemplate, mergeCustomAccounts, type CoaTemplateAccount } from '../lib/coa-templates';

const firms = new Hono<{ Bindings: Bindings; Variables: Variables }>();
firms.use('*', authMiddleware);

// GET /api/firms/my ??current user's firm info + all accessible clients (or standalone sub-accounts)
firms.get('/my', async (c) => {
  const user = c.get('user');

  // Standalone supervisor/accountant/admin ??return sub-accounts linked via parent_user_id
  if (!user.firm_id) {
    if (['admin', 'supervisor', 'accountant'].includes(user.role)) {
      const clients = await c.env.DB.prepare(
        `SELECT id, id as client_user_id, company_name as display_name, status, company_name, name as user_name, email
         FROM users WHERE parent_user_id = ? AND status = 'active'
         ORDER BY created_at DESC`
      ).bind(user.id).all();
      return c.json({ firm: null, clients: clients.results, my_role: user.role });
    }
    return c.json({ error: 'Not a firm member' }, 404);
  }

  const firm = await c.env.DB.prepare(
    'SELECT id, name, owner_user_id, created_at FROM firms WHERE id = ?'
  ).bind(user.firm_id).first();
  if (!firm) return c.json({ error: 'Firm not found' }, 404);

  let clients;
  if (user.firm_role === 'admin') {
    // Firm clients + sub-accounts linked via parent_user_id
    clients = await c.env.DB.prepare(
      `SELECT fc.id, fc.client_user_id, fc.display_name, fc.status, u.company_name, u.name as user_name, u.email
       FROM firm_clients fc JOIN users u ON u.id = fc.client_user_id
       WHERE fc.firm_id = ?
       UNION ALL
       SELECT u2.id, u2.id as client_user_id, u2.company_name as display_name, u2.status, u2.company_name, u2.name as user_name, u2.email
       FROM users u2 WHERE u2.parent_user_id = ? AND u2.status = 'active'
       ORDER BY display_name`
    ).bind(user.firm_id, user.id).all();
  } else {
    clients = await c.env.DB.prepare(
      `SELECT fc.id, fc.client_user_id, fc.display_name, fc.status, u.company_name, u.name as user_name, u.email
       FROM firm_clients fc
       JOIN firm_client_assignments fca ON fca.firm_client_id = fc.id
       JOIN firm_members fm ON fm.id = fca.firm_member_id
       JOIN users u ON u.id = fc.client_user_id
       WHERE fm.user_id = ? AND fm.firm_id = ? AND fc.status = 'active' AND fm.is_active = 1
       ORDER BY fc.created_at DESC`
    ).bind(user.id, user.firm_id).all();
  }

  return c.json({ firm, clients: clients.results, my_role: user.firm_role });
});

// GET /api/firms/my-clients ??list of accessible client IDs (lightweight)
firms.get('/my-clients', async (c) => {
  const user = c.get('user');

  // Standalone supervisor/accountant/admin ??show sub-accounts linked via parent_user_id
  if (!user.firm_id) {
    if (['admin', 'supervisor', 'accountant'].includes(user.role)) {
      const rows = await c.env.DB.prepare(
        `SELECT id, id as client_user_id, company_name as display_name, status
         FROM users WHERE parent_user_id = ? AND status = 'active'
         ORDER BY created_at DESC`
      ).bind(user.id).all();
      return c.json({ data: rows.results });
    }
    return c.json({ data: [] });
  }

  let rows;
  if (user.firm_role === 'admin') {
    // Firm clients + sub-accounts linked via parent_user_id
    rows = await c.env.DB.prepare(
      `SELECT id, client_user_id, display_name, status FROM firm_clients WHERE firm_id = ? AND status = ?
       UNION ALL
       SELECT id, id as client_user_id, company_name as display_name, status FROM users WHERE parent_user_id = ? AND status = ?
       ORDER BY display_name`
    ).bind(user.firm_id, 'active', user.id, 'active').all();
  } else {
    rows = await c.env.DB.prepare(
      `SELECT fc.id, fc.client_user_id, fc.display_name, fc.status
       FROM firm_clients fc
       JOIN firm_client_assignments fca ON fca.firm_client_id = fc.id
       JOIN firm_members fm ON fm.id = fca.firm_member_id
       WHERE fm.user_id = ? AND fm.firm_id = ? AND fc.status = ? AND fm.is_active = 1
       ORDER BY fc.created_at DESC`
    ).bind(user.id, user.firm_id, 'active').all();
  }

  return c.json({ data: rows.results });
});

// GET /api/firms/:id/members ??list staff members (firm admin only)
firms.get('/:id/members', async (c) => {
  const user = c.get('user');
  if (!user.firm_id || user.firm_id !== c.req.param('id')) return c.json({ error: 'Access denied' }, 403);

  const rows = await c.env.DB.prepare(
    `SELECT fm.id, fm.user_id, fm.role, fm.is_active, fm.created_at, u.email, u.name
     FROM firm_members fm JOIN users u ON u.id = fm.user_id
     WHERE fm.firm_id = ? ORDER BY fm.created_at DESC`
  ).bind(user.firm_id).all();

  return c.json({ data: rows.results });
});

// POST /api/firms/:id/members ??add staff member
firms.post('/:id/members', async (c) => {
  const user = c.get('user');
  if (!user.firm_id || user.firm_id !== c.req.param('id') || user.firm_role !== 'admin') {
    return c.json({ error: 'Access denied' }, 403);
  }

  const body = await c.req.json();
  const { email, role, password, name } = body as { email: string; role?: string; password?: string; name?: string };
  if (!email) return c.json({ error: 'email required' }, 400);

  // Find or create user
  let memberUser = await c.env.DB.prepare(
    'SELECT id, email, name FROM users WHERE email = ?'
  ).bind(email).first<{ id: string; email: string; name: string }>();
  let createdPassword: string | null = null;

  if (!memberUser) {
    const id = `u-${uuidv4().slice(0, 8)}`;
    createdPassword = password || uuidv4().slice(0, 12);
    const passwordHash = await hash(createdPassword, 10);
    const displayName = name || email.split('@')[0];
    await c.env.DB.prepare(
      'INSERT INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)'
    ).bind(id, email, passwordHash, displayName, 'user').run();
    memberUser = { id, email, name: displayName };
  } else if (password) {
    // Update password for existing user
    const passwordHash = await hash(password, 10);
    await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(passwordHash, memberUser.id).run();
    createdPassword = password;
  }

  // Check if already a member
  const existing = await c.env.DB.prepare(
    'SELECT id FROM firm_members WHERE firm_id = ? AND user_id = ?'
  ).bind(user.firm_id, memberUser.id).first();
  if (existing) return c.json({ error: 'Already a member of this firm' }, 409);

  const memberId = `fm-${uuidv4().slice(0, 8)}`;
  await c.env.DB.prepare(
    'INSERT INTO firm_members (id, firm_id, user_id, role) VALUES (?, ?, ?, ?)'
  ).bind(memberId, user.firm_id, memberUser.id, role || 'staff').run();

  return c.json({ id: memberId, user_id: memberUser.id, email: memberUser.email, name: memberUser.name, role: role || 'staff', ...(createdPassword ? { password: createdPassword } : {}) }, 201);
});

// DELETE /api/firms/:id/members/:mid ??permanently delete staff member and user account
firms.delete('/:id/members/:mid', async (c) => {
  const user = c.get('user');
  if (!user.firm_id || user.firm_id !== c.req.param('id') || user.firm_role !== 'admin') {
    return c.json({ error: 'Access denied' }, 403);
  }
  // Get user_id before deleting
  const member = await c.env.DB.prepare(
    'SELECT user_id FROM firm_members WHERE id = ? AND firm_id = ?'
  ).bind(c.req.param('mid'), user.firm_id).first<{ user_id: string }>();
  if (!member) return c.json({ error: 'Member not found' }, 404);
  // Don't allow deleting yourself
  if (member.user_id === user.id) return c.json({ error: 'Cannot delete yourself' }, 400);
  // Delete from firm_members
  await c.env.DB.prepare('DELETE FROM firm_members WHERE id = ? AND firm_id = ?')
    .bind(c.req.param('mid'), user.firm_id).run();
  // Delete assignments
  await c.env.DB.prepare('DELETE FROM firm_client_assignments WHERE firm_member_id = ?')
    .bind(c.req.param('mid')).run();
  // Delete user account
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(member.user_id).run();
  return c.json({ success: true, deleted_user_id: member.user_id });
});

// PATCH /api/firms/:id/members/:mid ??toggle active/inactive or update role
firms.patch('/:id/members/:mid', async (c) => {
  const user = c.get('user');
  if (!user.firm_id || user.firm_id !== c.req.param('id') || user.firm_role !== 'admin') {
    return c.json({ error: 'Access denied' }, 403);
  }
  const body = await c.req.json();
  const sets: string[] = [];
  const params: any[] = [];
  if (body.is_active !== undefined) { sets.push('is_active = ?'); params.push(body.is_active ? 1 : 0); }
  if (body.role) { sets.push('role = ?'); params.push(body.role); }
  if (body.name) {
    const member = await c.env.DB.prepare('SELECT user_id FROM firm_members WHERE id = ? AND firm_id = ?')
      .bind(c.req.param('mid'), user.firm_id).first<{ user_id: string }>();
    if (member) await c.env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(body.name, member.user_id).run();
  }
  if (sets.length === 0 && !body.name) return c.json({ error: 'No fields to update' }, 400);
  if (sets.length > 0) {
    params.push(c.req.param('mid'), user.firm_id);
    await c.env.DB.prepare(`UPDATE firm_members SET ${sets.join(', ')} WHERE id = ? AND firm_id = ?`).bind(...params).run();
  }
  return c.json({ success: true });
});

// PATCH /api/firms/:id/members/:mid/password ??change login password
firms.patch('/:id/members/:mid/password', async (c) => {
  const user = c.get('user');
  if (!user.firm_id || user.firm_id !== c.req.param('id') || user.firm_role !== 'admin') {
    return c.json({ error: 'Access denied' }, 403);
  }
  const body = await c.req.json();
  const { password } = body;
  if (!password || password.length < 4) return c.json({ error: 'Password must be at least 4 characters' }, 400);
  // Get the user_id from firm_members
  const member = await c.env.DB.prepare('SELECT user_id FROM firm_members WHERE id = ? AND firm_id = ?')
    .bind(c.req.param('mid'), user.firm_id).first<{ user_id: string }>();
  if (!member) return c.json({ error: 'Member not found' }, 404);
  const pwHash = await hash(password, 10);
  await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(pwHash, member.user_id).run();
  return c.json({ success: true });
});

// GET /api/firms/:id/clients ??list clients (firm admin only)
firms.get('/:id/clients', async (c) => {
  const user = c.get('user');
  if (!user.firm_id || user.firm_id !== c.req.param('id')) return c.json({ error: 'Access denied' }, 403);

  const rows = await c.env.DB.prepare(
    `SELECT fc.id, fc.client_user_id, fc.display_name, fc.status, fc.created_at,
            u.company_name, u.name as user_name, u.email
     FROM firm_clients fc JOIN users u ON u.id = fc.client_user_id
     WHERE fc.firm_id = ? ORDER BY fc.created_at DESC`
  ).bind(user.firm_id).all();

  return c.json({ data: rows.results });
});

// POST /api/firms/my/clients ??add client for current firm user (or standalone supervisor/accountant)
firms.post('/my/clients', async (c) => {
  try {
  const user = c.get('user');
  const canManage = user.firm_role === 'admin' || ['admin', 'supervisor', 'accountant'].includes(user.role);
  if (!canManage) {
    return c.json({ error: 'Access denied. Requires admin, supervisor, or accountant role.' }, 403);
  }
  const body = await c.req.json();
  const { company_name, email, display_name, contact_name, initial_password, industry, fy_start, fy_end,
          coa_mode, coa_industry, custom_accounts, removed_codes } = body as any;
  if (!company_name || !email) return c.json({ error: 'company_name and email required' }, 400);

  const clientUserId = `u-${uuidv4().slice(0, 8)}`;
  const pw = (initial_password && initial_password.length >= 6) ? initial_password : uuidv4().slice(0, 12);
  const passwordHash = await hash(pw, 10);
  const name = contact_name || company_name;

  // Link to parent (firm admin or standalone supervisor)
  const parentUserId = user.firm_id ? user.id : user.id;
  const isFirmContext = !!user.firm_id;

  // Supervisor accounts always get higher tier ??tier is per-user, not per-company
  await c.env.DB.prepare(
    `INSERT INTO users (id, email, password_hash, name, company_name, role, permission_tier, parent_user_id)
     VALUES (?, ?, ?, ?, ?, 'supervisor', 'higher', ?)`
  ).bind(clientUserId, email, passwordHash, name, company_name, isFirmContext ? null : parentUserId).run();

  await c.env.DB.prepare(
    `INSERT INTO company_settings (user_id, name, legal_name, industry, fiscal_year_start, fiscal_year_end)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(clientUserId, company_name, company_name, industry || 'general', fy_start || null, fy_end || null).run();

  let firmClientId: string | null = null;
  if (isFirmContext && user.firm_id) {
    firmClientId = `fc-${uuidv4().slice(0, 8)}`;
    await c.env.DB.prepare(
      'INSERT INTO firm_clients (id, firm_id, client_user_id, display_name) VALUES (?, ?, ?, ?)'
    ).bind(firmClientId, user.firm_id, clientUserId, display_name || company_name).run();
  }

  // Seed compliance + COA
	  await seedClientData(c, clientUserId, user.id, { industry: coa_industry || industry || "general", coaMode: coa_mode === "manual" ? "manual" : "industry", customAccounts: custom_accounts || [], removedCodes: removed_codes || [] });

  return c.json({
    id: firmClientId || clientUserId, client_user_id: clientUserId, user_id: clientUserId,
    company_name, email, password: pw, display_name: display_name || null,
  }, 201);
  } catch (e: any) {
    console.error('POST /firms/my/clients error:', e?.message, e?.stack);
    return c.json({ error: e?.message || 'Internal error' }, 500);
  }
});

// POST /api/firms/:id/clients ??add client (creates user + company_settings + firm_clients)
firms.post('/:id/clients', async (c) => {
  const user = c.get('user');
  const isFirmAdmin = user.firm_id && user.firm_id === c.req.param('id') && user.firm_role === 'admin';
  const isSystemManager = ['admin', 'supervisor', 'accountant'].includes(user.role);
  if (!isFirmAdmin && !isSystemManager) {
    return c.json({ error: 'Access denied' }, 403);
  }
  const body = await c.req.json();
  const { company_name, email, display_name, contact_name, initial_password, industry, fy_start, fy_end,
          coa_mode, coa_industry, custom_accounts, removed_codes } = body as any;
  if (!company_name || !email) return c.json({ error: 'company_name and email required' }, 400);

  const clientUserId = `u-${uuidv4().slice(0, 8)}`;
  const pw = (initial_password && initial_password.length >= 6) ? initial_password : uuidv4().slice(0, 12);
  const passwordHash = await hash(pw, 10);
  const name = contact_name || company_name;

  // Supervisor accounts always get higher tier ??tier is per-user, not per-company
  await c.env.DB.prepare(
    `INSERT INTO users (id, email, password_hash, name, company_name, role, permission_tier)
     VALUES (?, ?, ?, ?, ?, 'supervisor', 'higher')`
  ).bind(clientUserId, email, passwordHash, name, company_name).run();

  await c.env.DB.prepare(
    `INSERT INTO company_settings (user_id, name, legal_name, industry, fiscal_year_start, fiscal_year_end)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(clientUserId, company_name, company_name, industry || 'general', fy_start || null, fy_end || null).run();

  const firmClientId = `fc-${uuidv4().slice(0, 8)}`;
  await c.env.DB.prepare(
    'INSERT INTO firm_clients (id, firm_id, client_user_id, display_name) VALUES (?, ?, ?, ?)'
  ).bind(firmClientId, user.firm_id, clientUserId, display_name || null).run();

	  await seedClientData(c, clientUserId, user.id, { industry: coa_industry || industry || "general", coaMode: coa_mode === "manual" ? "manual" : "industry", customAccounts: custom_accounts || [], removedCodes: removed_codes || [] });

  return c.json({
    id: firmClientId, client_user_id: clientUserId, user_id: clientUserId,
    company_name, email, password: pw, display_name: display_name || null,
  }, 201);
});

async function seedClientData(c: any, clientUserId: string, adminUserId: string,
  opts?: { industry?: string; coaMode?: 'industry' | 'manual'; customAccounts?: CoaTemplateAccount[]; removedCodes?: string[]; }) {
  // Seed compliance templates ??try batch, fall back to sequential
  const templates = await c.env.DB.prepare('SELECT id FROM compliance_templates WHERE is_required = 1').all();
  if (templates.results.length > 0) {
    try {
      const stmts = (templates.results as any[]).map((t: any) =>
        c.env.DB.prepare(
          'INSERT OR IGNORE INTO member_compliance (id, user_id, template_id, status) VALUES (?, ?, ?, ?)'
        ).bind(`mc-${uuidv4().slice(0, 8)}`, clientUserId, t.id, 'pending')
      );
      if (typeof c.env.DB.batch === 'function') {
        await c.env.DB.batch(stmts);
      } else {
        for (const s of stmts) await s.run();
      }
    } catch (e: any) {
      console.error('seedClientData compliance batch failed, falling back:', e?.message);
      // Fall back to sequential if batch fails
      for (const t of templates.results as any[]) {
        await c.env.DB.prepare(
          'INSERT OR IGNORE INTO member_compliance (id, user_id, template_id, status) VALUES (?, ?, ?, ?)'
        ).bind(`mc-${uuidv4().slice(0, 8)}`, clientUserId, t.id, 'pending').run();
      }
    }
  }

  // Seed COA accounts — use industry-aware template or fall back to u-hayson
  const coaIndustry = opts?.industry || 'general';
  const coaMode = opts?.coaMode || 'industry';
  const customAccounts = opts?.customAccounts || [];
  const removedCodes = new Set(opts?.removedCodes || []);

  let accounts: any[];
  if (opts?.coaMode) {
    // New behaviour: use coa-templates module
    accounts = getCoaTemplate(coaIndustry, coaMode);
    if (customAccounts.length > 0) {
      accounts = mergeCustomAccounts(accounts, customAccounts);
    }
    // Filter out removed codes
    if (removedCodes.size > 0) {
      accounts = accounts.filter((a: any) => !removedCodes.has(a.account_code));
    }
  } else {
    // Backward compat: copy from u-hayson (no coa_mode sent)
    const canonicalAccounts = await c.env.DB.prepare(
      "SELECT account_code, account_name, account_type, parent_code, opening_balance FROM accounts WHERE user_id = 'u-hayson'"
    ).all();
    const sourceAccounts: any[] = canonicalAccounts.results.length > 0 ? canonicalAccounts.results
      : (await c.env.DB.prepare(
        'SELECT account_code, account_name, account_type, parent_code, opening_balance FROM accounts WHERE user_id = ?'
      ).bind(adminUserId).all()).results;
    accounts = sourceAccounts.map((a: any) => ({
      account_code: a.account_code,
      account_name: a.account_name,
      account_type: a.account_type,
      parent_code: a.parent_code || null,
      opening_balance: a.opening_balance || 0,
    }));
  }

  if (accounts.length > 0) {
    const inserts = accounts.map((a: any) =>
      c.env.DB.prepare(
        'INSERT OR IGNORE INTO accounts (id, user_id, account_code, account_name, account_type, parent_code, opening_balance) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(`acc-${uuidv4().slice(0, 8)}`, clientUserId, a.account_code, a.account_name, a.account_type, a.parent_code || null, a.opening_balance || 0)
    );
    try {
      if (typeof c.env.DB.batch === 'function') {
        const CHUNK = 100;
        for (let i = 0; i < inserts.length; i += CHUNK) {
          await c.env.DB.batch(inserts.slice(i, i + CHUNK));
        }
      } else {
        for (const s of inserts) await s.run();
      }
    } catch (e: any) {
      console.error('seedClientData COA batch failed, falling back:', e?.message);
      // Fall back to sequential
      for (const s of inserts) await s.run();
    }
  }
}

// PATCH /api/firms/:id/clients/:cid ??update client (archive/restore)
firms.patch('/:id/clients/:cid', async (c) => {
  const user = c.get('user');
  if (!user.firm_id || user.firm_id !== c.req.param('id') || user.firm_role !== 'admin') {
    return c.json({ error: 'Access denied' }, 403);
  }

  const body = await c.req.json();
  const { status, display_name } = body as { status?: string; display_name?: string };

  const sets: string[] = [];
  const params: any[] = [];
  if (status) { sets.push('status = ?'); params.push(status); }
  if (display_name !== undefined) { sets.push('display_name = ?'); params.push(display_name); }
  if (sets.length === 0) return c.json({ error: 'No fields to update' }, 400);

  params.push(c.req.param('cid'), user.firm_id);
  await c.env.DB.prepare(
    `UPDATE firm_clients SET ${sets.join(', ')} WHERE id = ? AND firm_id = ?`
  ).bind(...params).run();

  return c.json({ success: true });
});

// GET /api/firms/:id/assignments ??list all staff-to-client assignments
firms.get('/:id/assignments', async (c) => {
  const user = c.get('user');
  if (!user.firm_id || user.firm_id !== c.req.param('id') || user.firm_role !== 'admin') {
    return c.json({ error: 'Access denied' }, 403);
  }

  const rows = await c.env.DB.prepare(
    `SELECT fca.id, fca.firm_member_id, fca.firm_client_id, fm.user_id as staff_user_id, u.email as staff_email, u.name as staff_name
     FROM firm_client_assignments fca
     JOIN firm_members fm ON fm.id = fca.firm_member_id
     JOIN users u ON u.id = fm.user_id
     WHERE fm.firm_id = ?`
  ).bind(user.firm_id).all();

  return c.json({ data: rows.results });
});

// POST /api/firms/:id/assignments ??bulk update assignments for a member
firms.post('/:id/assignments', async (c) => {
  const user = c.get('user');
  if (!user.firm_id || user.firm_id !== c.req.param('id') || user.firm_role !== 'admin') {
    return c.json({ error: 'Access denied' }, 403);
  }

  const body = await c.req.json();
  const { firm_member_id, firm_client_ids } = body as { firm_member_id: string; firm_client_ids: string[] };

  if (!firm_member_id || !Array.isArray(firm_client_ids)) {
    return c.json({ error: 'firm_member_id and firm_client_ids[] required' }, 400);
  }

  // Delete existing assignments for this member
  await c.env.DB.prepare(
    'DELETE FROM firm_client_assignments WHERE firm_member_id = ?'
  ).bind(firm_member_id).run();

  // Insert new assignments
  for (const cid of firm_client_ids) {
    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO firm_client_assignments (id, firm_member_id, firm_client_id) VALUES (?, ?, ?)'
    ).bind(`fca-${uuidv4().slice(0, 8)}`, firm_member_id, cid).run();
  }

  return c.json({ success: true, assigned: firm_client_ids.length });
});

export { firms as firmRoutes };
