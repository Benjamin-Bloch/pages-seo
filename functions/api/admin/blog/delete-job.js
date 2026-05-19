// Hard-delete an unfinished job + its R2 image if any.
import { json } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';

export const onRequestPost = async ({ request, env }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }
  const id = String(body.id || '').trim();
  if (!id) return json(400, { error: 'missing_id' });
  const job = await env.DB.prepare('SELECT id, status, hero_image_key FROM blog_jobs WHERE id=? LIMIT 1').bind(id).first();
  if (!job) return json(404, { error: 'not_found' });
  if (job.status === 'published') return json(409, { error: 'already_published' });
  if (job.hero_image_key && env.IMAGES) {
    await env.IMAGES.delete(job.hero_image_key).catch(() => {});
  }
  await env.DB.prepare('DELETE FROM blog_jobs WHERE id=?').bind(id).run();
  return json(200, { ok: true });
};
