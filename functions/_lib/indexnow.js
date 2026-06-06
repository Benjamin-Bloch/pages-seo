// IndexNow client. Pings Bing/Yandex/Seznam/etc. when new content lands.
// Free, no auth beyond the public key the site hosts at /<key>.txt.
//
// Setup once per deployment:
//   1. Generate a 32-char hex key:  openssl rand -hex 32
//   2. Save as a secret:  wrangler pages secret put INDEXNOW_KEY
//   3. The /<INDEXNOW_KEY>.txt route serves it (functions/[key].txt.js).

import { getIndexNowKey } from './indexnow_key.js';
import { getSiteIdentity } from './site_identity.js';

const INDEXNOW_URL = 'https://api.indexnow.org/indexnow';

// Resolve the host the page lives on. The widely-known case is the
// user's own domain (e.g. blog.example.com). We use the request URL's
// hostname when available; falls back to the resolved SITE_URL
// (Pages secret or D1 setting).
export async function getHost(env, request) {
  if (request) try { return new URL(request.url).hostname; } catch { /* */ }
  const id = await getSiteIdentity(env);
  if (id?.url) try { return new URL(id.url).hostname; } catch { /* */ }
  return null;
}

export async function pingIndexNow(env, urls, request = null) {
  // Resolve via Pages secret first, D1 setting second. Both browser
  // and 1-click Deploy installs end up with the key in D1; only the
  // CLI install path puts it in a Pages secret.
  const key = await getIndexNowKey(env);
  if (!key) return { ok: false, error: 'indexnow_not_configured' };
  if (!urls || !urls.length) return { ok: false, error: 'no_urls' };
  const host = await getHost(env, request);
  if (!host) return { ok: false, error: 'no_host' };

  const r = await fetch(INDEXNOW_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      host,
      key,
      urlList: urls.slice(0, 10000), // IndexNow per-request cap
    }),
  });
  const body = await r.text().catch(() => '');
  return { ok: r.ok || r.status === 202, status: r.status, body, urls };
}
