// /blog and /blog/page/N — index of published posts, paginated.
//
// Why pagination matters here: when we passed 100 published posts
// older entries silently fell off /blog. They were still in the
// sitemap so Google might rediscover them, but the loss of internal
// links to /blog/<old-slug> hurts both crawl budget and the page's
// authority. With pagination every post stays one hop from the
// archive entrypoint and rel=prev/next gives Google the topology
// hint to walk the sequence as a series.

import { esc } from '../_lib/util.js';
import { loadSettings } from '../_lib/settings.js';

// Page size for /blog and /blog/page/N. Matches the embed widget's
// default so the SERP archive feels the same as the embed.
// Sitemap.xml.js shares the constant via a re-import below.
export const PAGE_SIZE = 10;

export async function renderBlogIndex({ env, request, page = 1 }) {
  const host = new URL(request.url).hostname;
  const baseUrl = `https://${host}`;
  page = Math.max(1, parseInt(page, 10) || 1);

  // Total + this-page rows in two queries. COUNT is cheap on D1
  // when filtered by an indexed column (status).
  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM blog_posts WHERE status='published'`
  ).first().catch(() => ({ n: 0 }));
  const total = totalRow?.n || 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Out-of-range pages → 404 so we don't waste indexing on empty
  // archives.
  if (page > totalPages && page !== 1) {
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }

  const offset = (page - 1) * PAGE_SIZE;
  const r = await env.DB.prepare(
    `SELECT slug, title, meta_description, hero_image_key, hero_image_alt, published_at
       FROM blog_posts WHERE status='published'
       ORDER BY published_at DESC LIMIT ? OFFSET ?`
  ).bind(PAGE_SIZE, offset).all();
  const posts = r.results || [];

  const settings = await loadSettings(env).catch(() => ({}));
  const siteName = env.SITE_NAME || settings.site_name || 'pages-seo';
  const siteDesc = env.SITE_DESCRIPTION || settings.site_description ||
                   `Articles from ${siteName}.`;

  const items = posts.map((p) => {
    const date = new Date((p.published_at || 0) * 1000).toLocaleDateString('en-GB', {
      year: 'numeric', month: 'long', day: 'numeric',
    });
    // Prefer the stored R2 hero image; fall back to the live cover
    // template so a card is never blank.
    const imgSrc = p.hero_image_key
      ? `/image/${esc(p.hero_image_key)}`
      : `/cover/${esc(p.slug)}.svg`;
    const img = `<img src="${imgSrc}" alt="${esc(p.hero_image_alt || p.title)}" width="640" height="336" loading="lazy" decoding="async" />`;
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

  // Canonical: page 1 is /blog (so Google merges /blog and any
  // /blog/page/1 link equity). Other pages are self-canonical.
  const canonical = page === 1 ? `${baseUrl}/blog` : `${baseUrl}/blog/page/${page}`;

  // rel=prev / rel=next — Google deprecated using these for indexing
  // in 2019 but still uses them as hints, and Bing + Yandex use them
  // actively. Cheap to emit, no downside.
  const prevHref = page === 2 ? '/blog' : (page > 2 ? `/blog/page/${page - 1}` : null);
  const nextHref = page < totalPages ? `/blog/page/${page + 1}` : null;
  const relLinks = [
    prevHref ? `<link rel="prev" href="${prevHref}" />` : '',
    nextHref ? `<link rel="next" href="${nextHref}" />` : '',
  ].filter(Boolean).join('');

  // On-page pager — visible to users + crawlable for search engines.
  // Three regions of links: prev / page numbers (windowed to ±3) / next.
  const windowSize = 3;
  const pageNums = [];
  for (let i = Math.max(1, page - windowSize); i <= Math.min(totalPages, page + windowSize); i++) {
    pageNums.push(i);
  }
  const pagerLinks = pageNums.map((i) => {
    const href = i === 1 ? '/blog' : `/blog/page/${i}`;
    const aria = i === page ? ' aria-current="page"' : '';
    const cls = i === page ? 'pager-num pager-current' : 'pager-num';
    return `<a class="${cls}" href="${href}"${aria}>${i}</a>`;
  }).join(' ');
  // Pager: when there's more than one page we show the full nav.
  // When there's only one we still emit a small summary ("4 posts")
  // so the page never looks like the list is the whole story — it
  // also gives Google a hint about the collection size.
  const pagerHTML = totalPages > 1 ? `
<nav class="pager" aria-label="Blog pagination">
  ${prevHref ? `<a class="pager-prev" rel="prev" href="${prevHref}">← Newer</a>` : ''}
  <span class="pager-nums">${pagerLinks}</span>
  ${nextHref ? `<a class="pager-next" rel="next" href="${nextHref}">Older →</a>` : ''}
  <span class="pager-pos">Page ${page} of ${totalPages} · ${total} post${total === 1 ? '' : 's'}</span>
</nav>` : (total > 0 ? `
<nav class="pager pager-single" aria-label="Blog pagination">
  <span class="pager-pos">${total} post${total === 1 ? '' : 's'}</span>
</nav>` : '');

  // Page-specific title hint: page 1 keeps the canonical "Blog ·
  // brand"; later pages append "page N" so the SERP listing
  // disambiguates.
  const titleStr = page === 1
    ? `Blog · ${siteName}`
    : `Blog · page ${page} · ${siteName}`;

  // JSON-LD: WebSite with SearchAction. The archive page is the
  // canonical "site search entry point" for the SERP Sitelinks
  // Searchbox feature.
  const ldJson = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': `${baseUrl}/#website`,
        url: baseUrl, name: siteName, description: siteDesc,
        potentialAction: {
          '@type': 'SearchAction',
          target: { '@type': 'EntryPoint', urlTemplate: `${baseUrl}/blog?q={search_term_string}` },
          'query-input': 'required name=search_term_string',
        },
      },
      {
        '@type': 'CollectionPage',
        '@id': `${canonical}#page`,
        url: canonical, name: titleStr,
        isPartOf: { '@id': `${baseUrl}/#website` },
        mainEntity: {
          '@type': 'ItemList',
          itemListElement: posts.map((p, i) => ({
            '@type': 'ListItem',
            position: offset + i + 1,
            url: `${baseUrl}/blog/${p.slug}`,
            name: p.title,
          })),
        },
      },
    ],
  });

  const gv = String(settings?.google_site_verification || '').trim();
  const bv = String(settings?.bing_site_verification   || '').trim();
  const verifyMetas = [
    gv ? `<meta name="google-site-verification" content="${esc(gv)}" />` : '',
    bv ? `<meta name="msvalidate.01" content="${esc(bv)}" />` : '',
  ].filter(Boolean).join('\n');

  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${esc(titleStr)}</title>
<meta name="description" content="${esc(siteDesc)}" />
<link rel="canonical" href="${canonical}" />
${relLinks}
${verifyMetas}
<link rel="alternate" type="application/rss+xml" title="${esc(siteName)} — RSS feed" href="${baseUrl}/feed.xml" />
<meta name="robots" content="index,follow" />
<meta property="og:title" content="${esc(titleStr)}" />
<meta property="og:description" content="${esc(siteDesc)}" />
<meta property="og:url" content="${canonical}" />
<meta property="og:type" content="website" />
<meta name="twitter:card" content="summary" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&display=swap" />
<link rel="stylesheet" href="/style.css" />
<script type="application/ld+json">${ldJson}</script>
</head>
<body>
<header class="nav">
  <a class="brand" href="/">${esc(siteName)}</a>
  <nav><a href="/blog" aria-current="page">Blog</a></nav>
</header>
<main class="blog-index">
  <header class="blog-index-head">
    <div>
      <h1>Blog${page > 1 ? ` <span class="page-suffix">— page ${page}</span>` : ''}</h1>
      <p class="lede">${esc(siteDesc)}</p>
    </div>
    <!-- Search box. Filters the visible list via /api/widget?q=…
         (same endpoint the embed widget uses), so result ordering
         is consistent across surfaces. Falls back to the canonical
         /blog?q= URL if JavaScript is disabled — Google's
         SearchAction JSON-LD targets that URL too. -->
    <form id="blog-search-form" role="search" action="/blog" method="GET" class="blog-search">
      <input id="blog-search-input"
             type="search" name="q"
             placeholder="Search posts…"
             autocomplete="off" spellcheck="false"
             aria-label="Search posts"
             value="" />
      <button type="submit" class="blog-search-go" aria-label="Search">→</button>
    </form>
  </header>
  ${posts.length ? `<ul id="blog-list">${items}</ul>` : '<ul id="blog-list" hidden></ul><p id="blog-noposts" class="lede">First post lands soon.</p>'}
  <div id="blog-empty" class="blog-empty" hidden></div>
  ${pagerHTML}
</main>

<!-- Inline client-side search. Reads ?q= from the URL on load to
     pre-fill the input (so /blog?q=foo works from a deep link or
     SearchAction). Debounces 200ms; fetches /api/widget for matches
     and re-renders the list inline without leaving the page.

     Defence in depth: the renderer never uses innerHTML on the
     server response. Cards are built via document.createElement and
     textContent so post-supplied strings can't be HTML-injected
     even if the API ever returned tainted data. -->
<script>
(function () {
  var form  = document.getElementById('blog-search-form');
  var input = document.getElementById('blog-search-input');
  var list  = document.getElementById('blog-list');
  var empty = document.getElementById('blog-empty');
  var pager = document.querySelector('main.blog-index .pager');
  var noposts = document.getElementById('blog-noposts');
  if (!form || !input || !list) return;

  // Restore q from URL on first paint.
  try {
    var q0 = new URL(location.href).searchParams.get('q') || '';
    if (q0) { input.value = q0; doSearch(q0, false); }
  } catch (e) {}

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    doSearch(input.value.trim(), true);
  });

  // Debounced live filter as the user types.
  var t = null;
  input.addEventListener('input', function () {
    if (t) clearTimeout(t);
    t = setTimeout(function () { doSearch(input.value.trim(), false); }, 200);
  });

  function setEmpty(msg) {
    if (msg) { empty.hidden = false; empty.textContent = msg; }
    else { empty.hidden = true; empty.textContent = ''; }
  }

  function clearList() {
    while (list.firstChild) list.removeChild(list.firstChild);
  }

  function buildItem(p) {
    var li = document.createElement('li');
    if (p.image) {
      var img = document.createElement('img');
      img.src = p.image;
      img.alt = p.title || '';
      img.setAttribute('width',  '640');
      img.setAttribute('height', '336');
      img.loading  = 'lazy';
      img.decoding = 'async';
      li.appendChild(img);
    }
    var meta = document.createElement('div');
    meta.className = 'blog-meta';
    var date = document.createElement('div');
    date.className = 'blog-date';
    date.textContent = p.date || '';
    meta.appendChild(date);
    var h2 = document.createElement('h2');
    var a  = document.createElement('a');
    a.href = '/blog/' + encodeURIComponent(p.slug);
    a.textContent = p.title || '';
    h2.appendChild(a);
    meta.appendChild(h2);
    var pgr = document.createElement('p');
    pgr.textContent = (p.excerpt || '').slice(0, 200);
    meta.appendChild(pgr);
    li.appendChild(meta);
    return li;
  }

  function setUrlQ(q) {
    try {
      var u = new URL(location.href);
      if (q) u.searchParams.set('q', q); else u.searchParams.delete('q');
      history.replaceState({}, '', u.pathname + (u.search || '') + (u.hash || ''));
    } catch (e) {}
  }

  function doSearch(q, hardSubmit) {
    setUrlQ(q);
    if (!q) {
      if (hardSubmit) { location.href = '/blog'; return; }
      fetchPage('', 1);
      return;
    }
    fetchPage(q, 1);
  }

  function fetchPage(q, page) {
    var url = '/api/widget?per_page=10&page=' + page + (q ? '&q=' + encodeURIComponent(q) : '');
    fetch(url, { credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (d) {
        clearList();
        list.hidden = false;
        if (noposts) noposts.hidden = true;
        if (!d.posts || !d.posts.length) {
          setEmpty(q ? 'No posts match "' + q + '".' : 'First post lands soon.');
          if (pager) pager.style.display = 'none';
          return;
        }
        setEmpty('');
        for (var i = 0; i < d.posts.length; i++) {
          list.appendChild(buildItem(d.posts[i]));
        }
        // Hide server-rendered pager while in search mode.
        if (pager) pager.style.display = q ? 'none' : '';
      })
      .catch(function () {
        setEmpty('Search failed. Try again, or browse the full list.');
      });
  }
})();
</script>
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
}

export const onRequestGet = (ctx) => renderBlogIndex({ env: ctx.env, request: ctx.request, page: 1 });
