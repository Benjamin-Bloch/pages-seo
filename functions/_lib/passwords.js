// PBKDF2-SHA256 password hashing + session token signing.
//
// Why PBKDF2 not Argon2id: Cloudflare Workers Web Crypto exposes
// PBKDF2 natively. Argon2 would require a ~200KB WASM bundle and
// configuration overhead. PBKDF2 at 200k iterations is acceptable
// for the threat model here (single-tenant admin behind a generated
// 64-char fallback token).
//
// Session token format: `<session_id_hex>.<hmac_base64>` where hmac
// is HMAC-SHA256 of session_id keyed with ADMIN_TOKEN. The cookie is
// httpOnly + SameSite=Lax + Secure (Cloudflare Pages is HTTPS-only).

// Cloudflare Workers caps PBKDF2 iterations at 100,000 (CRYPTO-1051
// in the Workers runtime). 100k is the highest value we can pick;
// lower would weaken the hash. Documented here because the natural
// reach for "more iterations = better" runs straight into this cap.
const PBKDF2_ITER = 100_000;
const PASSWORD_HASH_BYTES = 32;
const SALT_BYTES = 16;
const SESSION_DAYS = 14;

// ── encoding helpers ────────────────────────────────────────────
function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function fromB64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function toHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function constTimeEq(a, b) {
  if (a.length !== b.length) return false;
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return acc === 0;
}

// ── password hashing ────────────────────────────────────────────

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('password_too_short');
  }
  if (password.length > 256) throw new Error('password_too_long');
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(password, salt);
  return { hash: toB64(hash), salt: toB64(salt) };
}

export async function verifyPassword(password, hashB64, saltB64) {
  if (!password || !hashB64 || !saltB64) return false;
  try {
    const salt = fromB64(saltB64);
    const candidate = await pbkdf2(password, salt);
    return constTimeEq(toB64(candidate), hashB64);
  } catch {
    return false;
  }
}

async function pbkdf2(password, salt) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    baseKey,
    PASSWORD_HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

// ── session tokens ──────────────────────────────────────────────

export function newSessionId() {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

export async function signSession(sessionId, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sessionId));
  return `${sessionId}.${toB64(new Uint8Array(sig))}`;
}

export async function verifySessionToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const sessionId = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  if (!/^[0-9a-f]{32}$/.test(sessionId)) return null;
  const expected = (await signSession(sessionId, secret)).slice(dot + 1);
  if (!constTimeEq(expected, provided)) return null;
  return sessionId;
}

// Cookie name used everywhere.
export const SESSION_COOKIE = 'ps_session';

export function sessionExpirySec() {
  return Math.floor(Date.now() / 1000) + (SESSION_DAYS * 24 * 60 * 60);
}

// Build the Set-Cookie header value for a session.
export function buildSessionCookie(value, maxAgeSec) {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    `Max-Age=${maxAgeSec}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ];
  return parts.join('; ');
}

// And the explicit delete-cookie variant for logout.
export function buildSessionCookieClear() {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function readCookie(req, name) {
  const hdr = req.headers.get('cookie') || '';
  const cookies = hdr.split(/;\s*/);
  for (const c of cookies) {
    const eq = c.indexOf('=');
    if (eq < 0) continue;
    if (c.slice(0, eq).trim() === name) return c.slice(eq + 1).trim();
  }
  return null;
}
