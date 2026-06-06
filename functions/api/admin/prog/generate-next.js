// Picks the next 'pending' keyword and generates a programmatic page for
// it: AI text → AI image → R2 upload → prog_pages row → IndexNow ping.
//
// Designed to be called repeatedly by the cron Worker (which iterates
// across multiple short HTTP calls) or manually from the admin UI.
import { json, newId, nowSec, slugify, audit } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';
import { generateContent, generateImage } from '../../../_lib/ai.js';
import { pingIndexNow } from '../../../_lib/indexnow.js';
import { onPublish as gscOnPublish } from '../../../_lib/google_indexing.js';
import { sanitiseMarkdownLinks } from '../../../_lib/links/sanitise.js';
import { buildAliasMap } from '../../../_lib/links/aliases.js';
import { loadSettings } from '../../../_lib/settings.js';
import { checkBudget } from '../../../_lib/usage.js';

export const onRequestPost = async ({ request, env, waitUntil }) => {
  const gate = await adminGate(env, request); if (gate) return gate;

  // Atomically claim the highest-priority pending keyword. Priority
  // defaults to score (so high-intent keywords go first); the admin can
  // override priority via the queue UI to pin specific keywords. Ties
  // resolve to oldest-created-first so a long backlog still drains in
  // a predictable order.
  const claimed = await env.DB.batch([
    env.DB.prepare(`SELECT id, keyword FROM prog_keywords WHERE status='pending'
                    ORDER BY priority DESC, created_at ASC LIMIT 1`),
  ]);
  const next = claimed[0]?.results?.[0];
  if (!next) return json(200, { ok: true, drained: true });

  const t0 = nowSec();
  await env.DB.prepare(
    "UPDATE prog_keywords SET status='processing', attempts=attempts+1, updated_at=? WHERE id=? AND status='pending'"
  ).bind(t0, next.id).run();

  const aliases = await buildAliasMap(env);
  const settings = await loadSettings(env);

  // Budget check before we touch the LLM. Cron pulls a fresh keyword
  // each minute on a busy backlog; hard-stop above budget.
  let body = {};
  try { body = await request.clone().json(); } catch { /* fine */ }
  const source = request.headers.get('X-Source-Cron') === '1' ? 'cron-prog' : 'admin-prog';
  if (source === 'cron-prog' && !body.allow_over_budget) {
    const b = await checkBudget(env, source);
    if (!b.allowed) {
      // Re-queue the keyword we just claimed so it isn't lost.
      await env.DB.prepare("UPDATE prog_keywords SET status='pending', updated_at=? WHERE id=?")
        .bind(nowSec(), next.id).run();
      return json(429, { error: 'budget_exceeded', month_spend_usd: b.spend, budget_usd: b.budget, pct: b.pct });
    }
  }

  let content;
  try {
    content = await generateContent(env, {
      kind: 'programmatic',
      seed: next.keyword,
      provider: settings.default_ai_provider || undefined,
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
      "UPDATE prog_keywords SET status='failed', error=?, updated_at=? WHERE id=?"
    ).bind('text:' + msg, nowSec(), next.id).run();
    return json(502, { error: 'text_failed', keyword: next.keyword, detail: msg });
  }

  // Sanitise generated markdown — expands alias names like (signup) →
  // /signup, drops links to non-whitelisted paths, auto-links bare URLs.
  content.body_markdown = sanitiseMarkdownLinks(content.body_markdown, { aliases });

  // Slug uniqueness against existing pages.
  let slug = content.slug || slugify(content.title);
  for (let n = 1; n <= 20; n++) {
    const taken = await env.DB.prepare('SELECT 1 FROM prog_pages WHERE slug=? LIMIT 1').bind(slug).first();
    if (!taken) break;
    slug = `${content.slug}-${n + 1}`;
  }

  // Duplicate-content guard. Programmatic pages are the highest risk
  // for Google's "low-value programmatic content" filter — the kind
  // of pages that get hit by Helpful Content updates. Two checks:
  //
  //   1. Exact-or-near title collision against an existing published
  //     prog page (normalised: lowercase, strip non-alphanumeric).
  //     If found, mark this one hidden so it doesn't ship live.
  //
  //   2. Meta-description Jaccard similarity against any existing
  //     page. If ≥0.80 (very similar set of words) we also hide.
  //     The check is O(N*M) but bounded by the small N (we look only
  //     at the latest 200 pages, which is plenty for catching the
  //     "AI keeps repeating the same intro" failure mode).
  //
  // When a duplicate is detected we still write the row — saved as
  // 'hidden' so the admin can review it. The keyword stays marked
  // 'done' (we did process it) but with an explicit dup note in the
  // error column so it's easy to find.
  function normTitle(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  }
  function jaccard(a, b) {
    const wa = new Set(normTitle(a).split(' ').filter((w) => w.length > 2));
    const wb = new Set(normTitle(b).split(' ').filter((w) => w.length > 2));
    if (!wa.size || !wb.size) return 0;
    let intersect = 0;
    for (const w of wa) if (wb.has(w)) intersect++;
    const union = wa.size + wb.size - intersect;
    return union ? intersect / union : 0;
  }

  let publishStatus = 'published';
  let dupReason = null;
  try {
    const nt = normTitle(content.title);
    const existing = await env.DB.prepare(
      `SELECT slug, title, meta_description FROM prog_pages
       WHERE status='published' ORDER BY published_at DESC LIMIT 200`
    ).all().catch(() => ({ results: [] }));
    for (const row of (existing.results || [])) {
      if (normTitle(row.title) === nt) {
        publishStatus = 'hidden';
        dupReason = 'duplicate_title:' + row.slug;
        break;
      }
      const sim = jaccard(content.meta_description, row.meta_description);
      if (sim >= 0.80) {
        publishStatus = 'hidden';
        dupReason = `duplicate_description(${sim.toFixed(2)}):` + row.slug;
        break;
      }
    }
  } catch { /* dup check is best-effort */ }

  let imageKey = null;
  try {
    const img = await generateImage(env, { prompt: content.hero_image_prompt, source });
    imageKey = `${slug}-${Date.now()}.png`;
    if (env.IMAGES) {
      await env.IMAGES.put(imageKey, img.bytes, {
        httpMetadata: { contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable' },
      });
    }
  } catch {
    // Non-fatal — page ships without hero image.
    imageKey = null;
  }

  const pageId = newId();
  const t = nowSec();
  await env.DB.prepare(
    `INSERT INTO prog_pages (id, slug, keyword, title, meta_description, body_markdown,
        hero_image_key, hero_image_alt, status, ai_provider, created_at, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    pageId, slug, next.keyword, content.title, content.meta_description, content.body_markdown,
    imageKey, content.hero_image_alt, publishStatus, content.ai_provider, t, t
  ).run();
  await env.DB.prepare(
    "UPDATE prog_keywords SET status='done', page_id=?, error=?, updated_at=? WHERE id=?"
  ).bind(pageId, dupReason, t, next.id).run();

  // Only ping IndexNow when we actually published the page. Hidden
  // dupes don't need (or want) a crawl.
  const host = new URL(request.url).hostname;
  if (publishStatus === 'published') {
    const newUrls = [`https://${host}/p/${slug}`];
    waitUntil(pingIndexNow(env, newUrls, request).catch(() => {}));
    // Google Search Console: sitemap re-submit + optional Indexing
    // API ping. Skips silently when no GOOGLE_SA_JSON is in vault.
    waitUntil(gscOnPublish(env, newUrls).catch(() => {}));
  }
  audit(env, 'admin', 'prog_generate', pageId, { keyword: next.keyword, slug, status: publishStatus, dupReason });
  return json(200, {
    ok: true, keyword: next.keyword, slug, page_id: pageId,
    ai_provider: content.ai_provider,
    status: publishStatus,
    dup_reason: dupReason,
  });
};
