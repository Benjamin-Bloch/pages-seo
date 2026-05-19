// Shared Soro-style blog-embed widget renderer.
//
// Consumers:
//   /widget.js           → generic widget; uses site name + latest posts
//   /api/embed/<id>      → named embed; uses settings from blog_embeds row
//
// Contract on the host page:
//   <div id="ps-blog"></div>
//   <script src="…" defer></script>

export function jsString(s) {
  return "'" + String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(new RegExp('\u2028', 'g'), '\\u2028')
    .replace(new RegExp('\u2029', 'g'), '\\u2029') + "'";
}

export function imageUrlFor(key) {
  if (!key) return null;
  return '/image/' + key.split('/').map(encodeURIComponent).join('/');
}

export async function loadArticles(env, limit) {
  const rows = await env.DB.prepare(
    `SELECT slug, title, meta_description, hero_image_key, published_at
       FROM blog_posts WHERE status = 'published'
       ORDER BY published_at DESC LIMIT ?`
  ).bind(limit).all().catch(() => ({ results: [] }));
  return (rows.results || []).map((r) => ({
    slug: r.slug,
    title: r.title,
    excerpt: r.meta_description || '',
    image: imageUrlFor(r.hero_image_key),
    date: new Date((r.published_at || 0) * 1000)
      .toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    iso: new Date((r.published_at || 0) * 1000).toISOString(),
  }));
}

export function widgetBody({ title, accent = '#0a0a0a', apiBase, embedId = '', articles }) {
  const css = [
    '#ps-blog{--ps-accent:' + accent + ';--ps-bg:#fff;--ps-fg:#0a0a0a;--ps-muted:#6b6760;--ps-line:#e8e5dd;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:var(--ps-fg);max-width:900px;margin:0 auto;line-height:1.55}',
    '@media (prefers-color-scheme: dark){#ps-blog{--ps-bg:#0e0f12;--ps-fg:#f0eee8;--ps-muted:#a09c93;--ps-line:#262932}}',
    '.ps-blog{padding:24px 0}',
    '.ps-blog-head{margin:0 0 24px;padding:0 0 14px;border-bottom:1px solid var(--ps-line);display:flex;justify-content:space-between;align-items:baseline;gap:10px}',
    '.ps-blog-head h2{font-size:1.6rem;margin:0;font-weight:600;letter-spacing:-0.01em;color:var(--ps-fg)}',
    '.ps-blog-back{background:transparent;border:0;color:var(--ps-accent);font:inherit;font-size:0.9rem;cursor:pointer;padding:6px 0;display:none}',
    '.ps-blog-back.show{display:inline-block}',
    '.ps-blog-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}',
    '.ps-blog-card{background:var(--ps-bg);border:1px solid var(--ps-line);border-radius:10px;overflow:hidden;text-decoration:none;color:inherit;display:flex;flex-direction:column;transition:transform .12s,border-color .12s}',
    '.ps-blog-card:hover{transform:translateY(-2px);border-color:var(--ps-accent)}',
    '.ps-blog-card img{display:block;width:100%;aspect-ratio:1.7;object-fit:cover;background:#000}',
    '.ps-blog-card .ps-card-body{padding:14px 16px 16px;display:flex;flex-direction:column;gap:6px;flex:1}',
    '.ps-blog-card h3{font-size:1rem;margin:0;letter-spacing:-0.005em;line-height:1.3;color:var(--ps-fg)}',
    '.ps-blog-card p{font-size:0.88rem;margin:0;color:var(--ps-muted);line-height:1.5;flex:1;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
    '.ps-blog-card .ps-card-date{font-size:0.76rem;color:var(--ps-muted);text-transform:uppercase;letter-spacing:0.04em;margin-top:auto}',
    '.ps-blog-article{max-width:680px;margin:0 auto}',
    '.ps-blog-article h1{font-size:1.85rem;line-height:1.15;margin:0 0 8px;font-weight:600;letter-spacing:-0.015em;color:var(--ps-fg)}',
    '.ps-blog-article .ps-art-date{font-size:0.85rem;color:var(--ps-muted);margin-bottom:24px}',
    '.ps-blog-article img.ps-art-hero{display:block;width:100%;aspect-ratio:1.9;object-fit:cover;border-radius:10px;margin:0 0 24px;background:#000}',
    '.ps-blog-article .ps-art-body{font-size:1rem;line-height:1.7;color:var(--ps-fg)}',
    '.ps-blog-article .ps-art-body h2{font-size:1.3rem;margin:28px 0 10px;letter-spacing:-0.005em}',
    '.ps-blog-article .ps-art-body h3{font-size:1.1rem;margin:24px 0 10px}',
    '.ps-blog-article .ps-art-body p{margin:0 0 16px}',
    '.ps-blog-article .ps-art-body ul,.ps-blog-article .ps-art-body ol{padding-left:22px;margin:0 0 16px}',
    '.ps-blog-article .ps-art-body li{margin-bottom:4px}',
    '.ps-blog-article .ps-art-body a{color:var(--ps-accent);text-decoration:underline;text-underline-offset:2px}',
    '.ps-blog-article .ps-art-body strong{color:var(--ps-fg);font-weight:600}',
    '.ps-blog-article .ps-art-body code{background:rgba(0,0,0,0.05);padding:1px 5px;border-radius:3px;font-size:0.9em}',
    '@media (prefers-color-scheme: dark){.ps-blog-article .ps-art-body code{background:rgba(255,255,255,0.06)}}',
    '.ps-blog-loading{padding:48px 20px;text-align:center;color:var(--ps-muted);font-size:0.95rem}',
    '.ps-blog-empty{padding:48px 20px;text-align:center;color:var(--ps-muted);font-style:italic}',
  ].join('\n');

  // Body content (post.body_html) is rendered server-side from sanitised
  // Markdown by functions/_lib/markdown.js — no untrusted host input. The
  // single innerHTML assignment in showArticle() relies on that guarantee.
  return `(function(){
'use strict';
var PS_TITLE = ${jsString(title)};
var PS_API = ${jsString(apiBase)};
var PS_EMBED_ID = ${jsString(embedId)};
var PS_T = {
  loading: 'Loading article…',
  failed: 'Could not load this article. Try refreshing the page.',
  back: '← Back to all posts',
  empty: 'No posts yet.'
};
var PS_POSTS = ${JSON.stringify(articles)};

var container = document.getElementById('ps-blog');
if (!container) {
  console.warn('pages-seo embed: no element with id="ps-blog" found');
  return;
}

var inSrcdoc = false;
try {
  inSrcdoc = (window.location.href === 'about:srcdoc') ||
             (window.self !== window.top && window.location.origin === 'null');
} catch (e) { inSrcdoc = true; }

var docOrig = { title: document.title, desc: '' };
var descMeta = document.querySelector('meta[name="description"]');
if (descMeta) docOrig.desc = descMeta.getAttribute('content') || '';

function articleUrl(slug) {
  try {
    var u = new URL(window.location.href);
    u.searchParams.set('post', slug);
    return u.pathname + u.search;
  } catch (e) { return '?post=' + encodeURIComponent(slug); }
}
function listUrl() {
  try {
    var u = new URL(window.location.href);
    u.searchParams.delete('post');
    return u.pathname + (u.search ? u.search : '');
  } catch (e) { return window.location.pathname; }
}
function safePush(url) {
  if (inSrcdoc) return;
  try { history.pushState({}, '', url); } catch (e) {}
}

function make(tag, cls, txt) {
  var el = document.createElement(tag);
  if (cls) el.className = cls;
  if (txt != null) el.textContent = txt;
  return el;
}
function statusMsg(text, cls) {
  while (content.firstChild) content.removeChild(content.firstChild);
  content.appendChild(make('div', cls || 'ps-blog-loading', text));
}

var styleId = 'ps-blog-styles';
if (!document.getElementById(styleId)) {
  var style = document.createElement('style');
  style.id = styleId;
  style.textContent = ${jsString(css)};
  document.head.appendChild(style);
}

while (container.firstChild) container.removeChild(container.firstChild);
var root = make('div', 'ps-blog');
var head = make('div', 'ps-blog-head');
head.appendChild(make('h2', null, PS_TITLE));
var back = document.createElement('button');
back.type = 'button'; back.className = 'ps-blog-back'; back.textContent = PS_T.back;
head.appendChild(back);
root.appendChild(head);
var content = document.createElement('div');
root.appendChild(content);
container.appendChild(root);

back.addEventListener('click', function (e) {
  e.preventDefault();
  showList();
  safePush(listUrl());
});

function showList() {
  back.classList.remove('show');
  if (!inSrcdoc) {
    document.title = docOrig.title;
    if (descMeta && docOrig.desc) descMeta.setAttribute('content', docOrig.desc);
  }
  while (content.firstChild) content.removeChild(content.firstChild);
  if (!PS_POSTS.length) {
    content.appendChild(make('div', 'ps-blog-empty', PS_T.empty));
    return;
  }
  var grid = make('div', 'ps-blog-grid');
  for (var i = 0; i < PS_POSTS.length; i++) {
    var p = PS_POSTS[i];
    var card = document.createElement('a');
    card.className = 'ps-blog-card';
    card.href = PS_API + '/blog/' + encodeURIComponent(p.slug);
    if (inSrcdoc) { card.target = '_blank'; card.rel = 'noopener'; }
    if (p.image) {
      var img = document.createElement('img');
      img.src = PS_API + p.image; img.alt = p.title || ''; img.loading = 'lazy';
      card.appendChild(img);
    }
    var body = make('div', 'ps-card-body');
    body.appendChild(make('h3', null, p.title || ''));
    body.appendChild(make('p', null, p.excerpt || ''));
    body.appendChild(make('div', 'ps-card-date', p.date || ''));
    card.appendChild(body);
    (function (slug) {
      card.addEventListener('click', function (e) {
        if (inSrcdoc) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
        e.preventDefault();
        showArticle(slug, true);
      });
    })(p.slug);
    grid.appendChild(card);
  }
  content.appendChild(grid);
}

function showArticle(slug, push) {
  var p = null;
  for (var i = 0; i < PS_POSTS.length; i++) {
    if (PS_POSTS[i].slug === slug) { p = PS_POSTS[i]; break; }
  }
  if (!p) return showList();
  back.classList.add('show');
  if (push) safePush(articleUrl(slug));
  statusMsg(PS_T.loading, 'ps-blog-loading');

  fetch(PS_API + '/api/public/post/' + encodeURIComponent(slug), { credentials: 'omit' })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function (data) {
      if (!data || !data.post) return Promise.reject('no_post');
      var post = data.post;
      if (!inSrcdoc) {
        document.title = post.title + ' · ' + docOrig.title;
        if (descMeta) descMeta.setAttribute('content', post.meta_description || docOrig.desc);
      }
      while (content.firstChild) content.removeChild(content.firstChild);
      var art = make('article', 'ps-blog-article');
      art.appendChild(make('h1', null, post.title || ''));
      art.appendChild(make('div', 'ps-art-date', p.date || ''));
      if (post.hero_image_url) {
        var hi = document.createElement('img');
        hi.className = 'ps-art-hero';
        hi.src = PS_API + post.hero_image_url; hi.alt = post.title || ''; hi.loading = 'lazy';
        art.appendChild(hi);
      }
      var bodyEl = make('div', 'ps-art-body');
      bodyEl.innerHTML = String(post.body_html || '');
      var links = bodyEl.querySelectorAll('a');
      for (var j = 0; j < links.length; j++) {
        links[j].target = '_blank';
        links[j].rel = 'noopener noreferrer';
      }
      art.appendChild(bodyEl);
      content.appendChild(art);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    })
    .catch(function () {
      statusMsg(PS_T.failed, 'ps-blog-empty');
    });
}

window.addEventListener('popstate', function () {
  var slug = null;
  try { slug = new URL(window.location.href).searchParams.get('post'); } catch (e) {}
  if (slug) showArticle(slug, false); else showList();
});

var initialSlug = null;
try { initialSlug = new URL(window.location.href).searchParams.get('post'); } catch (e) {}
if (initialSlug) showArticle(initialSlug, false); else showList();
})();`;
}
