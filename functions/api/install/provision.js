// POST /api/install/provision
//
// One-shot installer endpoint. Takes the user's Cloudflare API token
// + install details and provisions:
//   1. The user's account id (from /accounts).
//   2. A D1 database named after their project slug.
//   3. An R2 bucket named "<slug>-images".
//   4. A Pages project bound to the GitHub repo with all three
//      bindings configured + the Workers AI binding.
//   5. Triggers the first deployment.
//
// Schema application + admin-user seeding happen in the *target* site's
// own /api/setup endpoint after the first deploy finishes. The
// installer doesn't try to apply schema directly to D1 over the API —
// D1's REST `query` endpoint only accepts single statements and would
// need a separate trip per CREATE TABLE.
//
// The user's API token never leaves the installer's process. We do
// not persist it.

import { json } from '../../_lib/util.js';

const CF_API = 'https://api.cloudflare.com/client/v4';
const REPO_OWNER = 'Benjamin-Bloch';
const REPO_NAME  = 'pages-seo';
const PROD_BRANCH = 'main';

function fail(at, status, detail) {
  return json(status, { ok: false, failed_at: at, error: 'install_failed', detail });
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

const SLUG_RX = /^[a-z][a-z0-9-]{1,32}$/;
const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const onRequestPost = async ({ request }) => {
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }

  const token     = String(body?.token || '').trim();
  const project   = String(body?.project || '').trim().toLowerCase();
  const siteName  = String(body?.site_name || '').trim();
  const email     = String(body?.email || '').trim().toLowerCase();
  const password  = String(body?.password || '');

  if (!token)               return fail('validate', 400, 'API token required');
  if (!SLUG_RX.test(project)) return fail('validate', 400, 'Project slug: lowercase letters/digits/dashes, 2–33 chars, must start with a letter');
  if (!siteName)            return fail('validate', 400, 'Site name required');
  if (!EMAIL_RX.test(email)) return fail('validate', 400, 'Valid email required');
  if (password.length < 12) return fail('validate', 400, 'Password must be 12+ characters');

  // ── 1. account ──────────────────────────────────────────────
  const accR = await cfFetch(token, '/accounts');
  if (!accR.res.ok || !accR.body?.result?.length) {
    return fail('account', 401, firstErrorMessage(accR.body) || 'Token rejected by Cloudflare (check scopes).');
  }
  const accountId = accR.body.result[0].id;
  const accountName = accR.body.result[0].name;

  // ── 2. D1 database ──────────────────────────────────────────
  const d1Name = project;
  const d1R = await cfFetch(token, `/accounts/${accountId}/d1/database`, {
    method: 'POST',
    body: JSON.stringify({ name: d1Name }),
  });
  if (!d1R.res.ok || !d1R.body?.result?.uuid) {
    return fail('d1', d1R.res.status || 500, firstErrorMessage(d1R.body) || 'Failed to create D1 database (slug taken on this account?).');
  }
  const d1Id = d1R.body.result.uuid;

  // ── 3. R2 bucket ────────────────────────────────────────────
  const r2Name = project + '-images';
  const r2R = await cfFetch(token, `/accounts/${accountId}/r2/buckets`, {
    method: 'POST',
    body: JSON.stringify({ name: r2Name }),
  });
  // R2 returns 409 if the bucket already exists on this account — we
  // tolerate that (the user may have run the installer before) but
  // not other failures.
  if (!r2R.res.ok && r2R.res.status !== 409) {
    return fail('r2', r2R.res.status || 500, firstErrorMessage(r2R.body) || 'Failed to create R2 bucket.');
  }

  // ── 4. Pages project ────────────────────────────────────────
  // Bindings, env vars, and the GitHub source all go in this one
  // call. Production-only deployment configs — we don't bother with
  // preview branches for installs.
  const pagesPayload = {
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

  const pagesR = await cfFetch(token, `/accounts/${accountId}/pages/projects`, {
    method: 'POST',
    body: JSON.stringify(pagesPayload),
  });
  if (!pagesR.res.ok || !pagesR.body?.result?.subdomain) {
    return fail('pages', pagesR.res.status || 500, firstErrorMessage(pagesR.body) || 'Failed to create Pages project. The slug may already be in use on Cloudflare Pages.');
  }
  const subdomain = pagesR.body.result.subdomain;
  const pagesUrl  = `https://${subdomain}`;

  // SITE_URL needs to point at the Pages domain. We set it after the
  // project exists because we don't know the subdomain until then.
  // (Cloudflare assigns one of the form `<slug>-<hash>.pages.dev` if
  // the bare `<slug>.pages.dev` is taken.)
  const envPatch = {
    deployment_configs: {
      production: {
        env_vars: {
          SITE_URL: { type: 'plain_text', value: pagesUrl },
        },
      },
      preview: {
        env_vars: {
          SITE_URL: { type: 'plain_text', value: pagesUrl },
        },
      },
    },
  };
  await cfFetch(token, `/accounts/${accountId}/pages/projects/${project}`, {
    method: 'PATCH',
    body: JSON.stringify(envPatch),
  });
  // Best-effort: if the PATCH fails, the in-app /api/setup still
  // works because it can derive SITE_URL from settings the user
  // submits there. We don't block the install on this.

  // ── 5. Kick off the first deployment ────────────────────────
  // Creating a Pages project with a GitHub source enables deploys but
  // doesn't trigger one immediately. We POST /deployments to fire the
  // first build right away.
  await cfFetch(token, `/accounts/${accountId}/pages/projects/${project}/deployments`, {
    method: 'POST',
  });

  // ── 6. Stash the seed payload for /api/setup on the new site ──
  // We can't reach the new site's /api/setup yet — it's still
  // building. The new install will reach our /api/install/seed-info
  // endpoint with its project slug on first boot to fetch the
  // pre-supplied email + password + SITE_NAME so the operator never
  // has to type them twice.
  //
  // Storage: keep it on THIS site's D1 (the installer's), encrypted
  // at rest with a random key embedded in the URL we hand back. We
  // don't have access to the new site's D1 to write directly. For
  // v1, we skip this convenience step — the user will type their
  // password once into the /admin first-run setup card after the
  // deploy completes. That's still a clean experience.

  return json(200, {
    ok: true,
    pages_url: pagesUrl,
    account: { id: accountId, name: accountName },
    project,
    d1: { id: d1Id, name: d1Name },
    r2: { name: r2Name },
    // Pre-fill these in the first-run setup form on the new site so
    // the operator doesn't retype them. Sent back to the browser
    // (not stored).
    seed: { email, password, site_name: siteName },
  });
};
