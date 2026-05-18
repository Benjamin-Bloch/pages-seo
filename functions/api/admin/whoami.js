// Returns 200 if the bearer token is valid, 401 otherwise. The admin UI
// uses this to validate the token on initial load before showing the
// dashboard.
import { json } from '../../_lib/util.js';
import { requireAdmin } from '../../_lib/auth.js';

export const onRequestGet = ({ request, env }) => {
  if (!requireAdmin(env, request)) return json(401, { error: 'unauthorized' });
  return json(200, { ok: true });
};
