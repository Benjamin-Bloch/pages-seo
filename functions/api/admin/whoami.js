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

export const onRequestGet = async ({ request, env }) => {
  const missing = missingConfig(env);
  if (missing.length) return json(503, configError(missing));
  const auth = await requireAdminAsync(env, request);
  if (!auth) return json(401, { error: 'unauthorized' });
  return json(200, {
    ok: true,
    email: auth.email || null,
    via: auth.via,
    site_name: env.SITE_NAME,
    site_url: env.SITE_URL,
  });
};
