// /cover/<slug>.svg
//
// Live cover-template renderer. Looks up:
//   1. The post (blog_posts or prog_pages) by slug
//   2. The default cover_template (is_default=1) from D1
//   3. Settings (so brand.{tagline,colors,logo_url,...} resolve)
//
// Builds a template context with every variable available, renders
// the template's layer spec via cover_svg.js, and returns an SVG.
//
// Why SVG and not PNG: Workers don't have a 2D canvas. SVG is text we
// can produce from a string template, with zero dependencies. Every
// modern browser, OG scraper, and social-link unfurler accepts SVG —
// the few that don't (legacy desktop email clients) aren't the
// primary audience for blog covers.
//
// Storage: we don't store a per-post PNG. The SVG is computed on
// every cache miss (cheap — pure string composition) and cached at
// the Cloudflare edge for an hour. Backgrounds + logos are stored
// ONCE in R2 (the spec references them by URL); we never duplicate
// them per post.
//
// Cache busting: the SVG is keyed by slug. Editing the default
// template changes the rendered output for every existing post the
// moment the edge cache expires (within ~1h). To force-bust earlier,
// admin can trigger a deploy or hit the URL with ?v=<timestamp>.

import { renderCoverSvg } from '../_lib/cover_svg.js';
import { buildBrandContext } from '../_lib/template.js';
import { loadSettings } from '../_lib/settings.js';

export const onRequestGet = async ({ env, request, params }) => {
  const slug = String(params.slug || '').toLowerCase();
  if (!/^[a-z0-9-]{1,200}$/.test(slug)) {
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }

  // Look up the post in both tables. Either is fine; the renderer
  // doesn't care whether it's a blog or programmatic page.
  let post = null;
  let kind = 'blog';
  try {
    post = await env.DB.prepare(
      `SELECT slug, title, meta_description, body_markdown, hero_image_key, hero_image_alt,
              keywords, ai_provider, status, published_at
       FROM blog_posts WHERE slug = ? AND status='published' LIMIT 1`
    ).bind(slug).first();
    if (!post) {
      post = await env.DB.prepare(
        `SELECT slug, title, meta_description, body_markdown, hero_image_key, hero_image_alt,
                keyword, ai_provider, status, published_at
         FROM prog_pages WHERE slug = ? AND status='published' LIMIT 1`
      ).bind(slug).first();
      kind = 'programmatic';
    }
  } catch { /* DB unavailable — fall through to a generic card */ }

  // Look up the default template. If none exists we can't render —
  // return a 404 so the caller (page_render.js) falls back to its
  // built-in OG SVG instead.
  let template = null;
  try {
    template = await env.DB.prepare(
      `SELECT spec_json FROM cover_templates WHERE is_default = 1 LIMIT 1`
    ).first();
  } catch { /* no template */ }
  if (!template?.spec_json) {
    return new Response('No default cover template configured', {
      status: 404, headers: { 'content-type': 'text/plain' },
    });
  }
  let spec;
  try { spec = JSON.parse(template.spec_json); }
  catch { return new Response('Template spec corrupt', { status: 500, headers: { 'content-type': 'text/plain' } }); }

  const settings = await loadSettings(env).catch(() => ({}));

  // Build the context. If no post was found we still render — using
  // the slug-as-title as a graceful degrade so deep-linked OG cards
  // for hidden/draft posts still produce something readable.
  const fakePost = post || { slug, title: slug.replace(/-/g, ' '), body_markdown: '', published_at: 0 };
  fakePost.urlPath = kind === 'blog' ? `/blog/${slug}` : `/p/${slug}`;
  const ctx = buildBrandContext({ env, settings, post: fakePost, request, kind });

  // Pass env so the renderer can inline R2-hosted backgrounds + logos
  // as base64 data URLs. Without that, browsers serving this SVG via
  // <img src=…> render external <image> hrefs as blank — which is
  // exactly the failure the user saw before this fix.
  const svg = await renderCoverSvg(spec, ctx, env);

  return new Response(svg, {
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      // Browser cache 1 day, edge 1 hour. Templates are rarely-changing
      // but the source of truth is D1; an hour at the edge is enough
      // freshness for OG scrapers and slow enough to coast.
      // 5 min browser, 15 min edge. Short enough that template
      // edits propagate quickly (a stale ?v= cache key catches
      // the rest), long enough to amortise the R2-inline cost
      // across a normal day's traffic.
      'cache-control': 'public, max-age=300, s-maxage=900',
    },
  });
};
