// GET /api/update/github/start?state=<base64-json>
//
// Redirects the operator to GitHub's OAuth authorize endpoint with
// our Client ID + `public_repo` scope. `state` is an opaque blob the
// browser populated (typically the user's project owner + repo); we
// pass it through unmodified and verify on callback to defeat CSRF.
//
// We don't validate the state contents here — only its size — to
// keep this endpoint a thin redirect.

import { json } from '../../../_lib/util.js';

export const onRequestGet = async ({ env, request }) => {
  if (!env?.GITHUB_OAUTH_CLIENT_ID) {
    return json(503, {
      error: 'oauth_not_configured',
      detail: 'GITHUB_OAUTH_CLIENT_ID is not set on this Pages project.',
    });
  }
  const url = new URL(request.url);
  const state = String(url.searchParams.get('state') || '').slice(0, 4096);

  // We also generate a short anti-CSRF nonce, stash it in a cookie,
  // and require it back on callback. State alone isn't enough because
  // it's user-controllable.
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = Array.from(nonceBytes).map((b) => b.toString(16).padStart(2, '0')).join('');

  const params = new URLSearchParams({
    client_id: env.GITHUB_OAUTH_CLIENT_ID,
    redirect_uri: `${url.origin}/api/update/github/callback`,
    scope: 'public_repo',
    state: `${nonce}:${state}`,
    allow_signup: 'false',
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://github.com/login/oauth/authorize?${params}`,
      'Set-Cookie': `ps_gh_nonce=${nonce}; Max-Age=600; Path=/api/update; HttpOnly; Secure; SameSite=Lax`,
    },
  });
};
