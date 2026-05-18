// /p/<slug> — programmatic-SEO landing pages.
import { renderContentPage } from '../_lib/page_render.js';

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
  return new Response(renderContentPage({ env, request, post, kind: 'programmatic' }), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=600, s-maxage=3600',
    },
  });
};
