// POST /api/admin/notices/dismiss
//
// Marks a notice as dismissed. Doesn't delete the row — keeping
// dismissed rows lets a re-recording produce a new active notice
// (because the dedup query only finds undismissed rows).
//
// Body: { id: '<16-byte hex>' }
//
// Response: { ok: true, dismissed: true } | 404 if id not found.

import { json, nowSec } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';

export const onRequestPost = async ({ env, request }) => {
  const gate = await adminGate(env, request);
  if (gate) return gate;
  if (!env?.DB) return json(503, { ok: false, error: 'no_db_binding' });

  let body;
  try { body = await request.json(); }
  catch { return json(400, { ok: false, error: 'bad_json' }); }

  const id = String(body?.id || '').trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(id)) return json(400, { ok: false, error: 'bad_id' });

  try {
    const r = await env.DB.prepare(
      `UPDATE admin_notices SET dismissed_at = ?
        WHERE id = ? AND dismissed_at IS NULL`
    ).bind(nowSec(), id).run();
    if ((r?.meta?.changes ?? 0) === 0) {
      return json(404, { ok: false, error: 'not_found_or_already_dismissed' });
    }
    return json(200, { ok: true, dismissed: true });
  } catch (e) {
    return json(500, { ok: false, error: String(e?.message || e).slice(0, 200) });
  }
};
