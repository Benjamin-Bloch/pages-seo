// GET /api/public/post/<slug>
//
// Returns one published blog post's metadata + fully-rendered HTML
// body. Powers the embed widget (which paints content on-demand when
// a card is clicked). Public, no auth, CORS-open, edge-cached.
//
// The body HTML is rendered server-side from sanitised Markdown.
import { renderMarkdown } from '../../../_lib/markdown.js';

function imageUrlFor(key) {
  if (!key) return null;
  return '/image/' + key.split('/').map(encodeURIComponent).join('/');
}

export const onRequestGet = async ({ env, params }) => {
  if (!env?.DB) {
    return new Response(JSON.stringify({ error: 'no_db' }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  const slug = String(params.slug || '').trim();
  if (!slug || !/^[a-z0-9-]{1,120}$/.test(slug)) {
    return new Response(JSON.stringify({ error: 'invalid_slug' }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  const row = await env.DB.prepare(
    `SELECT slug, title, meta_description, keywords, hero_image_key, hero_image_alt,
            body_markdown, ai_provider, published_at
       FROM blog_posts
      WHERE status = 'published' AND slug = ? LIMIT 1`
  ).bind(slug).first().catch(() => null);

  if (!row) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json; charset=utf-8',
                  'access-control-allow-origin': '*' },
    });
  }

  return new Response(JSON.stringify({
    ok: true,
    post: {
      slug: row.slug,
      title: row.title,
      meta_description: row.meta_description,
      keywords: row.keywords,
      hero_image_url: imageUrlFor(row.hero_image_key),
      hero_image_alt: row.hero_image_alt,
      body_html: renderMarkdown(row.body_markdown || ''),
      provider: row.ai_provider,
      published_at: row.published_at,
      published_iso: new Date((row.published_at || 0) * 1000).toISOString(),
    },
  }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Body content rarely changes after publish; long cache is fine.
      'cache-control': 'public, max-age=600',
      'access-control-allow-origin': '*',
    },
  });
};
