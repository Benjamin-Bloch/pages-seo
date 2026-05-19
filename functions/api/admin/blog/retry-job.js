// Resets a failed job back to the step that needs re-running so the
// next call to /text or /image picks it up.
import { json, nowSec } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';

export const onRequestPost = async ({ request, env }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }
  const id = String(body.id || '').trim();
  if (!id) return json(400, { error: 'missing_id' });
  const job = await env.DB.prepare('SELECT id, status, error FROM blog_jobs WHERE id = ? LIMIT 1').bind(id).first();
  if (!job) return json(404, { error: 'not_found' });
  if (job.status === 'published') return json(409, { error: 'already_published' });

  let target;
  if (job.status === 'failed') {
    target = String(job.error || '').startsWith('image:') ? 'text_done' : 'created';
  } else {
    target = job.status; // stale but not failed — leave at natural resume point
  }
  await env.DB.prepare("UPDATE blog_jobs SET status=?, error=NULL, updated_at=? WHERE id=?")
    .bind(target, nowSec(), id).run();
  return json(200, { ok: true, status: target });
};
