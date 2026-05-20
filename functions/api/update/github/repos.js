// GET /api/update/github/repos
//
// Uses the operator's OAuth token to figure out which of their
// repositories is the pages-seo fork.
//
// Strategy, in order of preference:
//   1. Try `<their-login>/pages-seo` — by far the most common case
//      because that's the default name when you click "Fork" on
//      GitHub. Fast: one GET. If it exists AND is a fork (parent ==
//      Benjamin-Bloch/pages-seo), we return it as the auto-pick.
//   2. Otherwise, search their repos for forks of upstream. The
//      `/user/repos` endpoint is paginated; we cap at the first 100
//      repos sorted by recent update (enough for almost everyone).
//      Returns every match so the SPA can render a dropdown.
//
// Response:
//   { ok: true,
//     login: 'alice',
//     auto: { owner, name, full_name, default_branch, html_url } | null,
//     candidates: [ { owner, name, full_name, default_branch, html_url, updated_at } ],
//     searched_count: <how many repos we scanned>,
//     more_pages: bool  // true if we stopped at the 100-repo cap
//   }

import { json } from '../../../_lib/util.js';
import { readOAuthCookie } from '../../../_lib/oauth_cookie.js';

const UPSTREAM_FULL_NAME = 'Benjamin-Bloch/pages-seo';
const DEFAULT_REPO_NAME  = 'pages-seo';
const SCAN_PAGES         = 4;     // up to 4 × 30 = 120 most-recent repos
const PER_PAGE           = 30;

function ghHeaders(token) {
  return {
    Authorization: 'token ' + token,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'pages-seo-update',
  };
}

function isPagesSeoFork(repo) {
  if (!repo?.fork) return false;
  // GitHub's repo list endpoint doesn't include `parent`; only the
  // detailed get-repo does. We accept any fork whose name matches our
  // canonical name OR whose description mentions us, then verify the
  // parent on demand. Cheaper than getting every fork individually.
  if ((repo.name || '').toLowerCase() === DEFAULT_REPO_NAME) return true;
  return false;
}

// Verifies the parent really is the upstream pages-seo. Done as a
// secondary check before we commit to a repo as "this is yours".
async function verifyFork(token, fullName) {
  const r = await fetch(`https://api.github.com/repos/${fullName}`, { headers: ghHeaders(token) });
  if (!r.ok) return null;
  const d = await r.json();
  if (!d?.fork) return null;
  const parent = d?.parent?.full_name;
  if (!parent || parent.toLowerCase() !== UPSTREAM_FULL_NAME.toLowerCase()) return null;
  return {
    owner: d.owner?.login,
    name:  d.name,
    full_name: d.full_name,
    default_branch: d.default_branch || 'main',
    html_url: d.html_url,
    updated_at: d.updated_at || null,
  };
}

export const onRequestGet = async ({ env, request }) => {
  const session = await readOAuthCookie(env, request);
  if (!session?.token) return json(401, { ok: false, error: 'gh_not_connected' });
  const token = session.token;
  const login = session.login || '';

  // 1. Fast path: try <login>/pages-seo by name.
  if (login) {
    const guess = `${login}/${DEFAULT_REPO_NAME}`;
    const verified = await verifyFork(token, guess);
    if (verified) {
      return json(200, {
        ok: true,
        login,
        auto: verified,
        candidates: [verified],
        searched_count: 1,
        more_pages: false,
      });
    }
  }

  // 2. Fallback: list user repos, keep the forks whose name matches,
  //    verify each parent. Cap at SCAN_PAGES pages of PER_PAGE.
  const candidates = [];
  let searched = 0;
  let morePages = false;
  for (let page = 1; page <= SCAN_PAGES; page++) {
    const r = await fetch(
      `https://api.github.com/user/repos?per_page=${PER_PAGE}&page=${page}&type=owner&sort=updated`,
      { headers: ghHeaders(token) },
    );
    if (!r.ok) break;
    const rows = await r.json().catch(() => []);
    if (!Array.isArray(rows) || !rows.length) break;
    searched += rows.length;
    for (const repo of rows) {
      if (isPagesSeoFork(repo)) {
        const v = await verifyFork(token, repo.full_name);
        if (v) candidates.push(v);
      }
    }
    if (rows.length < PER_PAGE) { morePages = false; break; }
    if (page === SCAN_PAGES) { morePages = true; break; }
  }

  // Dedup by full_name (the verifyFork loop should never produce
  // duplicates, but be defensive).
  const seen = new Set();
  const unique = candidates.filter((c) => {
    const k = c.full_name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  return json(200, {
    ok: true,
    login,
    auto: unique.length === 1 ? unique[0] : null,
    candidates: unique,
    searched_count: searched,
    more_pages: morePages,
  });
};
