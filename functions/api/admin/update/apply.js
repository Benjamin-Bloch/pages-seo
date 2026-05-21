// POST /api/admin/update/apply
//
// Triggers a fresh deployment of the user's Pages project from their
// Git source. Works only for installs done via the browser flow at
// seo.benjaminb.xyz/install (those projects are linked to a GitHub
// fork). CLI installs use Direct Upload, which has no public REST
// API for re-deploys — those operators run the terminal command
// again to update.
//
// Request body:
//   { token: '<cloudflare api token>' }
//
// We accept the token per-call rather than persist it: an API token
// with Pages:Edit on the user's account has too much blast radius to
// sit in D1 alongside their content. The token never reaches storage.
//
// Flow:
//   1. Read install metadata from settings (account id, project slug,
//      installed SHA).
//   2. Tell GitHub to refresh the user's fork against upstream (we
//      can't — would need a GitHub token; user has to sync manually
//      OR enable the "sync fork on update" GitHub Action separately).
//      For v1 we just trigger the Pages rebuild and assume the user's
//      fork is up to date. UI tells them to click "Sync fork" on
//      GitHub first if not.
//   3. POST /accounts/<id>/pages/projects/<slug>/deployments with no
//      body → Cloudflare pulls latest commit from the linked fork
//      and rebuilds.
//   4. Wait for GitHub to report the latest SHA so we can store it
//      in settings.installed_sha for the next compare.

import { json, audit } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';
import { loadSettings, setSetting } from '../../../_lib/settings.js';

const CF_API = 'https://api.cloudflare.com/client/v4';

async function fetchLatestSha() {
  try {
    const r = await fetch(
      'https://api.github.com/repos/Benjamin-Bloch/pages-seo/commits/main',
      { headers: { 'User-Agent': 'pages-seo-update', Accept: 'application/vnd.github+json' } },
    );
    if (!r.ok) return '';
    const d = await r.json();
    return d?.sha || '';
  } catch { return ''; }
}

export const onRequestPost = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;

  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }

  const token = String(body?.token || '').trim();
  if (!token) return json(400, { error: 'token_required', detail: 'Paste a Cloudflare API token with Pages:Edit scope.' });

  const s = await loadSettings(env);
  // 'browser' installs come from /install (Git-linked Pages projects).
  // 'maintainer' installs (e.g. seo.benjaminb.xyz itself) are also
  // Git-linked — both share the same "trigger a redeploy" code path.
  // 'cli' installs use Direct Upload and have no Pages REST hook to
  // pull, so the operator re-runs the install one-liner instead.
  if (s.install_method !== 'browser' && s.install_method !== 'maintainer') {
    return json(409, {
      error: 'not_supported_for_install_method',
      detail: 'In-app update is only available for installs done via the browser or maintainer flow (Git-linked). For CLI installs, re-run the terminal installer command.',
    });
  }
  const accountId = String(s.install_cf_account || '').trim();
  const project   = String(s.install_cf_project || '').trim();
  if (!accountId || !project) {
    return json(409, { error: 'missing_install_metadata', detail: 'Account id or project slug not recorded at install time. Use the CLI updater instead.' });
  }

  // Trigger the rebuild. For Git-linked Pages projects the
  // /deployments endpoint expects a multipart/form-data POST with
  // the branch field — an empty JSON body returns 400 "A 'manifest'
  // field was expected in the request body" (the manifest path is
  // for Direct Upload deploys, which we're not doing here).
  const branch = String(s.production_branch || 'main').trim() || 'main';
  const form = new FormData();
  form.append('branch', branch);
  const r = await fetch(
    `${CF_API}/accounts/${accountId}/pages/projects/${project}/deployments`,
    { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form },
  );
  let respBody = null;
  try { respBody = await r.json(); } catch { /* */ }

  if (!r.ok) {
    const detail = (Array.isArray(respBody?.errors) && respBody.errors[0]?.message)
      || `Cloudflare returned HTTP ${r.status}`;
    return json(r.status || 502, { error: 'cloudflare_error', detail });
  }

  // Record the SHA we just kicked off. Best-effort — if GitHub is
  // unreachable, we leave installed_sha alone; the next /update GET
  // will show the same "X commits behind" until the next successful
  // fetch.
  const latestSha = await fetchLatestSha();
  if (latestSha) await setSetting(env, 'installed_sha', latestSha);
  await setSetting(env, 'update_dismissed_sha', latestSha || '');

  await audit(env, 'admin', 'update_apply', '', JSON.stringify({
    project, account: accountId, new_sha: latestSha || null,
  }));

  return json(200, {
    ok: true,
    deployment_id: respBody?.result?.id || null,
    deployment_url: respBody?.result?.url || null,
    new_sha: latestSha || null,
  });
};
