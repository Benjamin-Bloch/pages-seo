// AES-GCM secret vault, keyed off ADMIN_TOKEN.
//
// Goal: let the admin set/replace LLM API keys from the dashboard
// without round-tripping through `wrangler pages secret put`. Trade-off
// is explicit: anyone with the admin token can decrypt the vault, which
// is the same blast radius the admin token already has (they can run
// the chain that *uses* those keys), so the security delta is small.
//
// Storage shape (D1 `secrets_vault` table):
//   key_name   TEXT PRIMARY KEY   — e.g. "OPENAI_API_KEY"
//   ciphertext TEXT NOT NULL      — base64(IV || ciphertext-with-tag)
//   updated_at INTEGER NOT NULL
//
// Encryption: AES-GCM-256, 12-byte random IV per record, key derived
// from ADMIN_TOKEN via PBKDF2-SHA256 (100k iterations, fixed salt).
//
// The fixed PBKDF2 salt is tied to the schema so rotating the admin
// token forces a re-encryption pass (we expose `reencryptAll` for that).
//
// Reading order in lookupApiKey():
//   1. env.<NAME> (Cloudflare Pages secret) — preserves existing setup
//   2. vault row decrypted with current ADMIN_TOKEN
//   3. undefined

import { getAdminToken } from './admin_token.js';

const PBKDF2_SALT = new TextEncoder().encode('pages-seo:vault:v1');
const PBKDF2_ITER = 100_000;
const IV_BYTES = 12;

// Cache the derived CryptoKey per request — derivation is ~3ms but a
// page render might decrypt 5-10 keys, no point repeating.
let cachedKey;
let cachedTokenHash;

async function deriveKey(adminToken) {
  // Hash the token cheaply just so we know when to invalidate the cache.
  // Don't use the hash directly as the AES key — PBKDF2 is doing that.
  const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(adminToken));
  const hashHex = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  if (cachedKey && cachedTokenHash === hashHex) return cachedKey;

  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(adminToken),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  cachedKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: PBKDF2_SALT, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  cachedTokenHash = hashHex;
  return cachedKey;
}

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function fromB64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function encryptValue(env, plaintext) {
  const adminToken = await getAdminToken(env);
  if (!adminToken) throw new Error('admin_token_missing');
  const key = await deriveKey(adminToken);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  ));
  // Pack IV + ciphertext together for storage simplicity.
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0); out.set(ct, iv.length);
  return toB64(out);
}

export async function decryptValue(env, packedB64) {
  const adminToken = await getAdminToken(env);
  if (!adminToken) throw new Error('admin_token_missing');
  const key = await deriveKey(adminToken);
  const packed = fromB64(packedB64);
  if (packed.length < IV_BYTES + 16) throw new Error('ciphertext_too_short');
  const iv = packed.slice(0, IV_BYTES);
  const ct = packed.slice(IV_BYTES);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}

export async function setVaultSecret(env, name, plaintext) {
  if (!plaintext) {
    // Empty string = delete.
    await env.DB.prepare('DELETE FROM secrets_vault WHERE key_name = ?').bind(name).run();
    return { deleted: true };
  }
  const ciphertext = await encryptValue(env, plaintext);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO secrets_vault (key_name, ciphertext, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key_name) DO UPDATE SET ciphertext=excluded.ciphertext, updated_at=excluded.updated_at`
  ).bind(name, ciphertext, now).run();
  return { stored: true };
}

export async function getVaultSecret(env, name) {
  if (!env?.DB) return undefined;
  const row = await env.DB.prepare('SELECT ciphertext FROM secrets_vault WHERE key_name = ? LIMIT 1').bind(name).first();
  if (!row?.ciphertext) return undefined;
  try {
    return await decryptValue(env, row.ciphertext);
  } catch {
    // Likely the admin token was rotated — caller should treat as missing.
    return undefined;
  }
}

// Build a thin env wrapper that falls back to the vault for any key
// not present in the real env. Use this where you'd normally read
// env.OPENAI_API_KEY etc. — wrap the env once at request entry.
export async function envWithVault(env, names) {
  const overlay = { ...env };
  for (const name of names) {
    if (overlay[name] && String(overlay[name]).trim()) continue; // Pages secret wins
    const v = await getVaultSecret(env, name);
    if (v) overlay[name] = v;
  }
  return overlay;
}

// Return { name: 'pages-secret' | 'vault' | 'unset' } for every requested name.
// Used by the admin UI to render the status grid.
export async function describeKeys(env, names) {
  const out = {};
  for (const name of names) {
    if (env?.[name] && String(env[name]).trim()) { out[name] = 'pages-secret'; continue; }
    const v = await getVaultSecret(env, name);
    out[name] = v ? 'vault' : 'unset';
  }
  return out;
}
