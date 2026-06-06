// Step 4/4 — insert into blog_posts, mark topic used, ping IndexNow.
import { json, newId, nowSec, audit } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';
import { markTopicUsed } from '../../../_lib/topics.js';
import { pingIndexNow } from '../../../_lib/indexnow.js';
import { onPublish as gscOnPublish } from '../../../_lib/google_indexing.js';
import { syncSitemapAliases } from '../../../_lib/links/aliases.js';
import { storeEmbedding } from '../../../_lib/dedup.js';
import { scorePost, statusForScore } from '../../../_lib/quality.js';

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

  // Pre-publish quality scoring. Weak posts (band='bad') go to status
  // 'review' instead of 'published', and skip the search-engine pings.
  // The operator can force-publish via body.force_publish:true (which
  // also flips a 'review' row to 'published' on a re-run).
  const verdict = scorePost({
    title: job.title,
    body_markdown: job.body_markdown,
    meta_description: job.meta_description,
    slug: job.slug,
  });
  const finalStatus = statusForScore(verdict, { forcePublish: !!body.force_publish });

  const postId = newId();
  const t = nowSec();
  await env.DB.prepare(
    `INSERT INTO blog_posts (id, slug, title, meta_description, body_markdown,
        hero_image_key, hero_image_alt, status, topic_seed, keywords,
        ai_provider, created_at, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    postId, job.slug, job.title, job.meta_description, job.body_markdown,
    job.hero_image_key, job.hero_image_alt, finalStatus,
    job.topic_key, job.keywords,
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

  // Search-engine and embedding side-effects only run for genuinely
  // published posts. A 'review'-state post is invisible to /blog and
  // /sitemap, so telling Google about it would be a 404 by the time
  // they crawl. The embedding is also deferred; we'll re-embed when
  // the post is force-published.
  if (finalStatus === 'published') {
    const host = new URL(request.url).hostname;
    const newUrls = [`https://${host}/blog`, `https://${host}/blog/${job.slug}`];
    waitUntil(pingIndexNow(env, newUrls, request).catch(() => {}));
    waitUntil(gscOnPublish(env, newUrls).catch(() => {}));
    waitUntil(syncSitemapAliases(env).catch(() => {}));
    waitUntil(storeEmbedding(env, job.slug, {
      title: job.title,
      body_markdown: job.body_markdown,
      meta_description: job.meta_description,
    }).catch(() => {}));
  }

  // Log the quality verdict so the audit timeline shows WHY a post
  // went to review (or what score it earned even when published).
  audit(env, 'admin', 'blog_publish', postId, {
    job_id: jobId, slug: job.slug,
    status: finalStatus,
    quality: { score: verdict.score, band: verdict.band, issues: verdict.issues, stats: verdict.stats },
  });
  return json(200, {
    ok: true,
    status: finalStatus,
    blog_post_id: postId, slug: job.slug, title: job.title,
    quality: verdict,
  });
};
