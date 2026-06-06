// Resolves the IndexNow key the same way getAdminToken() resolves
// the admin token: Pages secret first, D1 setting second.
//
// Why both paths exist:
//   - CLI install (`setup.sh`) writes `INDEXNOW_KEY` as a Pages secret
//     because it has the wrangler session to do that.
//   - Browser install + 1-click Deploy to Cloudflare install leave the
//     secret unset; /api/setup generates one and stores it in D1
//     instead. The site never sees a secret in that case.
//
// Both indexnow.js (the ping client) and [indexnow_key].txt.js (the
// site-verification file Bing/Yandex/Seznam fetch) must call this
// helper, or the 1-click install path silently never pings IndexNow.
//
// Cached on the env object for the isolate lifetime so repeated
// publishes in the same isolate don't re-hit D1.

import { loadSettings } from './settings.js';

const CACHE_KEY = '__ps_indexnow_key_cache';

export async function getIndexNowKey(env) {
  if (env?.[CACHE_KEY]) return env[CACHE_KEY];
  const fromPagesSecret = env?.INDEXNOW_KEY && String(env.INDEXNOW_KEY).trim();
  if (fromPagesSecret) {
    try { env[CACHE_KEY] = fromPagesSecret; } catch { /* env may be frozen */ }
    return fromPagesSecret;
  }
  if (!env?.DB) return '';
  try {
    const s = await loadSettings(env);
    const k = String(s?.indexnow_key || '').trim();
    if (k) {
      try { env[CACHE_KEY] = k; } catch { /* env may be frozen */ }
      return k;
    }
  } catch { /* settings table may not exist on a truly fresh deploy */ }
  return '';
}
