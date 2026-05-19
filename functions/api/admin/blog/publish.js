// Step 4/4 — insert into blog_posts, mark topic used, ping IndexNow.
import { json, newId, nowSec, audit } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';
import { markTopicUsed } from '../../../_lib/topics.js';
import { pingIndexNow } from '../../../_lib/indexnow.js';

export const onRequestPost = async ({ request, env, waitUntil }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }
  const jobId = String(body.job_id || '');
  if (!jobId) return json(400, { error: 'missing_job_id' });

  const job = await env.DB.prepare('SELECT * FROM blog_jobs WHERE id = ? LIMIT 1').bind(jobId).first();
  if (!job) return json(404, { error: 'job_not_found' });
  if (job.status === 'published' && job.blog_post_id) {
    return json(200, { ok: true, status: 'published', blog_post_id: job.blog_post_id, slug: job.slug, idempotent: true });
  }
  if (job.status !== 'image_done') {
    return json(409, { error: 'wrong_state', current: job.status, hint: 'call /image first' });
  }
  if (!job.title || !job.slug || !job.body_markdown) {
    return json(409, { error: 'job_incomplete' });
  }
  const postId = newId();
  const t = nowSec();
  await env.DB.prepare(
    `INSERT INTO blog_posts (id, slug, title, meta_description, body_markdown,
        hero_image_key, hero_image_alt, status, topic_seed, keywords,
        ai_provider, created_at, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?)`
  ).bind(
    postId, job.slug, job.title, job.meta_description, job.body_markdown,
    job.hero_image_key, job.hero_image_alt, job.topic_key, job.keywords,
    job.ai_provider, t, t
  ).run();
  await env.DB.prepare(
    "UPDATE blog_jobs SET status='published', blog_post_id=?, updated_at=? WHERE id=?"
  ).bind(postId, t, jobId).run();
  // If this job came from a calendar slot, close the loop.
  await env.DB.prepare(
    "UPDATE content_calendar SET status='published', post_id=?, updated_at=? WHERE job_id=?"
  ).bind(postId, t, jobId).run().catch(() => {});
  await markTopicUsed(env, job.topic_key).catch(() => {});

  // Best-effort IndexNow ping. The host is derived from this request so
  // it works for both production and preview hostnames.
  const host = new URL(request.url).hostname;
  waitUntil(
    pingIndexNow(env, [`https://${host}/blog`, `https://${host}/blog/${job.slug}`], request)
      .catch(() => {})
  );
  audit(env, 'admin', 'blog_publish', postId, { job_id: jobId, slug: job.slug });
  return json(200, { ok: true, status: 'published', blog_post_id: postId, slug: job.slug, title: job.title });
};
