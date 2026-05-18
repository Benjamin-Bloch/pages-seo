// Step 3/4 — generate hero image and upload to R2. Non-fatal if it fails
// (the job advances to image_done without a key).
import { json, nowSec } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';
import { generateImage } from '../../../_lib/ai.js';

export const onRequestPost = async ({ request, env }) => {
  const gate = adminGate(env, request); if (gate) return gate;
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }
  const jobId = String(body.job_id || '');
  if (!jobId) return json(400, { error: 'missing_job_id' });

  const job = await env.DB.prepare('SELECT * FROM blog_jobs WHERE id = ? LIMIT 1').bind(jobId).first();
  if (!job) return json(404, { error: 'job_not_found' });
  if (['image_done', 'published'].includes(job.status)) {
    return json(200, { ok: true, job_id: jobId, status: job.status, idempotent: true });
  }
  if (job.status !== 'text_done') {
    return json(409, { error: 'wrong_state', current: job.status, hint: 'call /text first' });
  }
  if (!job.hero_image_prompt) {
    await env.DB.prepare("UPDATE blog_jobs SET status='image_done', updated_at=? WHERE id=?")
      .bind(nowSec(), jobId).run();
    return json(200, { ok: true, job_id: jobId, status: 'image_done', image_skipped: true });
  }

  let imageKey = null;
  let imageError = null;
  let imageProvider = null;
  try {
    const r = await generateImage(env, { prompt: job.hero_image_prompt, provider: body.provider });
    imageProvider = r.ai_provider;
    imageKey = `${job.slug}-${Date.now()}.png`;
    if (!env.IMAGES) throw new Error('r2_binding_missing');
    await env.IMAGES.put(imageKey, r.bytes, {
      httpMetadata: { contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable' },
    });
  } catch (e) {
    imageError = String(e.message || e).slice(0, 800);
    imageKey = null;
  }

  await env.DB.prepare(
    `UPDATE blog_jobs SET status='image_done', hero_image_key=?, error=?, updated_at=? WHERE id=?`
  ).bind(imageKey, imageError ? 'image:' + imageError : null, nowSec(), jobId).run();

  return json(200, {
    ok: true, job_id: jobId, status: 'image_done',
    image_uploaded: !!imageKey,
    image_error: imageError,
    image_provider: imageProvider,
  });
};
