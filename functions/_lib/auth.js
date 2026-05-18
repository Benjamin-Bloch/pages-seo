// Single-user admin auth. There's no signup/login flow in pages-seo —
// it's a self-hosted tool, so we use a shared admin bearer token.
//
// Set with: wrangler pages secret put ADMIN_TOKEN --project-name=<name>
//
// Pass on every admin request via:
//   Authorization: Bearer <token>
// or
//   X-Admin-Token: <token>
//
// The admin UI prompts for the token on first load and stores it in
// localStorage (same machine reuse). Treat the token like a password —
// rotate via `secret put` if it leaks.

export function requireAdmin(env, request) {
  const token = env.ADMIN_TOKEN;
  if (!token) return null;
  const bearer = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (bearer && bearer[1].trim() === token) return { actor: 'admin' };
  const hdr = (request.headers.get('X-Admin-Token') || '').trim();
  if (hdr && hdr === token) return { actor: 'admin' };
  return null;
}
