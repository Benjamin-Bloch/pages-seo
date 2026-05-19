// GET /api/public/latest-post
//
// Returns the most recently-published blog post as a small JSON payload
// so the marketing landing page can replace its static "real post"
// example with the actual latest output of the toolkit. Cached at the
// edge for 5 minutes so this isn't a per-pageview database hit.
//
// Public (no auth): the data is the same content already at /blog/<slug>.
import { json } from '../../_lib/util.js';

export const onRequestGet = async ({ env }) => {
  if (!env?.DB) {
    return json(200, { ok: true, post: null, note: 'no_db' });
  }
  try {
    const row = await env.DB.prepare(
      `SELECT slug, title, meta_description, keywords, hero_image_key,
              published_at, ai_provider, LENGTH(body_markdown) AS body_chars
         FROM blog_posts
        WHERE status = 'published'
        ORDER BY published_at DESC LIMIT 1`
    ).first();

    if (!row) {
      return new Response(JSON.stringify({ ok: true, post: null }), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=60',
          'access-control-allow-origin': '*',
        },
      });
    }

    return new Response(JSON.stringify({
      ok: true,
      post: {
        slug: row.slug,
        title: row.title,
        meta_description: row.meta_description,
        keywords: row.keywords,
        body_chars: row.body_chars,
        provider: row.ai_provider,
        published_at: row.published_at,
        published_iso: new Date((row.published_at || 0) * 1000).toISOString(),
        hero_image_url: row.hero_image_key
          ? '/image/' + row.hero_image_key.split('/').map(encodeURIComponent).join('/')
          : null,
        url: '/blog/' + row.slug,
      },
    }), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=300',  // 5 minutes
        'access-control-allow-origin': '*',
      },
    });
  } catch (e) {
    return json(500, { ok: false, error: String(e?.message || e).slice(0, 200) });
  }
};
