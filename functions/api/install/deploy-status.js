// POST /api/install/deploy-status
//
// Returns the status of the most recent deployment on a Pages project
// so the installer's #done pane can detect Cloudflare build failures
// (the case where /api/install/check keeps timing out because the
// build never finished). Without this, the user just stares at a
// spinner forever; with this, we can swap into a "build failed, want
// to retry?" sub-state and offer one-click recovery.
//
// Body: { token, account_id, project }
//
// Response (200):
//   {
//     ok: true,
//     deployment_id: <uuid> | null,
//     status: 'success' | 'failure' | 'building' | 'queued' | 'unknown',
//     stage: <name> | null,        // e.g. 'build' | 'deploy'
//     created_on: <iso>,
//     short_id: <8-char>,
//     deployment_url: <preview url>,
//     build_log_url: <dashboard url> | null,
//     error_summary: <short msg> | null   // pulled from latest_stage.name + signals
//   }
//
// Response (401): token rejected
// Response (404): project not found (rare — user deleted it)
// Response (502): CF API unreachable
//
// Token + account_id come from the installer's lastBody; we never
// persist them.

import { json } from '../../_lib/util.js';

const CF_API = 'https://api.cloudflare.com/client/v4';

async function cfFetch(token, path) {
  const r = await fetch(CF_API + path, {
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
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

// Map Cloudflare's stage statuses to four buckets the UI cares about.
// Real values seen in the wild: 'queued', 'active', 'success',
// 'failure', 'canceled', 'skipped'. We treat 'canceled' as a failure
// from the user's perspective — it never got there.
function bucket(stageStatus) {
  if (!stageStatus) return 'unknown';
  const s = String(stageStatus).toLowerCase();
  if (s === 'success') return 'success';
  if (s === 'failure' || s === 'failed' || s === 'canceled' || s === 'cancelled') return 'failure';
  if (s === 'active' || s === 'queued' || s === 'idle') return 'building';
  return 'unknown';
}

// Build a one-liner reason from Cloudflare's deployment record. The
// API doesn't expose the full build log here — that's behind the
// dashboard — but the latest_stage's name + status combo is usually
// enough to tell the user what happened ("Build failed during
// 'build' stage" etc).
function summariseFailure(deployment) {
  const stages = Array.isArray(deployment?.stages) ? deployment.stages : [];
  const failed = stages.find((s) => bucket(s?.status) === 'failure');
  if (failed?.name) return `Failed during '${failed.name}' stage.`;
  const latest = deployment?.latest_stage;
  if (latest?.name && bucket(latest?.status) === 'failure') {
    return `Failed during '${latest.name}' stage.`;
  }
  return 'Build failed — open the build log for details.';
}

export const onRequestPost = async ({ request }) => {
  let payload;
  try { payload = await request.json(); }
  catch { return json(400, { ok: false, error: 'bad_json' }); }

  const token     = String(payload?.token      || '').trim();
  const accountId = String(payload?.account_id || '').trim().toLowerCase();
  const project   = String(payload?.project    || '').trim().toLowerCase();

  if (!token)                                              return json(400, { ok: false, error: 'missing_token' });
  if (!/^[a-f0-9]{32}$/.test(accountId))                   return json(400, { ok: false, error: 'bad_account_id' });
  if (!/^[a-z][a-z0-9-]{1,32}$/.test(project))             return json(400, { ok: false, error: 'bad_project' });

  // List the project's deployments (CF returns newest-first). We
  // only need the first.
  const r = await cfFetch(
    token,
    `/accounts/${accountId}/pages/projects/${project}/deployments?per_page=5&env=production`,
  );

  if (r.status === 401 || r.status === 403) {
    return json(401, { ok: false, error: 'token_rejected', detail: firstError(r.body) });
  }
  if (r.status === 404) {
    return json(404, { ok: false, error: 'project_not_found' });
  }
  if (!r.ok) {
    return json(502, { ok: false, error: 'cf_api_error', detail: firstError(r.body) || ('HTTP ' + r.status) });
  }

  const deployments = r.body?.result || [];
  if (!deployments.length) {
    return json(200, { ok: true, deployment_id: null, status: 'unknown', stage: null });
  }

  const latest = deployments[0];
  const status = bucket(latest?.latest_stage?.status);
  const stage  = latest?.latest_stage?.name || null;

  const out = {
    ok: true,
    deployment_id: latest?.id || null,
    short_id: (latest?.id || '').slice(0, 8),
    status,
    stage,
    created_on: latest?.created_on || null,
    deployment_url: latest?.url || null,
    build_log_url: latest?.id
      ? `https://dash.cloudflare.com/${accountId}/pages/view/${project}/${latest.id}`
      : null,
    error_summary: status === 'failure' ? summariseFailure(latest) : null,
  };

  return json(200, out, { 'cache-control': 'no-store' });
};
