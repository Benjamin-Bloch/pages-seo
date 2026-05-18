// Dynamic sitemap. Pulls published blog posts + programmatic pages from
// D1 and emits one <url> per row plus the static marketing entries.
export const onRequestGet = async ({ env, request }) => {
  const host = new URL(request.url).hostname;
  const site = `https://${host}`;
  const lastmod = new Date().toISOString().slice(0, 10);

  const blogs = await env.DB.prepare(
    `SELECT slug, published_at FROM blog_posts WHERE status='published' ORDER BY published_at DESC LIMIT 5000`
  ).all().catch(() => ({ results: [] }));
  const progs = await env.DB.prepare(
    `SELECT slug, published_at FROM prog_pages WHERE status='published' ORDER BY published_at DESC LIMIT 10000`
  ).all().catch(() => ({ results: [] }));

  const entries = [
    { path: '/',     priority: '1.0', changefreq: 'weekly', lastmod },
    { path: '/blog', priority: '0.9', changefreq: 'daily',  lastmod },
  ];
  for (const p of (blogs.results || [])) {
    entries.push({
      path: `/blog/${p.slug}`,
      priority: '0.7', changefreq: 'monthly',
      lastmod: new Date((p.published_at || 0) * 1000).toISOString().slice(0, 10),
    });
  }
  for (const p of (progs.results || [])) {
    entries.push({
      path: `/p/${p.slug}`,
      priority: '0.6', changefreq: 'monthly',
      lastmod: new Date((p.published_at || 0) * 1000).toISOString().slice(0, 10),
    });
  }
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map((e) =>
      `  <url><loc>${site}${e.path}</loc><lastmod>${e.lastmod}</lastmod>` +
      `<changefreq>${e.changefreq}</changefreq><priority>${e.priority}</priority></url>`
    ),
    '</urlset>',
  ].join('\n');
  return new Response(body, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
};
