// GET    /api/admin/users           list users (email + last_login)
// POST   /api/admin/users           { email, password } → create
// PUT    /api/admin/users?id=X      { password } → change password
// DELETE /api/admin/users?id=X      remove account (sessions cascade-deleted)
//
// All gated by adminGate (bearer token OR existing session). To
// bootstrap the very first user, call POST with the bearer
// ADMIN_TOKEN — that's the only path open before any user exists.
import { json, newId, nowSec, audit } from '../../_lib/util.js';
import { adminGate } from '../../_lib/auth.js';
import { hashPassword } from '../../_lib/passwords.js';

const MIN_PW = 8;
const MAX_PW = 256;

function validEmail(s) {
  return typeof s === 'string'
    && s.length > 3 && s.length < 200
    && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
}

export const onRequestGet = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  const r = await env.DB.prepare(
    `SELECT id, email, created_at, last_login_at FROM users ORDER BY created_at ASC`
  ).all();
  return json(200, { ok: true, users: r?.results || [] });
};

export const onRequestPost = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');
  if (!validEmail(email)) return json(400, { error: 'invalid_email' });
  if (password.length < MIN_PW || password.length > MAX_PW) {
    return json(400, { error: 'password_length', min: MIN_PW, max: MAX_PW });
  }
  // Unique-email check (the table has UNIQUE constraint too, but a
  // friendly 409 beats a SQL error).
  const existing = await env.DB.prepare(
    `SELECT id FROM users WHERE email = ? LIMIT 1`
  ).bind(email).first().catch(() => null);
  if (existing) return json(409, { error: 'email_already_exists' });

  let creds;
  try { creds = await hashPassword(password); }
  catch (e) { return json(400, { error: String(e?.message || e) }); }

  const id = newId();
  const t = nowSec();
  await env.DB.prepare(
    `INSERT INTO users (id, email, password_hash, password_salt, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(id, email, creds.hash, creds.salt, t).run();

  audit(env, 'admin', 'user_create', id, { email });
  return json(200, { ok: true, id, email });
};

export const onRequestPut = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  const url = new URL(request.url);
  const id = String(url.searchParams.get('id') || '').trim();
  if (!id) return json(400, { error: 'missing_id' });
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }
  const password = String(body?.password || '');
  if (password.length < MIN_PW || password.length > MAX_PW) {
    return json(400, { error: 'password_length', min: MIN_PW, max: MAX_PW });
  }
  const creds = await hashPassword(password);
  const r = await env.DB.prepare(
    `UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?`
  ).bind(creds.hash, creds.salt, id).run();
  // Invalidate every existing session for this user — a password
  // change should kick all browsers, otherwise the change does nothing
  // to revoke ongoing access.
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run().catch(() => null);
  audit(env, 'admin', 'user_password_change', id, {});
  return json(200, { ok: true, changed: r?.meta?.changes || 0 });
};

export const onRequestDelete = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  const url = new URL(request.url);
  const id = String(url.searchParams.get('id') || '').trim();
  if (!id) return json(400, { error: 'missing_id' });
  // Refuse to delete the last user — otherwise password login is dead.
  const cnt = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  if ((cnt?.n || 0) <= 1) {
    return json(400, { error: 'cannot_delete_last_user', hint: 'Create another user before deleting this one.' });
  }
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run().catch(() => null);
  audit(env, 'admin', 'user_delete', id, {});
  return json(200, { ok: true });
};
