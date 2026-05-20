// POST /api/setup
//
// First-run bootstrap. Called by the admin SPA when /admin loads
// with `?setup=<token>` and detects no users exist yet.
//
// The token is the install-time magic link. The installer at
// seo.benjaminb.xyz/install generates a random hex string at
// install time, sets it as a Pages env var (SETUP_TOKEN) on the
// new project, and hands the operator a link of the form
// https://<their-domain>/admin?setup=<token>. On first visit we
// match the URL token against env.SETUP_TOKEN; on success the
// admin user is created and the token is invalidated by
// onboarding_complete being set (we don't try to unset the env
// var — that would require Pages API calls we don't run here).
//
// CLI installs that don't set SETUP_TOKEN fall back to the
// "first-visitor wins" behaviour they always had: any POST to a
// users-empty database creates the admin.
//
// GET /api/setup
//   Returns { ok, needs_setup, requires_token } so the SPA knows
//   whether to demand a token in the URL.

import { json, nowSec, newId } from '../_lib/util.js';
import { hashPassword } from '../_lib/passwords.js';
import { setSetting, loadSettings } from '../_lib/settings.js';
import { SCHEMA_SQL } from '../_lib/schema.js';

const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MIN_PW = 8;
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

// Returns the expected token, or '' if none configured.
async function expectedSetupToken(env) {
  // Env var (Pages secret) wins. Settings table is checked next so
  // re-runs from a fresh deploy that re-pushed SETUP_TOKEN as a
  // setting also work.
  if (env?.SETUP_TOKEN && String(env.SETUP_TOKEN).trim()) {
    return String(env.SETUP_TOKEN).trim();
  }
  if (!env?.DB) return '';
  try {
    const s = await loadSettings(env);
    return String(s?.setup_token || '').trim();
  } catch {
    return '';
  }
}

// Constant-time-ish equality so a careful attacker can't infer the
// token byte-by-byte from response timing. We hash both inputs and
// compare the digests — collisions in SHA-256 are not a concern.
async function tokensMatch(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  // Hash and compare so the loop length is independent of the secret.
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const xa = new Uint8Array(ha), xb = new Uint8Array(hb);
  let acc = 0;
  for (let i = 0; i < xa.length; i++) acc |= xa[i] ^ xb[i];
  return acc === 0;
}

export const onRequestGet = async ({ env }) => {
  if (!env?.DB) return json(503, { error: 'no_db_binding' });
  const n = await userCount(env);
  const expected = await expectedSetupToken(env);
  return json(200, {
    ok: true,
    needs_setup: n === 0,
    requires_token: !!expected,
  });
};

export const onRequestPost = async ({ env, request }) => {
  if (!env?.DB) return json(503, { error: 'no_db_binding' });

  // Hard gate: only valid when no users exist.
  if ((await userCount(env)) > 0) {
    return json(409, { error: 'setup_already_done', detail: 'An admin user already exists.' });
  }

  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }

  // Token gate. If a SETUP_TOKEN is configured (browser-installed
  // sites), the POST body must include a matching `setup_token`.
  // CLI installs leave SETUP_TOKEN unset and skip this check.
  const expected = await expectedSetupToken(env);
  if (expected) {
    const supplied = String(body?.setup_token || '').trim();
    if (!(await tokensMatch(supplied, expected))) {
      return json(401, { error: 'bad_setup_token', detail: 'Open /admin?setup=<token> from the install URL you were given.' });
    }
  }

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

  // 4b. Install metadata for the Updates tab. All optional — CLI
  // installs supply none of these and the tab falls back gracefully.
  if (body.install_method)       await setSetting(env, 'install_method',     String(body.install_method).slice(0, 16));
  if (body.installed_sha)        await setSetting(env, 'installed_sha',      String(body.installed_sha).slice(0, 64));
  if (body.install_repo_owner)   await setSetting(env, 'install_repo_owner', String(body.install_repo_owner).slice(0, 80));
  if (body.install_repo_name)    await setSetting(env, 'install_repo_name',  String(body.install_repo_name).slice(0, 100));
  if (body.install_cf_account)   await setSetting(env, 'install_cf_account', String(body.install_cf_account).slice(0, 64));
  if (body.install_cf_project)   await setSetting(env, 'install_cf_project', String(body.install_cf_project).slice(0, 64));

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

  // 6. Mark setup as done — even though the user-count check above
  //    already prevents a second run, this gives the admin UI an
  //    explicit flag to read in case the table-level check ever
  //    becomes ambiguous (multi-user installs etc.).
  await setSetting(env, 'onboarding_complete', String(nowSec()));

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
