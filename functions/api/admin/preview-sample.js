// Dry-run blog generation. Calls the AI provider chain end-to-end with
// a synthetic brand+topic, runs the markdown sanitiser, and returns the
// fully-rendered HTML preview. Does NOT touch D1 or R2 — safe to call
// repeatedly while tuning prompts or testing a new provider.
//
// POST body (all optional):
//   { topic?: string, kind?: 'article'|'programmatic', provider?: string,
//     brand?: { name, url, cta }, with_image?: boolean }
//
// Response:
//   { ok, content, html, image_data_url? }
//
// `with_image: true` also generates the hero (slower; ~5-20s on
// Workers AI) and inlines it as a data: URL so the preview is fully
// self-contained.
import { json } from '../../_lib/util.js';
import { adminGate } from '../../_lib/auth.js';
import { generateContent, generateImage } from '../../_lib/ai.js';
import { sanitiseMarkdownLinks } from '../../_lib/links/sanitise.js';
import { buildAliasMap } from '../../_lib/links/aliases.js';
import { renderContentPage } from '../../_lib/page_render.js';
import { loadSettings } from '../../_lib/settings.js';

const DEFAULT_TOPIC = 'Practical tips for someone starting out';

export const onRequestPost = async ({ request, env }) => {
  const gate = await adminGate(env, request); if (gate) return gate;

  let body = {};
  try { body = await request.json(); } catch { /* empty body ok */ }

  const kind = body.kind === 'programmatic' ? 'programmatic' : 'article';
  const seed = String(body.topic || DEFAULT_TOPIC).slice(0, 240);
  const settings = await loadSettings(env);
  const provider = body.provider ? String(body.provider) : (settings.default_ai_provider || undefined);
  const brand = {
    // settings.site_name / site_url resolve Pages secret first, then
    // D1 setting — works on CLI + browser + 1-click Deploy installs.
    name: body.brand?.name || settings.site_name,
    url:  body.brand?.url  || settings.site_url,
    cta:  body.brand?.cta  || settings.site_cta,
    tone: body.brand?.tone || settings.brand_voice_tone || settings.site_tone || undefined,
    audience: body.brand?.audience || settings.brand_target_audience || settings.site_audience || undefined,
    business_type:   body.brand?.business_type   || settings.brand_business_type   || undefined,
    key_themes:      body.brand?.key_themes      || settings.brand_key_themes      || undefined,
    topics_to_avoid: body.brand?.topics_to_avoid || settings.brand_topics_to_avoid || undefined,
    service_area:    body.brand?.service_area    || settings.brand_service_area    || undefined,
    aliases: await buildAliasMap(env),
  };

  let content;
  try {
    content = await generateContent(env, { kind, seed, provider, brand, source: 'preview' });
  } catch (e) {
    return json(502, { error: 'text_failed', detail: String(e?.message || e).slice(0, 400) });
  }
  content.body_markdown = sanitiseMarkdownLinks(content.body_markdown, { aliases: brand.aliases });

  let imageDataUrl = null;
  let imageError = null;
  if (body.with_image) {
    try {
      const img = await generateImage(env, { prompt: content.hero_image_prompt, provider, source: 'preview' });
      // Inline as data URL so the preview is portable. ~1-2MB typical.
      let bin = '';
      const chunk = 0x8000;
      for (let i = 0; i < img.bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, img.bytes.subarray(i, i + chunk));
      }
      imageDataUrl = 'data:image/png;base64,' + btoa(bin);
    } catch (e) {
      imageError = String(e?.message || e).slice(0, 400);
    }
  }

  const pseudoPost = {
    slug: content.slug,
    title: content.title,
    meta_description: content.meta_description,
    body_markdown: content.body_markdown,
    hero_image_key: null, // we inline the image below instead of /image/<key>
    hero_image_alt: content.hero_image_alt,
    keywords: content.keywords,
    published_at: Math.floor(Date.now() / 1000),
    status: 'preview',
    urlPath: (kind === 'blog' || kind === 'article' ? '/blog/' : '/p/') + content.slug,
  };
  let html = renderContentPage({ env, request, post: pseudoPost, kind: kind === 'programmatic' ? 'prog' : 'blog' });
  if (imageDataUrl) {
    // Splice the inline image into the rendered HTML — the renderer
    // skipped it because hero_image_key was null.
    const safeAlt = (pseudoPost.hero_image_alt || pseudoPost.title).replace(/"/g, '&quot;');
    html = html.replace('<article class="prose">',
      `<img class="hero" src="${imageDataUrl}" alt="${safeAlt}" /><article class="prose">`);
  }

  return json(200, {
    ok: true,
    content,
    image_data_url: imageDataUrl,
    image_error: imageError,
    html,
  });
};
