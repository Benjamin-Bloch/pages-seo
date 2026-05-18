// Step 1/4 — pick a topic and create a job row.
import { json, newId, nowSec } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';
import { pickNextTopic } from '../../../_lib/topics.js';

export const onRequestPost = async ({ request, env }) => {
  const gate = adminGate(env, request); if (gate) return gate;
  let body = {};
  try { body = await request.json(); } catch { /* empty body ok */ }
  let topic;
  if (body.topic_key && body.angle) {
    topic = { key: String(body.topic_key), angle: String(body.angle) };
  } else {
    topic = await pickNextTopic(env);
  }
  if (!topic) return json(500, { error: 'no_topic_available' });
  const id = newId();
  const t = nowSec();
  await env.DB.prepare(
    `INSERT INTO blog_jobs (id, status, topic_key, topic_angle, created_at, updated_at)
     VALUES (?, 'created', ?, ?, ?, ?)`
  ).bind(id, topic.key, topic.angle, t, t).run();
  return json(200, { ok: true, job_id: id, status: 'created', topic: topic.key });
};
