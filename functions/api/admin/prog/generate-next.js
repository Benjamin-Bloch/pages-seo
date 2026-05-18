// Picks the next 'pending' keyword and generates a programmatic page for
// it: AI text → AI image → R2 upload → prog_pages row → IndexNow ping.
//
// Designed to be called repeatedly by the cron Worker (which iterates
// across multiple short HTTP calls) or manually from the admin UI.
import { json, newId, nowSec, slugify, audit } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';
import { generateContent, generateImage } from '../../../_lib/ai.js';
import { pingIndexNow } from '../../../_lib/indexnow.js';
import { sanitiseMarkdownLinks } from '../../../_lib/links/sanitise.js';
import { buildAliases } from '../../../_lib/links/aliases.js';
import { loadSettings } from '../../../_lib/settings.js';

export const onRequestPost = async ({ request, env, waitUntil }) => {
  const gate = adminGate(env, request); if (gate) return gate;

  // Atomically claim the oldest pending keyword. The status flip from
  // pending → processing blocks parallel workers from picking the same row.
  const claimed = await env.DB.batch([
    env.DB.prepare(`SELECT id, keyword FROM prog_keywords WHERE status='pending' ORDER BY created_at LIMIT 1`),
  ]);
  const next = claimed[0]?.results?.[0];
  if (!next) return json(200, { ok: true, drained: true });

  const t0 = nowSec();
  await env.DB.prepare(
    "UPDATE prog_keywords SET status='processing', attempts=attempts+1, updated_at=? WHERE id=? AND status='pending'"
  ).bind(t0, next.id).run();

  const aliases = buildAliases(env);
  const settings = await loadSettings(env);
  let content;
  try {
    content = await generateContent(env, {
      kind: 'programmatic',
      seed: next.keyword,
      provider: settings.default_ai_provider || undefined,
      brand: {
        name: env.SITE_NAME || 'this site',
        url: env.SITE_URL || '/',
        cta: settings.site_cta,
        tone: settings.site_tone || undefined,
        audience: settings.site_audience || undefined,
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

  let imageKey = null;
  try {
    const img = await generateImage(env, { prompt: content.hero_image_prompt });
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
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?)`
  ).bind(
    pageId, slug, next.keyword, content.title, content.meta_description, content.body_markdown,
    imageKey, content.hero_image_alt, content.ai_provider, t, t
  ).run();
  await env.DB.prepare(
    "UPDATE prog_keywords SET status='done', page_id=?, error=NULL, updated_at=? WHERE id=?"
  ).bind(pageId, t, next.id).run();

  const host = new URL(request.url).hostname;
  waitUntil(
    pingIndexNow(env, [`https://${host}/p/${slug}`], request).catch(() => {})
  );
  audit(env, 'admin', 'prog_generate', pageId, { keyword: next.keyword, slug });
  return json(200, { ok: true, keyword: next.keyword, slug, page_id: pageId, ai_provider: content.ai_provider });
};
