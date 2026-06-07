// GET /api/changes?since=<sha>
//
// What's new between the caller's installed commit and upstream
// HEAD. Used by the in-admin Updates tab to render release notes
// + a deploy button.
//
// Why not just point everyone at /api/update/diff? The diff endpoint
// was built specifically for the /update flow on seo.benjaminb.xyz
// and returns a wider shape (files_changed, additions, deletions)
// that we don't need for the admin view. This endpoint:
//
//   - Returns a tight { ok, up_to_date, ahead, commits, latest } shape
//   - Is edge-cached aggressively (~5 min) since the answer changes
//     only when upstream gains a commit
//   - Splits commit messages into subject + body so the admin UI can
//     render a richer card without the host parsing
//
// Query params:
//   since=<7-40 hex chars>   the caller's installed commit SHA.
//                            Required; missing → 400.
//   limit=<1-100>            cap on commits returned. Default 50.
//
// Response (200):
//   {
//     ok: true,
//     since:       '<input sha>',
//     latest:      { sha, short, message, date, html_url },
//     up_to_date:  bool,
//     ahead:       <count of commits between>,
//     commits: [
//       { sha, short, subject, body, date, url, author },
//       ...
//     ]
//   }
//
// Errors (4xx/5xx):
//   { ok: false, error: '...', detail: '...' }

import { json } from '../_lib/util.js';

const UPSTREAM_OWNER = 'Benjamin-Bloch';
const UPSTREAM_REPO  = 'pages-seo';
const BRANCH         = 'main';

const EDGE_CACHE_SEC    = 300;
const BROWSER_CACHE_SEC = 60;
const MAX_COMMITS       = 100;

// Authenticate when GITHUB_TOKEN is bound. The unauth fallback uses
// Cloudflare's shared edge-IP pool (60 req/hr) which is fine for
// most deployments but can 502 under load.
function ghHeaders(env) {
  const h = {
    'User-Agent': 'pages-seo-changes',
    Accept: 'application/vnd.github+json',
  };
  if (env?.GITHUB_TOKEN) {
    h.Authorization = 'Bearer ' + String(env.GITHUB_TOKEN).trim();
  }
  return h;
}
function short(sha) { return String(sha || '').slice(0, 7); }

// Split a commit message into subject (first line) + body (rest).
// Most commit UIs render these differently, so passing them
// pre-split saves the admin from re-doing it.
function splitMessage(msg) {
  const s = String(msg || '');
  const nl = s.indexOf('\n');
  if (nl === -1) return { subject: s.slice(0, 200), body: '' };
  return {
    subject: s.slice(0, nl).slice(0, 200),
    body: s.slice(nl + 1).trim().slice(0, 1200),
  };
}

export const onRequestGet = async ({ request, env }) => {
  const url = new URL(request.url);
  const since = String(url.searchParams.get('since') || '').trim().toLowerCase();
  const limit = Math.min(MAX_COMMITS, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 50));

  if (!since) return json(400, { ok: false, error: 'missing_since', detail: 'pass ?since=<sha>' });
  if (!/^[0-9a-f]{7,40}$/.test(since)) {
    return json(400, { ok: false, error: 'bad_sha', detail: 'since must be 7-40 hex chars' });
  }

  // Latest commit on main.
  let latest;
  try {
    const r = await fetch(
      `https://api.github.com/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/commits/${BRANCH}`,
      { headers: ghHeaders(env) },
    );
    if (!r.ok) {
      return json(502, { ok: false, error: 'github_latest_failed', detail: 'HTTP ' + r.status });
    }
    latest = await r.json();
  } catch (e) {
    return json(502, { ok: false, error: 'github_unreachable', detail: String(e?.message || e) });
  }

  const latestOut = {
    sha: latest.sha,
    short: short(latest.sha),
    message: (latest.commit?.message || '').split('\n')[0].slice(0, 200),
    date: latest.commit?.author?.date || null,
    html_url: latest.html_url,
  };

  // Up-to-date shortcut: the caller's SHA prefixes the latest, or
  // vice versa. Saves a compare call.
  if (since === latestOut.sha
      || latestOut.sha.startsWith(since)
      || since.startsWith(latestOut.sha.slice(0, since.length))) {
    return new Response(JSON.stringify({
      ok: true, since, latest: latestOut, up_to_date: true, ahead: 0, commits: [],
    }), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': `public, max-age=${BROWSER_CACHE_SEC}, s-maxage=${EDGE_CACHE_SEC}, stale-while-revalidate=86400`,
        'access-control-allow-origin': '*',
      },
    });
  }

  // Compare base → latest.
  let cmp;
  try {
    const r = await fetch(
      `https://api.github.com/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/compare/${since}...${latestOut.sha}`,
      { headers: ghHeaders(env) },
    );
    if (!r.ok) {
      // 404 here usually means the caller's SHA isn't an ancestor of
      // main any more — they're on a fork that diverged. Tell them
      // explicitly so the admin can surface a "your fork has
      // unrelated history" message instead of a generic 502.
      if (r.status === 404) {
        return json(409, {
          ok: false,
          error: 'sha_not_ancestor',
          detail: 'The installed SHA is not in upstream main\'s history. Your fork has diverged — see /docs#ts-marketing-page.',
          latest: latestOut,
        });
      }
      return json(502, { ok: false, error: 'github_compare_failed', detail: 'HTTP ' + r.status });
    }
    cmp = await r.json();
  } catch (e) {
    return json(502, { ok: false, error: 'github_unreachable', detail: String(e?.message || e) });
  }

  const commits = (cmp.commits || []).slice(0, limit).map((c) => {
    const { subject, body } = splitMessage(c.commit?.message);
    return {
      sha:     c.sha,
      short:   short(c.sha),
      subject,
      body,
      date:    c.commit?.author?.date || null,
      url:     c.html_url,
      author:  c.author?.login || c.commit?.author?.name || 'unknown',
    };
  });

  return new Response(JSON.stringify({
    ok: true,
    since,
    latest: latestOut,
    up_to_date: commits.length === 0,
    ahead: commits.length,
    commits,
  }, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${BROWSER_CACHE_SEC}, s-maxage=${EDGE_CACHE_SEC}, stale-while-revalidate=86400`,
      'access-control-allow-origin': '*',
    },
  });
};
