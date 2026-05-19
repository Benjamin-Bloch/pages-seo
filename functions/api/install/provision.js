// POST /api/install/provision
//
// Idempotent installer. Walks six steps:
//   1. account     – resolve the user's account id from the token
//   2. d1          – create (or find existing) D1 database
//   3. r2          – create (or find existing) R2 bucket
//   4. pages       – create (or find existing) Pages project bound to
//                    GitHub + D1 + R2 + Workers AI
//   5. env         – patch SITE_URL on the new project once we know
//                    its assigned subdomain
//   6. deploy      – kick off the first deployment
//
// Every step is allowed to fail and be retried. State is persisted to
// the installer's own D1 (this Pages project) keyed by (project_slug,
// token_fingerprint). The fingerprint is the first 16 hex chars of
// sha256(token) — enough to recognise the same token on a retry, but
// the raw token never lands in storage.
//
// On retry, completed steps short-circuit: if d1_id is already saved,
// we re-use it instead of creating a fresh database (which would
// fail with "already exists" and prompt the user to rename their
// project).

import { json, nowSec } from '../../_lib/util.js';

const CF_API = 'https://api.cloudflare.com/client/v4';
// The user supplies their own GitHub owner + repo (e.g. their fork of
// pages-seo). We never default to the upstream repo because Cloudflare
// can only see GitHub repos owned by an account that has authorised
// the Workers & Pages GitHub App — and the upstream repo lives under
// the maintainer's account, not the user's.
const PROD_BRANCH = 'main';
const DEFAULT_REPO_NAME = 'pages-seo';

const SLUG_RX  = /^[a-z][a-z0-9-]{1,32}$/;
const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function fail(at, status, detail, extras = {}) {
  return json(status, { ok: false, failed_at: at, error: 'install_failed', detail, ...extras });
}

// Detect the "you haven't connected GitHub to Cloudflare Pages on this
// account yet" failure mode. Cloudflare returns a generic
// "internal issue with your Cloudflare Pages Git installation"
// message in that case — we surface a structured hint so the UI can
// show a one-click Connect GitHub flow instead of a dead end.
function isGithubInstallError(msg) {
  if (!msg) return false;
  return /Git installation|git integration|github app|connect.*git|reinstalling your installation/i.test(msg);
}

async function tokenFingerprint(token) {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function cfFetch(token, path, init = {}) {
  const res = await fetch(CF_API + path, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { res, body };
}

function firstErrorMessage(body) {
  if (!body) return null;
  if (Array.isArray(body.errors) && body.errors.length) {
    return body.errors.map((e) => e.message || String(e)).join(' · ');
  }
  return body.error || body.detail || null;
}

// ── state helpers ───────────────────────────────────────────────
async function loadState(env, project, fp) {
  if (!env?.DB) return null;
  return env.DB.prepare(
    `SELECT * FROM install_state WHERE project = ? AND token_fp = ? LIMIT 1`
  ).bind(project, fp).first().catch(() => null);
}

async function saveStep(env, project, fp, patch) {
  if (!env?.DB) return;
  const now = nowSec();
  const existing = await loadState(env, project, fp);
  if (existing) {
    const sets = [];
    const args = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`);
      args.push(v);
    }
    sets.push('updated_at = ?'); args.push(now);
    args.push(project, fp);
    await env.DB.prepare(
      `UPDATE install_state SET ${sets.join(', ')} WHERE project = ? AND token_fp = ?`
    ).bind(...args).run().catch(() => {});
  } else {
    const cols = ['project', 'token_fp', 'created_at', 'updated_at', ...Object.keys(patch)];
    const vals = [project, fp, now, now, ...Object.values(patch)];
    const placeholders = cols.map(() => '?').join(', ');
    await env.DB.prepare(
      `INSERT INTO install_state (${cols.join(', ')}) VALUES (${placeholders})`
    ).bind(...vals).run().catch(() => {});
  }
}

// ── step implementations ────────────────────────────────────────
async function ensureAccount(token) {
  const r = await cfFetch(token, '/accounts');
  if (!r.res.ok || !r.body?.result?.length) {
    throw new Error(firstErrorMessage(r.body) || 'Token rejected by Cloudflare (check scopes).');
  }
  return { id: r.body.result[0].id, name: r.body.result[0].name };
}

// Find an existing D1 database by name. Returns its UUID or null.
// We use the `name` query filter Cloudflare's D1 list endpoint supports
// to skip walking pages whenever it's available; fall back to a small
// page walk if the filter isn't honoured.
async function findD1(token, accountId, name) {
  const direct = await cfFetch(token, `/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}&per_page=10`);
  if (direct.res.ok) {
    const hit = (direct.body?.result || []).find((r) => r.name === name);
    if (hit) return hit.uuid;
    // The filter returned nothing — assume it works and the db doesn't exist.
    if (Array.isArray(direct.body?.result)) return null;
  }
  // Filter may be ignored on older API versions. Walk a few pages.
  for (let page = 1; page <= 5; page++) {
    const listR = await cfFetch(token, `/accounts/${accountId}/d1/database?page=${page}&per_page=50`);
    if (!listR.res.ok) break;
    const rows = listR.body?.result || [];
    const hit = rows.find((r) => r.name === name);
    if (hit) return hit.uuid;
    if (rows.length < 50) break;
  }
  return null;
}

async function ensureD1(token, accountId, name) {
  // Pre-flight: look first. Avoids the create-then-conflict dance on
  // every fresh install attempt, even when nothing's wrong.
  const existing = await findD1(token, accountId, name);
  if (existing) return { id: existing, name, reused: true };

  const createR = await cfFetch(token, `/accounts/${accountId}/d1/database`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  if (createR.res.ok && createR.body?.result?.uuid) {
    return { id: createR.body.result.uuid, name, reused: false };
  }
  // A racing-create can still hit a 409 between the lookup and the create.
  const msg = firstErrorMessage(createR.body) || '';
  if (/already exists/i.test(msg)) {
    const after = await findD1(token, accountId, name);
    if (after) return { id: after, name, reused: true };
  }
  throw new Error(msg || 'Failed to create D1 database.');
}

async function findR2(token, accountId, name) {
  // R2 list endpoint: per-bucket pagination via cursor. For our needs
  // (does this name exist?) a simple page-walk works.
  let cursor = '';
  for (let i = 0; i < 5; i++) {
    const url = `/accounts/${accountId}/r2/buckets?per_page=100${cursor ? '&cursor=' + cursor : ''}`;
    const r = await cfFetch(token, url);
    if (!r.res.ok) return null;
    const buckets = r.body?.result?.buckets || r.body?.result || [];
    const hit = buckets.find((b) => b.name === name);
    if (hit) return name;
    cursor = r.body?.result_info?.cursor || '';
    if (!cursor) break;
  }
  return null;
}

async function ensureR2(token, accountId, name) {
  // Pre-flight: skip the create when the bucket already exists.
  const existing = await findR2(token, accountId, name);
  if (existing) return { name, reused: true };

  const r = await cfFetch(token, `/accounts/${accountId}/r2/buckets`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  if (r.res.ok) return { name, reused: false };
  if (r.res.status === 409) return { name, reused: true };
  const msg = firstErrorMessage(r.body) || `R2 create failed (HTTP ${r.res.status})`;
  if (/already exists/i.test(msg)) return { name, reused: true };
  throw new Error(msg);
}

// Look up a Pages project by name. GET /accounts/:account/pages/projects/:name
// returns 404 cleanly when missing — perfect pre-flight.
async function findPagesProject(token, accountId, project) {
  const r = await cfFetch(token, `/accounts/${accountId}/pages/projects/${project}`);
  if (r.res.ok && r.body?.result?.subdomain) {
    return { subdomain: r.body.result.subdomain };
  }
  return null;
}

async function ensurePagesProject(token, accountId, project, siteName, d1Id, r2Name, owner, repoName) {
  // Pre-flight: look up by name first. GET returns 404 cleanly when
  // missing, which is far cheaper than a failed POST.
  const existing = await findPagesProject(token, accountId, project);
  if (existing) return { subdomain: existing.subdomain, reused: true };

  const payload = {
    name: project,
    production_branch: PROD_BRANCH,
    source: {
      type: 'github',
      config: {
        owner,
        repo_name: repoName,
        production_branch: PROD_BRANCH,
        production_deployments_enabled: true,
        deployments_enabled: true,
      },
    },
    deployment_configs: {
      production: {
        d1_databases: { DB: { id: d1Id } },
        r2_buckets:   { IMAGES: { name: r2Name } },
        ai_bindings:  { AI: {} },
        env_vars: {
          SITE_NAME: { type: 'plain_text', value: siteName },
        },
      },
      preview: {
        d1_databases: { DB: { id: d1Id } },
        r2_buckets:   { IMAGES: { name: r2Name } },
        ai_bindings:  { AI: {} },
        env_vars: {
          SITE_NAME: { type: 'plain_text', value: siteName },
        },
      },
    },
  };
  const r = await cfFetch(token, `/accounts/${accountId}/pages/projects`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (r.res.ok && r.body?.result?.subdomain) {
    return { subdomain: r.body.result.subdomain, reused: false };
  }
  // Race fallback: if a project appeared between pre-flight and create,
  // fetch it now rather than complain.
  const msg = firstErrorMessage(r.body) || '';
  if (/already exists|name is unavailable/i.test(msg)) {
    const after = await findPagesProject(token, accountId, project);
    if (after) return { subdomain: after.subdomain, reused: true };
  }
  throw new Error(msg || `Pages create failed (HTTP ${r.res.status})`);
}

async function patchSiteUrl(token, accountId, project, pagesUrl) {
  await cfFetch(token, `/accounts/${accountId}/pages/projects/${project}`, {
    method: 'PATCH',
    body: JSON.stringify({
      deployment_configs: {
        production: { env_vars: { SITE_URL: { type: 'plain_text', value: pagesUrl } } },
        preview:    { env_vars: { SITE_URL: { type: 'plain_text', value: pagesUrl } } },
      },
    }),
  }).catch(() => {}); // best-effort
}

async function triggerDeploy(token, accountId, project) {
  await cfFetch(token, `/accounts/${accountId}/pages/projects/${project}/deployments`, {
    method: 'POST',
  }).catch(() => {});
}

// ── handler ─────────────────────────────────────────────────────
export const onRequestPost = async ({ env, request }) => {
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }

  const token     = String(body?.token || '').trim();
  const owner     = String(body?.owner || '').trim();
  const repoName  = String(body?.repo  || '').trim() || DEFAULT_REPO_NAME;
  const project   = String(body?.project || '').trim().toLowerCase();
  const siteName  = String(body?.site_name || '').trim();
  const email     = String(body?.email || '').trim().toLowerCase();
  const password  = String(body?.password || '');

  if (!token)                return fail('validate', 400, 'API token required');
  if (!owner)                return fail('validate', 400, 'GitHub owner required — fork the repo to your account first');
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner)) return fail('validate', 400, 'GitHub owner: letters, digits, dashes only.');
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repoName))      return fail('validate', 400, 'Repo name: letters, digits, dot, dash, underscore.');
  if (!SLUG_RX.test(project)) return fail('validate', 400, 'Project slug: lowercase letters/digits/dashes, 2–33 chars, must start with a letter');
  if (!siteName)             return fail('validate', 400, 'Site name required');
  if (!EMAIL_RX.test(email)) return fail('validate', 400, 'Valid email required');
  if (password.length < 8)   return fail('validate', 400, 'Password must be 8+ characters');

  const fp = await tokenFingerprint(token);
  let state = (await loadState(env, project, fp)) || {};

  // ── step 1: account ─────────────────────────────────────────
  let account;
  if (state.account_id) {
    account = { id: state.account_id };
  } else {
    try { account = await ensureAccount(token); }
    catch (e) {
      await saveStep(env, project, fp, { last_step: 'account', last_error: String(e.message || e) });
      return fail('account', 401, String(e.message || e));
    }
    await saveStep(env, project, fp, { account_id: account.id, last_step: 'account', last_error: null });
  }

  // ── step 2: D1 ─────────────────────────────────────────────
  let d1Id = state.d1_id;
  if (!d1Id) {
    try {
      const d1 = await ensureD1(token, account.id, project);
      d1Id = d1.id;
      await saveStep(env, project, fp, { d1_id: d1Id, last_step: 'd1', last_error: null });
    } catch (e) {
      await saveStep(env, project, fp, { last_step: 'd1', last_error: String(e.message || e) });
      return fail('d1', 500, String(e.message || e));
    }
  }

  // ── step 3: R2 ─────────────────────────────────────────────
  let r2Name = state.r2_name;
  if (!r2Name) {
    const desiredName = project + '-images';
    try {
      const r2 = await ensureR2(token, account.id, desiredName);
      r2Name = r2.name;
      await saveStep(env, project, fp, { r2_name: r2Name, last_step: 'r2', last_error: null });
    } catch (e) {
      await saveStep(env, project, fp, { last_step: 'r2', last_error: String(e.message || e) });
      return fail('r2', 500, String(e.message || e));
    }
  }

  // ── step 4: Pages project ──────────────────────────────────
  let pagesUrl = state.pages_url;
  if (!state.pages_created) {
    try {
      const p = await ensurePagesProject(token, account.id, project, siteName, d1Id, r2Name, owner, repoName);
      pagesUrl = `https://${p.subdomain}`;
      await saveStep(env, project, fp, {
        pages_created: 1, pages_url: pagesUrl, last_step: 'pages', last_error: null,
      });
    } catch (e) {
      const msg = String(e.message || e);
      await saveStep(env, project, fp, { last_step: 'pages', last_error: msg });
      // Specific actionable hint when Cloudflare can't see the user's
      // repo. Usual causes:
      //   - they typed a wrong owner/repo (no such fork)
      //   - they haven't forked yet
      //   - they forked but haven't granted the Cloudflare Workers &
      //     Pages GitHub App access to the repo
      // The "install app" deeplink targets exactly this repo so the
      // user lands on the "select repositories" screen pre-narrowed.
      const extras = isGithubInstallError(msg) ? {
        hint: 'github_app_required',
        owner, repo: repoName,
        fork_url: `https://github.com/Benjamin-Bloch/pages-seo/fork`,
        repo_url: `https://github.com/${owner}/${repoName}`,
        github_app_install_url: `https://github.com/apps/cloudflare-workers-and-pages/installations/new/permissions?suggested_target_id=&repository_ids[]=`,
      } : {};
      return fail('pages', 500, msg, extras);
    }
  }

  // ── step 5: SITE_URL patch (always retry; cheap, idempotent) ─
  await patchSiteUrl(token, account.id, project, pagesUrl);

  // ── step 6: deploy ─────────────────────────────────────────
  if (!state.deploy_started) {
    await triggerDeploy(token, account.id, project);
    await saveStep(env, project, fp, { deploy_started: 1, last_step: 'deploy', last_error: null });
  }

  return json(200, {
    ok: true,
    pages_url: pagesUrl,
    account: { id: account.id },
    project,
    d1: { id: d1Id, name: project },
    r2: { name: r2Name },
    resumed: !!state.account_id,    // true if any state existed before this call
    seed: { email, password, site_name: siteName },
  });
};

// GET /api/install/provision?project=…&token_fp=…
// Lets the UI show prior state on a page reload so the user knows
// they have an install in progress they can resume. Optional — the
// client can just call POST again and we'll resume automatically.
export const onRequestGet = async ({ env, request }) => {
  const u = new URL(request.url);
  const project = (u.searchParams.get('project') || '').toLowerCase();
  const fp      = u.searchParams.get('token_fp')  || '';
  if (!project || !fp) return json(400, { error: 'missing_params' });
  const state = await loadState(env, project, fp);
  if (!state) return json(404, { ok: false, found: false });
  return json(200, { ok: true, found: true, state });
};
