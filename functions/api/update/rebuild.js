// POST /api/update/rebuild
//   { token: '<cf-api-token>', owner: '<gh-login>', repo: 'pages-seo' }
//
// Triggers a fresh Cloudflare Pages deployment for the user's project.
// We resolve the user's Cloudflare account id from the token, find
// the Pages project whose Git source matches the supplied owner+repo,
// and POST to /accounts/<id>/pages/projects/<slug>/deployments.
//
// Why a different shape than the admin's /api/admin/update/apply:
//   - That endpoint runs inside a user's own install (knows its own
//     account id + project slug from settings).
//   - This one runs on seo.benjaminb.xyz for everyone. We don't know
//     anything about their project until they tell us. The token
//     identifies the account; the owner+repo lets us pick the right
//     project. The token is never persisted.
//
// Returns the pages.dev URL so the SPA can link to /admin on the
// freshly-rebuilt site.

import { json } from '../../_lib/util.js';

const CF_API = 'https://api.cloudflare.com/client/v4';

async function cf(token, path, init = {}) {
  const r = await fetch(CF_API + path, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  let body = null;
  try { body = await r.json(); } catch { /* non-JSON */ }
  return { res: r, body };
}

function firstErrorMessage(body) {
  if (!body) return null;
  if (Array.isArray(body.errors) && body.errors.length) {
    return body.errors.map((e) => e.message || String(e)).join(' · ');
  }
  return body.error || body.detail || null;
}

const NAME_RX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export const onRequestPost = async ({ request }) => {
  let body;
  try { body = await request.json(); } catch { return json(400, { ok: false, error: 'bad_json' }); }

  const token = String(body?.token || '').trim();
  const owner = String(body?.owner || '').trim();
  const repo  = String(body?.repo  || '').trim() || 'pages-seo';
  if (!token)               return json(400, { ok: false, error: 'token_required' });
  if (!NAME_RX.test(owner)) return json(400, { ok: false, error: 'bad_owner' });
  if (!NAME_RX.test(repo))  return json(400, { ok: false, error: 'bad_repo' });

  // 1. Resolve the account id from the token.
  const accR = await cf(token, '/accounts');
  if (!accR.res.ok || !accR.body?.result?.length) {
    return json(401, { ok: false, error: 'token_rejected', detail: firstErrorMessage(accR.body) || 'check scopes' });
  }
  const accountId = accR.body.result[0].id;

  // 2. Find the project that points at this fork. Pages projects
  //    don't expose their source in `list`, so we have to GET each
  //    project's detail. Walk the project list (paginated, ~25 per
  //    page) and bail as soon as we find a match.
  let page = 1, perPage = 25, found = null;
  while (page <= 8) {
    const listR = await cf(token, `/accounts/${accountId}/pages/projects?page=${page}&per_page=${perPage}`);
    if (!listR.res.ok) {
      return json(502, { ok: false, error: 'list_projects_failed', detail: firstErrorMessage(listR.body) || ('HTTP ' + listR.res.status) });
    }
    const rows = listR.body?.result || [];
    for (const p of rows) {
      const src = p?.source?.config || {};
      if (src.owner && src.repo_name &&
          src.owner.toLowerCase() === owner.toLowerCase() &&
          src.repo_name.toLowerCase() === repo.toLowerCase()) {
        found = p;
        break;
      }
    }
    if (found) break;
    if (rows.length < perPage) break;
    page++;
  }

  if (!found) {
    return json(404, {
      ok: false,
      error: 'project_not_found',
      detail: `No Pages project on this Cloudflare account is linked to ${owner}/${repo}. Did you select the wrong account, or use the CLI install path?`,
    });
  }

  const projectName = found.name;
  const subdomain = found.subdomain || `${projectName}.pages.dev`;

  // 3. Trigger a fresh deployment. Empty body = re-pull from the
  //    configured Git source. Cloudflare returns 200 + the new
  //    deployment object.
  const depR = await cf(token, `/accounts/${accountId}/pages/projects/${projectName}/deployments`, { method: 'POST' });
  if (!depR.res.ok) {
    return json(depR.res.status || 502, {
      ok: false,
      error: 'deploy_failed',
      detail: firstErrorMessage(depR.body) || ('HTTP ' + depR.res.status),
    });
  }

  return json(200, {
    ok: true,
    project: projectName,
    pages_url: `https://${subdomain}`,
    deployment_id: depR.body?.result?.id || null,
  });
};
