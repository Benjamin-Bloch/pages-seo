// GET /api/update/github/callback?code=…&state=<nonce>:<flow>:<userState>
//
// GitHub redirects here after the user approves our OAuth request.
// We exchange `code` for an access token, verify the nonce against
// our cookie, encrypt the token into an HttpOnly cookie scoped to
// /api, and redirect back to /<flow>?gh=connected&state=… so the
// SPA can re-render and continue.
//
// flow ∈ { 'install', 'update' } — chosen by /api/update/github/start
// when the SPA called it. The OAuth App only allows one callback URL,
// so we route post-auth into either /install or /update based on it.

import { setOAuthCookie } from '../../../_lib/oauth_cookie.js';

const VALID_FLOWS = new Set(['install', 'update']);

function readCookie(req, name) {
  const hdr = req.headers.get('cookie') || '';
  for (const c of hdr.split(/;\s*/)) {
    const eq = c.indexOf('=');
    if (eq < 0) continue;
    if (c.slice(0, eq).trim() === name) return c.slice(eq + 1).trim();
  }
  return null;
}

function fail(url, flow, code, msg) {
  // Redirect to /<flow> with the error in a query param so the SPA
  // can render it without a JSON dead-end.
  const dest = '/' + (VALID_FLOWS.has(flow) ? flow : 'update');
  const u = new URL(dest, url);
  u.searchParams.set('gh', 'error');
  u.searchParams.set('error', code);
  if (msg) u.searchParams.set('detail', msg.slice(0, 200));
  return Response.redirect(u.toString(), 302);
}

export const onRequestGet = async ({ env, request }) => {
  const url = new URL(request.url);
  if (!env?.GITHUB_OAUTH_CLIENT_ID || !env?.GITHUB_OAUTH_CLIENT_SECRET) {
    return fail(url, 'update', 'oauth_not_configured');
  }
  const code = String(url.searchParams.get('code') || '');
  const rawState = String(url.searchParams.get('state') || '');
  if (!code)     return fail(url, 'update', 'missing_code');
  if (!rawState) return fail(url, 'update', 'missing_state');

  // State shape is now `<nonce>:<flow>:<userState>`. Old shape was
  // `<nonce>:<userState>` (no flow); accept both for backwards
  // compatibility (default to 'update' when only one colon).
  const parts = rawState.split(':');
  let nonce, flow, userState;
  if (parts.length >= 3 && VALID_FLOWS.has(parts[1])) {
    nonce = parts[0];
    flow = parts[1];
    userState = parts.slice(2).join(':');
  } else {
    nonce = parts[0];
    flow = 'update';
    userState = parts.slice(1).join(':');
  }

  if (!/^[0-9a-f]{32}$/.test(nonce)) return fail(url, flow, 'bad_nonce');
  const expected = readCookie(request, 'ps_gh_nonce');
  if (!expected || expected !== nonce) {
    return fail(url, flow, 'nonce_mismatch', 'Cookie nonce missing or did not match. Try Connect GitHub again.');
  }

  // Exchange the code for an access token.
  let token = '';
  try {
    const r = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: env.GITHUB_OAUTH_CLIENT_ID,
        client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
        code,
        redirect_uri: `${url.origin}/api/update/github/callback`,
      }),
    });
    const d = await r.json();
    if (d?.error) return fail(url, flow, d.error, d.error_description);
    token = String(d?.access_token || '');
    if (!token) return fail(url, flow, 'no_token');
  } catch (e) {
    return fail(url, flow, 'exchange_failed', String(e?.message || e));
  }

  // Get the user's login so we can show "Connected as @x" without
  // an extra GitHub call later.
  let login = '';
  try {
    const r = await fetch('https://api.github.com/user', {
      headers: { Authorization: 'token ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'pages-seo-update' },
    });
    if (r.ok) {
      const d = await r.json();
      login = String(d?.login || '');
    }
  } catch { /* non-fatal */ }

  const cookie = await setOAuthCookie(env, { token, login, ts: Math.floor(Date.now() / 1000) });
  const dest = new URL('/' + flow, url);
  dest.searchParams.set('gh', 'connected');
  if (userState) dest.searchParams.set('state', userState);

  return new Response(null, {
    status: 302,
    headers: new Headers([
      ['Location', dest.toString()],
      // Clear the nonce cookie and set the token cookie. The nonce
      // cookie was set at Path=/api/update; clear it with the same
      // path so the browser actually expires it.
      ['Set-Cookie', 'ps_gh_nonce=; Max-Age=0; Path=/api/update; HttpOnly; Secure; SameSite=Lax'],
      ['Set-Cookie', cookie],
    ]),
  });
};
