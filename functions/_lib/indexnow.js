// IndexNow client. Pings Bing/Yandex/Seznam/etc. when new content lands.
// Free, no auth beyond the public key the site hosts at /<key>.txt.
//
// Setup once per deployment:
//   1. Generate a 32-char hex key:  openssl rand -hex 32
//   2. Save as a secret:  wrangler pages secret put INDEXNOW_KEY
//   3. The /<INDEXNOW_KEY>.txt route serves it (functions/[key].txt.js).

const INDEXNOW_URL = 'https://api.indexnow.org/indexnow';

// Resolve the host the page lives on. The widely-known case is the
// user's own domain (e.g. blog.example.com). We use the request URL's
// hostname when available; falls back to env.SITE_URL.
export function getHost(env, request) {
  if (request) try { return new URL(request.url).hostname; } catch { /* */ }
  if (env?.SITE_URL) try { return new URL(env.SITE_URL).hostname; } catch { /* */ }
  return null;
}

export async function pingIndexNow(env, urls, request = null) {
  if (!env?.INDEXNOW_KEY) return { ok: false, error: 'indexnow_not_configured' };
  if (!urls || !urls.length) return { ok: false, error: 'no_urls' };
  const host = getHost(env, request);
  if (!host) return { ok: false, error: 'no_host' };

  const r = await fetch(INDEXNOW_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      host,
      key: env.INDEXNOW_KEY,
      urlList: urls.slice(0, 10000), // IndexNow per-request cap
    }),
  });
  const body = await r.text().catch(() => '');
  return { ok: r.ok || r.status === 202, status: r.status, body, urls };
}
