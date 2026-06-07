// POST /api/install/repair
//
// Manual fallback for sites that were installed before self-repair
// secrets were added to the Pages project. The user supplies their
// CF API token + account id + project slug; we look up the project,
// figure out the D1 database id (by name = project slug) and R2
// bucket name (by name = `${slug}-images`), then PATCH the project
// to re-assert all bindings AND set the CF_* secrets so future
// repairs can be done in-site without the user copying their token
// in again.
//
// Returns 200 + { ok: true, bindings: {...}, deploy_triggered } on
// success.

import { json } from '../../_lib/util.js';

const CF_API = 'https://api.cloudflare.com/client/v4';

async function cfFetch(token, path, init = {}) {
  const res = await fetch(CF_API + path, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  let body = null;
  try { body = await res.json(); } catch { /* */ }
  return { res, body };
}

function firstError(body) {
  if (Array.isArray(body?.errors) && body.errors.length) {
    return body.errors.map((e) => e.message || String(e)).join(' · ');
  }
  return body?.error || null;
}

async function resolveAccount(token) {
  const r = await cfFetch(token, '/accounts');
  if (!r.res.ok || !r.body?.result?.length) {
    throw new Error(firstError(r.body) || 'Token rejected by Cloudflare.');
  }
  return r.body.result[0].id;
}

async function findD1(token, accountId, name) {
  const r = await cfFetch(token, `/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}&per_page=50`);
  if (!r.res.ok) return null;
  const hit = (r.body?.result || []).find((row) => row.name === name);
  return hit ? hit.uuid : null;
}

async function findR2(token, accountId, name) {
  let cursor = '';
  for (let i = 0; i < 5; i++) {
    const url = `/accounts/${accountId}/r2/buckets?per_page=100${cursor ? '&cursor=' + cursor : ''}`;
    const r = await cfFetch(token, url);
    if (!r.res.ok) return null;
    const buckets = r.body?.result?.buckets || r.body?.result || [];
    if (buckets.find((b) => b.name === name)) return name;
    cursor = r.body?.result_info?.cursor || '';
    if (!cursor) break;
  }
  return null;
}

export const onRequestPost = async ({ request }) => {
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }
  const token   = String(body?.token   || '').trim();
  const project = String(body?.project || '').trim().toLowerCase();
  let   accountId = String(body?.account_id || '').trim();
  if (!token)   return json(400, { error: 'missing_token' });
  if (!project) return json(400, { error: 'missing_project' });

  try {
    if (!accountId) accountId = await resolveAccount(token);

    // Look up the project so we can preserve existing env_vars.
    const projR = await cfFetch(token, `/accounts/${accountId}/pages/projects/${project}`);
    if (!projR.res.ok) {
      return json(404, { error: 'project_not_found', detail: firstError(projR.body) || ('HTTP ' + projR.res.status) });
    }
    const proj = projR.body?.result;
    const pagesUrl = proj?.subdomain ? `https://${proj.subdomain}` : '';

    // The installer's naming convention: D1 db name = project slug,
    // R2 bucket name = `${slug}-images`. We look them up by name so
    // this works whether or not the user remembers the IDs.
    const d1Id = await findD1(token, accountId, project);
    if (!d1Id) return json(404, { error: 'd1_not_found', detail: `No D1 database named "${project}". Re-run /install instead.` });
    const r2Name = await findR2(token, accountId, `${project}-images`);
    if (!r2Name) return json(404, { error: 'r2_not_found', detail: `No R2 bucket named "${project}-images". Re-run /install instead.` });

    const existingProdEnv = proj?.deployment_configs?.production?.env_vars || {};
    const existingPrevEnv = proj?.deployment_configs?.preview?.env_vars    || existingProdEnv;
    // Merge in the CF_* secrets so the site can self-repair next
    // time without going through this endpoint at all.
    const mergedProdEnv = {
      ...existingProdEnv,
      CF_API_TOKEN:  { type: 'secret_text', value: token },
      CF_ACCOUNT_ID: { type: 'secret_text', value: accountId },
      CF_PROJECT:    { type: 'plain_text',  value: project },
      CF_D1_ID:      { type: 'secret_text', value: d1Id },
      CF_R2_NAME:    { type: 'plain_text',  value: r2Name },
      SITE_URL: existingProdEnv.SITE_URL || { type: 'plain_text', value: pagesUrl },
    };
    const mergedPrevEnv = {
      ...existingPrevEnv,
      CF_API_TOKEN:  { type: 'secret_text', value: token },
      CF_ACCOUNT_ID: { type: 'secret_text', value: accountId },
      CF_PROJECT:    { type: 'plain_text',  value: project },
      CF_D1_ID:      { type: 'secret_text', value: d1Id },
      CF_R2_NAME:    { type: 'plain_text',  value: r2Name },
      SITE_URL: existingPrevEnv.SITE_URL || { type: 'plain_text', value: pagesUrl },
    };
    const bindings = {
      d1_databases: { DB:     { id: d1Id } },
      r2_buckets:   { IMAGES: { name: r2Name } },
      ai_bindings:  { AI: {} },
    };
    const patchBody = JSON.stringify({
      deployment_configs: {
        production: { ...bindings, env_vars: mergedProdEnv },
        preview:    { ...bindings, env_vars: mergedPrevEnv },
      },
    });

    // PATCH, GET-verify, PATCH-once-more on failure. Same retry shape
    // as provision.js to dodge Cloudflare's silent-drop behaviour.
    let patchR = await cfFetch(token, `/accounts/${accountId}/pages/projects/${project}`, { method: 'PATCH', body: patchBody });
    let verifyR = await cfFetch(token, `/accounts/${accountId}/pages/projects/${project}`);
    let prodAfter = verifyR.body?.result?.deployment_configs?.production || {};
    let dbOk = prodAfter?.d1_databases?.DB?.id === d1Id;
    let r2Ok = prodAfter?.r2_buckets?.IMAGES?.name === r2Name;
    let aiOk = !!prodAfter?.ai_bindings?.AI;
    let retried = false;
    if (!(dbOk && r2Ok && aiOk)) {
      retried = true;
      await cfFetch(token, `/accounts/${accountId}/pages/projects/${project}`, { method: 'PATCH', body: patchBody });
      verifyR = await cfFetch(token, `/accounts/${accountId}/pages/projects/${project}`);
      prodAfter = verifyR.body?.result?.deployment_configs?.production || {};
      dbOk = prodAfter?.d1_databases?.DB?.id === d1Id;
      r2Ok = prodAfter?.r2_buckets?.IMAGES?.name === r2Name;
      aiOk = !!prodAfter?.ai_bindings?.AI;
    }

    // Kick a fresh deployment so the live Functions actually pick up
    // the bindings. Without this the project config is correct but
    // the running Worker keeps serving the unbound build.
    const deployR = await cfFetch(token, `/accounts/${accountId}/pages/projects/${project}/deployments`, { method: 'POST' });

    const healthy = dbOk && r2Ok && aiOk;
    return json(healthy ? 200 : 500, {
      ok: healthy,
      project,
      pages_url: pagesUrl,
      bindings: { DB: dbOk, IMAGES: r2Ok, AI: aiOk },
      patch_retried: retried,
      deploy_triggered: deployR.res.ok,
      detail: healthy ? null : 'Bindings still missing after two PATCH attempts.',
    });
  } catch (e) {
    return json(500, { error: 'repair_failed', detail: String(e?.message || e) });
  }
};
