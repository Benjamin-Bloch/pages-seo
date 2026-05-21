// /og/<slug>.svg
//
// Open-Graph image generator for posts that don't have a hero image.
//
// Today this endpoint serves two roles:
//
//   1. When a default cover template exists, it's a thin alias for
//      /cover/<slug>.svg — same renderer, same variables, same
//      output. We keep the /og/ URL alive so social-share links the
//      blog has already published don't break.
//
//   2. When no default template exists, it falls back to a built-in
//      hard-coded card so we never emit a missing-image og:image.
//      The card mirrors the "main — official" template visually so
//      the brand stays consistent.

import { renderCoverSvg } from '../_lib/cover_svg.js';
import { buildBrandContext } from '../_lib/template.js';
import { loadSettings } from '../_lib/settings.js';
import { esc } from '../_lib/util.js';

const W = 1200, H = 630;

// Hard-coded fallback spec. Used only when there's no default
// cover_template row in the DB — i.e. the user hasn't installed the
// official template yet. Keeps the visual identity consistent.
function fallbackSpec() {
  return {
    width: W, height: H,
    layers: [
      { id: 'bg', kind: 'box', x: 0, y: 0, w: W, h: H, fill: '#0a0c10', radius: 0 },
      { id: 'rule', kind: 'box', x: 80, y: 60, w: 200, h: 2, fill: '#d4af62', radius: 0 },
      { id: 'eyebrow', kind: 'text', x: 80, y: 80, w: 700, h: 30,
        text: '{brand.name|upper}',
        size: 22, family: '"JetBrains Mono", monospace', weight: '600',
        align: 'left', color: '#d4af62', shadow: false,
      },
      { id: 'title', kind: 'text', x: 80, y: 280, w: 1040, h: 240,
        text: '{title}',
        size: 76, family: '"Playfair Display", Georgia, serif', weight: '700',
        align: 'left', color: '#f5f0e6', shadow: false,
      },
      { id: 'sig', kind: 'text', x: 80, y: 560, w: 600, h: 30,
        text: '{pub_date|date:long} · {reading_time}',
        size: 16, family: '"JetBrains Mono", monospace', weight: '400',
        align: 'left', color: 'rgba(245,240,230,0.55)', shadow: false,
      },
    ],
  };
}

export const onRequestGet = async ({ env, request, params }) => {
  const slug = String(params.slug || '').toLowerCase();
  if (!/^[a-z0-9-]{1,200}$/.test(slug)) {
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }

  // Look up the post.
  let post = null;
  let kind = 'blog';
  try {
    post = await env.DB.prepare(
      `SELECT slug, title, meta_description, body_markdown, hero_image_key,
              keywords, ai_provider, status, published_at
       FROM blog_posts WHERE slug = ? AND status='published' LIMIT 1`
    ).bind(slug).first();
    if (!post) {
      post = await env.DB.prepare(
        `SELECT slug, title, meta_description, body_markdown, hero_image_key,
                keyword, ai_provider, status, published_at
         FROM prog_pages WHERE slug = ? AND status='published' LIMIT 1`
      ).bind(slug).first();
      kind = 'programmatic';
    }
  } catch { /* DB unavailable — fall through */ }

  // Use the default cover template if one exists; otherwise the
  // built-in fallback spec.
  let spec = null;
  try {
    const row = await env.DB.prepare(
      `SELECT spec_json FROM cover_templates WHERE is_default = 1 LIMIT 1`
    ).first();
    if (row?.spec_json) spec = JSON.parse(row.spec_json);
  } catch { /* */ }
  if (!spec) spec = fallbackSpec();

  const settings = await loadSettings(env).catch(() => ({}));
  const fakePost = post || { slug, title: slug.replace(/-/g, ' '), body_markdown: '', published_at: 0 };
  fakePost.urlPath = kind === 'blog' ? `/blog/${slug}` : `/p/${slug}`;
  const ctx = buildBrandContext({ env, settings, post: fakePost, request, kind });

  // env passed so R2-hosted background/logo assets get base64-inlined
  // (see cover_svg.js). Social card scrapers and any <img src=…>
  // loader of this SVG won't fetch external references otherwise.
  const svg = await renderCoverSvg(spec, ctx, env);

  return new Response(svg, {
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      // OG card lookups go through social-share scrapers that cache
       // aggressively on their own end (Twitter, Slack, FB all
       // cache for hours-to-days regardless of our headers), so a
       // short server-side cache is fine — the practical refresh
       // rate is dominated by the scrapers' own caches.
      'cache-control': 'public, max-age=300, s-maxage=900',
    },
  });
};

// esc is imported only to avoid breaking imports elsewhere if this
// file is referenced as a module; we don't use it directly here
// since renderCoverSvg handles all escaping internally.
void esc;
