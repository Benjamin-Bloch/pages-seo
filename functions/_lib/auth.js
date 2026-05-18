// Single-user admin auth + required-config gate.
//
// There's no signup/login flow in pages-seo — it's a self-hosted tool,
// so we use a shared admin bearer token. Pass on every admin request via:
//   Authorization: Bearer <token>
// or
//   X-Admin-Token: <token>
//
// `requireAdmin` returns truthy when both auth and config pass. Callers
// that want a ready-made error Response can use `adminGate(env, request)`
// instead — it returns null on success, or a 401/503 Response.

import { json } from './util.js';
import { missingConfig, configError } from './config.js';

export function requireAdmin(env, request) {
  const token = env?.ADMIN_TOKEN;
  if (!token) return null;
  const bearer = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (bearer && bearer[1].trim() === token) return { actor: 'admin' };
  const hdr = (request.headers.get('X-Admin-Token') || '').trim();
  if (hdr && hdr === token) return { actor: 'admin' };
  return null;
}

// One-call gate for admin endpoints. Returns:
//   - null when the request is authorised AND required config is present
//   - a Response (401 / 503) otherwise — callers can `return` it directly.
export function adminGate(env, request) {
  const missing = missingConfig(env);
  if (missing.length) return json(503, configError(missing));
  if (!requireAdmin(env, request)) return json(401, { error: 'unauthorized' });
  return null;
}
