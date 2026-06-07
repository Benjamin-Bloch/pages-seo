// Admin notices helper.
//
// Surfaces backend conditions the admin SPA can't detect itself.
// Notices live in D1 and are read by /api/admin/notices (which the
// admin dashboard polls). Each notice has a `kind` slug that acts
// as a dedup key: re-recording an existing active notice of the
// same kind is a no-op. Dismissing a notice and then re-recording
// it produces a fresh row, so transient issues that re-occur
// re-surface for the operator.
//
// Usage:
//   await recordNotice(env, {
//     kind:         'cover_template_missing',
//     severity:     'warn',
//     title:        'No default cover template',
//     detail:       'New posts use a built-in fallback. Set a default in Covers.',
//     action_url:   '/admin#covers',
//     action_label: 'Open Covers',
//   });
//
// All fields except `kind` and `title` are optional. Fire-and-forget
// — callers don't need to await for the notice to be useful.

import { newId, nowSec } from './util.js';

const VALID_SEVERITIES = new Set(['info', 'warn', 'error']);

export async function recordNotice(env, notice) {
  if (!env?.DB) return;
  if (!notice?.kind || !notice?.title) return;

  const kind = String(notice.kind).slice(0, 64);
  const title = String(notice.title).slice(0, 200);
  const detail = notice.detail ? String(notice.detail).slice(0, 1200) : null;
  const severity = VALID_SEVERITIES.has(notice.severity) ? notice.severity : 'warn';
  const actionUrl = notice.action_url ? String(notice.action_url).slice(0, 500) : null;
  const actionLabel = notice.action_label ? String(notice.action_label).slice(0, 60) : null;

  try {
    // Dedup: bail if an active (undismissed) notice of this kind
    // already exists. Avoids a thrash where every request from the
    // affected code path inserts a new row.
    const existing = await env.DB.prepare(
      `SELECT id FROM admin_notices
        WHERE kind = ? AND dismissed_at IS NULL
        LIMIT 1`
    ).bind(kind).first();
    if (existing?.id) return;

    await env.DB.prepare(
      `INSERT INTO admin_notices
         (id, kind, severity, title, detail, action_url, action_label, created_at, dismissed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    ).bind(
      newId(), kind, severity, title, detail, actionUrl, actionLabel, nowSec(),
    ).run();
  } catch {
    // Table missing on a half-migrated DB, or transient D1 hiccup.
    // Notices are diagnostic; never fail the request that tried to
    // record one.
  }
}

// Clears a notice by kind. Used when the condition that triggered
// it is observed to be resolved (e.g. a default cover gets installed
// after a cover_template_missing notice was recorded).
export async function clearNotice(env, kind) {
  if (!env?.DB || !kind) return;
  try {
    await env.DB.prepare(
      `UPDATE admin_notices SET dismissed_at = ?
        WHERE kind = ? AND dismissed_at IS NULL`
    ).bind(nowSec(), String(kind).slice(0, 64)).run();
  } catch { /* noop on D1 hiccup */ }
}
