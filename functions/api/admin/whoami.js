// GET /api/admin/whoami
//
// 200 + { ok, email?, via, site_name, site_url } if the request is
//   authenticated (either a valid session cookie or the bearer token).
// 401 if not authenticated.
// 503 + { error: 'config_incomplete', missing } if SITE_NAME / SITE_URL
//   / ADMIN_TOKEN aren't all set.
//
// The admin UI hits this on first load to decide whether to show the
// dashboard, the login form, or a "finish setup first" message.
import { json } from '../../_lib/util.js';
import { requireAdminAsync } from '../../_lib/auth.js';
import { missingConfig, configError } from '../../_lib/config.js';

import { getSiteIdentity } from '../../_lib/site_identity.js';

export const onRequestGet = async ({ request, env }) => {
  const missing = await missingConfig(env);
  if (missing.length) {
    // Tell the UI whether this is a fresh deploy that just needs the
    // setup screen, or a real misconfiguration. The setup screen is
    // shown when NO users exist yet — at that point /admin is safe to
    // expose (nobody to authenticate against).
    let usersCount = 0;
    if (env?.DB) {
      try {
        const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first();
        usersCount = r?.n || 0;
      } catch { /* table may not exist yet — treat as 0 */ }
    }
    return json(503, { ...configError(missing), needs_setup: usersCount === 0 });
  }
  const auth = await requireAdminAsync(env, request);
  if (!auth) return json(401, { error: 'unauthorized' });
  const identity = await getSiteIdentity(env);
  return json(200, {
    ok: true,
    email: auth.email || null,
    via: auth.via,
    site_name: identity.name,
    site_url: identity.url,
  });
};
