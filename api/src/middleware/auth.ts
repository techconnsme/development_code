import { verify } from 'jsonwebtoken';
import { AppContext, AppNext, AuthUser, Bindings } from '../types';

export type { AppContext, AppNext };

// Fail-fast if JWT_SECRET is not configured (never fall back to hardcoded secret)
export function getJwtSecret(env: Bindings): string {
  if (!env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is not configured');
  return env.JWT_SECRET;
}

export async function authMiddleware(c: AppContext, next: AppNext) {
  let token: string | undefined;

  // Read from httpOnly cookie first (XSS-safe), then Authorization header
  const cookieHeader = c.req.header('Cookie') || '';
  const cookieMatch = cookieHeader.match(/(?:^|;\s*)token=([^;]+)/);
  if (cookieMatch) {
    token = cookieMatch[1];
  } else {
    const authHeader = c.req.header('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    }
  }

  // Fallback: query param (iframe downloads can't set headers)
  if (!token) {
    token = c.req.query('token') || undefined;
  }

  if (!token) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  try {
    const payload = verify(token, getJwtSecret(c.env)) as AuthUser;
    c.set('user', payload);
    await next();
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
}

export async function adminMiddleware(c: AppContext, next: AppNext) {
  const user = c.get('user');
  if (!user || user.role !== 'admin') {
    return c.json({ error: 'Admin access required' }, 403);
  }
  await next();
}

export async function auditorMiddleware(c: AppContext, next: AppNext) {
  const user = c.get('user');
  if (!user || (user.role !== 'admin' && user.role !== 'auditor')) {
    return c.json({ error: 'Auditor or admin access required' }, 403);
  }
  await next();
}

// Bookkeeper/accountant write access — blocks auditor (read-only) role
export async function bookkeeperMiddleware(c: AppContext, next: AppNext) {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Authentication required' }, 401);
  if (user.role === 'auditor') {
    return c.json({ error: 'Auditor role is read-only. Write operations require bookkeeper or admin access.' }, 403);
  }
  await next();
}

// Higher permission tier required — for hard delete, restore, permanent delete
// Checks user.permission_tier from DB (firm_members.permission_tier for firm staff,
// users.permission_tier for direct SME accounts).
export async function requireHigherTier(c: AppContext): Promise<boolean> {
  const user = c.get('user');
  if (!user) return false;
  // Firm admin is always higher
  if (user.firm_role === 'admin') return true;
  const db = c.env.DB;
  // Firm staff: check firm_members.permission_tier
  if (user.firm_id) {
    try {
      const row = await db.prepare(
        'SELECT permission_tier FROM firm_members WHERE firm_id = ? AND user_id = ? AND is_active = 1'
      ).bind(user.firm_id, user.id).first<{ permission_tier: string }>();
      if (row?.permission_tier === 'higher') return true;
    } catch { /* column may not exist yet */ }
  }
  // Direct user (SME): check users.permission_tier (defaults to 'higher' for solo bosses)
  try {
    const row = await db.prepare(
      'SELECT permission_tier FROM users WHERE id = ?'
    ).bind(user.id).first<{ permission_tier: string }>();
    if (row?.permission_tier === 'higher') return true;
    if (row?.permission_tier == null) return true; // legacy accounts default to higher
  } catch { /* column may not exist yet */ }
  return false;
}

export async function higherTierMiddleware(c: AppContext, next: AppNext) {
  const ok = await requireHigherTier(c);
  if (!ok) return c.json({
    error: 'Higher permission tier required for this action',
    hint: 'Only account owner or boss-level users can delete or restore items. Contact your admin.',
  }, 403);
  await next();
}

// Validates X-Active-Client header for firm staff, sets client_user_id context
export async function firmContextMiddleware(c: AppContext, next: AppNext) {
  const user = c.get('user');
  if (!user?.firm_id) { await next(); return; }

  const activeClientId = c.req.header('X-Active-Client');
  if (!activeClientId) { await next(); return; }

  const db = c.env.DB;

  if (user.firm_role === 'admin') {
    // Check firm_clients first
    const client = await db.prepare(
      'SELECT client_user_id FROM firm_clients WHERE firm_id = ? AND id = ? AND status = ?'
    ).bind(user.firm_id, activeClientId, 'active').first<{ client_user_id: string }>();
    if (client) {
      c.set('client_user_id', client.client_user_id);
    } else {
      // Also check sub-accounts linked via parent_user_id (standalone clients)
      const sub = await db.prepare(
        'SELECT id FROM users WHERE parent_user_id = ? AND id = ? AND status = ?'
      ).bind(user.id, activeClientId, 'active').first<{ id: string }>();
      if (!sub) return c.json({ error: 'Client not found' }, 403);
      c.set('client_user_id', sub.id);
    }
  } else {
    const assignment = await db.prepare(
      `SELECT fc.client_user_id FROM firm_clients fc
       JOIN firm_client_assignments fca ON fca.firm_client_id = fc.id
       JOIN firm_members fm ON fm.id = fca.firm_member_id
       WHERE fm.user_id = ? AND fm.firm_id = ? AND fc.id = ? AND fc.status = ? AND fm.is_active = 1`
    ).bind(user.id, user.firm_id, activeClientId, 'active').first<{ client_user_id: string }>();
    if (!assignment) return c.json({ error: 'Access to this client denied' }, 403);
    c.set('client_user_id', assignment.client_user_id);
  }

  await next();
}
