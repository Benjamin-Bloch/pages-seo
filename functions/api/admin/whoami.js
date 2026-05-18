// Returns 200 if the bearer token is valid, 401 otherwise.
// Returns 503 with the list of missing settings if the deployment hasn't
// been finished (SITE_NAME / SITE_URL / ADMIN_TOKEN not all set). The
// admin UI uses this on first load to either show the dashboard, the
// "enter token" gate, or a clear "finish setup first" message.
import { json } from '../../_lib/util.js';
import { requireAdmin } from '../../_lib/auth.js';
import { missingConfig, configError } from '../../_lib/config.js';

export const onRequestGet = ({ request, env }) => {
  const missing = missingConfig(env);
  if (missing.length) return json(503, configError(missing));
  if (!requireAdmin(env, request)) return json(401, { error: 'unauthorized' });
  return json(200, { ok: true, site_name: env.SITE_NAME, site_url: env.SITE_URL });
};
