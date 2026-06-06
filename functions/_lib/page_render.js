// Renders a single content page (blog post or programmatic landing) to
// HTML with full SEO metadata + Article schema.
import { renderMarkdown } from './markdown.js';
import { esc } from './util.js';

// Default hero dimensions when the DB row didn't capture them. Most of
// our covers are 1200×630 (the OG default) so emitting width/height
// attributes at those dimensions stops the browser from reserving
// the wrong space — CLS goes to zero even before the image decodes.
const HERO_W = 1200, HERO_H = 630;

// Read these from env.SITE_BRAND_* if set so self-hosters can override.
function brand(env) {
  return {
    name: env?.SITE_NAME || 'pages-seo',
    description: env?.SITE_DESCRIPTION || 'Self-hosted programmatic-SEO toolkit on Cloudflare Pages.',
    logoUrl: env?.SITE_LOGO_URL || null,
    ctaSignupUrl: env?.SITE_SIGNUP_URL || '/',
  };
}

// Build the JSON-LD graph. We now emit four entities:
//   - Article (or WebPage for prog pages) — the content itself
//   - BreadcrumbList — Home › Blog › <title>
//   - WebSite — with a SearchAction so Google can render the
//     Sitelinks Searchbox in SERPs (significant CTR uplift on
//     brand queries; harmless on others)
//   - Organization — author/publisher tied back to the brand
//
// The graph form lets us cross-reference @id between nodes so
// Google sees the publisher of an Article is the same Organization
// referenced by the WebSite.
function jsonLD({ site, post, host, kind, settings }) {
  const isArticle = kind === 'blog';
  const baseUrl = `https://${host}`;
  const orgId   = `${baseUrl}/#org`;
  const webId   = `${baseUrl}/#website`;
  const pageId  = `${baseUrl}${post.urlPath}#main`;

  // Same three-way precedence as the on-page <img> hero so the
  // structured-data image, the og:image, and the visible hero are
  // all the same URL.
  // Cache-bust the cover URL with the template's updated_at so any
  // template edit forces edge + browser revalidation. Without this,
  // /cover/<slug>.svg can serve stale renders for up to the
  // s-maxage TTL (15 min today) after a template change.
  const useCover = (settings?.hero_image_mode === 'cover') && settings?._has_default_template;
  const coverV = settings?._default_template_v ? `?v=${settings._default_template_v}` : '';
  const heroAbs = useCover
    ? `${baseUrl}/cover/${encodeURIComponent(post.slug || 'home')}.svg${coverV}`
    : post.hero_image_key
      ? `${baseUrl}/image/${post.hero_image_key}`
      : `${baseUrl}/og/${encodeURIComponent(post.slug || 'home')}.svg`;

  const graph = [
    {
      '@type': 'Organization',
      '@id': orgId,
      name: site.name,
      url: baseUrl,
      ...(site.logoUrl ? { logo: { '@type': 'ImageObject', url: site.logoUrl } } : {}),
    },
    {
      '@type': 'WebSite',
      '@id': webId,
      url: baseUrl,
      name: site.name,
      description: site.description,
      publisher: { '@id': orgId },
      potentialAction: {
        '@type': 'SearchAction',
        target: {
          '@type': 'EntryPoint',
          urlTemplate: `${baseUrl}/blog?q={search_term_string}`,
        },
        'query-input': 'required name=search_term_string',
      },
    },
    {
      '@type': isArticle ? 'Article' : 'WebPage',
      '@id': pageId,
      headline: post.title,
      description: post.meta_description,
      url: `${baseUrl}${post.urlPath}`,
      image: {
        '@type': 'ImageObject',
        url: heroAbs,
        width: HERO_W,
        height: HERO_H,
      },
      datePublished: new Date((post.published_at || 0) * 1000).toISOString(),
      dateModified:  new Date((post.modified_at || post.published_at || 0) * 1000).toISOString(),
      author:    { '@id': orgId },
      publisher: { '@id': orgId },
      isPartOf:  { '@id': webId },
      inLanguage: 'en',
      mainEntityOfPage: { '@type': 'WebPage', '@id': `${baseUrl}${post.urlPath}` },
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${baseUrl}/` },
        isArticle
          ? { '@type': 'ListItem', position: 2, name: 'Blog', item: `${baseUrl}/blog` }
          : null,
        { '@type': 'ListItem', position: isArticle ? 3 : 2, name: post.title },
      ].filter(Boolean),
    },
  ];

  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph });
}

export function renderContentPage({ env, request, post, kind, related = [], settings = {} }) {
  const host = new URL(request.url).hostname;
  const site = brand(env);
  const urlPath = post.urlPath;
  const dateStr = new Date((post.published_at || 0) * 1000).toLocaleDateString('en-GB', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  // Hero image source — three-way fall-through, in priority order:
  //
  //   1. hero_image_mode === 'cover' AND a default cover_template
  //      exists → /cover/<slug>.svg. The SVG renders live from the
  //      template + post variables, so flipping the template
  //      retroactively updates every post's cover with no per-post
  //      storage. This is the path that makes "Apply to all" + the
  //      template editor a single source of truth.
  //
  //   2. Else if post.hero_image_key is set → /image/<key>. Legacy
  //      per-post PNGs (AI-generated or manually applied) keep
  //      working.
  //
  //   3. Else → /og/<slug>.svg. A built-in generic card so we
  //      ALWAYS emit a valid og:image (never null), even for posts
  //      that haven't been through the image pipeline.
  //
  // The hero is the LCP element so we set width/height,
  // decoding=async, fetchpriority=high, and a preload link in
  // <head>. With those four together CLS is zero and LCP-time
  // drops measurably.
  const useCoverEndpoint = (settings?.hero_image_mode === 'cover') && settings?._has_default_template;
  const heroSrc = useCoverEndpoint
    ? `/cover/${esc(post.slug || 'home')}.svg${settings?._default_template_v ? '?v=' + settings._default_template_v : ''}`
    : post.hero_image_key
      ? `/image/${esc(post.hero_image_key)}`
      : `/og/${esc(post.slug || 'home')}.svg`;
  const heroAlt = esc(post.hero_image_alt || post.title);
  // Wrap the hero img in a shimmer-skeleton container. Three layers:
  //   - .hero-wrap is the sized box (1200×630 aspect ratio).
  //   - ::before draws an animated shimmer (linear-gradient sliding
  //     across) so the user perceives motion even when nothing's
  //     actually loaded.
  //   - <img class="hero"> fades in via opacity 0→1 once its
  //     `load` event fires. The onload handler is inline so there's
  //     no JS dependency.
  // When the image is already in cache (cache hit, fast connection),
  // onload fires before paint and the skeleton never shows visibly —
  // no perceived flicker either way.
  const heroImg = `
<div class="hero-wrap" style="aspect-ratio:${HERO_W}/${HERO_H}">
  <img class="hero" src="${heroSrc}" alt="${heroAlt}" width="${HERO_W}" height="${HERO_H}" decoding="async" fetchpriority="high" onload="this.classList.add('is-loaded')" onerror="this.classList.add('is-loaded')" />
</div>`;

  const bodyHTML = renderMarkdown(post.body_markdown);

  // "Read next" — only on /blog/<slug> pages and only when we have at
  // least one sibling post to link to.
  const relatedHTML = (kind === 'blog' && related.length) ? `
<aside class="read-next">
  <h2 class="read-next-title">Read next</h2>
  <ul class="read-next-list">
    ${related.map((r) => {
      const rSrc = r.hero_image_key ? `/image/${esc(r.hero_image_key)}` : '';
      return `
      <li>
        <a href="/blog/${esc(r.slug)}">
          ${rSrc ? `<img src="${rSrc}" alt="${esc(r.hero_image_alt || r.title)}" width="640" height="336" loading="lazy" decoding="async" />` : ''}
          <div class="read-next-meta">
            <h3>${esc(r.title)}</h3>
            ${r.meta_description ? `<p>${esc(r.meta_description.slice(0, 140))}</p>` : ''}
          </div>
        </a>
      </li>`;
    }).join('')}
  </ul>
</aside>` : '';

  // Search-engine verification metas. We read from D1 settings so
  // self-hosters can configure verification per-install without
  // editing this file. Bing recommends meta name="msvalidate.01";
  // Google supports both file upload and meta name="google-site-
  // verification" — we offer the meta path since it survives
  // redeploys without R2 file management.
  const gv = String(settings?.google_site_verification || '').trim();
  const bv = String(settings?.bing_site_verification   || '').trim();
  const verifyMetas = [
    gv ? `<meta name="google-site-verification" content="${esc(gv)}" />` : '',
    bv ? `<meta name="msvalidate.01" content="${esc(bv)}" />` : '',
  ].filter(Boolean).join('\n');

  // Critical preload — the hero image is almost always the LCP
  // element. Preload tells the browser to fetch it in parallel with
  // the HTML, which on a typical blog cuts LCP by ~300-800ms.
  const preloadHero = `<link rel="preload" as="image" href="${heroSrc}" fetchpriority="high" />`;

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
<link rel="alternate" type="application/rss+xml" title="${esc(env.SITE_NAME || settings.site_name || 'pages-seo')} — RSS feed" href="https://${host}/feed.xml" />
${verifyMetas}
<meta property="og:type" content="${kind === 'blog' ? 'article' : 'website'}" />
<meta property="og:title" content="${esc(post.title)}" />
<meta property="og:description" content="${esc(post.meta_description)}" />
<meta property="og:url" content="https://${host}${urlPath}" />
<meta property="og:image" content="https://${host}${heroSrc}" />
<meta property="og:image:width" content="${HERO_W}" />
<meta property="og:image:height" content="${HERO_H}" />
<meta property="og:site_name" content="${esc(site.name)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(post.title)}" />
<meta name="twitter:description" content="${esc(post.meta_description)}" />
<meta name="twitter:image" content="https://${host}${heroSrc}" />
${preloadHero}
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&display=swap" />
<link rel="stylesheet" href="/style.css" />
<script type="application/ld+json">${jsonLD({ site, post: { ...post, urlPath }, host, kind, settings })}</script>
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
