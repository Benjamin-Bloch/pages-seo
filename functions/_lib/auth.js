// Admin auth + required-config gate.
//
// Two credentials accepted in parallel:
//   1. Bearer ADMIN_TOKEN — the original 64-char fallback. Always
//      valid as long as ADMIN_TOKEN is configured. Used by the cron
//      Worker and as a recovery credential if the user accounts table
//      gets wiped.
//   2. Session cookie (ps_session) — created by POST /api/admin/login
//      with an email + password. Verified via HMAC and a row in the
//      sessions table that hasn't expired.
//
// `requireAdmin` returns truthy when either auth path passes.
// `adminGate(env, request)` returns null on success or a 401/503
// Response.

import { json } from './util.js';
import { missingConfig, configError } from './config.js';
import { SESSION_COOKIE, readCookie, verifySessionToken } from './passwords.js';
import { getAdminToken } from './admin_token.js';

async function bearerToken(env, request) {
  const token = await getAdminToken(env);
  if (!token) return false;
  const bearer = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (bearer && bearer[1].trim() === token) return true;
  const hdr = (request.headers.get('X-Admin-Token') || '').trim();
  return !!(hdr && hdr === token);
}

async function sessionAuth(env, request) {
  if (!env?.DB) return null;
  const token = await getAdminToken(env);
  if (!token) return null;
  const raw = readCookie(request, SESSION_COOKIE);
  if (!raw) return null;
  const sessionId = await verifySessionToken(raw, token);
  if (!sessionId) return null;
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT s.id, s.user_id, s.expires_at, u.email
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? LIMIT 1`
  ).bind(sessionId).first().catch(() => null);
  if (!row) return null;
  if (row.expires_at <= now) return null;
  return { sessionId: row.id, userId: row.user_id, email: row.email };
}

// Legacy sync path. The bearer check is now async because it has to
// look up the token from D1 settings when the Pages secret isn't set.
// Existing callers that imported `requireAdmin` get an async version.
export async function requireAdmin(env, request) {
  return (await bearerToken(env, request)) ? { actor: 'admin' } : null;
}

// Async — checks both Bearer AND session cookie.
export async function requireAdminAsync(env, request) {
  if (await bearerToken(env, request)) return { actor: 'admin', via: 'bearer' };
  const sess = await sessionAuth(env, request);
  if (sess) return { actor: 'admin', via: 'session', ...sess };
  return null;
}

// One-call gate for admin endpoints. Returns:
//   - null when the request is authorised AND required config is present
//   - a Response (401 / 503) otherwise.
// Now async — accepts both bearer + cookie. All call sites use it as
// `const gate = await adminGate(...); if (gate) return gate;`.
export async function adminGate(env, request) {
  const missing = await missingConfig(env);
  if (missing.length) return json(503, configError(missing));
  const auth = await requireAdminAsync(env, request);
  if (!auth) return json(401, { error: 'unauthorized' });
  return null;
}
