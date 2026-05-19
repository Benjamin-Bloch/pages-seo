// GET /api/admin/update
//
// Reports the user's installed commit SHA vs upstream main HEAD, plus
// the commit list between them and the changed-files diff stats from
// GitHub's public compare API. The Updates admin tab calls this on
// mount and on every refresh.
//
// Response shape:
//   {
//     ok: true,
//     install_method: 'browser' | 'cli' | '',
//     current: { sha: '<40-char hex>', short: '<7>', date: '<iso>' } | null,
//     latest:  { sha, short, date, message },
//     ahead:   N,                       // commits upstream is ahead by
//     up_to_date: bool,
//     can_apply: bool,                  // true only for browser installs
//     can_apply_reason: '<string>',     // why or why-not
//     repo: { owner, name },
//     commits: [ { sha, short, message, date, url, author } ],
//     files_changed: N,
//     additions: N,
//     deletions: N,
//     changelog_chunks: [ '<markdown>' ] | null,   // segments of CHANGELOG.md matching this range
//   }
//
// We use the unauthenticated GitHub API for read endpoints. Rate limit
// is 60/hour per source IP; Pages Functions share an outbound IP per
// colo so this is reasonable for a self-hosted admin tool that checks
// once per page load.

import { json } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';
import { loadSettings } from '../../../_lib/settings.js';

const UPSTREAM_OWNER = 'Benjamin-Bloch';
const UPSTREAM_REPO  = 'pages-seo';
const BRANCH = 'main';

function ghHeaders() {
  return {
    'User-Agent': 'pages-seo-update',
    Accept: 'application/vnd.github+json',
  };
}

async function fetchLatest() {
  const r = await fetch(
    `https://api.github.com/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/commits/${BRANCH}`,
    { headers: ghHeaders() },
  );
  if (!r.ok) throw new Error('github_latest_' + r.status);
  return r.json();
}

async function fetchCompare(base, head) {
  // GitHub's compare endpoint returns commits + stats in one call.
  // Capped at 250 commits — way more than any sane update window.
  const r = await fetch(
    `https://api.github.com/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/compare/${base}...${head}`,
    { headers: ghHeaders() },
  );
  if (!r.ok) throw new Error('github_compare_' + r.status);
  return r.json();
}

function short(sha) { return String(sha || '').slice(0, 7); }

export const onRequestGet = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;

  const s = await loadSettings(env);
  const installedSha = String(s.installed_sha || '').trim();
  const installMethod = String(s.install_method || '').trim();

  let latest;
  try { latest = await fetchLatest(); }
  catch (e) { return json(502, { ok: false, error: 'github_unreachable', detail: String(e?.message || e) }); }

  const latestSha = latest.sha;

  // Build the current-version block — null if we don't know what was
  // installed (CLI installs don't set installed_sha, or it was lost).
  const current = installedSha ? {
    sha: installedSha,
    short: short(installedSha),
    date: null, // filled in below if compare succeeds
  } : null;

  // If we don't know the installed SHA, return latest + a "we don't
  // know what you have" message. UI handles this.
  if (!installedSha) {
    return json(200, {
      ok: true,
      install_method: installMethod,
      current: null,
      latest: { sha: latestSha, short: short(latestSha), date: latest.commit?.author?.date || null, message: (latest.commit?.message || '').split('\n')[0] },
      ahead: null,
      up_to_date: false,
      can_apply: false,
      can_apply_reason: 'unknown_install_sha',
      repo: { owner: s.install_repo_owner || '', name: s.install_repo_name || '' },
      commits: [],
      files_changed: 0,
      additions: 0,
      deletions: 0,
    });
  }

  if (installedSha === latestSha) {
    return json(200, {
      ok: true,
      install_method: installMethod,
      current: { ...current, date: latest.commit?.author?.date || null },
      latest: { sha: latestSha, short: short(latestSha), date: latest.commit?.author?.date || null, message: (latest.commit?.message || '').split('\n')[0] },
      ahead: 0,
      up_to_date: true,
      can_apply: false,
      can_apply_reason: 'up_to_date',
      repo: { owner: s.install_repo_owner || '', name: s.install_repo_name || '' },
      commits: [],
      files_changed: 0,
      additions: 0,
      deletions: 0,
    });
  }

  // Compare installed → upstream HEAD.
  let cmp;
  try { cmp = await fetchCompare(installedSha, latestSha); }
  catch (e) { return json(502, { ok: false, error: 'github_compare_failed', detail: String(e?.message || e) }); }

  const commits = (cmp.commits || []).map((c) => ({
    sha: c.sha,
    short: short(c.sha),
    message: (c.commit?.message || '').split('\n')[0].slice(0, 200),
    date:    c.commit?.author?.date || null,
    url:     c.html_url,
    author:  c.author?.login || c.commit?.author?.name || 'unknown',
  }));

  const canApply = installMethod === 'browser';
  const canApplyReason = canApply
    ? 'browser_install'
    : (installMethod === 'cli' ? 'cli_install' : 'unknown_method');

  return json(200, {
    ok: true,
    install_method: installMethod,
    current: { ...current, date: null },  // we don't fetch the installed commit's date; cheap to skip
    latest: {
      sha: latestSha,
      short: short(latestSha),
      date: latest.commit?.author?.date || null,
      message: (latest.commit?.message || '').split('\n')[0],
    },
    ahead: commits.length,
    up_to_date: false,
    can_apply: canApply,
    can_apply_reason: canApplyReason,
    repo: { owner: s.install_repo_owner || '', name: s.install_repo_name || '' },
    commits,
    files_changed: cmp.files?.length || 0,
    additions: (cmp.files || []).reduce((n, f) => n + (f.additions || 0), 0),
    deletions: (cmp.files || []).reduce((n, f) => n + (f.deletions || 0), 0),
  });
};
