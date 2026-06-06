// Step 2/4 — call the AI for article text. Falls back to OpenAI if
// Workers AI fails.
import { json, nowSec, slugify } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';
import { generateContent } from '../../../_lib/ai.js';
import { sanitiseMarkdownLinks } from '../../../_lib/links/sanitise.js';
import { buildAliasMap } from '../../../_lib/links/aliases.js';
import { loadSettings } from '../../../_lib/settings.js';
import { checkBudget } from '../../../_lib/usage.js';
import { injectInternalLinks, loadLinkTargets } from '../../../_lib/internal_links.js';

export const onRequestPost = async ({ request, env }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
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
  const aliases = await buildAliasMap(env);
  const settings = await loadSettings(env);

  // Identify caller: cron Worker sends X-Source-Cron, otherwise treat
  // as ad-hoc admin click. Cron gets hard-stopped at budget; admin can
  // override with allow_over_budget=true in the body.
  const source = request.headers.get('X-Source-Cron') === '1' ? 'cron-blog' : 'admin-blog';
  if (source === 'cron-blog' && !body.allow_over_budget) {
    const b = await checkBudget(env, source);
    if (!b.allowed) {
      return json(429, { error: 'budget_exceeded', month_spend_usd: b.spend, budget_usd: b.budget, pct: b.pct });
    }
  }

  let post;
  try {
    post = await generateContent(env, {
      kind: 'article',
      seed: job.topic_angle,
      provider: body.provider || settings.default_ai_provider || undefined,
      source,
      brand: {
        // settings.site_name resolves Pages secret first, then D1
        // — supports CLI + browser + 1-click Deploy installs.
        name: settings.site_name || 'this site',
        url: settings.site_url || '/',
        cta: settings.site_cta,
        tone: settings.brand_voice_tone || settings.site_tone || undefined,
        audience: settings.brand_target_audience || settings.site_audience || undefined,
        business_type:    settings.brand_business_type    || undefined,
        key_themes:       settings.brand_key_themes       || undefined,
        topics_to_avoid:  settings.brand_topics_to_avoid  || undefined,
        service_area:     settings.brand_service_area     || undefined,
        aliases,
      },
    });
  } catch (e) {
    const msg = String(e.message || e).slice(0, 800);
    await env.DB.prepare(
      "UPDATE blog_jobs SET status='failed', error=?, updated_at=? WHERE id=?"
    ).bind('text:' + msg, nowSec(), jobId).run();
    // Release any calendar slot that claimed this job back to 'scheduled'.
    await env.DB.prepare(
      "UPDATE content_calendar SET status='scheduled', job_id=NULL, updated_at=? WHERE job_id=?"
    ).bind(nowSec(), jobId).run().catch(() => {});
    return json(502, { error: 'text_generation_failed', detail: msg });
  }

  // Scrub the body markdown: drop unsafe URLs, expand alias names like
  // (signup) → /signup, auto-link bare URLs. Done before the row is
  // persisted so no broken link ever reaches /blog/<slug>.
  post.body_markdown = sanitiseMarkdownLinks(post.body_markdown, { aliases });

  // The AI sometimes prepends "Blog" to its title/slug fields, producing
  // URLs like /blog/blogoptimize-... or /blog/blogai-content-... — the
  // category is already in the route, so this is duplicate noise.
  //
  // There's no purely-syntactic way to tell "blogai-content" (bug) from
  // "bloggers-guide" (legit) on the slug alone, so we rely on the TITLE
  // as the authoritative signal:
  //
  //   - The AI's tell is a capital letter immediately after "Blog"
  //     ("BlogAI Content", "BlogOptimize Cloudflare ..."), or a
  //     separator ("Blog: SEO ...", "Blog - SEO ...").
  //   - If the title gets cleaned, re-slugify from it. Otherwise leave
  //     the original slug alone (it might legitimately start with
  //     "blog" — bloggers, blogging).
  let titleTouched = false;
  if (post.title) {
    const cleaned = String(post.title).replace(/^Blog(?:\s*[:\-]\s*|(?=[A-Z]))/, '');
    if (cleaned !== post.title) {
      post.title = cleaned;
      titleTouched = true;
    }
  }
  if (titleTouched) {
    // Re-slugify from the cleaned title (uses the same slugifier the
    // AI's `shapeArticle` used). slugify is imported from util.js.
    post.slug = slugify(post.title);
  }
  const slug = await uniqSlug(post.slug);

  // Internal-link injection: scan the body for phrases that match
  // existing post titles/keywords, link them up to 3 times. Big SEO
  // and retention win — turns every new post into a link upgrade
  // for older ones. Best-effort: failure here is non-fatal.
  try {
    const targets = await loadLinkTargets(env, slug, { limit: 80 });
    if (targets.length) {
      const { body: linkedBody, injected } = injectInternalLinks(post.body_markdown, slug, targets);
      post.body_markdown = linkedBody;
      post._internal_links_injected = injected.length;
    }
  } catch { /* non-fatal */ }

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
