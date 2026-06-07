// GET /api/update/diff[?base=<sha>]
//
// Public endpoint (no auth) that returns commits between the user-
// supplied base SHA and upstream main HEAD. If no base is given we
// return latest + a "we don't know your baseline" hint.
//
// Used by /update to render the "what's new" pane before the user
// commits to anything sensitive. GitHub's public API is unauthed up
// to ~60 requests/hour per IP; this endpoint exists so we share
// pages-seo's Pages-side IP for the rate-limit pool rather than the
// visitor's home IP.

import { json } from '../../_lib/util.js';

const UPSTREAM_OWNER = 'Benjamin-Bloch';
const UPSTREAM_REPO  = 'pages-seo';
const BRANCH         = 'main';

function ghHeaders() {
  return {
    'User-Agent': 'pages-seo-update',
    Accept: 'application/vnd.github+json',
  };
}

function short(sha) { return String(sha || '').slice(0, 7); }

export const onRequestGet = async ({ request }) => {
  const url = new URL(request.url);
  const base = String(url.searchParams.get('base') || '').trim();
  if (base && !/^[0-9a-f]{7,40}$/.test(base)) {
    return json(400, { ok: false, error: 'bad_sha' });
  }

  // 1. Latest upstream.
  let latest;
  try {
    const r = await fetch(
      `https://api.github.com/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/commits/${BRANCH}`,
      { headers: ghHeaders() },
    );
    if (!r.ok) {
      return json(502, { ok: false, error: 'github_latest_failed', detail: 'HTTP ' + r.status });
    }
    latest = await r.json();
  } catch (e) {
    return json(502, { ok: false, error: 'github_unreachable', detail: String(e?.message || e) });
  }

  const latestSha = latest.sha;
  const latestOut = {
    sha: latestSha,
    short: short(latestSha),
    date: latest.commit?.author?.date || null,
    message: (latest.commit?.message || '').split('\n')[0],
  };

  if (!base) {
    // No baseline SHA, so we can't diff -- but fetch the last 30 commits
    // on main (server-side, sharing this Pages IP's GitHub rate limit
    // rather than the visitor's) to give the user something to read.
    let recent = [];
    try {
      const r = await fetch(
        `https://api.github.com/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/commits?per_page=30`,
        { headers: ghHeaders() },
      );
      if (r.ok) {
        const arr = await r.json();
        if (Array.isArray(arr)) {
          recent = arr.map((c) => ({
            sha: c.sha,
            short: short(c.sha),
            message: (c.commit?.message || '').split('\n')[0].slice(0, 200),
            date:    c.commit?.author?.date || null,
            url:     c.html_url,
            author:  c.author?.login || c.commit?.author?.name || 'unknown',
          }));
        }
      }
    } catch { /* recent list is best-effort */ }
    return json(200, {
      ok: true,
      latest: latestOut,
      current: null,
      ahead: null,
      up_to_date: false,
      commits: [],
      recent,
      files_changed: 0,
      additions: 0,
      deletions: 0,
    });
  }

  if (base === latestSha || latestSha.startsWith(base) || base.startsWith(latestSha.slice(0, base.length))) {
    return json(200, {
      ok: true,
      latest: latestOut,
      current: { sha: base, short: short(base) },
      ahead: 0,
      up_to_date: true,
      commits: [],
      files_changed: 0,
      additions: 0,
      deletions: 0,
    });
  }

  // 2. Compare base → latest.
  let cmp;
  try {
    const r = await fetch(
      `https://api.github.com/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/compare/${base}...${latestSha}`,
      { headers: ghHeaders() },
    );
    if (!r.ok) {
      return json(502, { ok: false, error: 'github_compare_failed', detail: 'HTTP ' + r.status });
    }
    cmp = await r.json();
  } catch (e) {
    return json(502, { ok: false, error: 'github_unreachable', detail: String(e?.message || e) });
  }

  const commits = (cmp.commits || []).map((c) => ({
    sha: c.sha,
    short: short(c.sha),
    message: (c.commit?.message || '').split('\n')[0].slice(0, 200),
    date:    c.commit?.author?.date || null,
    url:     c.html_url,
    author:  c.author?.login || c.commit?.author?.name || 'unknown',
  }));

  return json(200, {
    ok: true,
    latest: latestOut,
    current: { sha: base, short: short(base) },
    ahead: commits.length,
    up_to_date: commits.length === 0,
    commits,
    files_changed: cmp.files?.length || 0,
    additions: (cmp.files || []).reduce((n, f) => n + (f.additions || 0), 0),
    deletions: (cmp.files || []).reduce((n, f) => n + (f.deletions || 0), 0),
  });
};
