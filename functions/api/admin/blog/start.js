// Step 1/4 — pick a topic and create a job row.
//
// Topic source priority:
//   1. body.calendar_slot_id  → claim that specific slot
//   2. body.from_calendar:true → claim the oldest due scheduled slot
//   3. body.topic_key + body.angle → ad-hoc topic
//   4. fallback: pickNextTopic() (legacy random walk)
//
// "Claim" = flip the slot to status='generating' and link job_id.

import { json, newId, nowSec, audit } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';
import { pickNextTopic } from '../../../_lib/topics.js';

function todayUtc() { return new Date().toISOString().slice(0, 10); }

async function loadSlot(env, id) {
  return env.DB.prepare(
    `SELECT * FROM content_calendar WHERE id = ? LIMIT 1`
  ).bind(id).first().catch(() => null);
}

async function nextDueSlot(env) {
  return env.DB.prepare(
    `SELECT * FROM content_calendar
      WHERE status = 'scheduled' AND scheduled_for <= ?
      ORDER BY scheduled_for ASC, created_at ASC LIMIT 1`
  ).bind(todayUtc()).first().catch(() => null);
}

export const onRequestPost = async ({ request, env }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  let body = {};
  try { body = await request.json(); } catch { /* empty body ok */ }

  let topic = null;
  let slot  = null;

  if (body.calendar_slot_id) {
    slot = await loadSlot(env, String(body.calendar_slot_id));
    if (!slot) return json(404, { error: 'slot_not_found' });
    if (slot.status !== 'scheduled' && slot.status !== 'draft') {
      return json(409, { error: 'slot_not_runnable', detail: 'status=' + slot.status });
    }
  } else if (body.from_calendar) {
    slot = await nextDueSlot(env);
    // No due slot is OK — fall through to legacy topic picker.
  } else if (body.topic_key && body.angle) {
    topic = { key: String(body.topic_key), angle: String(body.angle) };
  }

  if (slot) {
    topic = {
      key:   slot.primary_keyword || slot.title,
      angle: slot.angle || slot.title,
    };
  }
  if (!topic) topic = await pickNextTopic(env);
  if (!topic) return json(500, { error: 'no_topic_available' });

  const id = newId();
  const t  = nowSec();
  await env.DB.prepare(
    `INSERT INTO blog_jobs (id, status, topic_key, topic_angle, created_at, updated_at)
     VALUES (?, 'created', ?, ?, ?, ?)`
  ).bind(id, topic.key, topic.angle, t, t).run();

  if (slot) {
    await env.DB.prepare(
      `UPDATE content_calendar SET status='generating', job_id=?, updated_at=? WHERE id=?`
    ).bind(id, t, slot.id).run();
    await audit(env, 'cron', 'calendar.claim', slot.id, JSON.stringify({ job_id: id }));
  }

  return json(200, { ok: true, job_id: id, status: 'created', topic: topic.key, slot_id: slot?.id || null });
};
