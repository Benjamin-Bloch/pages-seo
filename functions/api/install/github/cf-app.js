// GET /api/install/github/cf-app
//
// Checks whether the authenticated GitHub user has installed the
// "Cloudflare Workers and Pages" GitHub App on their account. We
// hit /user/installations with their OAuth token and look for an
// app whose slug or name matches.
//
// Used by the /install flow to auto-advance from the "authorise
// Cloudflare on your fork" step the moment the user finishes the
// install on GitHub — saves them clicking "Continue".
//
// Returns:
//   { ok: true, installed: bool, installations: [{ app_slug, account, html_url }] }

import { json } from '../../../_lib/util.js';
import { readOAuthCookie } from '../../../_lib/oauth_cookie.js';

const CF_APP_SLUGS = new Set([
  'cloudflare-workers-and-pages',
  'cloudflare-pages',  // legacy app name, just in case
]);

export const onRequestGet = async ({ env, request }) => {
  const session = await readOAuthCookie(env, request);
  if (!session?.token) return json(401, { ok: false, error: 'gh_not_connected' });

  const r = await fetch('https://api.github.com/user/installations?per_page=100', {
    headers: {
      Authorization: 'token ' + session.token,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'pages-seo-install',
    },
  });
  if (!r.ok) {
    return json(502, { ok: false, error: 'github_list_failed', detail: 'HTTP ' + r.status });
  }
  const body = await r.json().catch(() => ({}));
  const installations = (body?.installations || []).map((i) => ({
    app_slug: i.app_slug || '',
    account: i.account?.login || '',
    html_url: i.html_url || '',
  }));
  const installed = installations.some((i) => CF_APP_SLUGS.has(i.app_slug));
  return json(200, { ok: true, installed, installations });
};
