// Resolves SITE_NAME and SITE_URL from either:
//   1. Pages secrets (env.SITE_NAME / env.SITE_URL) — CLI install path.
//   2. D1 settings (site_name_db / site_url_db) — one-click install
//      path, written by /api/setup.
//
// Returned values are guaranteed strings (possibly empty). Cached on
// env for the request lifetime so we don't re-query.

import { loadSettings } from './settings.js';

const CACHE = '__ps_site_identity_cache';

export async function getSiteIdentity(env) {
  if (env?.[CACHE]) return env[CACHE];
  let name = (env?.SITE_NAME || '').trim();
  let url  = (env?.SITE_URL  || '').trim();
  if ((!name || !url) && env?.DB) {
    try {
      const s = await loadSettings(env);
      if (!name && s?.site_name_db) name = String(s.site_name_db).trim();
      if (!url  && s?.site_url_db)  url  = String(s.site_url_db).trim();
    } catch { /* settings table may be missing on a truly fresh deploy */ }
  }
  const out = { name, url };
  try { env[CACHE] = out; } catch { /* env is frozen on some platforms */ }
  return out;
}
