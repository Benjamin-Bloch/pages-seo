// /blog/<slug>
import { renderContentPage } from '../_lib/page_render.js';
import { loadSettings } from '../_lib/settings.js';

export const onRequestGet = async ({ env, request, params }) => {
  const slug = String(params.slug || '').toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }
  // Honour slug renames: blog_post_redirects maps old_slug -> new_slug.
  // 301 transfers ranking to the new URL. Table is created on demand by
  // the admin rename endpoint; lookup degrades gracefully if missing.
  try {
    const r = await env.DB.prepare(
      `SELECT new_slug FROM blog_post_redirects WHERE old_slug = ? LIMIT 1`
    ).bind(slug).first();
    if (r?.new_slug) {
      return Response.redirect(new URL(`/blog/${r.new_slug}`, request.url).toString(), 301);
    }
  } catch { /* table not yet created */ }
  const post = await env.DB.prepare(
    `SELECT slug, title, meta_description, body_markdown, hero_image_key, hero_image_alt,
            keywords, status, published_at
       FROM blog_posts WHERE slug = ? LIMIT 1`
  ).bind(slug).first();
  if (!post) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  if (post.status === 'hidden') return new Response('Gone', { status: 410, headers: { 'content-type': 'text/plain' } });
  // 'review' posts are admin-only drafts — invisible to public visitors
  // but still listed in /admin. Treat as 404 to keep them off Google.
  if (post.status === 'review') return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
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

  // Tag the settings with whether a default cover template exists.
  // If so AND hero_image_mode=cover, the page_render.js layer will
  // point the hero img + og:image at /cover/<slug>.svg (live
  // server-rendered from the template + post variables, no per-post
  // PNG stored). One query per request — D1 indexes is_default, so
  // it's effectively free.
  //
  // We also pull updated_at so page_render can append it as a
  // ?v=<ts> query on the cover URL. That changes the edge cache
  // key every time the template is edited, so admins don't see
  // stale covers after a template update.
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

  return new Response(renderContentPage({ env, request, post, kind: 'blog', related, settings }), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=600, s-maxage=3600',
    },
  });
};
