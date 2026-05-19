// /blog — index of published posts.
import { esc } from '../_lib/util.js';

export const onRequestGet = async ({ env }) => {
  const r = await env.DB.prepare(
    `SELECT slug, title, meta_description, hero_image_key, hero_image_alt, published_at
       FROM blog_posts WHERE status='published' ORDER BY published_at DESC LIMIT 100`
  ).all();
  const siteName = env.SITE_NAME || 'pages-seo';
  const siteDesc = env.SITE_DESCRIPTION || `Articles from ${siteName}.`;
  const posts = r.results || [];
  const items = posts.map((p) => {
    const date = new Date((p.published_at || 0) * 1000).toLocaleDateString('en-GB', {
      year: 'numeric', month: 'long', day: 'numeric',
    });
    const img = p.hero_image_key
      ? `<img src="/image/${esc(p.hero_image_key)}" alt="${esc(p.hero_image_alt || p.title)}" loading="lazy" />`
      : '';
    return `
      <li>
        ${img}
        <div class="blog-meta">
          <div class="blog-date">${esc(date)}</div>
          <h2><a href="/blog/${esc(p.slug)}">${esc(p.title)}</a></h2>
          <p>${esc((p.meta_description || '').slice(0, 200))}</p>
        </div>
      </li>`;
  }).join('');
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Blog · ${esc(siteName)}</title>
<meta name="description" content="${esc(siteDesc)}" />
<link rel="canonical" href="/blog" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&display=swap" />
<link rel="stylesheet" href="/style.css" />
</head>
<body>
<header class="nav">
  <a class="brand" href="/">${esc(siteName)}</a>
  <nav><a href="/blog" aria-current="page">Blog</a></nav>
</header>
<main class="blog-index">
  <h1>Blog</h1>
  <p class="lede">${esc(siteDesc)}</p>
  ${posts.length ? `<ul>${items}</ul>` : '<p class="lede">First post lands soon.</p>'}
</main>
<footer class="foot">
  <span>${esc(siteName)}</span> · <a href="/">Home</a> · <a href="/blog">Blog</a>
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
