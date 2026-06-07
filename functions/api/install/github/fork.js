// POST /api/install/github/fork
//
// Ensures the user has a fork of Benjamin-Bloch/pages-seo on their
// GitHub account, creating one if needed. Returns the fork's owner
// + name so the installer can plug them into the Cloudflare Pages-
// from-Git source config.
//
// Why this exists: the previous install flow asked the operator to
// fork the repo manually before pasting any tokens. With GitHub
// OAuth in place we can do the fork on their behalf and skip the
// step entirely. The OAuth scope `public_repo` covers creating
// forks of public repos.
//
// Idempotent:
//   - If `<login>/pages-seo` exists AND is a fork of upstream, return it.
//   - If `<login>/pages-seo` exists but isn't a fork of upstream
//     (the user already has an unrelated repo with that name), we
//     return 409 and let the SPA prompt for a different name.
//   - Otherwise call POST /repos/upstream/forks; return the new fork.

import { json } from '../../../_lib/util.js';
import { readOAuthCookie } from '../../../_lib/oauth_cookie.js';

const UPSTREAM_OWNER = 'Benjamin-Bloch';
const UPSTREAM_REPO  = 'pages-seo';

// Cloudflare Workers & Pages GitHub App — slug stays stable across
// account migrations, unlike the numeric app ID.
const CF_APP_SLUG = 'cloudflare-workers-and-pages';

function ghHeaders(token) {
  return {
    Authorization: 'token ' + token,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'pages-seo-install',
  };
}

// Look up the Cloudflare Workers & Pages GitHub App installation on
// the user's account (or the org that owns the fork). Returns the
// installation id + repository_selection ("all" or "selected") or
// null if the app isn't installed.
//
// Why this matters: when Cloudflare Pages tries to clone the user's
// fork during build, it does so via this GitHub App. If the app
// isn't installed OR is installed with "selected" mode but the new
// fork isn't in the list, the Pages-create call later fails with
// "internal issue with your Cloudflare Pages Git installation"
// (the diagnostic that already triggers the manual-link fallback in
// the SPA). Auto-adding the fork to the installation here removes
// that failure mode entirely.
async function findCfInstallation(token) {
  const r = await fetch('https://api.github.com/user/installations?per_page=100', {
    headers: ghHeaders(token),
  });
  if (!r.ok) return null;
  const d = await r.json().catch(() => ({}));
  const list = Array.isArray(d?.installations) ? d.installations : [];
  // Match by app slug rather than app id — slug is human-readable
  // and stable; app_id can theoretically change if CF re-registers.
  const hit = list.find((i) => i?.app_slug === CF_APP_SLUG);
  if (!hit) return null;
  return {
    id: hit.id,
    repository_selection: hit.repository_selection, // 'all' | 'selected'
    target_login: hit.account?.login || null,
  };
}

// Add a repo to an installation's selected-repos list. No-op when
// the installation is in 'all' mode (the repo is already visible).
// Returns { ok, action } where action is 'added' | 'already' | 'all_mode'.
async function addRepoToInstallation(token, installation, repoId) {
  if (installation.repository_selection === 'all') {
    return { ok: true, action: 'all_mode' };
  }
  // PUT /user/installations/:installation_id/repositories/:repository_id
  // Idempotent: returns 204 whether the repo was already in the list
  // or freshly added.
  const r = await fetch(
    `https://api.github.com/user/installations/${installation.id}/repositories/${repoId}`,
    { method: 'PUT', headers: ghHeaders(token) },
  );
  if (r.status === 204) return { ok: true, action: 'added' };
  if (r.status === 304) return { ok: true, action: 'already' };
  let detail = 'HTTP ' + r.status;
  try { const d = await r.json(); detail = d?.message || detail; } catch { /* */ }
  return { ok: false, action: 'failed', detail };
}

// Best-effort: ensure the fork is visible to the Cloudflare Workers
// & Pages GitHub App. Returns a small status object the caller can
// pass through to the SPA. Never throws — every failure mode falls
// back to "user can click the manual link" which the SPA already
// handles, so the install isn't blocked by anything here.
async function ensureCfAppAccess(token, repoId, repoFullName) {
  if (!repoId) return { ok: false, reason: 'no_repo_id' };
  try {
    const installation = await findCfInstallation(token);
    if (!installation) {
      return {
        ok: false,
        reason: 'not_installed',
        install_url: `https://github.com/apps/${CF_APP_SLUG}/installations/new`,
      };
    }
    const result = await addRepoToInstallation(token, installation, repoId);
    return {
      ok: result.ok,
      reason: result.action,
      installation_id: installation.id,
      target: installation.target_login,
      detail: result.detail || null,
    };
  } catch (e) {
    return { ok: false, reason: 'exception', detail: String(e?.message || e) };
  }
}

async function lookupRepo(token, fullName) {
  const r = await fetch(`https://api.github.com/repos/${fullName}`, { headers: ghHeaders(token) });
  if (r.status === 404) return { exists: false };
  if (!r.ok) return { exists: null, error: 'HTTP ' + r.status };
  const d = await r.json();
  return {
    exists: true,
    id: d?.id || null,
    is_fork: !!d?.fork,
    parent_full_name: d?.parent?.full_name || null,
    default_branch: d?.default_branch || 'main',
    owner: d?.owner?.login,
    name: d?.name,
    html_url: d?.html_url,
  };
}

export const onRequestPost = async ({ env, request }) => {
  const session = await readOAuthCookie(env, request);
  if (!session?.token) return json(401, { ok: false, error: 'gh_not_connected' });
  if (!session?.login) return json(401, { ok: false, error: 'no_gh_login' });

  const token = session.token;
  const login = session.login;
  const fullName = `${login}/${UPSTREAM_REPO}`;

  // Already have a fork?
  const existing = await lookupRepo(token, fullName);
  if (existing.exists && existing.is_fork) {
    const parentOk = existing.parent_full_name &&
      existing.parent_full_name.toLowerCase() === `${UPSTREAM_OWNER}/${UPSTREAM_REPO}`.toLowerCase();
    if (parentOk) {
      // Sync the existing fork to upstream main. This is the
      // critical step — without it, a user who forked weeks ago
      // and is reinstalling today gets the OLD code, and their
      // Pages deploy serves the wrong site (with the maintainer's
      // marketing page, the installer routes still present, etc).
      // GitHub's merge-upstream endpoint is idempotent and a
      // no-op if the fork is already current.
      const sync = await fetch(
        `https://api.github.com/repos/${fullName}/merge-upstream`,
        {
          method: 'POST',
          headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
          body: JSON.stringify({ branch: existing.default_branch || 'main' }),
        },
      );
      let syncResult = null;
      try { syncResult = await sync.json(); } catch { /* */ }
      // We tolerate sync errors here (e.g. dirty fork with diverged
      // history) — the install still works, the user just gets the
      // last-synced version of the code on this deploy. The error
      // detail makes it past so the UI can surface it.
      const cfAccess = await ensureCfAppAccess(token, existing.id, `${existing.owner}/${existing.name}`);
      return json(200, {
        ok: true,
        action: sync.ok && syncResult?.merge_type !== 'none' ? 'reused_synced' : 'reused',
        owner: existing.owner,
        repo: existing.name,
        full_name: `${existing.owner}/${existing.name}`,
        default_branch: existing.default_branch,
        html_url: existing.html_url,
        sync_result: sync.ok ? { merge_type: syncResult?.merge_type || 'unknown' }
                             : { error: syncResult?.message || 'HTTP ' + sync.status },
        cf_app_access: cfAccess,
      });
    }
    return json(409, {
      ok: false,
      error: 'wrong_parent',
      detail: `${fullName} is a fork of ${existing.parent_full_name}, not the upstream pages-seo. Rename it on GitHub or use a different account.`,
    });
  }
  if (existing.exists && !existing.is_fork) {
    return json(409, {
      ok: false,
      error: 'name_taken',
      detail: `You already have a repository named "${UPSTREAM_REPO}" on GitHub that isn't a fork. Rename it on GitHub (or delete it) so we can create the fork.`,
      html_url: existing.html_url,
    });
  }

  // Create the fork.
  const r = await fetch(
    `https://api.github.com/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/forks`,
    {
      method: 'POST',
      headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
      // Empty body — GitHub uses the authenticated user as the
      // fork owner by default. We could pass { name: 'something' }
      // to rename but want to keep the canonical name.
      body: '{}',
    },
  );
  if (!r.ok) {
    let detail = 'HTTP ' + r.status;
    try { const d = await r.json(); detail = d?.message || detail; } catch { /* */ }
    return json(502, { ok: false, error: 'fork_failed', detail });
  }

  const created = await r.json().catch(() => ({}));

  // GitHub creates forks asynchronously — the POST returns 202 with
  // the new repo's metadata, but a few seconds may pass before
  // /repos/<login>/<repo> is fully populated. That's fine for our
  // purposes (Cloudflare's later Pages-create call retries).
  const cfAccess = await ensureCfAppAccess(token, created.id, created.full_name || fullName);
  return json(200, {
    ok: true,
    action: 'created',
    owner: created.owner?.login || login,
    repo: created.name || UPSTREAM_REPO,
    full_name: created.full_name || fullName,
    default_branch: created.default_branch || 'main',
    html_url: created.html_url || `https://github.com/${fullName}`,
    cf_app_access: cfAccess,
  });
};
