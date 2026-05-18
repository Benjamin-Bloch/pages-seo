// /blog — index of published posts.
import { esc } from '../_lib/util.js';

export const onRequestGet = async ({ env }) => {
  const r = await env.DB.prepare(
    `SELECT slug, title, meta_description, hero_image_key, hero_image_alt, published_at
       FROM blog_posts WHERE status='published' ORDER BY published_at DESC LIMIT 100`
  ).all();
  const siteName = env.SITE_NAME || 'pages-seo';
  const posts = r.results || [];
  const grid = posts.map((p) => {
    const date = new Date((p.published_at || 0) * 1000).toLocaleDateString('en-GB', {
      year: 'numeric', month: 'long', day: 'numeric',
    });
    const img = p.hero_image_key
      ? `<img src="/image/${esc(p.hero_image_key)}" alt="${esc(p.hero_image_alt || p.title)}" loading="lazy" />`
      : '<div class="post-card-img-placeholder" aria-hidden="true"></div>';
    return `
      <article class="post-card">
        <a href="/blog/${esc(p.slug)}">
          ${img}
          <div class="post-card-body">
            <time>${esc(date)}</time>
            <h2>${esc(p.title)}</h2>
            <p>${esc((p.meta_description || '').slice(0, 180))}</p>
          </div>
        </a>
      </article>`;
  }).join('');
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Blog · ${esc(siteName)}</title>
<meta name="description" content="Articles published by ${esc(siteName)}." />
<link rel="stylesheet" href="/style.css" />
</head>
<body>
<header class="nav">
  <a class="brand" href="/">${esc(siteName)}</a>
  <nav><a href="/blog" aria-current="page">Blog</a></nav>
</header>
<main class="blog-index">
  <header class="blog-hero">
    <h1>Blog</h1>
    <p>Articles from ${esc(siteName)}.</p>
  </header>
  ${posts.length ? `<div class="post-grid">${grid}</div>` : '<div class="empty-state">First post lands soon.</div>'}
</main>
<footer class="foot">
  <span>${esc(siteName)}</span> · <a href="/">Home</a>
</footer>
</body>
</html>`;
  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300, s-maxage=3600',
    },
  });
};
