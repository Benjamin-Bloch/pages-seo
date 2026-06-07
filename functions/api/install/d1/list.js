// POST /api/install/d1/list
//
// Lists every D1 database on the user's Cloudflare account so the
// installer can offer an inline "your D1 cap is full — pick one to
// delete" recovery flow. Triggered when /api/install/provision
// returns hint: 'd1_quota_exceeded' on the d1 step.
//
// Body: { token: '<cf api token>', account_id?: '<id>' }
//   - account_id is optional. If absent we resolve it from /accounts
//     the same way provision.js does. Browser sends it through from
//     the failed provision response so we don't burn an extra round
//     trip.
//
// Response (200):
//   {
//     ok: true,
//     account: { id, name },
//     limit:   10,                 // free-tier cap; informational
//     count:   <number>,
//     databases: [
//       { uuid, name, created_at, num_tables, file_size, version },
//       ...
//     ]
//   }
//
// Response (401): token rejected
// Response (502): Cloudflare API unreachable
//
// We do NOT persist the token — single-shot pass-through.

import { json } from '../../../_lib/util.js';

const CF_API = 'https://api.cloudflare.com/client/v4';
// Free tier cap; bumped to 50,000 on Workers Paid but we display
// the free cap because that's where users hit the wall.
const FREE_TIER_D1_CAP = 10;

async function cfFetch(token, path) {
  const r = await fetch(CF_API + path, {
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  });
  let body = null;
  try { body = await r.json(); } catch { /* non-JSON, ignore */ }
  return { status: r.status, ok: r.ok, body };
}

function firstError(body) {
  if (Array.isArray(body?.errors) && body.errors.length) {
    return body.errors.map((e) => e.message || String(e)).join(' · ');
  }
  return body?.error || null;
}

async function resolveAccount(token, accountIdHint) {
  if (accountIdHint && /^[a-f0-9]{32}$/i.test(accountIdHint)) {
    // Verify the hint resolves — guards against a stale id the
    // browser cached from a different token.
    const r = await cfFetch(token, `/accounts/${accountIdHint}`);
    if (r.ok && r.body?.result?.id) {
      return { id: r.body.result.id, name: r.body.result.name };
    }
  }
  // Fall back to the first account on the token.
  const accountsR = await cfFetch(token, '/accounts');
  if (!accountsR.ok || !accountsR.body?.result?.length) return null;
  const a = accountsR.body.result[0];
  return { id: a.id, name: a.name };
}

export const onRequestPost = async ({ request }) => {
  let payload;
  try { payload = await request.json(); }
  catch { return json(400, { ok: false, error: 'bad_json' }); }

  const token = String(payload?.token || '').trim();
  if (!token) return json(400, { ok: false, error: 'missing_token' });

  const account = await resolveAccount(token, payload?.account_id);
  if (!account) {
    return json(401, {
      ok: false,
      error: 'token_rejected',
      detail: 'Token didn\'t resolve any account. Re-create it on /install.',
    });
  }

  // List D1 databases — walks up to 5 pages of 50, more than enough
  // since the free-tier cap is 10. (Paginating defensively in case
  // a future cap bump means a token can see more.)
  const databases = [];
  for (let page = 1; page <= 5; page++) {
    const r = await cfFetch(
      token,
      `/accounts/${account.id}/d1/database?page=${page}&per_page=50`,
    );
    if (!r.ok) {
      // Token doesn't have d1:read scope — surface that specifically.
      if (r.status === 403) {
        return json(403, {
          ok: false,
          error: 'd1_read_denied',
          detail: 'Your token can\'t list D1 databases. Re-create it with the D1:Edit scope included.',
        });
      }
      const detail = firstError(r.body) || ('HTTP ' + r.status);
      return json(502, { ok: false, error: 'cf_api_error', detail });
    }
    const rows = r.body?.result || [];
    for (const d of rows) {
      databases.push({
        uuid:       d.uuid,
        name:       d.name,
        created_at: d.created_at,
        num_tables: d.num_tables ?? null,
        file_size:  d.file_size  ?? null,
        version:    d.version    ?? null,
      });
    }
    if (rows.length < 50) break;
  }

  return json(200, {
    ok: true,
    account,
    limit: FREE_TIER_D1_CAP,
    count: databases.length,
    databases,
  }, {
    // Result is account-private — never cache at any layer.
    'cache-control': 'no-store',
  });
};
