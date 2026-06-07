// POST /api/install/d1/delete
//
// Deletes a single D1 database from the user's Cloudflare account.
// Used by the installer's "D1 cap full" recovery flow: list →
// pick one → delete → retry the install.
//
// Body: { token: '<cf api token>', account_id: '<id>', uuid: '<d1-uuid>' }
//   token and account_id are required so we can scope the delete to
//   the account the user explicitly authorised. uuid is the D1 to
//   delete. We don't accept a name — D1 names are user-chosen and
//   easy to typo; the uuid is unambiguous.
//
// Response (200): { ok: true, uuid, deleted: true }
// Response (400): missing/bad fields, or uuid format wrong
// Response (401): token rejected
// Response (403): token lacks d1:write
// Response (404): db doesn't exist (already deleted, harmless)
// Response (502): Cloudflare API unreachable / other CF error
//
// WHY THIS IS SAFE:
// The user pastes their own token; the delete only affects their
// account; we never persist either the token or the uuid. We do
// not call this without an explicit user click — the UI shows a
// confirmation step listing the db's name + table count before
// firing this request.

import { json } from '../../../_lib/util.js';

const CF_API = 'https://api.cloudflare.com/client/v4';

async function cfFetch(token, path, init) {
  const r = await fetch(CF_API + path, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
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

  const token     = String(payload?.token      || '').trim();
  const accountId = String(payload?.account_id || '').trim().toLowerCase();
  const uuid      = String(payload?.uuid       || '').trim().toLowerCase();

  if (!token)                               return json(400, { ok: false, error: 'missing_token' });
  if (!/^[a-f0-9]{32}$/.test(accountId))    return json(400, { ok: false, error: 'bad_account_id' });
  // D1 uuids are RFC-4122 v4 (8-4-4-4-12 hex).
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(uuid)) {
    return json(400, { ok: false, error: 'bad_uuid' });
  }

  const r = await cfFetch(token, `/accounts/${accountId}/d1/database/${uuid}`, {
    method: 'DELETE',
  });

  // Map CF status codes to friendly responses.
  if (r.ok)                  return json(200, { ok: true, uuid, deleted: true });
  if (r.status === 401)      return json(401, { ok: false, error: 'token_rejected', detail: firstError(r.body) });
  if (r.status === 403)      return json(403, { ok: false, error: 'd1_write_denied', detail: 'Your token can\'t delete D1 databases. Re-create it with D1:Edit checked.' });
  if (r.status === 404)      return json(404, { ok: false, error: 'db_not_found', detail: 'Already deleted or never existed.' });

  return json(502, {
    ok: false,
    error: 'cf_api_error',
    detail: firstError(r.body) || ('HTTP ' + r.status),
  });
};
