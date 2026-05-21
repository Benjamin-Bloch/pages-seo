// GET /api/admin/audit
//
// Read the audit_log table for the /admin Status page's "Recent
// activity" list.
//
// Query params (all optional):
//   limit       — default 50, max 200
//   before      — Unix seconds; return entries strictly before this
//                 timestamp (used by the UI for "Load older")
//   action      — substring match on action (e.g. "cover_" or "fail")
//   actor       — exact match on actor (e.g. "admin", "cron")
//   only_failures=1 — shorthand for action LIKE %fail% OR %error%
//
// Response: { ok, entries: [{ id, actor, action, target_id, details, created_at }] }
// `details` is parsed back to an object if it looks like JSON.

import { json } from '../../_lib/util.js';
import { adminGate } from '../../_lib/auth.js';

export const onRequestGet = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  if (!env.DB) return json(503, { error: 'no_db_binding' });

  const u = new URL(request.url);
  const limit  = Math.min(200, parseInt(u.searchParams.get('limit'), 10) || 50);
  const before = parseInt(u.searchParams.get('before'), 10) || 0;
  const action = String(u.searchParams.get('action') || '').trim();
  const actor  = String(u.searchParams.get('actor') || '').trim();
  const onlyFailures = u.searchParams.get('only_failures') === '1';

  const where = [];
  const binds = [];
  if (before) { where.push('created_at < ?'); binds.push(before); }
  if (action) { where.push('action LIKE ?'); binds.push(`%${action}%`); }
  if (actor)  { where.push('actor = ?'); binds.push(actor); }
  if (onlyFailures) where.push("(action LIKE '%fail%' OR action LIKE '%error%')");

  const sql = `SELECT id, actor, action, target_id, details, created_at
                 FROM audit_log
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY created_at DESC LIMIT ?`;
  binds.push(limit);

  const r = await env.DB.prepare(sql).bind(...binds).all();
  const entries = (r?.results || []).map((row) => {
    // details is stored as JSON string when callers pass objects.
    // Parse it back so the UI can format nicely; leave as-is if it
    // wasn't valid JSON.
    let details = row.details;
    if (typeof details === 'string' && details.length && /^[{\[]/.test(details)) {
      try { details = JSON.parse(details); } catch { /* leave string */ }
    }
    return { ...row, details };
  });

  return json(200, {
    ok: true,
    entries,
    next_before: entries.length === limit
      ? entries[entries.length - 1].created_at
      : null,
  });
};
