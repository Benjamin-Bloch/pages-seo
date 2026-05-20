// /blog/<slug>
import { renderContentPage } from '../_lib/page_render.js';
import { loadSettings } from '../_lib/settings.js';

export const onRequestGet = async ({ env, request, params }) => {
  const slug = String(params.slug || '').toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }
  const post = await env.DB.prepare(
    `SELECT slug, title, meta_description, body_markdown, hero_image_key, hero_image_alt,
            keywords, status, published_at
       FROM blog_posts WHERE slug = ? LIMIT 1`
  ).bind(slug).first();
  if (!post) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  if (post.status === 'hidden') return new Response('Gone', { status: 410, headers: { 'content-type': 'text/plain' } });
  post.urlPath = '/blog/' + post.slug;

  // "Read next" — three other recent posts the LLM didn't write into
  // the body. Ordered by recency for simplicity; cheaper than computing
  // similarity scores and good enough for sites with a few dozen posts.
  const relatedRows = await env.DB.prepare(
    `SELECT slug, title, meta_description, hero_image_key, hero_image_alt, published_at
       FROM blog_posts
      WHERE status='published' AND slug != ?
      ORDER BY published_at DESC LIMIT 3`
  ).bind(slug).all().catch(() => ({ results: [] }));
  const related = relatedRows.results || [];

  // Settings — used by the renderer for verification metas and the
  // JSON-LD WebSite block. Cached at DB level by D1 so per-request
  // cost is small.
  const settings = await loadSettings(env).catch(() => ({}));

  return new Response(renderContentPage({ env, request, post, kind: 'blog', related, settings }), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=600, s-maxage=3600',
    },
  });
};
