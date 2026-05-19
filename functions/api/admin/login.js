// POST /api/admin/login
//   Body: { email, password }
//   On success → 200 + Set-Cookie: ps_session=<id>.<hmac>; HttpOnly; ...
//   On failure → 401, with rate-limit tracked per email+IP.
//
// On the 5th consecutive failure (per email+IP), further attempts are
// blocked for 1 hour. The bearer ADMIN_TOKEN keeps working as a
// recovery credential.

import { json, nowSec } from '../../_lib/util.js';
import {
  verifyPassword,
  newSessionId,
  signSession,
  buildSessionCookie,
  sessionExpirySec,
} from '../../_lib/passwords.js';
import { getAdminToken } from '../../_lib/admin_token.js';

const MAX_FAILS = 5;
const LOCKOUT_SEC = 60 * 60; // 1 hour

function clientIp(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

export const onRequestPost = async ({ env, request }) => {
  if (!env?.DB) return json(500, { error: 'no_db' });
  if (!env?.ADMIN_TOKEN) {
    return json(503, { error: 'config_incomplete', detail: 'ADMIN_TOKEN secret required (used as the session-signing key).' });
  }

  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }

  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');
  if (!email || !password) return json(400, { error: 'missing_fields' });

  const ip = clientIp(request);
  const rlKey = `${email}|${ip}`;
  const now = nowSec();

  // Check the rate-limit gate first. If locked, return without touching
  // the user table — saves a DB round trip and avoids leaking signal.
  const rl = await env.DB.prepare(
    `SELECT failures, locked_until FROM login_attempts WHERE key = ? LIMIT 1`
  ).bind(rlKey).first().catch(() => null);
  if (rl?.locked_until && rl.locked_until > now) {
    return json(429, {
      error: 'locked',
      retry_after_sec: rl.locked_until - now,
    });
  }

  const user = await env.DB.prepare(
    `SELECT id, email, password_hash, password_salt FROM users WHERE email = ? LIMIT 1`
  ).bind(email).first().catch(() => null);

  const ok = user && await verifyPassword(password, user.password_hash, user.password_salt);

  if (!ok) {
    // Increment the fail counter; lock at MAX_FAILS.
    const fails = (rl?.failures || 0) + 1;
    const lockedUntil = fails >= MAX_FAILS ? now + LOCKOUT_SEC : null;
    await env.DB.prepare(
      `INSERT INTO login_attempts (key, failures, locked_until, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         failures = excluded.failures,
         locked_until = excluded.locked_until,
         updated_at = excluded.updated_at`
    ).bind(rlKey, fails, lockedUntil, now).run().catch(() => null);
    return json(401, { error: 'invalid_credentials' });
  }

  // Success: clear the fail counter, mint a session, set the cookie.
  await env.DB.prepare(
    `DELETE FROM login_attempts WHERE key = ?`
  ).bind(rlKey).run().catch(() => null);

  const sessionId = newSessionId();
  const expires = sessionExpirySec();
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(
    sessionId, user.id, now, expires,
    (request.headers.get('user-agent') || '').slice(0, 400),
  ).run();
  await env.DB.prepare(
    `UPDATE users SET last_login_at = ? WHERE id = ?`
  ).bind(now, user.id).run().catch(() => null);

  const token = await signSession(sessionId, await getAdminToken(env));
  const maxAge = expires - now;
  return new Response(JSON.stringify({ ok: true, email: user.email }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': buildSessionCookie(token, maxAge),
      'cache-control': 'no-store',
    },
  });
};
