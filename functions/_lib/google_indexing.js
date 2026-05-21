// Google Search Console + Indexing API client.
//
// Two paths:
//
//   1. submitSitemap(env, sitemapUrl, propertyId)
//      Tells Search Console to re-crawl your sitemap. Officially
//      supported for any content type. Slow (GSC may take hours to
//      pick up new URLs), but ToS-compliant. This is the default.
//
//   2. notifyUrl(env, url)
//      POSTs a single URL to the Indexing API for immediate crawl.
//      Officially Google only supports this for JobPosting and
//      BroadcastEvent schema — using it for blogs technically works
//      but violates ToS. Only fires when the user has explicitly
//      toggled settings.google_use_indexing_api === '1'.
//
// Credentials:
//   The service-account JSON is stored in the vault under the key
//   GOOGLE_SA_JSON (see secret_vault.js). We never write the
//   private_key to D1's settings table directly.
//
// JWT signing uses Web Crypto (subtle.importKey + sign with RS256),
// no external deps. Cloudflare Workers support RS256 natively.

import { getVaultSecret } from './secret_vault.js';
import { loadSettings } from './settings.js';
import { getSiteIdentity } from './site_identity.js';

const SCOPE_SITEMAP  = 'https://www.googleapis.com/auth/webmasters';
const SCOPE_INDEXING = 'https://www.googleapis.com/auth/indexing';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// In-isolate access-token cache. Tokens are valid for 1 hour; we
// expire 5 min early to avoid edge-case 401s during a refresh.
const TOKEN_CACHE = new Map();

// Base64url encode bytes/string without trailing '='.
function b64url(input) {
  let bytes;
  if (typeof input === 'string') bytes = new TextEncoder().encode(input);
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else if (input instanceof Uint8Array) bytes = input;
  else throw new Error('b64url: unsupported input');
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Convert a PKCS#8 PEM ("-----BEGIN PRIVATE KEY-----") to an ArrayBuffer
// of raw DER bytes ready for crypto.subtle.importKey.
function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return buf;
}

// Load + parse the service-account JSON from the vault.
async function loadServiceAccount(env) {
  const raw = await getVaultSecret(env, 'GOOGLE_SA_JSON');
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (!j.client_email || !j.private_key) return null;
    return j;
  } catch {
    return null;
  }
}

// Build a signed JWT for the requested scope and exchange it for a
// Google OAuth access token. Cached per-scope per-isolate.
async function getAccessToken(env, scope) {
  const sa = await loadServiceAccount(env);
  if (!sa) throw new Error('google_sa_not_configured');

  const cacheKey = sa.client_email + '|' + scope;
  const cached = TOKEN_CACHE.get(cacheKey);
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expires_at > now + 300) return cached.token;

  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope,
    aud: GOOGLE_TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };
  const unsigned = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claim));

  const keyData = pemToArrayBuffer(sa.private_key);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt = unsigned + '.' + b64url(sig);

  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('google_token_http_' + r.status + ': ' + t.slice(0, 200));
  }
  const d = await r.json();
  if (!d.access_token) throw new Error('google_token_empty');
  TOKEN_CACHE.set(cacheKey, { token: d.access_token, expires_at: now + (d.expires_in || 3600) });
  return d.access_token;
}

// Resolve the GSC property identifier. Prefer user-set
// settings.google_sc_property; fall back to deriving from SITE_URL
// (URL-prefix property — "https://example.com/").
async function resolveProperty(env) {
  const s = await loadSettings(env);
  const explicit = String(s.google_sc_property || '').trim();
  if (explicit) return explicit;
  const id = await getSiteIdentity(env);
  if (!id.url) return null;
  try {
    const u = new URL(id.url);
    return u.origin + '/';
  } catch {
    return null;
  }
}

// Submit the sitemap for re-crawl. Idempotent — Google merges
// repeated submissions. Returns { ok, status, property, sitemap }.
//
// Why PUT and not POST: GSC's sitemap endpoint is
//   PUT /webmasters/v3/sites/{siteUrl}/sitemaps/{feedpath}
// (yes, it really is PUT.)
export async function submitSitemap(env, sitemapUrl) {
  let property;
  try {
    property = await resolveProperty(env);
    if (!property) return { ok: false, error: 'no_property' };
    const token = await getAccessToken(env, SCOPE_SITEMAP);
    const r = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/sitemaps/${encodeURIComponent(sitemapUrl)}`,
      { method: 'PUT', headers: { Authorization: 'Bearer ' + token } },
    );
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { ok: false, status: r.status, error: 'google_sitemap_http', detail: t.slice(0, 240), property, sitemap: sitemapUrl };
    }
    return { ok: true, status: r.status, property, sitemap: sitemapUrl };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 240), property, sitemap: sitemapUrl };
  }
}

// Per-URL Indexing API notification. type: 'URL_UPDATED' on publish,
// 'URL_DELETED' on takedown (we don't currently call the second).
// Returns { ok, status, url } — does NOT throw.
export async function notifyUrl(env, url, type = 'URL_UPDATED') {
  try {
    const token = await getAccessToken(env, SCOPE_INDEXING);
    const r = await fetch('https://indexing.googleapis.com/v3/urlNotifications:publish', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ url, type }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { ok: false, status: r.status, error: 'google_indexing_http', detail: t.slice(0, 240), url };
    }
    return { ok: true, status: r.status, url };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 240), url };
  }
}

// Combined: called from the publish hooks. Always tries the sitemap
// submission; ALSO hits the Indexing API per-URL when the user has
// opted into google_use_indexing_api.
//
// Returns { sitemap, indexing? } — non-throwing.
export async function onPublish(env, urls) {
  const s = await loadSettings(env);
  if (!(await loadServiceAccount(env))) return { skipped: 'no_credentials' };

  const id = await getSiteIdentity(env);
  const sitemapUrl = (id.url || '').replace(/\/$/, '') + '/sitemap.xml';
  const out = { sitemap: await submitSitemap(env, sitemapUrl) };

  if (String(s.google_use_indexing_api || '') === '1' && urls?.length) {
    out.indexing = [];
    // Sequential rather than parallel — keeps within the 200 req/day
    // quota and avoids a thundering-herd on the rate limiter.
    for (const u of urls.slice(0, 10)) {
      out.indexing.push(await notifyUrl(env, u, 'URL_UPDATED'));
    }
  }
  return out;
}

// Lightweight "is this set up?" probe for the admin Settings UI.
// Returns { configured, client_email?, sitemap_test? }.
export async function describeConfig(env) {
  const sa = await loadServiceAccount(env);
  if (!sa) return { configured: false };
  return {
    configured: true,
    client_email: sa.client_email,
    project_id: sa.project_id || null,
    property: await resolveProperty(env),
  };
}
