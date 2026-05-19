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
const REPO_OWNER = 'Benjamin-Bloch';
const REPO_NAME  = 'pages-seo';
const PROD_BRANCH = 'main';

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

async function ensureD1(token, accountId, name) {
  // Try create. If it 4xxs with "already exists", fetch the list and
  // find the row with this name — we want to reuse it, not error out.
  const createR = await cfFetch(token, `/accounts/${accountId}/d1/database`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  if (createR.res.ok && createR.body?.result?.uuid) {
    return { id: createR.body.result.uuid, name, reused: false };
  }
  const msg = firstErrorMessage(createR.body) || '';
  if (/already exists/i.test(msg)) {
    // Resolve the existing one. D1 list is paginated; the page size
    // is small so we walk pages until we find it (cap at 5 pages /
    // 250 dbs which is well past anyone's realistic count).
    for (let page = 1; page <= 5; page++) {
      const listR = await cfFetch(token, `/accounts/${accountId}/d1/database?page=${page}&per_page=50`);
      if (!listR.res.ok) break;
      const rows = listR.body?.result || [];
      const hit = rows.find((r) => r.name === name);
      if (hit) return { id: hit.uuid, name, reused: true };
      if (rows.length < 50) break;
    }
    throw new Error(`D1 database named "${name}" exists on this account but couldn't be located — try a different project slug, or delete the existing database in the Cloudflare dashboard.`);
  }
  throw new Error(msg || 'Failed to create D1 database.');
}

async function ensureR2(token, accountId, name) {
  const r = await cfFetch(token, `/accounts/${accountId}/r2/buckets`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  if (r.res.ok) return { name, reused: false };
  // R2 returns 409 with "The bucket you tried to create already exists."
  // We treat that as a successful reuse.
  if (r.res.status === 409) return { name, reused: true };
  const msg = firstErrorMessage(r.body) || `R2 create failed (HTTP ${r.res.status})`;
  if (/already exists/i.test(msg)) return { name, reused: true };
  throw new Error(msg);
}

async function ensurePagesProject(token, accountId, project, siteName, d1Id, r2Name) {
  // Try create. If the project already exists for this account, return
  // its current subdomain so we can keep going (env patch + deploy
  // trigger are idempotent enough on their own).
  const payload = {
    name: project,
    production_branch: PROD_BRANCH,
    source: {
      type: 'github',
      config: {
        owner: REPO_OWNER,
        repo_name: REPO_NAME,
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
  const msg = firstErrorMessage(r.body) || '';
  if (/already exists|name is unavailable/i.test(msg)) {
    const existR = await cfFetch(token, `/accounts/${accountId}/pages/projects/${project}`);
    if (existR.res.ok && existR.body?.result?.subdomain) {
      return { subdomain: existR.body.result.subdomain, reused: true };
    }
    throw new Error(`Pages project "${project}" exists but couldn't be inspected — try a different slug.`);
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
  const project   = String(body?.project || '').trim().toLowerCase();
  const siteName  = String(body?.site_name || '').trim();
  const email     = String(body?.email || '').trim().toLowerCase();
  const password  = String(body?.password || '');

  if (!token)                return fail('validate', 400, 'API token required');
  if (!SLUG_RX.test(project)) return fail('validate', 400, 'Project slug: lowercase letters/digits/dashes, 2–33 chars, must start with a letter');
  if (!siteName)             return fail('validate', 400, 'Site name required');
  if (!EMAIL_RX.test(email)) return fail('validate', 400, 'Valid email required');
  if (password.length < 12)  return fail('validate', 400, 'Password must be 12+ characters');

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
      const p = await ensurePagesProject(token, account.id, project, siteName, d1Id, r2Name);
      pagesUrl = `https://${p.subdomain}`;
      await saveStep(env, project, fp, {
        pages_created: 1, pages_url: pagesUrl, last_step: 'pages', last_error: null,
      });
    } catch (e) {
      const msg = String(e.message || e);
      await saveStep(env, project, fp, { last_step: 'pages', last_error: msg });
      // Specific actionable hint when the user hasn't connected the
      // Cloudflare Workers & Pages GitHub App yet (or the install
      // lost its grant). They need to authorise the app once before
      // the Pages-create API can read from their fork.
      const extras = isGithubInstallError(msg) ? {
        hint: 'github_app_required',
        github_app_install_url: 'https://github.com/apps/cloudflare-workers-and-pages/installations/new',
        github_app_dashboard_url: 'https://dash.cloudflare.com/?to=/:account/workers-and-pages/create/pages',
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
