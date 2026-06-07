// POST /api/install/redeploy
//
// One-click recovery for the case where the installer reached the
// "Deploying…" screen but Cloudflare's Workers Builds then errored
// (typically: forks pinned to an old commit, missing files, mirror
// drift). Triggered from the #done pane after /api/install/deploy-status
// reports status:'failure'.
//
// What it does:
//   1. Reads the user's GitHub OAuth session from cookie. Aborts if
//      absent (we never persist the GH token so we need the active
//      session).
//   2. POSTs github.com/.../merge-upstream to sync the fork against
//      Benjamin-Bloch/pages-seo main. Best-effort — a fork that's
//      already current returns merge_type: 'none' which we treat as
//      a no-op, not an error.
//   3. POSTs Cloudflare's deployments endpoint to trigger a fresh
//      build of the Pages project.
//
// Body: { token, account_id, project, owner, repo }
//   token       — CF API token (same one used at install time)
//   account_id  — CF account uuid
//   project     — Pages project slug
//   owner       — GitHub fork owner (login)
//   repo        — GitHub fork repo name
//
// Response (200):
//   {
//     ok: true,
//     sync: { merge_type, base_branch } | { error },
//     deploy: { id, url } | { error },
//   }
//
// Response (401): GH session missing OR CF token rejected
// Response (502): GitHub or CF unreachable
//
// We never persist any of the inputs. The CF token + IDs come
// straight from the browser's localStorage install-secrets, the GH
// token comes from the existing OAuth cookie. Everything is single-
// shot pass-through.

import { json } from '../../_lib/util.js';
import { readOAuthCookie } from '../../_lib/oauth_cookie.js';

const CF_API = 'https://api.cloudflare.com/client/v4';
const UPSTREAM_BRANCH = 'main';

async function cfFetch(token, path, init) {
  const r = await fetch(CF_API + path, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
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

async function syncFork(ghToken, owner, repo) {
  try {
    const r = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/merge-upstream`,
      {
        method: 'POST',
        headers: {
          Authorization: 'token ' + ghToken,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'pages-seo-install',
        },
        body: JSON.stringify({ branch: UPSTREAM_BRANCH }),
      },
    );
    let body = null;
    try { body = await r.json(); } catch { /* */ }
    if (!r.ok) {
      return { error: body?.message || ('HTTP ' + r.status), status: r.status };
    }
    return {
      merge_type:  body?.merge_type  || 'unknown',
      base_branch: body?.base_branch || UPSTREAM_BRANCH,
      message:     body?.message     || '',
    };
  } catch (e) {
    return { error: String(e?.message || e).slice(0, 200) };
  }
}

async function triggerCfDeploy(token, accountId, project) {
  // Cloudflare's /deployments POST takes an optional body; an empty
  // POST kicks off a fresh build using the project's current config.
  const r = await cfFetch(
    token,
    `/accounts/${accountId}/pages/projects/${project}/deployments`,
    { method: 'POST' },
  );
  if (r.status === 401 || r.status === 403) {
    return { error: 'token_rejected', detail: firstError(r.body) };
  }
  if (!r.ok) {
    return { error: 'cf_api_error', detail: firstError(r.body) || ('HTTP ' + r.status) };
  }
  const result = r.body?.result || {};
  return {
    id:  result.id  || null,
    url: result.url || null,
  };
}

export const onRequestPost = async ({ env, request }) => {
  let payload;
  try { payload = await request.json(); }
  catch { return json(400, { ok: false, error: 'bad_json' }); }

  const token     = String(payload?.token      || '').trim();
  const accountId = String(payload?.account_id || '').trim().toLowerCase();
  const project   = String(payload?.project    || '').trim().toLowerCase();
  const owner     = String(payload?.owner      || '').trim();
  const repo      = String(payload?.repo       || '').trim();

  if (!token)                                              return json(400, { ok: false, error: 'missing_token' });
  if (!/^[a-f0-9]{32}$/.test(accountId))                   return json(400, { ok: false, error: 'bad_account_id' });
  if (!/^[a-z][a-z0-9-]{1,32}$/.test(project))             return json(400, { ok: false, error: 'bad_project' });
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner))      return json(400, { ok: false, error: 'bad_owner' });
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo))               return json(400, { ok: false, error: 'bad_repo' });

  // Step 1: read GH session. Without it we can't sync the fork.
  // We don't require it for the CF redeploy alone — if the user lost
  // the cookie, we still trigger CF (which will rebuild whatever's
  // currently at the fork's tip).
  let ghToken = '';
  try {
    const session = await readOAuthCookie(env, request);
    ghToken = session?.token || '';
  } catch { /* */ }

  const sync = ghToken
    ? await syncFork(ghToken, owner, repo)
    : { error: 'no_github_session', detail: 'Sign in with GitHub again to sync your fork. Triggering Cloudflare redeploy with current fork state.' };

  // Step 2: trigger CF redeploy regardless. Even if sync failed, a
  // redeploy of whatever's at the fork's tip can clear transient CF-
  // side build flakiness.
  const deploy = await triggerCfDeploy(token, accountId, project);

  if (deploy.error === 'token_rejected') {
    return json(401, { ok: false, error: 'token_rejected', detail: deploy.detail, sync });
  }
  if (deploy.error) {
    return json(502, { ok: false, error: deploy.error, detail: deploy.detail, sync });
  }

  return json(200, { ok: true, sync, deploy });
};
