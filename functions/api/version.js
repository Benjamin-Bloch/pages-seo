// GET /api/version
//
// Canonical "what version is upstream pages-seo at" endpoint.
// Returns the latest commit on Benjamin-Bloch/pages-seo's main
// branch + the latest release tag if any. Used by:
//
//   - the in-admin Updates tab (compare current vs upstream)
//   - the top-bar version badge in /admin
//   - third-party install managers that want a stable URL to poll
//
// Why this endpoint exists vs hitting api.github.com directly:
//
//   - GitHub's unauth limit is 60 req/hr per IP. Every visitor
//     to /admin polling the API would burn through that fast on
//     a popular install. With this endpoint, the call is shared:
//     Cloudflare's edge serves a cached response and we hit
//     GitHub at most once every 5 minutes per colo.
//
//   - Single source of truth — if we ever switch to a different
//     repo or add a "stable" channel, consumers don't need to
//     update their poll URL.
//
//   - Lets us add tag/changelog metadata GitHub's API doesn't
//     bundle by default.
//
// Response (200, content-type: application/json):
//   {
//     ok: true,
//     // Latest commit on main
//     sha, short, message, date, html_url, author,
//     // Latest release
//     tag, tag_html_url, tag_name, tag_published_at,
//     release_notes,                    // body of the latest GH release
//     commits_since_tag,                // int, or null on error
//     // Recent commits on main (last 20, newest first)
//     recent_commits: [
//       { sha, short, message, date, url, author }
//     ],
//     fetched_at: <unix seconds>
//   }
//
// Backward-compatible: every field that existed in v1 is still present.
//
// Errors (502, content-type: application/json):
//   { ok: false, error: 'github_unreachable' | 'github_<step>_failed', detail: '...' }

import { json } from '../_lib/util.js';

const UPSTREAM_OWNER = 'Benjamin-Bloch';
const UPSTREAM_REPO  = 'pages-seo';
const BRANCH         = 'main';

// Cache header tuning: 5 min at the edge, 60s in browsers. We want
// admin pollers to converge on the cached copy without burning the
// rate limit, but a fresh deploy should propagate within ~5 minutes.
const EDGE_CACHE_SEC    = 300;
const BROWSER_CACHE_SEC = 60;

// Build headers for GitHub. When env binds GITHUB_TOKEN we use it
// (5000 req/hr authenticated). Otherwise unauth (60 req/hr per IP,
// which on Cloudflare's shared edge IPs gets exhausted fast — this
// endpoint then returns 502s until the next minute reset). The
// admin Updates tab handles those 502s gracefully as transient.
function ghHeaders(env) {
  const h = {
    'User-Agent': 'pages-seo-version',
    Accept: 'application/vnd.github+json',
  };
  if (env?.GITHUB_TOKEN) {
    h.Authorization = 'Bearer ' + String(env.GITHUB_TOKEN).trim();
  }
  return h;
}

function short(sha) { return String(sha || '').slice(0, 7); }

// Fetch latest commit on main. Returns shape suitable for the
// response, or null on error (caller bubbles up a 502).
async function fetchLatestCommit(env) {
  const r = await fetch(
    `https://api.github.com/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/commits/${BRANCH}`,
    { headers: ghHeaders(env) },
  );
  if (!r.ok) return { error: 'github_latest_failed', detail: 'HTTP ' + r.status };
  const c = await r.json();
  return {
    sha: c.sha,
    short: short(c.sha),
    message: (c.commit?.message || '').split('\n')[0].slice(0, 200),
    date: c.commit?.author?.date || null,
    html_url: c.html_url,
    author: c.author?.login || c.commit?.author?.name || null,
  };
}

// Fetch latest release tag + body (changelog). Returns { tag, tag_html_url,
// tag_name, tag_published_at, release_notes } or all-null if no releases
// exist. Errors are non-fatal — we'll just omit fields from the response.
async function fetchLatestTag(env) {
  try {
    const r = await fetch(
      `https://api.github.com/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/releases/latest`,
      { headers: ghHeaders(env) },
    );
    // 404 = no releases ever published. Not an error in our model.
    if (r.status === 404 || !r.ok) {
      return { tag: null, tag_html_url: null, tag_name: null, tag_published_at: null, release_notes: null };
    }
    const d = await r.json();
    return {
      tag: d.tag_name || null,
      tag_html_url: d.html_url || null,
      tag_name: d.name || d.tag_name || null,
      tag_published_at: d.published_at || null,
      // Trim long release bodies — typical changelogs are well under 4 KB.
      release_notes: String(d.body || '').slice(0, 4000) || null,
    };
  } catch {
    return { tag: null, tag_html_url: null, tag_name: null, tag_published_at: null, release_notes: null };
  }
}

// Fetch the last 20 commits on main. Trimmed shape for the response;
// authoritative SHA + first-line message + author + date. Used by
// consumers to render "what's coming since v<installed>" lists.
async function fetchRecentCommits(env, { perPage = 20 } = {}) {
  try {
    const r = await fetch(
      `https://api.github.com/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/commits?sha=${BRANCH}&per_page=${perPage}`,
      { headers: ghHeaders(env) },
    );
    if (!r.ok) return [];
    const arr = await r.json();
    if (!Array.isArray(arr)) return [];
    return arr.map((c) => ({
      sha: c.sha,
      short: short(c.sha),
      message: (c.commit?.message || '').split('\n')[0].slice(0, 200),
      date: c.commit?.author?.date || null,
      url: c.html_url,
      author: c.author?.login || c.commit?.author?.name || null,
    }));
  } catch { return []; }
}

// Count commits between the latest release tag and main HEAD. Uses
// /compare which gives us ahead/behind cheaply. Returns null on error
// or when no tag exists yet (the caller decides what to render).
async function fetchCommitsSinceTag(env, tag) {
  if (!tag) return null;
  try {
    const r = await fetch(
      `https://api.github.com/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/compare/${encodeURIComponent(tag)}...${BRANCH}`,
      { headers: ghHeaders(env) },
    );
    if (!r.ok) return null;
    const d = await r.json();
    // `ahead_by` is the count on the right side (main) vs the left (tag).
    return typeof d.ahead_by === 'number' ? d.ahead_by : null;
  } catch { return null; }
}

export const onRequestGet = async ({ request, env }) => {
  // Stage 1: independent lookups in parallel. The count-since-tag
  // depends on the tag value, so that one waits for stage 1.
  const [commit, tag, recent_commits] = await Promise.all([
    fetchLatestCommit(env),
    fetchLatestTag(env),
    fetchRecentCommits(env, { perPage: 20 }),
  ]);

  if (commit?.error) {
    return json(502, {
      ok: false,
      error: commit.error,
      detail: commit.detail,
      hint: 'GitHub may be rate-limiting or briefly unreachable. The cached response from /api/version will resume serving as soon as a successful refresh lands.',
    });
  }

  // Stage 2: count commits between the latest tag and main HEAD.
  // Skipped if we have no tag, or when tag == HEAD (nothing to compare).
  const commits_since_tag = (tag?.tag && tag.tag !== commit.sha)
    ? await fetchCommitsSinceTag(env, tag.tag)
    : (tag?.tag ? 0 : null);

  return new Response(JSON.stringify({
    ok: true,
    sha: commit.sha,
    short: commit.short,
    message: commit.message,
    date: commit.date,
    html_url: commit.html_url,
    author: commit.author,
    tag: tag.tag,
    tag_html_url: tag.tag_html_url,
    tag_name: tag.tag_name || null,
    tag_published_at: tag.tag_published_at || null,
    release_notes: tag.release_notes || null,
    commits_since_tag,
    recent_commits,
    fetched_at: Math.floor(Date.now() / 1000),
  }, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Browsers refresh after 1 min, edge caches for 5 min, and
      // the stale-while-revalidate buys us 1 day of "stale but
      // usable" service if GitHub goes down briefly.
      'cache-control': `public, max-age=${BROWSER_CACHE_SEC}, s-maxage=${EDGE_CACHE_SEC}, stale-while-revalidate=86400`,
      'access-control-allow-origin': '*',
    },
  });
};
