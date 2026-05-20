// Encrypted cookie storage for the GitHub OAuth access token.
//
// Why a cookie, not D1: /update is a public page (anyone with a
// pages-seo install can use it), so we have no per-user database
// row to attach the token to. The cookie travels with the operator's
// browser and is meaningful only for the duration of their update
// session — exactly the right lifecycle.
//
// Encryption: AES-GCM-256, 12-byte IV, key derived from
// GITHUB_OAUTH_CLIENT_SECRET via PBKDF2-SHA256 (100k iter). The
// secret is already in our Pages secrets, so we get a free, stable
// HKDF root without adding another env var.
//
// Cookie format: `gh_token=<base64-url(iv || ciphertext)>`,
// HttpOnly, Secure, SameSite=Lax, Path=/api/update.
//
// We also stash the user's GitHub login alongside the token in the
// plaintext JSON we encrypt, so /status can return it without an
// extra GitHub roundtrip.

const COOKIE_NAME = 'ps_gh';
const COOKIE_PATH = '/api/update';
const TTL_SEC     = 60 * 60;     // 1 hour — enough to finish an update
const PBKDF2_ITER = 100_000;
const SALT        = new TextEncoder().encode('pages-seo:oauth-cookie:v1');

function toB64Url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64Url(s) {
  let b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(secret) {
  const base = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: SALT, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function readCookie(req, name) {
  const hdr = req.headers.get('cookie') || '';
  for (const c of hdr.split(/;\s*/)) {
    const eq = c.indexOf('=');
    if (eq < 0) continue;
    if (c.slice(0, eq).trim() === name) return c.slice(eq + 1).trim();
  }
  return null;
}

export async function setOAuthCookie(env, payload) {
  if (!env?.GITHUB_OAUTH_CLIENT_SECRET) throw new Error('oauth_secret_missing');
  const key = await deriveKey(env.GITHUB_OAUTH_CLIENT_SECRET);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0); packed.set(ct, iv.length);
  return [
    `${COOKIE_NAME}=${toB64Url(packed)}`,
    `Max-Age=${TTL_SEC}`,
    `Path=${COOKIE_PATH}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

export async function readOAuthCookie(env, request) {
  if (!env?.GITHUB_OAUTH_CLIENT_SECRET) return null;
  const raw = readCookie(request, COOKIE_NAME);
  if (!raw) return null;
  try {
    const key = await deriveKey(env.GITHUB_OAUTH_CLIENT_SECRET);
    const packed = fromB64Url(raw);
    if (packed.length < 12 + 16) return null;
    const iv = packed.slice(0, 12);
    const ct = packed.slice(12);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    return null;
  }
}

export function clearOAuthCookie() {
  return `${COOKIE_NAME}=; Max-Age=0; Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax`;
}
