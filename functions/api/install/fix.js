// POST /api/install/fix
//
// Apply a single fix for an issue surfaced by /api/install/diagnose.
// Body: { token, project, action, args? }
//
// Actions:
//   rebind        — PATCH project deployment_configs to re-assert
//                   d1_databases/DB, r2_buckets/IMAGES, ai_bindings/AI.
//                   Looks up the D1 db by name (= project) and the
//                   R2 bucket by name (= project-images).
//   add_secrets   — PATCH env_vars to add CF_API_TOKEN, CF_ACCOUNT_ID,
//                   CF_PROJECT, CF_D1_ID, CF_R2_NAME (preserving any
//                   existing env_vars unchanged).
//   sync_fork     — POST /repos/{owner}/{repo}/merge-upstream to
//                   pull upstream main into the user's fork.
//                   Requires the user supply a GitHub OAuth token
//                   via /api/update/github/start; the fix endpoint
//                   reads the cookie. If no cookie is present we
//                   return a 401 with a CTA to go through the OAuth
//                   flow.
//   redeploy      — POST a new deployment on the Pages project.
//
// All actions are idempotent — running them when there's nothing to
// fix returns ok:true with action: 'no-op'.

import { json, audit } from '../../_lib/util.js';
import { readOAuthCookie } from '../../_lib/oauth_cookie.js';

const CF_API = 'https://api.cloudflare.com/client/v4';
const UPSTREAM_OWNER = 'Benjamin-Bloch';
const UPSTREAM_REPO  = 'pages-seo';

async function cfFetch(token, path, init = {}) {
  const r = await fetch(CF_API + path, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  let body = null;
  try { body = await r.json(); } catch { /* */ }
  return { status: r.status, ok: r.ok, body };
}
function firstError(body) {
  if (Array.isArray(body?.errors) && body.errors.length) {
    return body.errors.map((e) => e.message || String(e)).join(' · ');
  }
  return body?.error || null;
}

async function resolveAccountId(token) {
  const r = await cfFetch(token, '/accounts');
  if (!r.ok || !r.body?.result?.length) {
    throw new Error('token_rejected: ' + (firstError(r.body) || ''));
  }
  return r.body.result[0].id;
}

async function findD1Id(token, accountId, name) {
  const r = await cfFetch(token, `/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}&per_page=10`);
  const hit = (r.body?.result || []).find((d) => d.name === name);
  return hit?.uuid || null;
}

async function findR2Name(token, accountId, name) {
  const r = await cfFetch(token, `/accounts/${accountId}/r2/buckets?per_page=100`);
  const buckets = r.body?.result?.buckets || r.body?.result || [];
  return buckets.find((b) => b.name === name) ? name : null;
}

async function fetchProject(token, accountId, project) {
  const r = await cfFetch(token, `/accounts/${accountId}/pages/projects/${project}`);
  if (!r.ok) throw new Error('project_not_found');
  return r.body?.result;
}

async function rebindAction(token, accountId, project, env) {
  const proj = await fetchProject(token, accountId, project);
  const d1Id = await findD1Id(token, accountId, project);
  if (!d1Id) throw new Error('d1_not_found: no D1 database named "' + project + '"');
  const r2 = await findR2Name(token, accountId, project + '-images');
  if (!r2) throw new Error('r2_not_found: no R2 bucket named "' + project + '-images"');

  // Preserve existing env_vars; only assert bindings + ensure CF_*
  // secrets remain (running rebind shouldn't wipe them).
  const prodEnv = proj?.deployment_configs?.production?.env_vars || {};
  const prevEnv = proj?.deployment_configs?.preview?.env_vars || prodEnv;

  const bindings = {
    d1_databases: { DB:     { id: d1Id } },
    r2_buckets:   { IMAGES: { name: r2 } },
    ai_bindings:  { AI: {} },
  };

  const r = await cfFetch(token, `/accounts/${accountId}/pages/projects/${project}`, {
    method: 'PATCH',
    body: JSON.stringify({
      deployment_configs: {
        production: { ...bindings, env_vars: prodEnv },
        preview:    { ...bindings, env_vars: prevEnv },
      },
    }),
  });
  if (!r.ok) throw new Error('patch_failed: ' + (firstError(r.body) || r.status));

  // Verify by GET.
  const after = await fetchProject(token, accountId, project);
  const verified = after?.deployment_configs?.production?.d1_databases?.DB?.id === d1Id;

  audit(env, 'admin', 'repair_rebind', project, { d1Id, r2, verified });
  return { ok: true, action: 'rebind', d1: { id: d1Id, name: project }, r2: { name: r2 }, verified };
}

async function addSecretsAction(token, accountId, project, env) {
  const proj = await fetchProject(token, accountId, project);
  const prodEnv = proj?.deployment_configs?.production?.env_vars || {};
  const prevEnv = proj?.deployment_configs?.preview?.env_vars || prodEnv;
  const d1Id = proj?.deployment_configs?.production?.d1_databases?.DB?.id
    || (await findD1Id(token, accountId, project));
  const r2 = proj?.deployment_configs?.production?.r2_buckets?.IMAGES?.name
    || (await findR2Name(token, accountId, project + '-images'));
  if (!d1Id || !r2) {
    throw new Error('bindings_required_first: run rebind before add_secrets');
  }

  const secretFields = {
    CF_API_TOKEN:  { type: 'secret_text', value: token },
    CF_ACCOUNT_ID: { type: 'secret_text', value: accountId },
    CF_PROJECT:    { type: 'plain_text',  value: project },
    CF_D1_ID:      { type: 'secret_text', value: d1Id },
    CF_R2_NAME:    { type: 'plain_text',  value: r2 },
  };

  const r = await cfFetch(token, `/accounts/${accountId}/pages/projects/${project}`, {
    method: 'PATCH',
    body: JSON.stringify({
      deployment_configs: {
        production: { env_vars: { ...prodEnv, ...secretFields } },
        preview:    { env_vars: { ...prevEnv, ...secretFields } },
      },
    }),
  });
  if (!r.ok) throw new Error('patch_failed: ' + (firstError(r.body) || r.status));
  audit(env, 'admin', 'repair_add_secrets', project, {});
  return { ok: true, action: 'add_secrets' };
}

async function syncForkAction({ args, request, env }) {
  // We need a GitHub OAuth token. Read it from the install-flow cookie.
  const session = await readOAuthCookie(env, request).catch(() => null);
  if (!session?.token) {
    return {
      ok: false, error: 'gh_oauth_required',
      detail: 'Sign in with GitHub first. The /repair page has a link in the help text — open /install and sign in once, then come back.',
      sign_in_url: '/api/update/github/start?flow=install&state=',
    };
  }
  const owner  = args?.owner;
  const repo   = args?.repo;
  const branch = args?.branch || 'main';
  if (!owner || !repo) return { ok: false, error: 'missing_args' };

  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/merge-upstream`, {
    method: 'POST',
    headers: {
      Authorization: 'token ' + session.token,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'pages-seo-repair',
    },
    body: JSON.stringify({ branch }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    return {
      ok: false, error: 'merge_failed',
      detail: body?.message || ('HTTP ' + r.status),
      hint: 'If the merge has conflicts you\'ll need to resolve them on GitHub manually, then re-run repair.',
    };
  }
  audit(env, 'admin', 'repair_sync_fork', owner + '/' + repo, { branch, merge_type: body?.merge_type });
  return { ok: true, action: 'sync_fork', merge_type: body?.merge_type || 'unknown', base_branch: body?.base_branch || branch };
}

async function redeployAction(token, accountId, project, env) {
  const r = await cfFetch(token, `/accounts/${accountId}/pages/projects/${project}/deployments`, {
    method: 'POST',
  });
  if (!r.ok) throw new Error('deploy_failed: ' + (firstError(r.body) || r.status));
  audit(env, 'admin', 'repair_redeploy', project, {});
  return { ok: true, action: 'redeploy' };
}

export const onRequestPost = async ({ env, request }) => {
  let payload;
  try { payload = await request.json(); }
  catch { return json(400, { ok: false, error: 'bad_json' }); }

  const token   = String(payload?.token   || '').trim();
  const project = String(payload?.project || '').trim().toLowerCase();
  const action  = String(payload?.action  || '').trim();
  if (!token)   return json(400, { ok: false, error: 'missing_token' });
  if (!project) return json(400, { ok: false, error: 'missing_project' });
  if (!action)  return json(400, { ok: false, error: 'missing_action' });

  let accountId;
  try { accountId = await resolveAccountId(token); }
  catch (e) {
    return json(401, { ok: false, error: 'token_rejected', detail: String(e?.message || e).slice(0, 200) });
  }

  try {
    if (action === 'rebind') {
      const out = await rebindAction(token, accountId, project, env);
      return json(200, out);
    }
    if (action === 'add_secrets') {
      const out = await addSecretsAction(token, accountId, project, env);
      return json(200, out);
    }
    if (action === 'sync_fork') {
      const out = await syncForkAction({ args: payload.args, request, env });
      return json(out.ok ? 200 : 400, out);
    }
    if (action === 'redeploy') {
      const out = await redeployAction(token, accountId, project, env);
      return json(200, out);
    }
    return json(400, { ok: false, error: 'unknown_action', got: action });
  } catch (e) {
    return json(500, { ok: false, error: 'fix_failed', detail: String(e?.message || e).slice(0, 240) });
  }
};
