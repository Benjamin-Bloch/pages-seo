// Shared blog-embed widget renderer.
//
// Consumers:
//   /widget.js           generic embed; latest posts from this site
//   /api/embed/<id>      named embed; reads settings from blog_embeds row
//
// Contract on the host page:
//   <div id="ps-blog"></div>
//   <script src="…" defer></script>
//
// Differences vs the previous version:
//
//   - Pagination: 10 per page by default; the embed config can
//     override (admin Embeds tab). A pager bar appears under the
//     grid when total_pages > 1.
//
//   - Search: a sticky search input at the top of the widget.
//     Debounced 250ms; hits /api/widget?q=… with the page reset to 1.
//     Empty + no-results states distinct from "site has no posts".
//
//   - No pre-baked posts. The bundle was ballooning every time a
//     site published — every embed bundle re-rendered with the full
//     list of posts. Now the bundle fetches the first page on load,
//     which means the JS file stays a few KB regardless of post
//     count.
//
//   - Keyboard nav: `/` focuses search, `j`/`k` move selection,
//     Enter opens, Esc goes back. `←`/`→` advance pages.
//
//   - Hash routing: `#post=slug` for deep links (doesn't collide
//     with the host page's query string). The old `?post=` routing
//     is still honoured on first load for backwards compat with
//     links anyone has already shared.
//
//   - Web Share button + URL copy fallback on the article view.
//
//   - Lazy images via native loading="lazy".
//
//   - Skeleton loaders during list + article fetches.
//
//   - View-on-site link in the footer so the widget always offers
//     an escape hatch to the canonical blog.
//
//   - Theme: the embed config can override accent, bg, fg, muted,
//     line — full palette overrides via CSS custom properties on
//     #ps-blog.

export function jsString(s) {
  return "'" + String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(new RegExp(' ', 'g'), '\\u2028')
    .replace(new RegExp(' ', 'g'), '\\u2029') + "'";
}

export function imageUrlFor(key) {
  if (!key) return null;
  return '/image/' + key.split('/').map(encodeURIComponent).join('/');
}

// Legacy preload helper. Older `widgetBody({ articles: […] })`
// callers expected a list pre-fetched server-side; the new bundle
// fetches via /api/widget so we no longer need this, but the export
// stays so any third-party caller still importing it doesn't break.
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
  }));
}

export function widgetBody({
  title,
  accent = '#0a0a0a',
  apiBase,
  embedId = '',
  perPage = 10,
  // theme: 'auto' | 'light' | 'dark' — controls prefers-color-scheme
  // override. The bundle still honours system preference when 'auto'.
  theme = 'auto',
  // Optional full palette override. Any key not present falls back to
  // the defaults baked into the CSS.
  palette = {},
  // unused articles parameter still accepted for backwards compat.
  articles, // eslint-disable-line no-unused-vars
}) {
  const themeCSS = (theme === 'dark') ? '#ps-blog{color-scheme:dark;}'
                 : (theme === 'light') ? '#ps-blog{color-scheme:light;}'
                 : '';
  const overrides = [
    palette.bg     ? `--ps-bg:${palette.bg};` : '',
    palette.fg     ? `--ps-fg:${palette.fg};` : '',
    palette.muted  ? `--ps-muted:${palette.muted};` : '',
    palette.line   ? `--ps-line:${palette.line};` : '',
    palette.accent ? `--ps-accent:${palette.accent};` : '',
  ].join('');
  const overridesCSS = overrides ? `#ps-blog{${overrides}}` : '';

  const css = `
${themeCSS}
${overridesCSS}
#ps-blog {
  --ps-accent: ${accent};
  --ps-bg: #ffffff;
  --ps-fg: #0a0a0a;
  --ps-muted: #6b6760;
  --ps-line: #e8e5dd;
  --ps-card: #fafaf7;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: var(--ps-fg);
  max-width: 920px;
  margin: 0 auto;
  line-height: 1.55;
  --ps-radius: 12px;
}
@media (prefers-color-scheme: dark) {
  #ps-blog { --ps-bg: #0e0f12; --ps-fg: #f0eee8; --ps-muted: #a09c93; --ps-line: #262932; --ps-card: #15171c; }
}
.ps-blog { padding: 24px 0; }

.ps-blog-toolbar {
  display: flex; gap: 12px; align-items: center;
  margin: 0 0 18px;
  padding: 0 0 14px;
  border-bottom: 1px solid var(--ps-line);
  flex-wrap: wrap;
}
.ps-blog-head { display: flex; align-items: baseline; gap: 12px; flex: 1; min-width: 200px; }
.ps-blog-head h2 {
  font-size: 1.5rem; margin: 0; font-weight: 600;
  letter-spacing: -0.01em; color: var(--ps-fg);
}
.ps-blog-count { font-size: 0.82rem; color: var(--ps-muted); }
.ps-blog-search {
  flex: 1; min-width: 200px; max-width: 320px;
  padding: 8px 12px;
  background: var(--ps-card);
  border: 1px solid var(--ps-line);
  border-radius: 8px;
  color: var(--ps-fg); font: inherit; font-size: 0.92rem;
  outline: none;
  transition: border-color .12s;
}
.ps-blog-search:focus { border-color: var(--ps-accent); }
.ps-blog-back {
  background: transparent; border: 0; color: var(--ps-accent);
  font: inherit; font-size: 0.9rem; cursor: pointer; padding: 6px 0;
  display: none;
}
.ps-blog-back.show { display: inline-block; }

.ps-blog-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 16px;
}
.ps-blog-card {
  background: var(--ps-bg);
  border: 1px solid var(--ps-line);
  border-radius: var(--ps-radius);
  overflow: hidden;
  text-decoration: none; color: inherit;
  display: flex; flex-direction: column;
  transition: transform .12s ease, border-color .12s;
}
.ps-blog-card:hover { transform: translateY(-2px); border-color: var(--ps-accent); }
.ps-blog-card.is-focused {
  border-color: var(--ps-accent);
  box-shadow: 0 0 0 2px var(--ps-accent);
}
.ps-blog-card-imgwrap {
  position: relative;
  width: 100%; aspect-ratio: 1.7;
  background: var(--ps-card);
}
.ps-blog-card img {
  display: block; width: 100%; height: 100%;
  object-fit: cover; background: var(--ps-card);
}
.ps-blog-card .ps-card-body {
  padding: 14px 16px 16px;
  display: flex; flex-direction: column; gap: 6px; flex: 1;
}
.ps-blog-card h3 {
  font-size: 1rem; margin: 0; letter-spacing: -0.005em;
  line-height: 1.3; color: var(--ps-fg);
}
.ps-blog-card p {
  font-size: 0.88rem; margin: 0; color: var(--ps-muted);
  line-height: 1.5; flex: 1;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
  overflow: hidden;
}
.ps-blog-card .ps-card-date {
  font-size: 0.74rem; color: var(--ps-muted);
  text-transform: uppercase; letter-spacing: 0.04em;
  margin-top: auto;
}

.ps-blog-pager {
  margin-top: 20px;
  display: flex; gap: 6px; align-items: center; justify-content: center;
  flex-wrap: wrap;
}
.ps-blog-pager button {
  background: var(--ps-card);
  border: 1px solid var(--ps-line);
  color: var(--ps-fg);
  border-radius: 6px;
  padding: 6px 10px;
  font: inherit; font-size: 0.85rem;
  cursor: pointer;
  min-width: 32px;
}
.ps-blog-pager button:hover { border-color: var(--ps-accent); color: var(--ps-accent); }
.ps-blog-pager button.is-current { background: var(--ps-accent); color: var(--ps-bg); border-color: var(--ps-accent); }
.ps-blog-pager button:disabled { opacity: 0.4; cursor: not-allowed; }
.ps-blog-pager-info { font-size: 0.78rem; color: var(--ps-muted); margin-left: 8px; }

.ps-blog-footer {
  margin-top: 32px;
  padding-top: 16px;
  border-top: 1px solid var(--ps-line);
  font-size: 0.78rem;
  color: var(--ps-muted);
  display: flex; justify-content: space-between; align-items: center;
  gap: 12px; flex-wrap: wrap;
}
.ps-blog-footer a { color: var(--ps-accent); text-decoration: none; }
.ps-blog-footer a:hover { text-decoration: underline; }

.ps-blog-article { max-width: 720px; margin: 0 auto; }
.ps-blog-article-meta {
  display: flex; align-items: center; gap: 12px;
  font-size: 0.85rem; color: var(--ps-muted);
  margin-bottom: 20px;
  flex-wrap: wrap;
}
.ps-blog-article-share {
  background: var(--ps-card); border: 1px solid var(--ps-line);
  color: var(--ps-fg); padding: 4px 10px; border-radius: 6px;
  font: inherit; font-size: 0.8rem; cursor: pointer;
  margin-left: auto;
}
.ps-blog-article-share:hover { border-color: var(--ps-accent); color: var(--ps-accent); }
.ps-blog-article h1 {
  font-size: 1.9rem; line-height: 1.15; margin: 0 0 10px;
  font-weight: 600; letter-spacing: -0.015em; color: var(--ps-fg);
}
.ps-blog-article img.ps-art-hero {
  display: block; width: 100%; aspect-ratio: 1.9; object-fit: cover;
  border-radius: var(--ps-radius); margin: 0 0 24px; background: var(--ps-card);
}
.ps-blog-article .ps-art-body { font-size: 1.02rem; line-height: 1.72; color: var(--ps-fg); }
.ps-blog-article .ps-art-body h2 { font-size: 1.3rem; margin: 28px 0 10px; letter-spacing: -0.005em; }
.ps-blog-article .ps-art-body h3 { font-size: 1.1rem; margin: 24px 0 10px; }
.ps-blog-article .ps-art-body p  { margin: 0 0 16px; }
.ps-blog-article .ps-art-body ul, .ps-blog-article .ps-art-body ol { padding-left: 22px; margin: 0 0 16px; }
.ps-blog-article .ps-art-body li { margin-bottom: 4px; }
.ps-blog-article .ps-art-body a  { color: var(--ps-accent); text-decoration: underline; text-underline-offset: 2px; }
.ps-blog-article .ps-art-body strong { color: var(--ps-fg); font-weight: 600; }
.ps-blog-article .ps-art-body code { background: rgba(0,0,0,0.05); padding: 1px 5px; border-radius: 3px; font-size: 0.9em; }
@media (prefers-color-scheme: dark) {
  .ps-blog-article .ps-art-body code { background: rgba(255,255,255,0.06); }
}
.ps-blog-article .ps-art-body blockquote {
  border-left: 3px solid var(--ps-accent);
  padding: 4px 16px; margin: 0 0 16px 0;
  color: var(--ps-muted); font-style: italic;
}

.ps-blog-skel {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px;
}
.ps-blog-skel-card {
  background: var(--ps-card);
  border: 1px solid var(--ps-line);
  border-radius: var(--ps-radius);
  overflow: hidden;
  animation: ps-skel-pulse 1.2s ease-in-out infinite;
}
.ps-blog-skel-card-img { aspect-ratio: 1.7; background: var(--ps-line); }
.ps-blog-skel-card-body { padding: 14px 16px 16px; }
.ps-blog-skel-line { background: var(--ps-line); border-radius: 4px; height: 14px; margin: 4px 0; }
.ps-blog-skel-line.short { width: 50%; }
@keyframes ps-skel-pulse { 0%,100%{opacity:1;} 50%{opacity:.5;} }

.ps-blog-empty {
  padding: 48px 20px; text-align: center;
  color: var(--ps-muted); font-style: italic;
}
.ps-blog-empty button {
  margin-top: 12px;
  background: transparent; border: 1px solid var(--ps-line);
  color: var(--ps-accent); padding: 6px 14px; border-radius: 6px;
  font: inherit; cursor: pointer;
}

.ps-blog-kbd {
  display: inline-block;
  background: var(--ps-card); border: 1px solid var(--ps-line);
  border-bottom-width: 2px;
  border-radius: 4px; padding: 0 5px;
  font-family: ui-monospace, Menlo, monospace; font-size: 0.78em;
  color: var(--ps-muted);
}
`;

  return `(function(){
'use strict';
var PS_TITLE = ${jsString(title)};
var PS_API = ${jsString(apiBase)};
var PS_EMBED_ID = ${jsString(embedId)};
var PS_PER_PAGE = ${Number.isFinite(perPage) ? perPage : 10};
var PS_T = {
  loading_post: 'Loading article…',
  failed: 'Could not load this article. Try refreshing the page.',
  back: '← Back to all posts',
  empty_site: 'No posts yet.',
  empty_search: 'No posts match your search.',
  no_more: 'You\\'ve reached the end.',
  search_placeholder: 'Search posts…',
  share: 'Share',
  copied: 'Link copied',
  view_site: 'View full site →',
  page_of: 'Page',
};

var container = document.getElementById('ps-blog');
if (!container) {
  console.warn('pages-seo embed: no element with id="ps-blog" found');
  return;
}

// ── srcdoc detection ──
// Some sandboxed iframes (Notion embeds, etc.) load us via srcdoc.
// In that case popstate / history don't behave the way we expect,
// so we treat clicks on cards as "open in a new tab" rather than
// inline.
var inSrcdoc = false;
try {
  inSrcdoc = (window.location.href === 'about:srcdoc') ||
             (window.self !== window.top && window.location.origin === 'null');
} catch (e) { inSrcdoc = true; }

var docOrig = { title: document.title, desc: '' };
var descMeta = document.querySelector('meta[name="description"]');
if (descMeta) docOrig.desc = descMeta.getAttribute('content') || '';

// Optional host hook: window.psBlog.onOpen(post) is called whenever
// a post is opened inline. Useful for analytics.
function fireOnOpen(post) {
  try {
    var h = window.psBlog && window.psBlog.onOpen;
    if (typeof h === 'function') h(post);
  } catch (e) { /* host hook must not break the widget */ }
}

// ── routing ──
// We use hash routing (#post=slug) so we don't collide with the
// host page's query string. Old ?post= links are still honoured on
// initial load for backwards compat.
function readRoute() {
  var slug = '';
  try {
    var hash = window.location.hash.replace(/^#/, '');
    var hp = new URLSearchParams(hash);
    slug = hp.get('post') || '';
    if (!slug) {
      var qp = new URL(window.location.href).searchParams;
      slug = qp.get('post') || '';
    }
  } catch (e) {}
  return slug;
}
function setRoute(slug) {
  if (inSrcdoc) return;
  try {
    var newHash = slug ? '#post=' + encodeURIComponent(slug) : '';
    if (window.location.hash !== newHash) {
      // Use replaceState so the back button takes us out of the
      // widget rather than cycling through every visited post.
      history.replaceState({}, '', window.location.pathname + window.location.search + newHash);
    }
  } catch (e) {}
}

// ── DOM helpers ──
function make(tag, cls, txt) {
  var el = document.createElement(tag);
  if (cls) el.className = cls;
  if (txt != null) el.textContent = txt;
  return el;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

// Inject the CSS once, even if multiple widget instances exist on
// the page.
var styleId = 'ps-blog-styles';
if (!document.getElementById(styleId)) {
  var style = document.createElement('style');
  style.id = styleId;
  style.textContent = ${jsString(css)};
  document.head.appendChild(style);
}

// ── build skeleton ──
clear(container);
var root = make('div', 'ps-blog');

var toolbar = make('div', 'ps-blog-toolbar');
var head = make('div', 'ps-blog-head');
var h2 = make('h2', null, PS_TITLE);
var count = make('span', 'ps-blog-count');
head.appendChild(h2); head.appendChild(count);
var search = document.createElement('input');
search.type = 'search';
search.className = 'ps-blog-search';
search.placeholder = PS_T.search_placeholder;
search.setAttribute('aria-label', PS_T.search_placeholder);
var back = document.createElement('button');
back.type = 'button'; back.className = 'ps-blog-back'; back.textContent = PS_T.back;
toolbar.appendChild(head);
toolbar.appendChild(search);
toolbar.appendChild(back);
root.appendChild(toolbar);

var content = document.createElement('div');
root.appendChild(content);

var footer = document.createElement('div');
footer.className = 'ps-blog-footer';
footer.appendChild(make('span', null, ''));
var siteLink = document.createElement('a');
siteLink.href = PS_API + '/blog'; siteLink.target = '_blank'; siteLink.rel = 'noopener';
siteLink.textContent = PS_T.view_site;
footer.appendChild(siteLink);
root.appendChild(footer);

container.appendChild(root);

// ── state ──
var state = {
  q: '',
  page: 1,
  total: 0,
  totalPages: 1,
  posts: [],
  inArticle: false,
  focusedIdx: 0,
  scrollY: 0,                // remember list scroll so we restore on back
  listScrollEl: null,         // window or a scroll parent (host iframe etc)
  loading: false,
};

function paramsString() {
  var p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.page > 1) p.set('page', String(state.page));
  p.set('per_page', String(PS_PER_PAGE));
  return p.toString();
}

// ── views ──
function renderSkeleton() {
  clear(content);
  var skel = make('div', 'ps-blog-skel');
  for (var i = 0; i < Math.min(PS_PER_PAGE, 6); i++) {
    var c = make('div', 'ps-blog-skel-card');
    c.appendChild(make('div', 'ps-blog-skel-card-img'));
    var b = make('div', 'ps-blog-skel-card-body');
    b.appendChild(make('div', 'ps-blog-skel-line'));
    b.appendChild(make('div', 'ps-blog-skel-line short'));
    c.appendChild(b);
    skel.appendChild(c);
  }
  content.appendChild(skel);
}

function renderList() {
  clear(content);
  if (!state.posts.length) {
    var empty = make('div', 'ps-blog-empty');
    empty.textContent = state.q ? PS_T.empty_search : PS_T.empty_site;
    if (state.q) {
      var clearBtn = document.createElement('button');
      clearBtn.textContent = 'Clear search';
      clearBtn.onclick = function () { search.value = ''; state.q = ''; state.page = 1; load(); search.focus(); };
      empty.appendChild(clearBtn);
    }
    content.appendChild(empty);
    return;
  }
  var grid = make('div', 'ps-blog-grid');
  for (var i = 0; i < state.posts.length; i++) {
    grid.appendChild(buildCard(state.posts[i], i));
  }
  content.appendChild(grid);
  if (state.totalPages > 1) renderPager();
  // Restore focus to the previously focused card after re-render
  // (e.g. when paging via keyboard).
  highlightFocused();
}

function buildCard(p, idx) {
  var card = document.createElement('a');
  card.className = 'ps-blog-card';
  card.href = PS_API + '/blog/' + encodeURIComponent(p.slug);
  card.setAttribute('data-idx', String(idx));
  card.setAttribute('data-slug', p.slug);
  if (inSrcdoc) { card.target = '_blank'; card.rel = 'noopener'; }

  if (p.image) {
    var imgwrap = make('div', 'ps-blog-card-imgwrap');
    var img = document.createElement('img');
    img.src = PS_API + p.image;
    img.alt = p.title || '';
    img.loading = 'lazy';
    img.decoding = 'async';
    imgwrap.appendChild(img);
    card.appendChild(imgwrap);
  }

  var body = make('div', 'ps-card-body');
  body.appendChild(make('h3', null, p.title || ''));
  if (p.excerpt) body.appendChild(make('p', null, p.excerpt));
  body.appendChild(make('div', 'ps-card-date', p.date || ''));
  card.appendChild(body);

  card.addEventListener('click', function (e) {
    if (inSrcdoc) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
    e.preventDefault();
    openArticle(p.slug, true);
  });

  return card;
}

function renderPager() {
  var pager = make('div', 'ps-blog-pager');
  var prev = document.createElement('button');
  prev.textContent = '←'; prev.title = 'Previous page';
  prev.disabled = state.page <= 1;
  prev.onclick = function () { goPage(state.page - 1); };
  pager.appendChild(prev);

  // Page-number window: show first, last, current ± 2, ellipsis
  // gaps. Keeps the bar compact for sites with 50+ pages.
  var win = pageWindow(state.page, state.totalPages, 2);
  var lastShown = 0;
  for (var i = 0; i < win.length; i++) {
    var n = win[i];
    if (n - lastShown > 1) {
      pager.appendChild(make('span', 'ps-blog-pager-info', '…'));
    }
    var btn = document.createElement('button');
    btn.textContent = String(n);
    if (n === state.page) btn.className = 'is-current';
    btn.onclick = (function (nn) { return function () { goPage(nn); }; })(n);
    pager.appendChild(btn);
    lastShown = n;
  }

  var next = document.createElement('button');
  next.textContent = '→'; next.title = 'Next page';
  next.disabled = state.page >= state.totalPages;
  next.onclick = function () { goPage(state.page + 1); };
  pager.appendChild(next);

  var info = make('span', 'ps-blog-pager-info',
    PS_T.page_of + ' ' + state.page + ' of ' + state.totalPages + ' · ' + state.total + ' posts');
  pager.appendChild(info);

  content.appendChild(pager);
}

function pageWindow(page, total, halfWidth) {
  var set = new Set();
  set.add(1); set.add(total);
  for (var i = page - halfWidth; i <= page + halfWidth; i++) {
    if (i >= 1 && i <= total) set.add(i);
  }
  return Array.from(set).sort(function (a, b) { return a - b; });
}

function goPage(n) {
  n = Math.max(1, Math.min(state.totalPages, n));
  if (n === state.page) return;
  state.page = n;
  state.focusedIdx = 0;
  load();
  // Scroll the widget into view if it's offscreen; don't scroll
  // the page if the widget is already visible.
  try {
    var rect = container.getBoundingClientRect();
    if (rect.top < 0 || rect.top > window.innerHeight) {
      container.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch (e) {}
}

function highlightFocused() {
  var cards = content.querySelectorAll('.ps-blog-card');
  for (var i = 0; i < cards.length; i++) {
    cards[i].classList.toggle('is-focused', i === state.focusedIdx);
  }
}

function updateCount() {
  if (state.total === 0) count.textContent = '';
  else count.textContent = state.q
    ? '(' + state.total + ' result' + (state.total === 1 ? '' : 's') + ')'
    : '(' + state.total + ' post' + (state.total === 1 ? '' : 's') + ')';
}

// ── network ──
function load() {
  if (state.loading) return;
  state.loading = true;
  renderSkeleton();
  var url = PS_API + '/api/widget?' + paramsString();
  if (PS_EMBED_ID) url += '&embed=' + encodeURIComponent(PS_EMBED_ID);
  fetch(url, { credentials: 'omit' })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function (data) {
      state.loading = false;
      state.posts = data.posts || [];
      state.total = data.total || 0;
      state.totalPages = data.total_pages || 1;
      if (state.page > state.totalPages) state.page = state.totalPages;
      updateCount();
      renderList();
    })
    .catch(function () {
      state.loading = false;
      clear(content);
      var empty = make('div', 'ps-blog-empty', PS_T.failed);
      content.appendChild(empty);
    });
}

// ── article view ──
function openArticle(slug, push) {
  state.inArticle = true;
  state.scrollY = window.pageYOffset || document.documentElement.scrollTop;
  back.classList.add('show');
  if (push) setRoute(slug);
  search.style.display = 'none';

  clear(content);
  // Article skeleton.
  var skel = make('div', 'ps-blog-skel');
  for (var i = 0; i < 1; i++) {
    var c = make('div', 'ps-blog-skel-card');
    c.appendChild(make('div', 'ps-blog-skel-card-img'));
    var b = make('div', 'ps-blog-skel-card-body');
    for (var j = 0; j < 6; j++) b.appendChild(make('div', 'ps-blog-skel-line' + (j === 5 ? ' short' : '')));
    c.appendChild(b);
    skel.appendChild(c);
  }
  content.appendChild(skel);

  fetch(PS_API + '/api/public/post/' + encodeURIComponent(slug), { credentials: 'omit' })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function (data) {
      if (!data || !data.post) return Promise.reject('no_post');
      var post = data.post;
      if (!inSrcdoc) {
        document.title = post.title + ' · ' + docOrig.title;
        if (descMeta) descMeta.setAttribute('content', post.meta_description || docOrig.desc);
      }
      fireOnOpen(post);

      clear(content);
      var art = make('article', 'ps-blog-article');
      art.appendChild(make('h1', null, post.title || ''));

      var meta = make('div', 'ps-blog-article-meta');
      var pubDate = (state.posts.find(function (x) { return x.slug === slug; }) || {}).date || '';
      meta.appendChild(make('span', null, pubDate));
      var shareBtn = document.createElement('button');
      shareBtn.className = 'ps-blog-article-share';
      shareBtn.type = 'button';
      shareBtn.textContent = PS_T.share;
      shareBtn.onclick = function () { sharePost(post, slug, shareBtn); };
      meta.appendChild(shareBtn);
      art.appendChild(meta);

      if (post.hero_image_url) {
        var hi = document.createElement('img');
        hi.className = 'ps-art-hero';
        hi.src = PS_API + post.hero_image_url;
        hi.alt = post.title || '';
        hi.loading = 'lazy'; hi.decoding = 'async';
        art.appendChild(hi);
      }

      var bodyEl = make('div', 'ps-art-body');
      // Server-side markdown.js produces sanitised HTML — that's
      // the documented contract. We open external links in a new
      // tab so the host page doesn't lose context.
      bodyEl.innerHTML = String(post.body_html || '');
      var links = bodyEl.querySelectorAll('a');
      for (var k = 0; k < links.length; k++) {
        links[k].target = '_blank';
        links[k].rel = 'noopener noreferrer';
      }
      // Make sure scripts in body_html — if any slipped through —
      // never execute. Defence in depth on top of server sanitise.
      var scripts = bodyEl.querySelectorAll('script');
      for (var s = 0; s < scripts.length; s++) scripts[s].remove();
      art.appendChild(bodyEl);

      content.appendChild(art);
      try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) {}
    })
    .catch(function () {
      clear(content);
      content.appendChild(make('div', 'ps-blog-empty', PS_T.failed));
    });
}

function sharePost(post, slug, btn) {
  var shareUrl = PS_API + '/blog/' + encodeURIComponent(slug);
  if (navigator.share) {
    navigator.share({
      title: post.title || '',
      text: post.meta_description || '',
      url: shareUrl,
    }).catch(function () { /* user dismissed */ });
    return;
  }
  // Fallback — copy URL to clipboard.
  try {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(shareUrl);
      var originalText = btn.textContent;
      btn.textContent = PS_T.copied;
      setTimeout(function () { btn.textContent = originalText; }, 1500);
    } else {
      window.prompt('Copy this URL:', shareUrl);
    }
  } catch (e) {
    window.prompt('Copy this URL:', shareUrl);
  }
}

function returnToList() {
  state.inArticle = false;
  back.classList.remove('show');
  search.style.display = '';
  setRoute('');
  if (!inSrcdoc) {
    document.title = docOrig.title;
    if (descMeta && docOrig.desc) descMeta.setAttribute('content', docOrig.desc);
  }
  renderList();
  try { window.scrollTo(0, state.scrollY); } catch (e) {}
}

back.addEventListener('click', function (e) {
  e.preventDefault();
  returnToList();
});

// ── search ──
var searchTimer = null;
search.addEventListener('input', function () {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(function () {
    state.q = search.value.trim();
    state.page = 1;
    state.focusedIdx = 0;
    load();
  }, 250);
});

// ── keyboard nav ──
function isTextField(el) {
  if (!el) return false;
  var tag = (el.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
document.addEventListener('keydown', function (e) {
  // Only act when the widget is visible AND the user isn't typing
  // somewhere else on the page.
  if (state.inArticle) {
    if (e.key === 'Escape') { returnToList(); e.preventDefault(); }
    return;
  }
  if (isTextField(e.target) && e.target !== search) return;
  if (e.key === '/' && e.target !== search) {
    e.preventDefault(); search.focus(); search.select();
    return;
  }
  if (e.target === search) {
    if (e.key === 'Escape') { search.value = ''; state.q = ''; state.page = 1; load(); }
    if (e.key === 'Enter') { e.preventDefault(); search.blur(); }
    return;
  }
  if (e.key === 'j' || e.key === 'ArrowDown') {
    if (state.focusedIdx < state.posts.length - 1) state.focusedIdx++;
    highlightFocused();
    e.preventDefault();
  } else if (e.key === 'k' || e.key === 'ArrowUp') {
    if (state.focusedIdx > 0) state.focusedIdx--;
    highlightFocused();
    e.preventDefault();
  } else if (e.key === 'Enter') {
    var p = state.posts[state.focusedIdx];
    if (p) openArticle(p.slug, true);
  } else if (e.key === 'ArrowLeft' && state.page > 1) {
    goPage(state.page - 1); e.preventDefault();
  } else if (e.key === 'ArrowRight' && state.page < state.totalPages) {
    goPage(state.page + 1); e.preventDefault();
  }
});

// ── popstate (back button) ──
window.addEventListener('hashchange', function () {
  var slug = readRoute();
  if (slug) {
    if (!state.inArticle) openArticle(slug, false);
  } else if (state.inArticle) {
    returnToList();
  }
});

// ── boot ──
var initialSlug = readRoute();
load();
if (initialSlug) {
  // Wait until first list load finishes so excerpt + image are
  // available for the article meta.
  setTimeout(function () { openArticle(initialSlug, false); }, 100);
}

// Expose minimal API on window so hosts can integrate.
window.psBlog = window.psBlog || {};
window.psBlog.refresh = load;
window.psBlog.openPost = function (slug) { openArticle(slug, true); };
window.psBlog.state = state;
})();`;
}
