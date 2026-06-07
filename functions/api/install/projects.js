// POST /api/install/projects
//
// List the Pages projects on the user's Cloudflare account so /repair
// can auto-detect (or offer a picker for) the project slug. Saves the
// user a trip to the CF dashboard to look up the name they entered
// six months ago.
//
// Body: { token: '<cf api token>' }
// Response:
//   200 { ok, account: { id, name }, projects: [
//          { name, subdomain, created_on, has_pages_seo_d1, has_pages_seo_r2 }, ...
//        ] }
//   400 if token missing
//   401 if token rejected by CF
//   502 if CF API unreachable
//
// We don't read or persist the token here — it's passed through to
// the CF API one shot, then forgotten. The /repair page calls this
// endpoint, then sends the same token to /api/install/repair when
// the user confirms.
//
// `has_pages_seo_d1` / `has_pages_seo_r2` are best-effort hints
// (we look up D1 + R2 lists with the same token + check whether
// names matching the project slug exist). They let the UI label
// candidates as "Looks like a pages-seo install" so users with
// many projects can pick confidently.

import { json } from '../../_lib/util.js';

const CF_API = 'https://api.cloudflare.com/client/v4';

async function cfFetch(token, path) {
  const r = await fetch(CF_API + path, {
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
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

export const onRequestPost = async ({ request }) => {
  let payload;
  try { payload = await request.json(); }
  catch { return json(400, { ok: false, error: 'bad_json' }); }

  const token = String(payload?.token || '').trim();
  if (!token) return json(400, { ok: false, error: 'missing_token' });

  // 1. Resolve the account. The token works against one or more
  // accounts; we take the first (matching the rest of the install
  // flow's assumption that most users have one).
  const accountsR = await cfFetch(token, '/accounts');
  if (!accountsR.ok || !accountsR.body?.result?.length) {
    const detail = firstError(accountsR.body) || ('HTTP ' + accountsR.status);
    return json(accountsR.status === 401 || accountsR.status === 403 ? 401 : 502, {
      ok: false,
      error: 'token_rejected',
      detail,
      hint: 'The token didn\'t list any accounts. Re-create it via the link on /repair — make sure Account Settings: Read is checked.',
    });
  }
  const account = accountsR.body.result[0];
  const accountId = account.id;

  // 2. List Pages projects. Cloudflare paginates at 25/page; we
  // walk up to 8 pages (200 projects) which is more than any normal
  // account.
  const projects = [];
  for (let page = 1; page <= 8; page++) {
    const r = await cfFetch(token,
      `/accounts/${accountId}/pages/projects?page=${page}&per_page=25`);
    if (!r.ok) {
      return json(502, {
        ok: false,
        error: 'pages_list_failed',
        detail: firstError(r.body) || ('HTTP ' + r.status),
      });
    }
    const rows = r.body?.result || [];
    for (const p of rows) projects.push(p);
    if (rows.length < 25) break;
  }

  // 3. Best-effort: cross-reference D1 + R2 names. The install
  // convention is: D1 named exactly after the project slug; R2
  // bucket named "<slug>-images". A project where both exist is
  // almost certainly a pages-seo install — useful signal for the
  // picker UI.
  const slugs = projects.map((p) => p.name);
  const d1Hits = new Set();
  const r2Hits = new Set();
  try {
    // We list D1s and R2 buckets once each. Walking by name-filter
    // per project would be a request explosion; we take the
    // first page (50 each) and intersect.
    const d1R = await cfFetch(token, `/accounts/${accountId}/d1/database?per_page=50`);
    if (d1R.ok) {
      for (const d of (d1R.body?.result || [])) {
        if (slugs.includes(d.name)) d1Hits.add(d.name);
      }
    }
  } catch { /* non-fatal */ }
  try {
    const r2R = await cfFetch(token, `/accounts/${accountId}/r2/buckets?per_page=50`);
    if (r2R.ok) {
      const buckets = r2R.body?.result?.buckets || r2R.body?.result || [];
      for (const b of buckets) {
        const expected = b.name.replace(/-images$/, '');
        if (slugs.includes(expected)) r2Hits.add(expected);
      }
    }
  } catch { /* non-fatal */ }

  // 4. Map projects to the shape the picker needs.
  const out = projects.map((p) => ({
    name: p.name,
    subdomain: p.subdomain || `${p.name}.pages.dev`,
    created_on: p.created_on || null,
    domains: p.domains || [],
    has_pages_seo_d1: d1Hits.has(p.name),
    has_pages_seo_r2: r2Hits.has(p.name),
    looks_like_pages_seo: d1Hits.has(p.name) && r2Hits.has(p.name),
  }));

  // Sort: pages-seo-looking projects first (most likely the target),
  // then alphabetical.
  out.sort((a, b) => {
    if (a.looks_like_pages_seo !== b.looks_like_pages_seo) {
      return a.looks_like_pages_seo ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return json(200, {
    ok: true,
    account: { id: accountId, name: account.name || '' },
    projects: out,
  });
};
