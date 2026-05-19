// POST /api/admin/logout
//   Clears the session cookie and deletes the matching row in sessions.
//   Returns 200 either way — logging out is always "successful" from
//   the caller's perspective.
import {
  SESSION_COOKIE, readCookie, verifySessionToken, buildSessionCookieClear,
} from '../../_lib/passwords.js';
import { getAdminToken } from '../../_lib/admin_token.js';

export const onRequestPost = async ({ env, request }) => {
  const raw = readCookie(request, SESSION_COOKIE);
  const token = env?.DB ? await getAdminToken(env) : '';
  if (raw && token) {
    const sessionId = await verifySessionToken(raw, token);
    if (sessionId) {
      await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run().catch(() => null);
    }
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': buildSessionCookieClear(),
      'cache-control': 'no-store',
    },
  });
};
