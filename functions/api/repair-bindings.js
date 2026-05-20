// POST /api/repair-bindings
//
// Self-repair. Cloudflare's Pages API has a known habit of silently
// dropping d1_databases / r2_buckets on PATCH (and occasionally on
// project create). When that happens, this site's Functions can't
// see env.DB and /admin shows `no_db_binding`. The installer ships
// the CF API token + account id + project slug as Pages secrets on
// every new project, so the site can fix itself: PATCH the project
// to re-assert bindings, then trigger a fresh deployment.
//
// Auth:
//   1. If env.DB is reachable, the caller must be an authenticated
//      admin (Bearer or session). This is the happy path: repair
//      after bindings were lost post-install.
//   2. If env.DB is missing (the very condition this endpoint exists
//      to fix), we fall back to the SETUP_TOKEN. The setup token is
//      shipped to the new admin as part of their magic link and is
//      the only credential available when there's no database to
//      authenticate against.
//
// All required env vars come from the installer:
//   CF_API_TOKEN  — secret, scoped to this account
//   CF_ACCOUNT_ID — secret
//   CF_PROJECT    — plain text, e.g. "breachwarden-seo-beta"
//   CF_D1_ID      — secret, the D1 database UUID
//   CF_R2_NAME    — plain text, the R2 bucket name
// If any are missing, returns 503 with which ones — the site was
// installed before the installer added them and can't self-repair.

import { json } from '../_lib/util.js';
import { requireAdminAsync } from '../_lib/auth.js';

const CF_API = 'https://api.cloudflare.com/client/v4';

async function tokensMatch(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
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

async function authorise(env, request, body) {
  // Path 1: DB is present and the caller is an admin.
  if (env?.DB) {
    const auth = await requireAdminAsync(env, request);
    if (auth) return { ok: true, via: auth.via };
  }
  // Path 2: DB is missing OR caller isn't admin yet — accept the
  // SETUP_TOKEN. This is the bootstrap path when /admin can't even
  // load the setup form because env.DB is unbound.
  const expected = String(env?.SETUP_TOKEN || '').trim();
  if (expected) {
    const supplied = String(body?.setup_token || '').trim();
    if (await tokensMatch(supplied, expected)) {
      return { ok: true, via: 'setup_token' };
    }
  }
  return { ok: false };
}

function missingEnvVars(env) {
  const need = ['CF_API_TOKEN', 'CF_ACCOUNT_ID', 'CF_PROJECT', 'CF_D1_ID', 'CF_R2_NAME'];
  return need.filter((k) => !env?.[k] || !String(env[k]).trim());
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
  try { body = await res.json(); } catch { /* */ }
  return { res, body };
}

async function getProject(token, accountId, project) {
  const r = await cfFetch(token, `/accounts/${accountId}/pages/projects/${project}`);
  if (!r.res.ok) return null;
  return r.body?.result || null;
}

function checkBindings(proj, expected) {
  const prod = proj?.deployment_configs?.production || {};
  return {
    DB:     prod?.d1_databases?.DB?.id === expected.d1Id,
    IMAGES: prod?.r2_buckets?.IMAGES?.name === expected.r2Name,
    AI:     !!prod?.ai_bindings?.AI,
  };
}

async function patchBindings(env, proj) {
  const token     = String(env.CF_API_TOKEN).trim();
  const accountId = String(env.CF_ACCOUNT_ID).trim();
  const project   = String(env.CF_PROJECT).trim();
  const d1Id      = String(env.CF_D1_ID).trim();
  const r2Name    = String(env.CF_R2_NAME).trim();

  // Preserve whatever env_vars the project already has — we only
  // want to re-assert bindings, not blow away SITE_URL etc. Pull the
  // production env_vars from the current project and pass them
  // through unchanged.
  const existingProdEnv = proj?.deployment_configs?.production?.env_vars || {};
  const existingPrevEnv = proj?.deployment_configs?.preview?.env_vars    || existingProdEnv;
  const bindings = {
    d1_databases: { DB:     { id: d1Id } },
    r2_buckets:   { IMAGES: { name: r2Name } },
    ai_bindings:  { AI: {} },
  };
  const body = JSON.stringify({
    deployment_configs: {
      production: { ...bindings, env_vars: existingProdEnv },
      preview:    { ...bindings, env_vars: existingPrevEnv },
    },
  });
  const r = await cfFetch(token, `/accounts/${accountId}/pages/projects/${project}`, {
    method: 'PATCH', body,
  });
  return { ok: r.res.ok, body: r.body };
}

async function triggerDeploy(env) {
  const token     = String(env.CF_API_TOKEN).trim();
  const accountId = String(env.CF_ACCOUNT_ID).trim();
  const project   = String(env.CF_PROJECT).trim();
  const r = await cfFetch(token, `/accounts/${accountId}/pages/projects/${project}/deployments`, {
    method: 'POST',
  });
  return { ok: r.res.ok };
}

// GET /api/repair-bindings — diagnostic. Returns which bindings the
// project currently has and which are missing. No auth required to
// read this — the only information leaked is whether the project
// is healthy, which an attacker can already probe via 503 responses
// on other endpoints.
export const onRequestGet = async ({ env }) => {
  const missing = missingEnvVars(env);
  if (missing.length) {
    return json(503, {
      ok: false,
      error: 'self_repair_unavailable',
      detail: 'This site was installed before self-repair credentials were added. Re-run /install on seo.benjaminb.xyz to upgrade.',
      missing,
    });
  }
  const token     = String(env.CF_API_TOKEN).trim();
  const accountId = String(env.CF_ACCOUNT_ID).trim();
  const project   = String(env.CF_PROJECT).trim();
  const d1Id      = String(env.CF_D1_ID).trim();
  const r2Name    = String(env.CF_R2_NAME).trim();
  const proj = await getProject(token, accountId, project);
  if (!proj) {
    return json(502, { ok: false, error: 'project_lookup_failed' });
  }
  const status = checkBindings(proj, { d1Id, r2Name });
  const healthy = status.DB && status.IMAGES && status.AI;
  return json(200, { ok: true, healthy, bindings: status, project });
};

export const onRequestPost = async ({ env, request }) => {
  let body = {};
  try { body = await request.json(); } catch { /* */ }

  const auth = await authorise(env, request, body);
  if (!auth.ok) return json(401, { error: 'unauthorized' });

  const missing = missingEnvVars(env);
  if (missing.length) {
    return json(503, {
      ok: false,
      error: 'self_repair_unavailable',
      detail: 'Missing CF_* secrets. Re-run /install to upgrade this site.',
      missing,
    });
  }

  const token     = String(env.CF_API_TOKEN).trim();
  const accountId = String(env.CF_ACCOUNT_ID).trim();
  const project   = String(env.CF_PROJECT).trim();
  const d1Id      = String(env.CF_D1_ID).trim();
  const r2Name    = String(env.CF_R2_NAME).trim();

  const proj = await getProject(token, accountId, project);
  if (!proj) return json(502, { ok: false, error: 'project_lookup_failed' });

  const before = checkBindings(proj, { d1Id, r2Name });
  const wasHealthy = before.DB && before.IMAGES && before.AI;

  // PATCH twice if needed — empirically a second PATCH catches the
  // cases where Cloudflare silently drops bindings on the first.
  await patchBindings(env, proj);
  let after = await getProject(token, accountId, project).then((p) => checkBindings(p, { d1Id, r2Name }));
  let retried = false;
  if (!(after.DB && after.IMAGES && after.AI)) {
    retried = true;
    await patchBindings(env, proj);
    after = await getProject(token, accountId, project).then((p) => checkBindings(p, { d1Id, r2Name }));
  }

  // Kick a fresh deployment so the bindings actually start flowing
  // to running Functions. Without this, bindings exist on the
  // project config but the live deploy keeps serving the unbound
  // Worker until something else triggers a build.
  const deploy = await triggerDeploy(env);

  const healthy = after.DB && after.IMAGES && after.AI;
  return json(healthy ? 200 : 500, {
    ok: healthy,
    via: auth.via,
    was_healthy: wasHealthy,
    bindings_before: before,
    bindings_after: after,
    patch_retried: retried,
    deploy_triggered: deploy.ok,
  });
};
