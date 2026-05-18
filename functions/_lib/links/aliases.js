// Internal link aliases the AI is told about. The prompt mentions these
// by name; the sanitiser expands them at insert time.
//
// Self-hosters: edit DEFAULTS below or override per-deploy via env vars
// (SITE_SIGNUP_URL, SITE_PRICING_URL, etc.).
//
// Keys are lower-cased on lookup, so case in the markdown doesn't matter.

const DEFAULTS = {
  // Marketing routes — guaranteed to exist on every pages-seo deployment.
  blog:    '/blog',
  home:    '/',
  rss:     '/rss.xml',
  sitemap: '/sitemap.xml',

  // Common product routes. Path values are placeholders; override via
  // env on the Pages project if you have real URLs for these.
  signup:   '/signup',
  login:    '/login',
  pricing:  '/pricing',
  contact:  '/contact',
};

// Build the resolved alias map for a request. Worker isolates don't
// expose process.env at module-eval time, so we read overrides out of
// the `env` object passed by the request handler.
export function buildAliases(env) {
  return {
    ...DEFAULTS,
    signup:   env?.SITE_SIGNUP_URL   || DEFAULTS.signup,
    login:    env?.SITE_LOGIN_URL    || DEFAULTS.login,
    pricing:  env?.SITE_PRICING_URL  || DEFAULTS.pricing,
    contact:  env?.SITE_CONTACT_URL  || DEFAULTS.contact,
  };
}

// Human-readable list of aliases for inclusion in the AI prompt.
export function aliasesForPrompt(env) {
  const a = buildAliases(env);
  return Object.entries(a).map(([k, v]) => `- "${k}" → ${v}`).join('\n');
}
