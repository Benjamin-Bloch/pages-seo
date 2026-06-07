// POST /api/update/github/sync
//   { owner: '<gh-login>', repo: 'pages-seo' }
//
// Calls GitHub's `merge-upstream` endpoint on the user's fork so it
// pulls in the latest commits from Benjamin-Bloch/pages-seo:main.
// Requires the OAuth cookie set by /api/update/github/callback.
//
// GitHub's endpoint: POST /repos/{owner}/{repo}/merge-upstream
// Docs: https://docs.github.com/en/rest/branches/branches#sync-a-fork-branch-with-the-upstream-repository
//
// Returns the merge result + the new HEAD SHA of the fork's main
// branch so the client can confirm the operation completed.

import { json } from '../../../_lib/util.js';
import { readOAuthCookie } from '../../../_lib/oauth_cookie.js';

const NAME_RX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export const onRequestPost = async ({ env, request }) => {
  const session = await readOAuthCookie(env, request);
  if (!session?.token) return json(401, { ok: false, error: 'gh_not_connected' });

  let body;
  try { body = await request.json(); } catch { return json(400, { ok: false, error: 'bad_json' }); }
  const owner = String(body?.owner || '').trim();
  const repo  = String(body?.repo  || '').trim() || 'pages-seo';
  if (!NAME_RX.test(owner)) return json(400, { ok: false, error: 'bad_owner' });
  if (!NAME_RX.test(repo))  return json(400, { ok: false, error: 'bad_repo' });

  // Optional sanity: make sure the OAuth session belongs to the same
  // GitHub login that's the fork's owner. This stops one user from
  // syncing another user's fork. GitHub will reject the merge call
  // anyway with a 403 if the token can't write, but failing here is
  // a clearer error.
  if (session.login && session.login.toLowerCase() !== owner.toLowerCase()) {
    return json(403, {
      ok: false,
      error: 'owner_mismatch',
      detail: `You connected as @${session.login} but are trying to sync ${owner}/${repo}. Re-connect with the right GitHub account.`,
    });
  }

  // Call merge-upstream.
  const r = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/merge-upstream`,
    {
      method: 'POST',
      headers: {
        Authorization: 'token ' + session.token,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'pages-seo-update',
        // Avoid stale 304s; the merge endpoint is happy with a fresh
        // payload every time.
        'If-None-Match': '',
      },
      body: JSON.stringify({ branch: 'main' }),
    },
  );
  let respBody = null;
  try { respBody = await r.json(); } catch { /* */ }

  if (!r.ok) {
    return json(r.status === 401 ? 401 : 502, {
      ok: false,
      error: 'github_merge_failed',
      detail: respBody?.message || `HTTP ${r.status}`,
    });
  }

  // Now fetch the new HEAD so the caller can confirm.
  let newSha = '';
  try {
    const headR = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits/main`,
      { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'pages-seo-update' } },
    );
    if (headR.ok) {
      const d = await headR.json();
      newSha = String(d?.sha || '');
    }
  } catch { /* non-fatal */ }

  return json(200, {
    ok: true,
    merge_type: respBody?.merge_type || 'unknown',  // 'fast-forward' | 'none' | 'merge'
    base_branch: respBody?.base_branch || 'unknown',
    new_sha: newSha,
  });
};
