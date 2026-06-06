// GET /api/github-stats
//
// Thin proxy + cache layer for github.com/Benjamin-Bloch/pages-seo
// repo stats. Fetches the repo metadata + latest release tag and
// returns the only four numbers the marketing page actually shows.
//
// Why this endpoint exists vs hitting api.github.com from the
// browser:
//   - GitHub's unauthenticated rate limit is 60 req/hr per IP, so
//     direct browser calls would burn through it on any popular day.
//   - Cloudflare's edge caches our response (10 min) so a single
//     origin hit serves every visitor in that colo for 10 min.
//   - We can strip out the ~70 fields GitHub returns and only ship
//     the four we use, saving bandwidth.
//
// Response (200, application/json):
//   {
//     ok: true,
//     stargazers_count: number,
//     forks_count: number,
//     open_issues_count: number,
//     latest_tag: string | null,
//     html_url: string,
//     fetched_at: <unix>
//   }
//
// Errors (502): { ok: false, error: 'upstream_failed' }
//
// CORS-open so the marketing page or any embed can use it.

import { json } from '../_lib/util.js';

const OWNER = 'Benjamin-Bloch';
const REPO  = 'pages-seo';

const EDGE_CACHE_SEC    = 600;  // 10 min at the edge
const BROWSER_CACHE_SEC = 120;  // 2 min in browser

async function fetchJson(url, headers) {
  const r = await fetch(url, { headers, cf: { cacheTtl: 600 } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

export const onRequestGet = async ({ env }) => {
  // GITHUB_TOKEN (optional secret) bumps the limit from 60 → 5000
  // req/hr. The endpoint works fine without it because we cache,
  // but on a high-traffic day the token is worth setting.
  const headers = {
    'User-Agent': 'pages-seo-github-stats',
    'Accept': 'application/vnd.github+json',
  };
  if (env?.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${env.GITHUB_TOKEN}`;

  try {
    // Two parallel calls — repo metadata + latest release. If the
    // release call 404s (no releases yet) we treat that as
    // "no tag" rather than failing the whole response.
    const repoUrl    = `https://api.github.com/repos/${OWNER}/${REPO}`;
    const releaseUrl = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
    const [repo, releaseRes] = await Promise.all([
      fetchJson(repoUrl, headers),
      fetch(releaseUrl, { headers, cf: { cacheTtl: 600 } }),
    ]);

    let latest_tag = null;
    if (releaseRes.ok) {
      const r = await releaseRes.json();
      latest_tag = r?.tag_name || null;
    }

    return json(200, {
      ok: true,
      stargazers_count: repo.stargazers_count ?? 0,
      forks_count:      repo.forks_count ?? 0,
      open_issues_count: repo.open_issues_count ?? 0,
      latest_tag,
      html_url: repo.html_url || `https://github.com/${OWNER}/${REPO}`,
      fetched_at: Math.floor(Date.now() / 1000),
    }, {
      'cache-control': `public, max-age=${BROWSER_CACHE_SEC}, s-maxage=${EDGE_CACHE_SEC}, stale-while-revalidate=86400`,
      'access-control-allow-origin': '*',
    });
  } catch (err) {
    return json(502, { ok: false, error: 'upstream_failed', detail: String(err.message || err).slice(0, 200) }, {
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
  }
};
