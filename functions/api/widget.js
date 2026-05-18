// /api/widget — JSON feed of recent posts for the embeddable widget.
// CORS-open since it's meant for cross-origin consumption.
export const onRequestGet = async ({ env, request }) => {
  const url = new URL(request.url);
  const count = Math.max(1, Math.min(20, parseInt(url.searchParams.get('count'), 10) || 5));
  const r = await env.DB.prepare(
    `SELECT slug, title, meta_description, hero_image_key, published_at
       FROM blog_posts WHERE status='published'
       ORDER BY published_at DESC LIMIT ?`
  ).bind(count).all();
  return new Response(JSON.stringify({ posts: r.results || [] }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300, s-maxage=600',
      'access-control-allow-origin': '*',
    },
  });
};
