// Renders a single content page (blog post or programmatic landing) to
// HTML with full SEO metadata + Article schema.
import { renderMarkdown } from './markdown.js';
import { esc } from './util.js';

// Read these from env.SITE_BRAND_* if set so self-hosters can override.
function brand(env) {
  return {
    name: env?.SITE_NAME || 'pages-seo',
    description: env?.SITE_DESCRIPTION || 'Self-hosted programmatic-SEO toolkit on Cloudflare Pages.',
    logoUrl: env?.SITE_LOGO_URL || null,
    ctaSignupUrl: env?.SITE_SIGNUP_URL || '/',
  };
}

function jsonLD({ site, post, host, kind }) {
  const isArticle = kind === 'blog';
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': isArticle ? 'Article' : 'WebPage',
        '@id': `https://${host}${post.urlPath}#main`,
        headline: post.title,
        description: post.meta_description,
        image: post.hero_image_key ? `https://${host}/image/${post.hero_image_key}` : undefined,
        datePublished: new Date((post.published_at || 0) * 1000).toISOString(),
        dateModified: new Date((post.published_at || 0) * 1000).toISOString(),
        author: { '@type': 'Organization', name: site.name },
        publisher: { '@type': 'Organization', name: site.name, url: `https://${host}` },
        mainEntityOfPage: { '@type': 'WebPage', '@id': `https://${host}${post.urlPath}` },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `https://${host}/` },
          isArticle
            ? { '@type': 'ListItem', position: 2, name: 'Blog', item: `https://${host}/blog` }
            : null,
          { '@type': 'ListItem', position: isArticle ? 3 : 2, name: post.title },
        ].filter(Boolean),
      },
    ],
  });
}

export function renderContentPage({ env, request, post, kind, related = [] }) {
  const host = new URL(request.url).hostname;
  const site = brand(env);
  const urlPath = post.urlPath;
  const dateStr = new Date((post.published_at || 0) * 1000).toLocaleDateString('en-GB', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
  const heroImg = post.hero_image_key
    ? `<img class="hero" src="/image/${esc(post.hero_image_key)}" alt="${esc(post.hero_image_alt || post.title)}" />`
    : '';
  const bodyHTML = renderMarkdown(post.body_markdown);

  // "Read next" — only on /blog/<slug> pages and only when we have at
  // least one sibling post to link to.
  const relatedHTML = (kind === 'blog' && related.length) ? `
<aside class="read-next">
  <h2 class="read-next-title">Read next</h2>
  <ul class="read-next-list">
    ${related.map((r) => `
      <li>
        <a href="/blog/${esc(r.slug)}">
          ${r.hero_image_key ? `<img src="/image/${esc(r.hero_image_key)}" alt="${esc(r.hero_image_alt || r.title)}" loading="lazy" />` : ''}
          <div class="read-next-meta">
            <h3>${esc(r.title)}</h3>
            ${r.meta_description ? `<p>${esc(r.meta_description.slice(0, 140))}</p>` : ''}
          </div>
        </a>
      </li>`).join('')}
  </ul>
</aside>` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${esc(post.title)} · ${esc(site.name)}</title>
<meta name="description" content="${esc(post.meta_description)}" />
${post.keywords ? `<meta name="keywords" content="${esc(post.keywords)}" />` : ''}
<link rel="canonical" href="https://${host}${urlPath}" />
<meta name="robots" content="index,follow,max-image-preview:large" />
<meta property="og:type" content="${kind === 'blog' ? 'article' : 'website'}" />
<meta property="og:title" content="${esc(post.title)}" />
<meta property="og:description" content="${esc(post.meta_description)}" />
<meta property="og:url" content="https://${host}${urlPath}" />
${post.hero_image_key ? `<meta property="og:image" content="https://${host}/image/${esc(post.hero_image_key)}" />` : ''}
<meta name="twitter:card" content="summary_large_image" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&display=swap" />
<link rel="stylesheet" href="/style.css" />
<script type="application/ld+json">${jsonLD({ site, post: { ...post, urlPath }, host, kind })}</script>
</head>
<body>
<header class="nav">
  <a class="brand" href="/">${esc(site.name)}</a>
  <nav><a href="/blog">Blog</a></nav>
</header>
<main class="post-shell">
  <div class="crumb"><a href="/">Home</a>${kind === 'blog' ? ' · <a href="/blog">Blog</a>' : ''}</div>
  <h1 class="post-title">${esc(post.title)}</h1>
  <div class="post-date">${esc(dateStr)}</div>
  ${heroImg}
  <article class="prose">${bodyHTML}</article>
  ${relatedHTML}
</main>
<footer class="foot">
  <span>${esc(site.name)}</span> · <a href="/">Home</a> · <a href="/blog">Blog</a>
</footer>
</body>
</html>`;
}
