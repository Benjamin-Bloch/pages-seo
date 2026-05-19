// GET    /api/admin/calendar           → list slots (date range or all upcoming)
// POST   /api/admin/calendar           → create a single slot
// PATCH  /api/admin/calendar           → update one slot (id required)
// DELETE /api/admin/calendar?id=…      → delete one slot
//
// Slots are the planning unit for the daily blog. The cron picks the
// oldest scheduled slot whose `scheduled_for <= today` and runs the
// blog chain for it. Published posts link back via post_id.

import { json, nowSec, newId, audit } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';

const VALID_STATUSES = ['scheduled', 'generating', 'draft', 'published', 'skipped'];

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function isValidDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

async function enrichWithPosts(env, rows) {
  // Hydrate `post` minimal info for slots that have published.
  const ids = rows.map((r) => r.post_id).filter(Boolean);
  if (!ids.length) return rows;
  const placeholders = ids.map(() => '?').join(',');
  const r = await env.DB.prepare(
    `SELECT id, slug, title, hero_image_key FROM blog_posts WHERE id IN (${placeholders})`
  ).bind(...ids).all().catch(() => ({ results: [] }));
  const byId = Object.fromEntries((r.results || []).map((p) => [p.id, p]));
  return rows.map((row) => ({
    ...row,
    post: row.post_id ? byId[row.post_id] || null : null,
  }));
}

export const onRequestGet = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  const url = new URL(request.url);
  const from = url.searchParams.get('from'); // YYYY-MM-DD inclusive
  const to   = url.searchParams.get('to');   // YYYY-MM-DD inclusive

  let q, args;
  if (isValidDate(from) && isValidDate(to)) {
    q = `SELECT * FROM content_calendar WHERE scheduled_for >= ? AND scheduled_for <= ? ORDER BY scheduled_for ASC, created_at ASC`;
    args = [from, to];
  } else {
    q = `SELECT * FROM content_calendar ORDER BY scheduled_for ASC LIMIT 120`;
    args = [];
  }
  const r = await env.DB.prepare(q).bind(...args).all().catch(() => ({ results: [] }));
  const rows = await enrichWithPosts(env, r.results || []);
  return json(200, { ok: true, slots: rows, today: todayUtc() });
};

export const onRequestPost = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }
  const scheduled_for = String(body?.scheduled_for || '').trim();
  const title         = String(body?.title || '').trim();
  if (!isValidDate(scheduled_for)) return json(400, { error: 'bad_date', detail: 'scheduled_for must be YYYY-MM-DD' });
  if (!title)                      return json(400, { error: 'missing_title' });

  const id  = newId();
  const now = nowSec();
  await env.DB.prepare(
    `INSERT INTO content_calendar
       (id, scheduled_for, title, primary_keyword, angle, status, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'scheduled', 'manual', ?, ?)`
  ).bind(
    id, scheduled_for, title.slice(0, 200),
    String(body?.primary_keyword || '').trim().slice(0, 120) || null,
    String(body?.angle || '').trim().slice(0, 500) || null,
    now, now,
  ).run();
  await audit(env, 'admin', 'calendar.create', id, JSON.stringify({ scheduled_for, title }));
  return json(200, { ok: true, id });
};

export const onRequestPatch = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }
  const id = String(body?.id || '').trim();
  if (!id) return json(400, { error: 'missing_id' });

  const sets = [];
  const args = [];
  if (body.scheduled_for !== undefined) {
    if (!isValidDate(body.scheduled_for)) return json(400, { error: 'bad_date' });
    sets.push('scheduled_for = ?'); args.push(body.scheduled_for);
  }
  if (body.title !== undefined) {
    const t = String(body.title || '').trim();
    if (!t) return json(400, { error: 'empty_title' });
    sets.push('title = ?'); args.push(t.slice(0, 200));
  }
  if (body.primary_keyword !== undefined) {
    sets.push('primary_keyword = ?'); args.push(String(body.primary_keyword || '').trim().slice(0, 120) || null);
  }
  if (body.angle !== undefined) {
    sets.push('angle = ?'); args.push(String(body.angle || '').trim().slice(0, 500) || null);
  }
  if (body.status !== undefined) {
    if (!VALID_STATUSES.includes(body.status)) return json(400, { error: 'bad_status' });
    sets.push('status = ?'); args.push(body.status);
  }
  if (!sets.length) return json(400, { error: 'nothing_to_update' });
  sets.push('updated_at = ?'); args.push(nowSec());
  args.push(id);

  const r = await env.DB.prepare(
    `UPDATE content_calendar SET ${sets.join(', ')} WHERE id = ?`
  ).bind(...args).run();
  if (!r?.meta?.changes) return json(404, { error: 'not_found' });
  await audit(env, 'admin', 'calendar.update', id, '');
  return json(200, { ok: true });
};

export const onRequestDelete = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return json(400, { error: 'missing_id' });
  // Only allow deleting non-published slots — a published slot links a
  // real blog_posts row, removing the calendar entry would lose history.
  const row = await env.DB.prepare(
    `SELECT status FROM content_calendar WHERE id = ?`
  ).bind(id).first().catch(() => null);
  if (!row) return json(404, { error: 'not_found' });
  if (row.status === 'published') return json(409, { error: 'cannot_delete_published' });
  await env.DB.prepare(`DELETE FROM content_calendar WHERE id = ?`).bind(id).run();
  await audit(env, 'admin', 'calendar.delete', id, '');
  return json(200, { ok: true });
};
