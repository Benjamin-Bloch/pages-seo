// /p/<slug> — programmatic-SEO landing pages.
import { renderContentPage } from '../_lib/page_render.js';
import { loadSettings } from '../_lib/settings.js';

export const onRequestGet = async ({ env, request, params }) => {
  const slug = String(params.slug || '').toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }
  const post = await env.DB.prepare(
    `SELECT slug, title, meta_description, body_markdown, hero_image_key, hero_image_alt,
            status, published_at
       FROM prog_pages WHERE slug = ? LIMIT 1`
  ).bind(slug).first();
  if (!post) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  if (post.status === 'hidden') return new Response('Gone', { status: 410, headers: { 'content-type': 'text/plain' } });
  post.urlPath = '/p/' + post.slug;
  const settings = await loadSettings(env).catch(() => ({}));
  // See blog/[slug].js for the rationale — flag whether a default
  // cover template exists so page_render.js can route the hero src
  // through /cover/<slug>.svg.
  if (settings?.hero_image_mode === 'cover') {
    try {
      const t = await env.DB.prepare(
        'SELECT updated_at FROM cover_templates WHERE is_default = 1 LIMIT 1'
      ).first();
      settings._has_default_template = !!t;
      settings._default_template_v = t?.updated_at || 0;
    } catch {
      settings._has_default_template = false;
      settings._default_template_v = 0;
    }
  }
  return new Response(renderContentPage({ env, request, post, kind: 'programmatic', settings }), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=600, s-maxage=3600',
    },
  });
};
