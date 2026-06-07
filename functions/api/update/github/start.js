// GET /api/update/github/start?state=<base64-json>&flow=<install|update>
//
// Redirects the operator to GitHub's OAuth authorize endpoint with
// our Client ID + `public_repo` scope. `state` is an opaque blob the
// browser populated; we pass it through unmodified, prefix it with a
// nonce + flow tag, and verify on callback to defeat CSRF.
//
// `flow` defaults to 'update' for backwards compatibility. The
// installer at /install calls this with flow=install so the
// callback knows to redirect back to /install rather than /update.
// We can't register a separate callback URL on the GitHub OAuth
// App (GitHub only allows one callback per app), so the callback is
// shared and the flow tag in state tells it where to send the user.

import { json } from '../../../_lib/util.js';

const VALID_FLOWS = new Set(['install', 'update']);

export const onRequestGet = async ({ env, request }) => {
  if (!env?.GITHUB_OAUTH_CLIENT_ID) {
    return json(503, {
      error: 'oauth_not_configured',
      detail: 'GITHUB_OAUTH_CLIENT_ID is not set on this Pages project.',
    });
  }
  const url = new URL(request.url);
  const state = String(url.searchParams.get('state') || '').slice(0, 4096);
  const flowRaw = String(url.searchParams.get('flow') || 'update');
  const flow = VALID_FLOWS.has(flowRaw) ? flowRaw : 'update';

  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = Array.from(nonceBytes).map((b) => b.toString(16).padStart(2, '0')).join('');

  // State now carries: <nonce>:<flow>:<userState>
  // Callback splits on the first two colons so userState can contain
  // colons or other base64 characters freely.
  const stateOut = `${nonce}:${flow}:${state}`;

  const params = new URLSearchParams({
    client_id: env.GITHUB_OAUTH_CLIENT_ID,
    redirect_uri: `${url.origin}/api/update/github/callback`,
    // public_repo  — create the fork, read repo metadata
    // read:user    — list the user's GitHub App installations so we can
    //                add the new fork to the Cloudflare app's repo list
    //                without sending them through the manual UI flow
    // user:email   — fetch the user's primary verified email so the
    //                site's first-run setup form can prefill it (saves
    //                them typing it on the magic-link screen)
    scope: 'public_repo read:user user:email',
    state: stateOut,
    allow_signup: 'false',
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://github.com/login/oauth/authorize?${params}`,
      // Cookie path stays at /api/update so the callback can read it.
      // /install needs the OAuth state too, but it talks to the
      // callback-issued ps_gh cookie (set at / path) which any
      // route under the site can read.
      'Set-Cookie': `ps_gh_nonce=${nonce}; Max-Age=600; Path=/api/update; HttpOnly; Secure; SameSite=Lax`,
    },
  });
};
