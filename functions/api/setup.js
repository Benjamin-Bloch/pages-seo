// POST /api/setup
//
// First-run bootstrap for the one-click deploy flow. Called once by
// the admin SPA when /admin loads and detects "no users exist yet."
// Gated by that same condition server-side so it can't be invoked a
// second time to hijack an existing install.
//
// What it does:
//   1. Applies the embedded schema (idempotent CREATE TABLE IF NOT EXISTS).
//   2. Generates a 64-char hex ADMIN_TOKEN and stores it in settings.
//   3. Generates a 64-char hex INDEXNOW_KEY and stores it in settings.
//   4. Persists site_name + site_url to settings.
//   5. Creates the first admin user with the supplied email + password.
//
// GET /api/setup
//   Returns whether setup is still needed (no users) so the SPA can
//   decide which screen to render.

import { json, nowSec, newId } from '../_lib/util.js';
import { hashPassword } from '../_lib/passwords.js';
import { setSetting } from '../_lib/settings.js';
import { SCHEMA_SQL } from '../_lib/schema.js';

const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MIN_PW = 12;
const MAX_PW = 256;

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function userCount(env) {
  try {
    const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first();
    return r?.n || 0;
  } catch {
    return 0; // table missing = 0 users
  }
}

export const onRequestGet = async ({ env }) => {
  if (!env?.DB) return json(503, { error: 'no_db_binding' });
  const n = await userCount(env);
  return json(200, { ok: true, needs_setup: n === 0 });
};

export const onRequestPost = async ({ env, request }) => {
  if (!env?.DB) return json(503, { error: 'no_db_binding' });

  // Hard gate: only valid when no users exist.
  if ((await userCount(env)) > 0) {
    return json(409, { error: 'setup_already_done', detail: 'An admin user already exists.' });
  }

  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }

  const email     = String(body?.email || '').trim().toLowerCase();
  const password  = String(body?.password || '');
  const site_name = String(body?.site_name || '').trim();
  const site_url  = String(body?.site_url  || '').trim();

  if (!EMAIL_RX.test(email)) return json(400, { error: 'invalid_email' });
  if (password.length < MIN_PW || password.length > MAX_PW) {
    return json(400, { error: 'password_length', min: MIN_PW, max: MAX_PW });
  }
  if (!site_name) return json(400, { error: 'missing_site_name' });
  if (!/^https?:\/\/.+/i.test(site_url)) return json(400, { error: 'invalid_site_url' });

  // 1. Apply schema. Wrangler's d1 console does this for CLI installs;
  //    on the one-click path we ship it bundled and run it here. Every
  //    statement is idempotent so re-runs are safe.
  for (const stmt of splitSql(SCHEMA_SQL)) {
    await env.DB.prepare(stmt).run();
  }

  // 2/3. Generate secrets.
  const adminToken   = randomHex(32);
  const indexnowKey  = randomHex(32);
  await setSetting(env, 'admin_token',  adminToken);
  await setSetting(env, 'indexnow_key', indexnowKey);

  // 4. Persist site identity.
  await setSetting(env, 'site_name_db', site_name);
  await setSetting(env, 'site_url_db',  site_url);

  // 5. Create the first admin user.
  let creds;
  try { creds = await hashPassword(password); }
  catch (e) { return json(400, { error: String(e?.message || e) }); }

  const id = newId();
  const t = nowSec();
  await env.DB.prepare(
    `INSERT INTO users (id, email, password_hash, password_salt, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(id, email, creds.hash, creds.salt, t).run();

  return json(200, { ok: true, email, site_url });
};

// Split bundled schema into individual statements for D1.run().
// D1 doesn't accept multi-statement strings; we split on `;` at the
// end of a line. Comments are stripped.
function splitSql(sql) {
  const stripped = String(sql)
    .replace(/--[^\n]*\n/g, '\n')   // line comments
    .replace(/\/\*[\s\S]*?\*\//g, ''); // block comments
  return stripped
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
