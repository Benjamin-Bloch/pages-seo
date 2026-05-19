// Required-config gate. Every admin endpoint calls adminGate (which
// in turn calls missingConfig) so we fail loudly with a clear error
// when SITE_NAME / SITE_URL aren't set anywhere.
//
// Both fields can live as Pages secrets (CLI install path) or as D1
// settings rows (one-click install path, written by /api/setup).
// ADMIN_TOKEN follows the same pattern via _lib/admin_token.js.

import { getSiteIdentity } from './site_identity.js';
import { getAdminToken } from './admin_token.js';

export async function missingConfig(env) {
  const out = [];
  const identity = await getSiteIdentity(env);
  if (!identity.name) out.push('SITE_NAME');
  if (!identity.url)  out.push('SITE_URL');
  const token = await getAdminToken(env);
  if (!token) out.push('ADMIN_TOKEN');
  return out;
}

export function configError(missing) {
  return {
    error: 'config_incomplete',
    missing,
    hint: 'Open /admin to finish the one-click setup, or push the values as Pages secrets via `wrangler pages secret put`.',
  };
}
