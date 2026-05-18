// Step 2/4 — call the AI for article text. Falls back to OpenAI if
// Workers AI fails.
import { json, nowSec } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';
import { generateContent } from '../../../_lib/ai.js';
import { sanitiseMarkdownLinks } from '../../../_lib/links/sanitise.js';
import { buildAliases } from '../../../_lib/links/aliases.js';

export const onRequestPost = async ({ request, env }) => {
  const gate = adminGate(env, request); if (gate) return gate;
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }
  const jobId = String(body.job_id || '');
  if (!jobId) return json(400, { error: 'missing_job_id' });

  const job = await env.DB.prepare('SELECT * FROM blog_jobs WHERE id = ? LIMIT 1').bind(jobId).first();
  if (!job) return json(404, { error: 'job_not_found' });
  if (['text_done', 'image_done', 'published'].includes(job.status)) {
    return json(200, { ok: true, job_id: jobId, status: job.status, idempotent: true });
  }
  if (job.status === 'failed') return json(409, { error: 'job_failed', detail: job.error });

  async function uniqSlug(candidate) {
    let slug = candidate;
    for (let n = 1; n <= 20; n++) {
      const a = await env.DB.prepare('SELECT 1 FROM blog_posts WHERE slug = ? LIMIT 1').bind(slug).first();
      const b = await env.DB.prepare('SELECT 1 FROM blog_jobs WHERE slug = ? AND id != ? LIMIT 1').bind(slug, jobId).first();
      if (!a && !b) return slug;
      slug = `${candidate}-${n + 1}`;
    }
    return `${candidate}-${Date.now()}`;
  }

  // Resolve the site's internal-link alias map (env-overridable) and pass
  // it into the prompt so the model can write [Sign up](signup) etc. After
  // the model returns, the sanitiser expands the aliases and validates
  // every link is on the whitelist before the row hits the DB.
  const aliases = buildAliases(env);

  let post;
  try {
    post = await generateContent(env, {
      kind: 'article',
      seed: job.topic_angle,
      provider: body.provider,
      brand: {
        name: env.SITE_NAME || 'this site',
        url: env.SITE_URL || '/',
        cta: env.SITE_CTA || 'Sign up to get started.',
        aliases, // available to the prompt builder
      },
    });
  } catch (e) {
    const msg = String(e.message || e).slice(0, 800);
    await env.DB.prepare(
      "UPDATE blog_jobs SET status='failed', error=?, updated_at=? WHERE id=?"
    ).bind('text:' + msg, nowSec(), jobId).run();
    return json(502, { error: 'text_generation_failed', detail: msg });
  }

  // Scrub the body markdown: drop unsafe URLs, expand alias names like
  // (signup) → /signup, auto-link bare URLs. Done before the row is
  // persisted so no broken link ever reaches /blog/<slug>.
  post.body_markdown = sanitiseMarkdownLinks(post.body_markdown, { aliases });

  const slug = await uniqSlug(post.slug);

  await env.DB.prepare(
    `UPDATE blog_jobs
        SET status='text_done',
            primary_query=?, title=?, slug=?, meta_description=?,
            body_markdown=?, keywords=?,
            hero_image_prompt=?, hero_image_alt=?,
            ai_provider=?,
            updated_at=?
      WHERE id=?`
  ).bind(
    post.primary_query, post.title, slug, post.meta_description,
    post.body_markdown, post.keywords,
    post.hero_image_prompt, post.hero_image_alt,
    post.ai_provider,
    nowSec(), jobId
  ).run();

  return json(200, { ok: true, job_id: jobId, status: 'text_done', slug, title: post.title, ai_provider: post.ai_provider });
};
