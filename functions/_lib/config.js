// Required-config gate. Every admin endpoint calls requireConfig(env)
// after requireAdmin(env, request) so we fail loudly with a clear
// message when SITE_NAME / SITE_URL / ADMIN_TOKEN aren't set.
//
// ADMIN_TOKEN is also checked inside requireAdmin, but we re-check it
// here so an operator who somehow bypassed auth still gets a clean
// error rather than a downstream "undefined" crash.

const REQUIRED = ['ADMIN_TOKEN', 'SITE_NAME', 'SITE_URL'];

export function missingConfig(env) {
  return REQUIRED.filter((k) => !env?.[k] || !String(env[k]).trim());
}

export function configError(missing) {
  return {
    error: 'config_incomplete',
    missing,
    hint: 'Set these as Pages secrets, e.g. `wrangler pages secret put SITE_URL --project-name=<your-project>`. The setup scripts do this for you.',
  };
}
