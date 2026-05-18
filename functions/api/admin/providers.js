// Lists which AI providers are configured (have a key/binding) so the
// admin UI can populate a "preferred provider" dropdown.
import { json } from '../../_lib/util.js';
import { requireAdmin } from '../../_lib/auth.js';
import { listProviders } from '../../_lib/ai.js';

export const onRequestGet = async ({ env, request }) => {
  if (!requireAdmin(env, request)) return json(401, { error: 'unauthorized' });
  return json(200, listProviders(env));
};
