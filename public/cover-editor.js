/* eslint-disable no-multi-assign */
//
// Cover designer — Canva-style rewrite.
//
// Lives separately from admin.js because it's substantial (~1400 LOC)
// and tightly self-contained. admin.js loads it on the Covers tab,
// then calls window.CoverEditor.init({ root, api, ...glue }).
//
// What's new vs. the old inline Cover module:
//
//   - Pointer events (touch + pen + mouse) instead of mouse-only.
//   - 8 resize handles (corners + edges) plus a rotation handle.
//   - Smart snap guides: when dragging/resizing, layers magnetically
//     align to canvas edges, canvas center, and every other layer's
//     edges + centers. Magenta guidelines render in real time.
//   - Marquee multi-select. Group-move; group-resize from any
//     bounding handle preserves relative layout. Align + distribute
//     in the floating toolbar when 2+ layers are selected.
//   - Floating toolbar over the selection (context-aware). Stays in
//     view above the selection unless that would clip the viewport,
//     in which case it flips below.
//   - Drag-from-sidebar onto the canvas (HTML5 DnD). Background
//     drops replace the bg; logos add a placed layer at the drop
//     point.
//   - Double-click a text layer to edit inline (positioned
//     contenteditable overlay; blur commits, Esc cancels).
//   - Right-click context menu: Bring forward / Send back / Duplicate
//     / Delete / Lock.
//   - Undo/redo with Cmd/Ctrl-Z + Cmd-Shift-Z. Every mutation goes
//     through cmd() so the history is consistent.
//   - Responsive canvas. Fits to the viewport with a scale factor;
//     zoom controls (25–400%) + reset (Cmd-0). Canvas pixels stay
//     at the spec resolution so exports remain 1200×630 or whatever
//     preset is chosen.
//   - Optional fields on layer schema: rotation (deg), opacity
//     (0–1), locked (bool). Old saved templates without these render
//     identically (defaults applied at render time).
//
// Backwards-compat: the template schema persisted to D1 is unchanged
// for old features. We only ADD optional fields. Server-side
// rendering (functions/_lib/cover_template.js or similar) does not
// need updates to keep loading old templates; if/when we want
// rotation/opacity to survive the apply step, those handlers will
// need a parallel update.

(function () {
  'use strict';

  // ── DOM helpers ──────────────────────────────────────────────────
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  // Toast helper. Defers to window.psToast (defined in admin.js)
  // when present; falls back to alert() so the editor still works
  // when loaded outside the admin shell (e.g. a future standalone
  // page). The signature matches psToast verbatim.
  function notify(msg, kind = 'info', opts = {}) {
    if (typeof window !== 'undefined' && typeof window.psToast === 'function') {
      return window.psToast(msg, kind, opts);
    }
    alert(String(msg));
  }

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') e.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
        else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else if (k === 'dataset' && typeof v === 'object') Object.assign(e.dataset, v);
        else if (v === false || v == null) { /* skip */ }
        else if (v === true) e.setAttribute(k, '');
        else e.setAttribute(k, String(v));
      }
    }
    for (const c of children) {
      if (c == null || c === false) continue;
      e.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return e;
  }
  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // ── constants ────────────────────────────────────────────────────
  // Fonts available in the editor. Each entry has:
  //   label  — display name in the picker
  //   value  — CSS font-family stack
  //   gf     — Google Fonts family + weights to load (or null for system)
  //   group  — grouping for the picker
  //
  // The Google Fonts <link> is injected once at editor init by
  // injectFontStylesheet(). For ad-hoc fonts the user types in
  // the "custom font" input, loadGoogleFont() appends a new
  // stylesheet at runtime.
  const FONT_FAMILIES = [
    // System ─────────────────────────────────────────────
    { group: 'System', label: 'System sans', value: 'system-ui, -apple-system, Segoe UI, sans-serif' },
    { group: 'System', label: 'System serif', value: 'Georgia, "Times New Roman", serif' },
    { group: 'System', label: 'System mono', value: 'ui-monospace, "JetBrains Mono", Menlo, monospace' },

    // Editorial serifs ───────────────────────────────────
    { group: 'Editorial serif', label: 'Playfair Display', value: '"Playfair Display", Georgia, serif',
      gf: { family: 'Playfair Display', weights: '400;500;600;700;800;900' } },
    { group: 'Editorial serif', label: 'Lora',              value: 'Lora, Georgia, serif',
      gf: { family: 'Lora', weights: '400;500;600;700' } },
    { group: 'Editorial serif', label: 'Cormorant Garamond', value: '"Cormorant Garamond", Garamond, serif',
      gf: { family: 'Cormorant Garamond', weights: '300;400;500;600;700' } },
    { group: 'Editorial serif', label: 'Crimson Pro',       value: '"Crimson Pro", Garamond, serif',
      gf: { family: 'Crimson Pro', weights: '300;400;500;600;700;800;900' } },
    { group: 'Editorial serif', label: 'EB Garamond',       value: '"EB Garamond", Garamond, serif',
      gf: { family: 'EB Garamond', weights: '400;500;600;700;800' } },
    { group: 'Editorial serif', label: 'Libre Baskerville', value: '"Libre Baskerville", Georgia, serif',
      gf: { family: 'Libre Baskerville', weights: '400;700' } },

    // Geometric sans ─────────────────────────────────────
    { group: 'Geometric sans', label: 'Inter',              value: 'Inter, sans-serif',
      gf: { family: 'Inter', weights: '300;400;500;600;700;800;900' } },
    { group: 'Geometric sans', label: 'Space Grotesk',      value: '"Space Grotesk", sans-serif',
      gf: { family: 'Space Grotesk', weights: '300;400;500;600;700' } },
    { group: 'Geometric sans', label: 'DM Sans',            value: '"DM Sans", sans-serif',
      gf: { family: 'DM Sans', weights: '400;500;700' } },
    { group: 'Geometric sans', label: 'Manrope',            value: 'Manrope, sans-serif',
      gf: { family: 'Manrope', weights: '300;400;500;600;700;800' } },
    { group: 'Geometric sans', label: 'Plus Jakarta Sans',  value: '"Plus Jakarta Sans", sans-serif',
      gf: { family: 'Plus Jakarta Sans', weights: '300;400;500;600;700;800' } },
    { group: 'Geometric sans', label: 'Outfit',             value: 'Outfit, sans-serif',
      gf: { family: 'Outfit', weights: '300;400;500;600;700;800;900' } },

    // Display / impact ───────────────────────────────────
    { group: 'Display', label: 'Bebas Neue',     value: '"Bebas Neue", Impact, sans-serif',
      gf: { family: 'Bebas Neue', weights: '400' } },
    { group: 'Display', label: 'Anton',          value: 'Anton, Impact, sans-serif',
      gf: { family: 'Anton', weights: '400' } },
    { group: 'Display', label: 'Oswald',         value: 'Oswald, Impact, sans-serif',
      gf: { family: 'Oswald', weights: '300;400;500;600;700' } },
    { group: 'Display', label: 'Bowlby One',     value: '"Bowlby One", Impact, sans-serif',
      gf: { family: 'Bowlby One', weights: '400' } },
    { group: 'Display', label: 'Archivo Black',  value: '"Archivo Black", Impact, sans-serif',
      gf: { family: 'Archivo Black', weights: '400' } },

    // Mono / technical ───────────────────────────────────
    { group: 'Mono',    label: 'JetBrains Mono', value: '"JetBrains Mono", monospace',
      gf: { family: 'JetBrains Mono', weights: '400;500;600;700;800' } },
    { group: 'Mono',    label: 'IBM Plex Mono',  value: '"IBM Plex Mono", monospace',
      gf: { family: 'IBM Plex Mono', weights: '300;400;500;600;700' } },
    { group: 'Mono',    label: 'Space Mono',     value: '"Space Mono", monospace',
      gf: { family: 'Space Mono', weights: '400;700' } },
  ];
  const FONT_WEIGHTS = ['300', '400', '500', '600', '700', '800'];

  // Track which Google Font families are already loaded so we don't
  // append duplicate <link> tags every time the user re-selects a font.
  const loadedFontFamilies = new Set();

  // Inject the master Google Fonts stylesheet for all curated fonts
  // at editor init. Built as a single URL with families separated by
  // `&family=…` so one request loads everything.
  function injectFontStylesheet() {
    const families = FONT_FAMILIES
      .filter((f) => f.gf)
      .map((f) => `family=${encodeURIComponent(f.gf.family).replace(/%20/g, '+')}:wght@${f.gf.weights}`);
    if (!families.length) return;
    families.forEach((f) => loadedFontFamilies.add(f.split('@')[0]));
    const href = 'https://fonts.googleapis.com/css2?' + families.join('&') + '&display=swap';
    // Avoid duplicate tags if the editor mounts twice.
    if (document.querySelector(`link[data-ce-fonts]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.ceFonts = '1';
    document.head.appendChild(link);
    // Preconnect too, for faster first paint.
    if (!document.querySelector('link[rel="preconnect"][href="https://fonts.gstatic.com"]')) {
      const pc = document.createElement('link');
      pc.rel = 'preconnect';
      pc.href = 'https://fonts.gstatic.com';
      pc.crossOrigin = 'anonymous';
      document.head.appendChild(pc);
    }
  }

  // Load an ad-hoc Google Font by family name. Sanitises the input
  // (Google Fonts names are letters / digits / spaces only — anything
  // else is either a typo or an attempt to inject). Resolves after
  // the font is actually ready for use on the canvas.
  async function loadGoogleFont(family) {
    const clean = String(family || '').trim().replace(/\s+/g, ' ');
    if (!/^[A-Za-z0-9 ]{2,40}$/.test(clean)) return false;
    const key = `family=${encodeURIComponent(clean).replace(/%20/g, '+')}`;
    if (loadedFontFamilies.has(key.split('@')[0])) return true;
    loadedFontFamilies.add(key.split('@')[0]);

    const href = `https://fonts.googleapis.com/css2?${key}:wght@300;400;500;600;700;800&display=swap`;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);

    // Wait for the @font-face declarations to parse, then for the
    // actual font file to be available for layout.
    try {
      if (document.fonts && document.fonts.load) {
        // load() forces a fetch + decode of the specified font at
        // 16px — once that resolves the font is usable everywhere.
        await document.fonts.load(`16px "${clean}"`);
        await document.fonts.ready;
      }
    } catch { /* network or unknown-font; fall through */ }
    return true;
  }
  const PRESETS = [
    { label: 'OG default 1200 × 630', w: 1200, h: 630 },
    { label: 'HD 1920 × 1080',        w: 1920, h: 1080 },
    { label: 'Square 1080 × 1080',    w: 1080, h: 1080 },
    { label: 'Portrait 1080 × 1350',  w: 1080, h: 1350 },
    { label: 'Pinterest 1000 × 1500', w: 1000, h: 1500 },
  ];
  // Pixels-in-canvas-space within which snapping engages. Felt
  // tuning value — small enough to ignore by moving fast, large
  // enough to grab on a deliberate slow drag.
  const SNAP_THRESHOLD = 6;

  // Image cache — keyed by URL. Returned as HTMLImageElement once
  // decoded.
  const imageCache = new Map();
  function loadImage(url) {
    if (!url) return Promise.resolve(null);
    if (imageCache.has(url)) return imageCache.get(url);
    const p = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
    imageCache.set(url, p);
    return p;
  }

  // Tiny UID — collision risk is low enough for a single editor session.
  function uid() { return 'l' + Math.random().toString(36).slice(2, 9); }

  // ── template/expression mirror ───────────────────────────────────
  // Same shape as the server's _lib/template.js so {title} etc.
  // preview consistently. Kept in lockstep with admin.js's earlier
  // copy — if you change one, change both.
  // Mirror of functions/_lib/template.js. Keep them in lockstep so
  // every filter in one place works in the other; the cover editor's
  // preview must produce the same string the server-side renderer
  // produces at request time.
  const TPL_FILTERS = {
    upper: (v) => String(v ?? '').toUpperCase(),
    lower: (v) => String(v ?? '').toLowerCase(),
    title: (v) => String(v ?? '').replace(/\w\S*/g, (t) => t[0].toUpperCase() + t.slice(1).toLowerCase()),
    capitalize: (v) => { const s = String(v ?? ''); return s ? s[0].toUpperCase() + s.slice(1) : ''; },
    truncate: (v, n) => {
      const s = String(v ?? '');
      const max = parseInt(n, 10) || 60;
      return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
    },
    default: (v, fb) => {
      const s = String(v ?? '').trim();
      return s ? v : (fb ?? '');
    },
    slug: (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    kebab: (v) => String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    snake: (v) => String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
    escape: (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    trim: (v) => String(v ?? '').trim(),
    first_word: (v) => String(v ?? '').trim().split(/\s+/)[0] || '',
    domain: (v) => {
      try { return new URL(String(v ?? '')).hostname.replace(/^www\./, ''); }
      catch { return String(v ?? '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0]; }
    },
    ordinal: (v) => {
      const n = parseInt(v, 10);
      if (!Number.isFinite(n)) return String(v ?? '');
      const s = ['th', 'st', 'nd', 'rd'];
      const v100 = n % 100;
      return n + (s[(v100 - 20) % 10] || s[v100] || s[0]);
    },
    pad: (v, n) => String(v ?? '').padStart(parseInt(n, 10) || 2, '0'),
    number_format: (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n.toLocaleString('en-US') : String(v ?? '');
    },
    pluralize: (v, arg) => {
      const n = Number(v);
      const [s, p] = String(arg || '').split(':');
      const word = (Math.abs(n) === 1) ? (s || '') : (p || (s ? s + 's' : ''));
      return Number.isFinite(n) ? `${n} ${word}` : String(v ?? '');
    },
    replace: (v, arg) => {
      if (!arg) return String(v ?? '');
      const idx = arg.indexOf(':');
      if (idx < 0) return String(v ?? '');
      return String(v ?? '').split(arg.slice(0, idx)).join(arg.slice(idx + 1));
    },
    prepend: (v, s) => (s || '') + String(v ?? ''),
    append: (v, s) => String(v ?? '') + (s || ''),
    read_time: (v, arg) => {
      const w = String(v ?? '').trim().split(/\s+/).filter(Boolean).length;
      const m = Math.max(1, Math.round(w / 220));
      return `${m}${arg ? arg : ' min read'}`;
    },
    word_count: (v) => String(v ?? '').trim().split(/\s+/).filter(Boolean).length,
    date: (v, fmt) => {
      const d = v ? new Date(v) : new Date();
      if (isNaN(d.getTime())) return '';
      const f = String(fmt || 'short');
      if (f === 'long' || f === 'medium')
        return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      if (f === 'short') return d.toISOString().slice(0, 10);
      if (f === 'us')    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      if (f === 'iso')   return d.toISOString();
      if (f === 'year')  return String(d.getUTCFullYear());
      if (f === 'month') return d.toLocaleDateString('en-GB', { month: 'long' });
      if (f === 'day')   return String(d.getUTCDate());
      if (f === 'dow')   return d.toLocaleDateString('en-GB', { weekday: 'long' });
      if (f === 'relative') {
        const diff = (Date.now() - d.getTime()) / 1000;
        const abs = Math.abs(diff);
        const past = diff >= 0;
        const pick = (n, u) => {
          const r = Math.round(n);
          return past ? `${r} ${u}${r === 1 ? '' : 's'} ago` : `in ${r} ${u}${r === 1 ? '' : 's'}`;
        };
        if (abs < 60) return past ? 'just now' : 'in a moment';
        if (abs < 3600) return pick(abs / 60, 'minute');
        if (abs < 86400) return pick(abs / 3600, 'hour');
        if (abs < 86400 * 30) return pick(abs / 86400, 'day');
        if (abs < 86400 * 365) return pick(abs / (86400 * 30), 'month');
        return pick(abs / (86400 * 365), 'year');
      }
      return f
        .replace(/YYYY/g, d.getUTCFullYear())
        .replace(/MM/g, String(d.getUTCMonth() + 1).padStart(2, '0'))
        .replace(/DD/g, String(d.getUTCDate()).padStart(2, '0'))
        .replace(/HH/g, String(d.getUTCHours()).padStart(2, '0'))
        .replace(/mm/g, String(d.getUTCMinutes()).padStart(2, '0'))
        .replace(/DOW/g, d.toLocaleDateString('en-GB', { weekday: 'long' }));
    },
  };

  // Variable reference — used by the editor's Variables panel to
  // show the user what's available. Each entry: { name, example,
  // description }. Keep in sync with template.js's buildBrandContext.
  const VARIABLE_CATALOGUE = [
    { group: 'Post', items: [
      { name: '{title}',           desc: 'The post title' },
      { name: '{slug}',            desc: 'URL slug, e.g. why-rankings-decay' },
      { name: '{excerpt}',         desc: 'First 200 chars of the body (markdown stripped)' },
      { name: '{keywords}',        desc: 'Comma-separated keywords' },
      { name: '{primary_keyword}', desc: 'Primary search query, if recorded' },
      { name: '{word_count}',      desc: 'Body word count' },
      { name: '{reading_time}',    desc: '"5 min read"' },
      { name: '{provider}',        desc: 'AI provider that wrote the post' },
    ]},
    { group: 'Dates', items: [
      { name: '{pub_date}',        desc: 'Publish date (use with |date:fmt)' },
      { name: '{pub_date_long}',   desc: '"18 May 2026"' },
      { name: '{pub_date_short}',  desc: '"2026-05-18"' },
      { name: '{pub_year}',        desc: '"2026"' },
      { name: '{pub_month}',       desc: '"May"' },
      { name: '{pub_dow}',         desc: 'Day of week, e.g. "Wednesday"' },
      { name: '{update_date}',     desc: 'Last modified date' },
      { name: '{today_long}',      desc: 'Today\'s date, "18 May 2026"' },
      { name: '{year}',            desc: 'Current year' },
    ]},
    { group: 'Brand', items: [
      { name: '{brand.name}',          desc: 'Site name' },
      { name: '{brand.url}',           desc: 'Site URL' },
      { name: '{brand.domain}',        desc: 'Hostname, no protocol' },
      { name: '{brand.tagline}',       desc: 'Short subtitle' },
      { name: '{brand.cta}',           desc: 'Call-to-action text from settings' },
      { name: '{brand.logo_url}',      desc: 'Logo image URL from settings' },
      { name: '{brand.primary_color}', desc: 'Hex colour from settings' },
      { name: '{brand.accent_color}',  desc: 'Hex colour from settings' },
    ]},
    { group: 'Site', items: [
      { name: '{site.host}',      desc: 'e.g. seo.benjaminb.xyz' },
      { name: '{site.url}',       desc: 'https://<host>' },
      { name: '{site.canonical}', desc: 'Full canonical URL for the post' },
    ]},
    { group: 'Filters', items: [
      { name: '{x|upper}',         desc: 'UPPERCASE' },
      { name: '{x|lower}',         desc: 'lowercase' },
      { name: '{x|title}',         desc: 'Title Case' },
      { name: '{x|capitalize}',    desc: 'Capitalize first letter only' },
      { name: '{x|truncate:60}',   desc: 'Cut after 60 chars + …' },
      { name: '{x|default:"foo"}', desc: 'Fall back when empty' },
      { name: '{x|date:long}',     desc: 'long / short / us / iso / year / month / dow / relative' },
      { name: '{x|ordinal}',       desc: '1 → "1st", 22 → "22nd"' },
      { name: '{x|pluralize:"post"}', desc: 'Auto-plural ("2 posts")' },
      { name: '{x|replace:"old:new"}', desc: 'Substring replace' },
      { name: '{x|read_time}',     desc: 'Estimate from word count' },
      { name: '{x|domain}',        desc: 'Hostname from a URL' },
      { name: '{if x}…{/if}',      desc: 'Conditional (also {if !x})' },
    ]},
  ];
  function tplLookup(ctx, path) {
    if (!path) return undefined;
    const parts = path.split('.');
    let cur = ctx;
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[p];
    }
    return cur;
  }
  function tplTruthy(v) {
    if (v == null || v === false || v === 0) return false;
    if (typeof v === 'string') {
      const s = v.trim();
      return !!s && s !== '0' && s.toLowerCase() !== 'false';
    }
    if (Array.isArray(v)) return v.length > 0;
    return true;
  }
  function tplExpand(template, ctx) {
    if (template == null) return '';
    let s = String(template);
    const re = /\{\s*if\s+(!)?\s*([a-zA-Z_][\w.]*)\s*\}([\s\S]*?)\{\s*\/if\s*\}/;
    for (let i = 0; i < 100; i++) {
      const m = s.match(re);
      if (!m) break;
      const v = tplLookup(ctx, m[2]);
      const keep = tplTruthy(v) !== (m[1] === '!') ? m[3] : '';
      s = s.slice(0, m.index) + keep + s.slice(m.index + m[0].length);
    }
    return s.replace(/\{\s*([^{}|][^{}]*?)\s*\}/g, (full, raw) => {
      if (/^\s*(if\s+|\/if)/i.test(raw)) return full;
      const parts = raw.split('|').map((p) => p.trim());
      const path = parts.shift();
      let v = tplLookup(ctx, path);
      for (const p of parts) {
        const colon = p.indexOf(':');
        const name = colon < 0 ? p.trim() : p.slice(0, colon).trim();
        let arg = colon < 0 ? undefined : p.slice(colon + 1).trim();
        if (arg) { const qm = arg.match(/^['"](.*)['"]$/); if (qm) arg = qm[1]; }
        const fn = TPL_FILTERS[name];
        if (typeof fn === 'function') { try { v = fn(v, arg); } catch { /* */ } }
      }
      return v == null ? '' : String(v);
    });
  }

  // ── editor state ─────────────────────────────────────────────────
  function defaultTemplate() {
    return { width: 1200, height: 630, background: null, layers: [] };
  }
  function makeState() {
    return {
      template: defaultTemplate(),
      selectedIds: new Set(),
      assets: { background: [], logo: [] },
      templates: [],
      posts: [],
      previewCtx: null,
      zoom: 1,            // 0.25–4
      autoFit: true,      // when true, zoom recalculates to fit container
      drag: null,         // active pointer interaction
      marquee: null,      // active marquee box (canvas-space)
      snapGuides: [],     // [{kind:'v'|'h', at:number}]
      editingTextId: null,
      contextMenu: null,
    };
  }

  // ── history (command stack) ──────────────────────────────────────
  function makeHistory() {
    return {
      past: [], future: [],
      capacity: 200,
      coalesceWith: null,    // when set, next push merges into the last entry if descriptor matches
    };
  }

  // ── core editor ──────────────────────────────────────────────────
  function CoverEditor() {
    const state = makeState();
    const history = makeHistory();
    let root;            // mount point
    let api;             // fetch helper from admin.js
    let glue;            // { onDirty, loadSettings, getWhoami }
    let canvas;          // <canvas>
    let ctx2d;           // 2D context
    let canvasWrap;      // container holding canvas + overlay
    let overlay;         // absolutely-positioned div over canvas for handles, guides, marquee
    let textEditor;      // contenteditable div for inline text editing
    let contextToolbar;  // selection-aware top toolbar (fixed band)
    let railEl;          // vertical icon column (left)
    let panelEl;         // slide-out panel next to the rail
    let zoomLabel;
    let presetSelect;
    let sizeLabel;
    let activeRail = null;  // which rail item is open: 'text' | 'uploads' | 'templates' | 'layers' | null
    let dirty = false;

    // ─── public init ─────────────────────────────────────────────
    function init(opts) {
      root = opts.root;
      api = opts.api;
      glue = opts.glue || {};
      // Kick the Google Fonts request as early as possible so they're
      // ready by the time the user wires up a real text layer. The
      // ones used in saved templates are loaded by the same mechanism
      // (curated set covers them, plus loadGoogleFont fills in any
      // missing ones referenced by spec.layers).
      injectFontStylesheet();
      build();
      bindGlobalKeys();
      // Initial render once mounted. We hold the first paint until
      // document.fonts.ready so text doesn't flash in the fallback
      // family. Cheap on subsequent loads (already-loaded fonts
      // resolve immediately).
      requestAnimationFrame(async () => {
        fitToContainer();
        try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch { /* */ }
        redraw();
      });
    }

    // ─── layout build ────────────────────────────────────────────
    //
    // Canva-style layout:
    //   ┌──────────────────────────────────────────────────────────┐
    //   │ ce-header  (compact: size + undo/redo + save/apply)      │
    //   ├────┬─────────┬────────────────────────────────────────────┤
    //   │    │         │ ce-context-toolbar (selection-aware band)  │
    //   │ ra │ panel   ├────────────────────────────────────────────┤
    //   │ il │ (slide- │                                            │
    //   │    │  out)   │   canvas viewport                          │
    //   │    │         │                                            │
    //   │    │         │                          [zoom cluster]    │
    //   ├────┴─────────┴────────────────────────────────────────────┤
    //   │ status hint                                                │
    //   └────────────────────────────────────────────────────────────┘
    //
    // Rail is always 60px. Panel collapses to 0px when nothing is
    // active. No right sidebar — selection controls live in the
    // context-toolbar, preview-with-title is the toolbar's "nothing
    // selected" state.
    function build() {
      clearChildren(root);
      root.classList.add('ce-root');

      // ── header (compact: just identity + global actions) ─────
      const header = el('header', { class: 'ce-header' },
        el('div', { class: 'ce-header-left' },
          el('label', { class: 'ce-size' },
            (sizeLabel = el('span', null, '1200 × 630')),
            (presetSelect = el('select', { class: 'ce-preset' },
              ...PRESETS.map((p, i) => el('option', { value: i }, p.label)),
              el('option', { value: 'custom' }, 'Custom…'),
            )),
          ),
          el('span', { class: 'ce-divider' }),
          el('button', { class: 'ce-icon-btn', title: 'Undo (Cmd Z)', onclick: undo }, '↺'),
          el('button', { class: 'ce-icon-btn', title: 'Redo (Cmd Shift Z)', onclick: redo }, '↻'),
        ),
        el('div', { class: 'ce-header-right' },
          // Always-visible post picker — was previously only shown
          // in the idle context-toolbar state, which made it
          // disappear the moment you selected a layer. That broke
          // the "load a template → preview against a real post →
          // apply" flow because the picker was hidden during
          // editing. Now it lives in the header where it stays put.
          (() => {
            const sel = el('select', {
              id: 'ce-header-post', class: 'ce-preset',
              title: 'Preview the current template using this post\'s title',
              style: { maxWidth: '220px' },
              onchange: () => { syncHeaderToPreview(); refreshPreview(); },
            }, el('option', { value: '' }, '(preview as post…)'));
            return sel;
          })(),
          el('button', { class: 'ce-btn ce-btn-ghost', onclick: openSaveTemplateDialog }, 'Save'),
          el('button', { class: 'ce-btn ce-btn-ghost', onclick: openApplyAllDialog,
            title: 'Re-render every published post\'s cover using the current template' },
            'Apply to all'),
          el('button', { class: 'ce-btn', onclick: openApplyDialog,
            title: 'Apply the rendered cover to the post selected above' },
            'Apply to post'),
        ),
      );

      presetSelect.addEventListener('change', () => {
        const v = presetSelect.value;
        if (v === 'custom') {
          const w = parseInt(prompt('Width in pixels', String(state.template.width)) || '0', 10);
          const h = parseInt(prompt('Height in pixels', String(state.template.height)) || '0', 10);
          if (!w || !h) { syncPresetSelect(); return; }
          cmd('resize-canvas', () => {
            state.template.width = clamp(w, 200, 4000);
            state.template.height = clamp(h, 200, 4000);
            updateSizeLabel();
            requestAnimationFrame(fitToContainer);
          });
        } else {
          const p = PRESETS[parseInt(v, 10)];
          if (!p) return;
          cmd('resize-canvas', () => {
            state.template.width = p.w; state.template.height = p.h;
            updateSizeLabel();
            requestAnimationFrame(fitToContainer);
          });
        }
      });

      // ── body row: rail + panel + stage ───────────────────────
      const body = el('div', { class: 'ce-body' });

      // Left rail
      railEl = el('nav', { class: 'ce-rail' },
        railBtn('text',      'T',  'Text'),
        railBtn('uploads',   '↥',  'Uploads'),
        railBtn('templates', '◫',  'Templates'),
        railBtn('layers',    '☰',  'Layers'),
        railBtn('vars',      '{}', 'Vars'),
      );

      // Slide-out panel (collapsed by default)
      panelEl = el('aside', { class: 'ce-panel is-collapsed' },
        el('div', { class: 'ce-panel-inner' }),
      );

      // Stage = top context toolbar + viewport
      const stage = el('div', { class: 'ce-stage' });
      contextToolbar = el('div', { class: 'ce-context-toolbar' });
      const viewport = el('div', { class: 'ce-viewport' });
      canvasWrap = el('div', { class: 'ce-canvas-wrap' });
      canvas = el('canvas', { class: 'ce-canvas', width: 1200, height: 630 });
      overlay = el('div', { class: 'ce-overlay' });
      canvasWrap.append(canvas, overlay);
      viewport.appendChild(canvasWrap);

      // Floating zoom cluster (bottom-right of stage)
      const zoomCluster = el('div', { class: 'ce-zoom-cluster' },
        el('button', { class: 'ce-icon-btn', title: 'Zoom out (Cmd −)', onclick: () => setZoom(state.zoom / 1.25) }, '−'),
        (zoomLabel = el('button', { class: 'ce-zoom-label', title: 'Fit to window (Cmd 0)',
          onclick: () => { state.autoFit = true; fitToContainer(); redraw(); } }, '100%')),
        el('button', { class: 'ce-icon-btn', title: 'Zoom in (Cmd +)', onclick: () => setZoom(state.zoom * 1.25) }, '+'),
      );

      stage.append(contextToolbar, viewport, zoomCluster);
      body.append(railEl, panelEl, stage);

      // Status hint
      const status = el('footer', { class: 'ce-status' },
        el('span', { class: 'ce-status-hint' }, 'Click a rail icon · Drag images onto the canvas · Double-click text to edit · Shift to constrain'),
      );

      root.append(header, body, status);

      // Viewport handlers
      ctx2d = canvas.getContext('2d');
      bindCanvas();
      bindDnD();
      // Resize: throttle to next frame so we don't recompute on every pixel.
      let resizeRaf = 0;
      window.addEventListener('resize', () => {
        cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => { fitToContainer(); redraw(); });
      });
      // ResizeObserver on the viewport re-fits when the rail panel
      // slides in/out. Three defenses against a feedback loop where
      // fitToContainer changes the canvas size, which appears/removes
      // a scrollbar, which changes viewport.clientWidth, which
      // triggers ResizeObserver again:
      //
      //   1. Only act if the viewport area changed by >4px since the
      //      last fit. Scrollbar appearance/disappearance is ~16px,
      //      so we still react to real layout changes — but a fit
      //      that didn't actually move the goalposts is ignored.
      //   2. requestAnimationFrame coalesces multiple notifications
      //      within a single frame into one fitToContainer call.
      //   3. Viewport overflow is toggled in applyZoom() based on
      //      whether the rendered canvas fits — so when autoFit is
      //      converged, there's no scrollbar to oscillate.
      //
      // Together these three break the loop even if one of them
      // misfires.
      if (typeof ResizeObserver !== 'undefined') {
        let lastW = 0, lastH = 0, pending = false;
        const ro = new ResizeObserver(() => {
          if (!state.autoFit) return;
          if (pending) return;
          pending = true;
          requestAnimationFrame(() => {
            pending = false;
            const r = viewport.getBoundingClientRect();
            if (Math.abs(r.width - lastW) < 4 && Math.abs(r.height - lastH) < 4) return;
            lastW = r.width; lastH = r.height;
            fitToContainer();
          });
        });
        ro.observe(viewport);
      }
    }

    // Build one rail button. Clicking toggles the panel.
    function railBtn(id, icon, label) {
      const btn = el('button', {
        class: 'ce-rail-btn',
        dataset: { rail: id },
        onclick: () => toggleRail(id),
      },
        el('span', { class: 'ce-rail-icon' }, icon),
        el('span', { class: 'ce-rail-label' }, label),
      );
      return btn;
    }

    function toggleRail(id) {
      if (activeRail === id) {
        closeRail();
      } else {
        openRail(id);
      }
    }
    function openRail(id) {
      activeRail = id;
      $$('.ce-rail-btn', railEl).forEach((b) => b.classList.toggle('is-active', b.dataset.rail === id));
      panelEl.classList.remove('is-collapsed');
      renderRailPanel(id);
      // After the panel layout settles, refit the canvas.
      requestAnimationFrame(() => { if (state.autoFit) fitToContainer(); });
    }
    function closeRail() {
      activeRail = null;
      $$('.ce-rail-btn', railEl).forEach((b) => b.classList.remove('is-active'));
      panelEl.classList.add('is-collapsed');
      requestAnimationFrame(() => { if (state.autoFit) fitToContainer(); });
    }
    function renderRailPanel(id) {
      const inner = $('.ce-panel-inner', panelEl);
      clearChildren(inner);
      const head = el('div', { class: 'ce-panel-head' },
        el('h3', { class: 'ce-panel-title' }, railTitleFor(id)),
        el('button', { class: 'ce-panel-close', title: 'Close', onclick: closeRail }, '×'),
      );
      inner.appendChild(head);
      if (id === 'text')      renderTextPanel(inner);
      if (id === 'uploads')   renderUploadsPanel(inner);
      if (id === 'templates') renderTemplatesPanel(inner);
      if (id === 'layers')    renderLayersPanel(inner);
      if (id === 'vars')      renderVarsPanel(inner);
    }
    function railTitleFor(id) {
      return { text: 'Text', uploads: 'Uploads', templates: 'Templates', layers: 'Layers', vars: 'Variables' }[id] || id;
    }

    // ── Variables panel ──────────────────────────────────────────
    // Lists every available template variable, grouped by section.
    // Click a variable name to copy it to the clipboard (and, if a
    // text layer is selected, append it to the layer's text).
    function renderVarsPanel(inner) {
      inner.appendChild(el('p', { class: 'ce-dim',
        style: { marginTop: '0', marginBottom: '12px' } },
        'Click a variable to copy it. If a text layer is selected, it appends to that layer.',
      ));
      for (const group of VARIABLE_CATALOGUE) {
        const sec = el('div', { class: 'ce-panel-sec' },
          el('h4', { class: 'ce-panel-sec-h' }, group.group),
        );
        const list = el('div', { class: 'ce-var-list' });
        for (const item of group.items) {
          const btn = el('button', { class: 'ce-var-item',
            title: item.desc,
            onclick: () => {
              // Copy to clipboard always; append to selected text
              // layer if one exists.
              try { navigator.clipboard.writeText(item.name); } catch { /* */ }
              const sel = selectedLayers();
              if (sel.length === 1 && sel[0].kind === 'text') {
                cmd('var-insert', () => {
                  sel[0].text = (sel[0].text || '') + item.name;
                });
              }
              // Flash a quick "copied" hint without disrupting the UI.
              btn.classList.add('is-copied');
              setTimeout(() => btn.classList.remove('is-copied'), 800);
            },
          },
            el('code', null, item.name),
            el('span', { class: 'ce-var-desc' }, item.desc),
          );
          list.appendChild(btn);
        }
        sec.appendChild(list);
        inner.appendChild(sec);
      }
    }

    function updateSizeLabel() {
      sizeLabel.textContent = `${state.template.width} × ${state.template.height}`;
    }
    function syncPresetSelect() {
      const idx = PRESETS.findIndex((p) => p.w === state.template.width && p.h === state.template.height);
      presetSelect.value = idx >= 0 ? String(idx) : 'custom';
    }

    // ── responsive scaling ────────────────────────────────────────
    //
    // The big win for the user experience is that "fit-to-window" is
    // the default and stays the default until they manually zoom.
    // Any layout change that affects the viewport's available area
    // (window resize, rail panel slide-in/out) re-fits if autoFit is
    // still on.
    //
    // Bug history: the previous version capped at 1.0 ("never
    // upscale"), which made small previews on big screens leave huge
    // empty space. We now upscale up to 2× for very small designs
    // (e.g. a 600×400 canvas on a 4K monitor). The hard ceiling
    // (4×) and floor (0.25×) match the manual zoom range.
    function fitToContainer() {
      const vp = $('.ce-viewport', root);
      if (!vp) return;
      // Use the bounding rect so we get the post-flex actual size,
      // not the pre-layout clientWidth which can lag during transitions.
      const r = vp.getBoundingClientRect();
      const padding = 32;
      const availW = Math.max(0, r.width  - padding * 2);
      const availH = Math.max(0, r.height - padding * 2);
      if (availW < 40 || availH < 40) return; // layout not ready yet
      const sw = availW / state.template.width;
      const sh = availH / state.template.height;
      const fit = Math.min(sw, sh);
      if (state.autoFit) {
        state.zoom = clamp(fit, 0.25, 4);
      }
      applyZoom();
    }
    function setZoom(z) {
      state.autoFit = false;
      state.zoom = clamp(z, 0.25, 4);
      applyZoom();
      redraw();
    }
    function applyZoom() {
      const { width, height } = state.template;
      canvasWrap.style.width  = `${width * state.zoom}px`;
      canvas.style.width  = '100%';
      canvas.style.height = '100%';
      canvasWrap.style.height = `${height * state.zoom}px`;
      // When autoFit is on we know the canvas fits the viewport by
      // construction, so hide overflow — that prevents the scrollbar
      // ↔ available-area oscillation that produced an infinite
      // refresh loop. When the user manually zooms beyond fit, allow
      // scrolling so they can pan the bigger canvas.
      const vp = $('.ce-viewport', root);
      if (vp) vp.style.overflow = state.autoFit ? 'hidden' : 'auto';
      if (zoomLabel) zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
      // Reposition handles + guides.
      renderOverlay();
    }

    // ── command pattern (history) ─────────────────────────────────
    // We snapshot the template before mutating, run the mutator, then
    // push the (before, after) pair onto the past stack. Undo restores
    // the before snapshot; redo reapplies the after.
    //
    // descriptor is a string key. Successive commands with the same
    // descriptor within 500ms coalesce — typing in the inspector
    // doesn't produce one history entry per keystroke.
    let lastCmdAt = 0;
    function cmd(descriptor, mutator) {
      const before = snapshot();
      try { mutator(); }
      catch (e) { console.error('[cover] cmd failed', e); restoreSnapshot(before); return; }
      const after = snapshot();
      // No actual change? Skip.
      if (JSON.stringify(before) === JSON.stringify(after)) return;
      const now = Date.now();
      const last = history.past[history.past.length - 1];
      if (last && last.descriptor === descriptor && (now - lastCmdAt) < 500) {
        last.after = after;          // coalesce: extend the last command
      } else {
        history.past.push({ descriptor, before, after });
        if (history.past.length > history.capacity) history.past.shift();
      }
      lastCmdAt = now;
      history.future.length = 0;
      markDirty();
      redraw();
    }
    function snapshot() {
      return {
        template: JSON.parse(JSON.stringify(state.template)),
        selectedIds: Array.from(state.selectedIds),
      };
    }
    function restoreSnapshot(s) {
      state.template = JSON.parse(JSON.stringify(s.template));
      state.selectedIds = new Set(s.selectedIds);
      updateSizeLabel(); syncPresetSelect();
      redraw();
    }
    function undo() {
      const c = history.past.pop();
      if (!c) return;
      history.future.push(c);
      restoreSnapshot(c.before);
      markDirty();
    }
    function redo() {
      const c = history.future.pop();
      if (!c) return;
      history.past.push(c);
      restoreSnapshot(c.after);
      markDirty();
    }
    function markDirty() {
      dirty = true;
      if (glue.onDirty) glue.onDirty();
    }

    // ── render dispatcher ─────────────────────────────────────────
    let scheduled = false;
    function redraw() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(async () => {
        scheduled = false;
        try { await drawCanvas(); }
        catch (e) { console.error('[cover] draw', e); }
        renderOverlay();
        renderContextToolbar();
        // Layers panel only redraws when the layers rail is open —
        // otherwise the panel is unmounted and there's nothing to do.
        if (activeRail === 'layers') {
          const inner = $('.ce-panel-inner', panelEl);
          if (inner) {
            clearChildren(inner);
            inner.appendChild(el('div', { class: 'ce-panel-head' },
              el('h3', { class: 'ce-panel-title' }, 'Layers'),
              el('button', { class: 'ce-panel-close', title: 'Close', onclick: closeRail }, '×'),
            ));
            renderLayersPanel(inner);
          }
        }
      });
    }

    // ── canvas rendering ──────────────────────────────────────────
    async function drawCanvas() {
      const { width, height } = state.template;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width; canvas.height = height;
      }
      const c = ctx2d;
      c.clearRect(0, 0, width, height);

      if (state.template.background?.url) {
        const img = await loadImage(state.template.background.url);
        if (img) {
          const r = Math.max(width / img.width, height / img.height);
          const w = img.width * r, h = img.height * r;
          c.drawImage(img, (width - w) / 2, (height - h) / 2, w, h);
        }
      } else {
        c.fillStyle = '#111';
        c.fillRect(0, 0, width, height);
      }

      for (const layer of state.template.layers) {
        await drawLayer(c, layer, state.previewCtx);
      }
    }
    async function drawLayer(c, layer, previewCtx) {
      c.save();
      // Apply opacity + rotation.
      c.globalAlpha = layer.opacity != null ? layer.opacity : 1;
      const rot = layer.rotation || 0;
      if (rot) {
        c.translate(layer.x + layer.w / 2, layer.y + layer.h / 2);
        c.rotate(rot * Math.PI / 180);
        c.translate(-(layer.x + layer.w / 2), -(layer.y + layer.h / 2));
      }

      if (layer.kind === 'box') {
        c.fillStyle = layer.fill || 'rgba(0,0,0,0.55)';
        if (layer.radius) {
          roundRect(c, layer.x, layer.y, layer.w, layer.h, layer.radius);
          c.fill();
        } else {
          c.fillRect(layer.x, layer.y, layer.w, layer.h);
        }
      } else if (layer.kind === 'text') {
        const fontSize = layer.size || 60;
        const family = layer.family || FONT_FAMILIES[0].value;
        const weight = layer.weight || '600';
        const italic = layer.italic ? 'italic ' : '';
        c.font = `${italic}${weight} ${fontSize}px ${family}`;
        c.fillStyle = layer.color || '#ffffff';
        c.textBaseline = 'top';
        c.textAlign = layer.align || 'left';
        const display = tplExpand(layer.text, previewCtx || { title: layer.text || '' });
        const lines = wrapLines(c, display, layer.w);
        const lineHeight = fontSize * (layer.lineHeight || 1.15);
        let drawX = layer.x;
        if (layer.align === 'center') drawX = layer.x + layer.w / 2;
        if (layer.align === 'right')  drawX = layer.x + layer.w;
        for (let i = 0; i < lines.length; i++) {
          if (layer.shadow) {
            c.shadowColor = layer.shadowColor || 'rgba(0,0,0,0.6)';
            c.shadowBlur = layer.shadowBlur != null ? layer.shadowBlur : 8;
            c.shadowOffsetY = layer.shadowY != null ? layer.shadowY : 2;
          }
          c.fillText(lines[i], drawX, layer.y + i * lineHeight);
          c.shadowColor = 'transparent'; c.shadowBlur = 0; c.shadowOffsetY = 0;
        }
      } else if (layer.kind === 'logo' && layer.url) {
        const img = await loadImage(layer.url);
        if (img) {
          const r = Math.min(layer.w / img.width, layer.h / img.height);
          const w = img.width * r, h = img.height * r;
          c.drawImage(img, layer.x + (layer.w - w) / 2, layer.y + (layer.h - h) / 2, w, h);
        }
      }
      c.restore();
    }
    function roundRect(c, x, y, w, h, r) {
      r = Math.min(r, w / 2, h / 2);
      c.beginPath();
      c.moveTo(x + r, y);
      c.arcTo(x + w, y,     x + w, y + h, r);
      c.arcTo(x + w, y + h, x,     y + h, r);
      c.arcTo(x,     y + h, x,     y,     r);
      c.arcTo(x,     y,     x + w, y,     r);
      c.closePath();
    }
    function wrapLines(c, text, maxWidth) {
      const lines = [];
      for (const para of String(text).split('\n')) {
        const words = para.split(/\s+/).filter(Boolean);
        let line = '';
        for (const w of words) {
          const trial = line ? line + ' ' + w : w;
          if (c.measureText(trial).width <= maxWidth) line = trial;
          else {
            if (line) lines.push(line);
            line = w;
          }
        }
        if (line) lines.push(line);
        if (!words.length) lines.push('');
      }
      return lines;
    }

    // ── overlay rendering (selection handles + guides) ───────────
    function renderOverlay() {
      // CRITICAL: when an inline text editor is active, do nothing.
      // Wiping the overlay would yank the contenteditable mid-edit
      // and lose focus / value. The editor is removed cleanly on
      // commit/cancel; any redraws triggered while it's open (e.g.
      // by a font load or template asset finishing) must not touch
      // it.
      if (state.editingTextId && textEditor) return;
      clearChildren(overlay);
      const sel = selectedLayers();
      // Snap guides.
      for (const g of state.snapGuides) {
        const line = el('div', { class: 'ce-guide ' + (g.kind === 'v' ? 'ce-guide-v' : 'ce-guide-h') });
        if (g.kind === 'v') {
          line.style.left = `${g.at * state.zoom}px`;
        } else {
          line.style.top = `${g.at * state.zoom}px`;
        }
        overlay.appendChild(line);
      }
      // Selection bounding box + handles.
      if (sel.length === 0) return;
      const bbox = boundingBox(sel);
      const sb = el('div', { class: 'ce-selection-box' });
      sb.style.left   = `${bbox.x * state.zoom}px`;
      sb.style.top    = `${bbox.y * state.zoom}px`;
      sb.style.width  = `${bbox.w * state.zoom}px`;
      sb.style.height = `${bbox.h * state.zoom}px`;
      overlay.appendChild(sb);
      // 8 resize handles.
      for (const h of HANDLES) {
        const dot = el('div', { class: 'ce-handle ce-handle-' + h.id, dataset: { handle: h.id } });
        const hx = bbox.x + h.fx * bbox.w;
        const hy = bbox.y + h.fy * bbox.h;
        dot.style.left = `${hx * state.zoom}px`;
        dot.style.top  = `${hy * state.zoom}px`;
        overlay.appendChild(dot);
      }
      // Rotation handle (single-layer only — group rotation is more
      // work than the v1 budget).
      if (sel.length === 1) {
        const rot = el('div', { class: 'ce-handle-rotate', dataset: { handle: 'rotate' } });
        const cx = (bbox.x + bbox.w / 2) * state.zoom;
        const cy = (bbox.y - 30 / state.zoom) * state.zoom;
        rot.style.left = `${cx}px`;
        rot.style.top  = `${cy}px`;
        overlay.appendChild(rot);
        // Connecting line.
        const line = el('div', { class: 'ce-rotate-link' });
        line.style.left = `${cx - 1}px`;
        line.style.top  = `${(bbox.y - 30 / state.zoom) * state.zoom}px`;
        line.style.height = `${30}px`;
        overlay.appendChild(line);
      }
      // Marquee.
      if (state.marquee) {
        const m = state.marquee;
        const x = Math.min(m.x0, m.x1), y = Math.min(m.y0, m.y1);
        const w = Math.abs(m.x1 - m.x0), h = Math.abs(m.y1 - m.y0);
        const box = el('div', { class: 'ce-marquee' });
        box.style.left   = `${x * state.zoom}px`;
        box.style.top    = `${y * state.zoom}px`;
        box.style.width  = `${w * state.zoom}px`;
        box.style.height = `${h * state.zoom}px`;
        overlay.appendChild(box);
      }
    }

    const HANDLES = [
      { id: 'nw', fx: 0,   fy: 0,   cursor: 'nwse-resize' },
      { id: 'n',  fx: 0.5, fy: 0,   cursor: 'ns-resize'   },
      { id: 'ne', fx: 1,   fy: 0,   cursor: 'nesw-resize' },
      { id: 'e',  fx: 1,   fy: 0.5, cursor: 'ew-resize'   },
      { id: 'se', fx: 1,   fy: 1,   cursor: 'nwse-resize' },
      { id: 's',  fx: 0.5, fy: 1,   cursor: 'ns-resize'   },
      { id: 'sw', fx: 0,   fy: 1,   cursor: 'nesw-resize' },
      { id: 'w',  fx: 0,   fy: 0.5, cursor: 'ew-resize'   },
    ];

    function selectedLayers() {
      return state.template.layers.filter((l) => state.selectedIds.has(l.id));
    }
    function boundingBox(layers) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const l of layers) {
        x0 = Math.min(x0, l.x);
        y0 = Math.min(y0, l.y);
        x1 = Math.max(x1, l.x + l.w);
        y1 = Math.max(y1, l.y + l.h);
      }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }

    // ── pointer interaction ──────────────────────────────────────
    function bindCanvas() {
      canvasWrap.addEventListener('pointerdown', onPointerDown);
      canvasWrap.addEventListener('pointermove', onPointerMove);
      canvasWrap.addEventListener('pointerup', onPointerUp);
      canvasWrap.addEventListener('pointercancel', onPointerUp);
      canvasWrap.addEventListener('dblclick', onDoubleClick);
      canvasWrap.addEventListener('contextmenu', onContextMenu);
    }
    function toCanvasCoords(ev) {
      const rect = canvas.getBoundingClientRect();
      const sx = state.template.width  / rect.width;
      const sy = state.template.height / rect.height;
      return { x: (ev.clientX - rect.left) * sx, y: (ev.clientY - rect.top) * sy };
    }
    function hitTest(px, py) {
      // Returns the topmost UNLOCKED layer under the point.
      for (let i = state.template.layers.length - 1; i >= 0; i--) {
        const l = state.template.layers[i];
        if (l.locked) continue;
        if (pointInLayer(l, px, py)) return l;
      }
      return null;
    }
    function pointInLayer(l, px, py) {
      // Approximation: ignore rotation in the hit-test for now. With
      // rotation, the bounding-box hit-test is a slight overshoot
      // (the user clicks slightly outside the rotated rect's visible
      // area but still hits). Acceptable until rotation is heavily
      // used; revisit with proper inverse-transform if needed.
      return px >= l.x && px <= l.x + l.w && py >= l.y && py <= l.y + l.h;
    }
    function onPointerDown(ev) {
      // If an inline text editor is open: clicks INSIDE it should
      // bubble naturally (caret placement etc); clicks OUTSIDE commit
      // and end editing, then proceed with the normal selection
      // logic. Without this guard, clicking on the editor's text was
      // being intercepted by selection code and the contenteditable
      // never saw the click.
      if (state.editingTextId && textEditor) {
        if (textEditor.contains(ev.target)) return; // let the editor handle it
        endInlineTextEdit(true);
        // Fall through to normal selection.
      }
      // Was a handle clicked? Handles live in the overlay layer.
      const handleEl = ev.target.closest('[data-handle]');
      const { x, y } = toCanvasCoords(ev);
      if (handleEl) {
        canvasWrap.setPointerCapture(ev.pointerId);
        const handle = handleEl.dataset.handle;
        const sel = selectedLayers();
        if (handle === 'rotate' && sel.length === 1) {
          beginRotate(sel[0], x, y);
        } else {
          beginResize(sel, handle, x, y);
        }
        return;
      }
      const hit = hitTest(x, y);
      if (!hit) {
        if (!ev.shiftKey) state.selectedIds.clear();
        canvasWrap.setPointerCapture(ev.pointerId);
        beginMarquee(x, y);
        redraw();
        return;
      }
      if (ev.shiftKey) {
        if (state.selectedIds.has(hit.id)) state.selectedIds.delete(hit.id);
        else state.selectedIds.add(hit.id);
      } else if (!state.selectedIds.has(hit.id)) {
        state.selectedIds = new Set([hit.id]);
      }
      canvasWrap.setPointerCapture(ev.pointerId);
      beginMove(x, y, ev.altKey);
      // Remember the layer we just clicked on. If pointerup happens
      // without movement AND this was already the only selected layer
      // AND it's a text layer, we'll promote the click to inline edit
      // (Canva's "click already-selected text again to type" gesture).
      state.drag.clickedOnText = (hit.kind === 'text' && state.selectedIds.size === 1 && state.selectedIds.has(hit.id));
      redraw();
    }
    function onPointerMove(ev) {
      if (!state.drag && !state.marquee) {
        // Update cursor on hover for affordances.
        const handleEl = ev.target.closest('[data-handle]');
        if (handleEl) {
          const h = HANDLES.find((x) => x.id === handleEl.dataset.handle);
          canvasWrap.style.cursor = h ? h.cursor : 'grab';
        } else {
          const { x, y } = toCanvasCoords(ev);
          canvasWrap.style.cursor = hitTest(x, y) ? 'move' : 'default';
        }
        return;
      }
      const { x, y } = toCanvasCoords(ev);
      if (state.marquee) {
        state.marquee.x1 = x; state.marquee.y1 = y;
        renderOverlay();
        return;
      }
      if (state.drag.mode === 'move')    doMove(x, y, ev.shiftKey);
      if (state.drag.mode === 'resize')  doResize(x, y, ev.shiftKey, ev.altKey);
      if (state.drag.mode === 'rotate')  doRotate(x, y, ev.shiftKey);
    }
    function onPointerUp(ev) {
      if (state.marquee) {
        const m = state.marquee;
        const box = {
          x: Math.min(m.x0, m.x1), y: Math.min(m.y0, m.y1),
          w: Math.abs(m.x1 - m.x0), h: Math.abs(m.y1 - m.y0),
        };
        state.marquee = null;
        // Anything with a non-trivial area gets the marquee select.
        // Click-without-drag clears the selection.
        if (box.w > 3 && box.h > 3) {
          const ids = state.template.layers
            .filter((l) => !l.locked && intersects(box, l))
            .map((l) => l.id);
          state.selectedIds = new Set(ids);
        }
        try { canvasWrap.releasePointerCapture(ev.pointerId); } catch { /* */ }
        redraw();
        return;
      }
      if (state.drag) {
        const desc = state.drag.descriptor;
        const clickedOnText = state.drag.clickedOnText;
        // The drag mutated state directly to keep it cheap; we now
        // wrap that in a single history entry by snapshotting the
        // pre-drag state we squirreled away in drag.before.
        const before = state.drag.before;
        const after = snapshot();
        const moved = JSON.stringify(before) !== JSON.stringify(after);
        // Click without drag on an already-selected text layer →
        // promote to inline edit. Canva's gesture: first click
        // selects, second (also a click, not double) starts editing.
        if (!moved && clickedOnText && desc === 'move') {
          const id = [...state.selectedIds][0];
          const layer = state.template.layers.find((l) => l.id === id);
          state.drag = null;
          state.snapGuides = [];
          try { canvasWrap.releasePointerCapture(ev.pointerId); } catch { /* */ }
          if (layer) beginInlineTextEdit(layer);
          return;
        }
        if (moved) {
          history.past.push({ descriptor: desc, before, after });
          if (history.past.length > history.capacity) history.past.shift();
          history.future.length = 0;
          markDirty();
        }
        state.drag = null;
        state.snapGuides = [];
        try { canvasWrap.releasePointerCapture(ev.pointerId); } catch { /* */ }
        redraw();
      }
    }
    function intersects(a, b) {
      return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
    }

    function beginMarquee(x, y) {
      state.marquee = { x0: x, y0: y, x1: x, y1: y };
    }
    function beginMove(x, y, dup) {
      const sel = selectedLayers();
      if (sel.length === 0) return;
      // Alt-drag = duplicate-on-start. The duplicates immediately
      // become the selection so the drag moves THEM, not the
      // originals.
      if (dup) {
        const clones = sel.map((l) => ({ ...JSON.parse(JSON.stringify(l)), id: uid() }));
        state.template.layers.push(...clones);
        state.selectedIds = new Set(clones.map((c) => c.id));
      }
      const layers = selectedLayers();
      state.drag = {
        mode: 'move',
        descriptor: dup ? 'dup-move' : 'move',
        startX: x, startY: y,
        before: snapshot(),
        origs: layers.map((l) => ({ id: l.id, x: l.x, y: l.y })),
      };
    }
    function beginResize(sel, handle, x, y) {
      if (sel.length === 0) return;
      const bbox = boundingBox(sel);
      state.drag = {
        mode: 'resize',
        handle,
        descriptor: 'resize',
        startX: x, startY: y,
        before: snapshot(),
        bbox: { ...bbox },
        origs: sel.map((l) => ({
          id: l.id,
          // Store relative position within the bounding box so we can
          // proportionally redistribute on group resize.
          rx: (l.x - bbox.x) / (bbox.w || 1),
          ry: (l.y - bbox.y) / (bbox.h || 1),
          rw: l.w / (bbox.w || 1),
          rh: l.h / (bbox.h || 1),
          origSize: l.size || null,
        })),
      };
    }
    function beginRotate(layer, x, y) {
      const cx = layer.x + layer.w / 2, cy = layer.y + layer.h / 2;
      state.drag = {
        mode: 'rotate',
        descriptor: 'rotate',
        before: snapshot(),
        cx, cy,
        startAngle: Math.atan2(y - cy, x - cx) * 180 / Math.PI,
        origRotation: layer.rotation || 0,
        layerId: layer.id,
      };
    }
    function doMove(x, y, axisLock) {
      const dx = x - state.drag.startX;
      const dy = y - state.drag.startY;
      // axisLock (shift) — confine to the dominant axis so the user
      // can drag straight without a steady hand.
      let mx = dx, my = dy;
      if (axisLock) {
        if (Math.abs(dx) > Math.abs(dy)) my = 0; else mx = 0;
      }
      // Apply move.
      for (const o of state.drag.origs) {
        const l = state.template.layers.find((x) => x.id === o.id);
        if (!l) continue;
        l.x = Math.round(o.x + mx);
        l.y = Math.round(o.y + my);
      }
      // Compute snap adjustments based on the post-move bounding box
      // of the selection (compared to siblings + canvas).
      const sel = selectedLayers();
      const snap = computeSnap(sel);
      if (snap.dx || snap.dy) {
        for (const o of state.drag.origs) {
          const l = state.template.layers.find((x) => x.id === o.id);
          if (l) { l.x += snap.dx; l.y += snap.dy; }
        }
      }
      state.snapGuides = snap.guides;
      drawCanvas().then(renderOverlay);
    }
    function doResize(x, y, uniform, fromCenter) {
      const d = state.drag;
      const bbox = d.bbox;
      const handle = d.handle;
      const minSize = 20;
      let nx = bbox.x, ny = bbox.y, nw = bbox.w, nh = bbox.h;
      if (handle.includes('e')) nw = Math.max(minSize, x - bbox.x);
      if (handle.includes('s')) nh = Math.max(minSize, y - bbox.y);
      if (handle.includes('w')) { nw = Math.max(minSize, bbox.x + bbox.w - x); nx = x; }
      if (handle.includes('n')) { nh = Math.max(minSize, bbox.y + bbox.h - y); ny = y; }
      if (uniform) {
        // Lock aspect ratio.
        const aspect = bbox.w / bbox.h;
        if (handle === 'e' || handle === 'w') nh = nw / aspect;
        else if (handle === 'n' || handle === 's') nw = nh * aspect;
        else { // corner
          const ratio = Math.max(nw / bbox.w, nh / bbox.h);
          nw = bbox.w * ratio;
          nh = bbox.h * ratio;
          if (handle.includes('w')) nx = bbox.x + bbox.w - nw;
          if (handle.includes('n')) ny = bbox.y + bbox.h - nh;
        }
      }
      if (fromCenter) {
        const dx = (nw - bbox.w) / 2, dy = (nh - bbox.h) / 2;
        nx = bbox.x - dx; ny = bbox.y - dy;
        nw = bbox.w + 2 * dx; nh = bbox.h + 2 * dy;
      }
      // Apply to each selected layer, keeping their relative position
      // inside the bbox.
      for (const o of d.origs) {
        const l = state.template.layers.find((x) => x.id === o.id);
        if (!l) continue;
        l.x = Math.round(nx + o.rx * nw);
        l.y = Math.round(ny + o.ry * nh);
        l.w = Math.max(minSize, Math.round(o.rw * nw));
        l.h = Math.max(minSize, Math.round(o.rh * nh));
        // Text layers: scale font size proportionally when grabbing a
        // corner. Edge handles change only one dim — leave font alone.
        if (l.kind === 'text' && o.origSize != null && (handle.length === 2)) {
          const f = Math.min(nw / bbox.w, nh / bbox.h);
          l.size = Math.max(8, Math.round(o.origSize * f));
        }
      }
      drawCanvas().then(renderOverlay);
    }
    function doRotate(x, y, snap) {
      const d = state.drag;
      const layer = state.template.layers.find((l) => l.id === d.layerId);
      if (!layer) return;
      const ang = Math.atan2(y - d.cy, x - d.cx) * 180 / Math.PI;
      let next = d.origRotation + (ang - d.startAngle);
      if (snap) next = Math.round(next / 15) * 15;
      layer.rotation = ((next + 360) % 360);
      drawCanvas().then(renderOverlay);
    }

    // ── snapping ──────────────────────────────────────────────────
    function computeSnap(sel) {
      if (sel.length === 0) return { dx: 0, dy: 0, guides: [] };
      const bbox = boundingBox(sel);
      const cw = state.template.width, ch = state.template.height;
      // Candidate vertical lines (x values) and horizontal lines (y).
      const vTargets = [0, cw / 2, cw];
      const hTargets = [0, ch / 2, ch];
      // Add other layers' edges + centers.
      for (const other of state.template.layers) {
        if (state.selectedIds.has(other.id)) continue;
        vTargets.push(other.x, other.x + other.w / 2, other.x + other.w);
        hTargets.push(other.y, other.y + other.h / 2, other.y + other.h);
      }
      // The selection's own snap points.
      const vSources = [bbox.x, bbox.x + bbox.w / 2, bbox.x + bbox.w];
      const hSources = [bbox.y, bbox.y + bbox.h / 2, bbox.y + bbox.h];

      let dx = 0, dy = 0;
      const guides = [];
      let bestDx = Infinity, bestDy = Infinity;
      for (const src of vSources) {
        for (const tgt of vTargets) {
          const d = tgt - src;
          if (Math.abs(d) < SNAP_THRESHOLD && Math.abs(d) < Math.abs(bestDx)) {
            bestDx = d;
          }
        }
      }
      for (const src of hSources) {
        for (const tgt of hTargets) {
          const d = tgt - src;
          if (Math.abs(d) < SNAP_THRESHOLD && Math.abs(d) < Math.abs(bestDy)) {
            bestDy = d;
          }
        }
      }
      if (bestDx !== Infinity) dx = bestDx;
      if (bestDy !== Infinity) dy = bestDy;
      // Build guide lines at the snapped position.
      const finalV = [bbox.x + dx, bbox.x + bbox.w / 2 + dx, bbox.x + bbox.w + dx];
      const finalH = [bbox.y + dy, bbox.y + bbox.h / 2 + dy, bbox.y + bbox.h + dy];
      for (const v of finalV) {
        if (vTargets.some((t) => Math.abs(t - v) < 0.5)) guides.push({ kind: 'v', at: v });
      }
      for (const h of finalH) {
        if (hTargets.some((t) => Math.abs(t - h) < 0.5)) guides.push({ kind: 'h', at: h });
      }
      return { dx, dy, guides };
    }

    // ── double-click / inline edit ───────────────────────────────
    function onDoubleClick(ev) {
      const { x, y } = toCanvasCoords(ev);
      const hit = hitTest(x, y);
      if (!hit || hit.kind !== 'text') return;
      beginInlineTextEdit(hit);
    }
    function beginInlineTextEdit(layer) {
      // Replace the canvas-rendered text with a contenteditable
      // positioned over the layer's bounds. On blur or Esc, commit.
      if (textEditor) endInlineTextEdit(false);
      state.editingTextId = layer.id;
      const ed = el('div', {
        class: 'ce-text-editor',
        contenteditable: 'true',
        style: {
          left:   `${layer.x * state.zoom}px`,
          top:    `${layer.y * state.zoom}px`,
          width:  `${layer.w * state.zoom}px`,
          minHeight: `${layer.h * state.zoom}px`,
          fontSize: `${(layer.size || 60) * state.zoom}px`,
          fontFamily: layer.family || FONT_FAMILIES[0].value,
          fontWeight: layer.weight || '600',
          color: layer.color || '#ffffff',
          textAlign: layer.align || 'left',
          fontStyle: layer.italic ? 'italic' : 'normal',
        },
      });
      ed.textContent = layer.text || '';
      ed.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); endInlineTextEdit(false); }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); endInlineTextEdit(true); }
      });
      ed.addEventListener('blur', () => endInlineTextEdit(true));
      overlay.appendChild(ed);
      textEditor = ed;
      // Microtask so the browser focuses after appending.
      setTimeout(() => {
        ed.focus();
        document.execCommand('selectAll', false, null);
      }, 0);
    }
    function endInlineTextEdit(commit) {
      if (!textEditor || !state.editingTextId) return;
      const id = state.editingTextId;
      const newText = textEditor.textContent;
      textEditor.remove();
      textEditor = null;
      state.editingTextId = null;
      if (!commit) return;
      cmd('edit-text', () => {
        const l = state.template.layers.find((x) => x.id === id);
        if (l) l.text = newText;
      });
    }

    // ── right-click context menu ─────────────────────────────────
    function onContextMenu(ev) {
      ev.preventDefault();
      const { x, y } = toCanvasCoords(ev);
      const hit = hitTest(x, y);
      if (hit && !state.selectedIds.has(hit.id)) {
        state.selectedIds = new Set([hit.id]);
        renderOverlay();
      }
      if (state.selectedIds.size === 0) return;
      showContextMenu(ev.clientX, ev.clientY);
    }
    function showContextMenu(clientX, clientY) {
      hideContextMenu();
      const sel = selectedLayers();
      const anyLocked = sel.some((l) => l.locked);
      const menu = el('div', { class: 'ce-context-menu' },
        menuItem('Bring forward', () => moveZ(+1)),
        menuItem('Bring to front', () => moveZ(+Infinity)),
        menuItem('Send backward', () => moveZ(-1)),
        menuItem('Send to back', () => moveZ(-Infinity)),
        el('div', { class: 'ce-context-sep' }),
        menuItem('Duplicate (⌘D)', duplicateSelection),
        menuItem(anyLocked ? 'Unlock' : 'Lock', toggleLock),
        menuItem('Delete (⌫)', deleteSelection),
      );
      menu.style.left = `${clientX}px`;
      menu.style.top  = `${clientY}px`;
      document.body.appendChild(menu);
      state.contextMenu = menu;
      const close = (e) => {
        if (e.target.closest('.ce-context-menu')) return;
        hideContextMenu();
        document.removeEventListener('mousedown', close, true);
      };
      // setTimeout so the contextmenu event's own propagation doesn't
      // close us immediately.
      setTimeout(() => document.addEventListener('mousedown', close, true), 0);
    }
    function menuItem(label, fn) {
      return el('button', { class: 'ce-context-item', onclick: () => { fn(); hideContextMenu(); } }, label);
    }
    function hideContextMenu() {
      if (state.contextMenu) {
        state.contextMenu.remove();
        state.contextMenu = null;
      }
    }
    function moveZ(delta) {
      cmd('zorder', () => {
        const layers = state.template.layers;
        const sel = sortedSelection();
        if (delta === +Infinity) {
          // Move all to the top, preserving relative order.
          const others = layers.filter((l) => !state.selectedIds.has(l.id));
          state.template.layers = others.concat(sel);
        } else if (delta === -Infinity) {
          const others = layers.filter((l) => !state.selectedIds.has(l.id));
          state.template.layers = sel.concat(others);
        } else if (delta > 0) {
          for (let i = layers.length - 2; i >= 0; i--) {
            if (state.selectedIds.has(layers[i].id) && !state.selectedIds.has(layers[i + 1].id)) {
              [layers[i], layers[i + 1]] = [layers[i + 1], layers[i]];
            }
          }
        } else if (delta < 0) {
          for (let i = 1; i < layers.length; i++) {
            if (state.selectedIds.has(layers[i].id) && !state.selectedIds.has(layers[i - 1].id)) {
              [layers[i], layers[i - 1]] = [layers[i - 1], layers[i]];
            }
          }
        }
      });
    }
    function sortedSelection() {
      // Selection in current z-order, lowest first.
      return state.template.layers.filter((l) => state.selectedIds.has(l.id));
    }
    function duplicateSelection() {
      cmd('duplicate', () => {
        const clones = selectedLayers().map((l) => ({
          ...JSON.parse(JSON.stringify(l)),
          id: uid(),
          x: l.x + 20,
          y: l.y + 20,
        }));
        state.template.layers.push(...clones);
        state.selectedIds = new Set(clones.map((c) => c.id));
      });
    }
    function toggleLock() {
      cmd('lock', () => {
        const sel = selectedLayers();
        const anyUnlocked = sel.some((l) => !l.locked);
        for (const l of sel) l.locked = anyUnlocked;
      });
    }
    function deleteSelection() {
      cmd('delete', () => {
        state.template.layers = state.template.layers.filter((l) => !state.selectedIds.has(l.id));
        state.selectedIds.clear();
      });
    }

    // ── contextual top toolbar ──────────────────────────────────
    //
    // Lives in the fixed band above the canvas. Contents change based
    // on what's selected:
    //   nothing → preview-with-title controls (post picker + title input)
    //   1 text  → font / size / weight / B / I / color / align / shadow
    //   1 box   → fill / alpha / radius
    //   1 logo  → source dropdown
    //   2+      → align controls; 3+ also distribute
    // The "common" right-side cluster (z-order / duplicate / lock /
    // delete / opacity) is always present when something is selected.
    function renderContextToolbar() {
      if (!contextToolbar) return;
      clearChildren(contextToolbar);
      const sel = selectedLayers();
      if (sel.length === 0) {
        renderIdleToolbar();
        return;
      }
      if (sel.length === 1 && sel[0].kind === 'text') appendTextControls(sel[0]);
      else if (sel.length === 1 && sel[0].kind === 'box') appendBoxControls(sel[0]);
      else if (sel.length === 1 && sel[0].kind === 'logo') appendLogoControls(sel[0]);
      else if (sel.length > 1) appendMultiControls(sel);

      contextToolbar.append(
        el('span', { class: 'ce-ctx-spacer' }),
        el('span', { class: 'ce-ctx-sep' }),
        ctxIcon('⇧', 'Bring to front', () => moveZ(+Infinity)),
        ctxIcon('⇩', 'Send to back',   () => moveZ(-Infinity)),
        ctxIcon('⎘', 'Duplicate (⌘D)', duplicateSelection),
        // Opacity slider — universally applicable, lives in toolbar
        // not in a separate inspector.
        (() => {
          const layer0 = sel[0];
          const val = layer0?.opacity != null ? layer0.opacity : 1;
          const range = el('input', {
            type: 'range', class: 'ce-ctx-input ce-ctx-range',
            min: 0, max: 1, step: 0.05, value: String(val),
            title: 'Opacity',
            oninput: (e) => cmd('opacity', () => {
              const v = parseFloat(e.target.value);
              for (const l of sel) l.opacity = v;
            }),
          });
          return range;
        })(),
        ctxIcon('🔒', 'Lock / unlock', toggleLock),
        ctxIcon('🗑', 'Delete (⌫)',   deleteSelection),
      );
    }

    function renderIdleToolbar() {
      // "Nothing selected" state — the preview-with-title controls.
      const postSel = el('select', {
        id: 'ce-preview-post', class: 'ce-ctx-input',
        onchange: refreshPreview,
      }, el('option', { value: '' }, '(preview as post…)'));
      // The current state.posts list is populated by loadPosts(); we
      // copy them in here on each render.
      for (const p of (state.posts || [])) {
        postSel.appendChild(el('option', { value: p.id }, p.title.slice(0, 60)));
      }
      const titleIn = el('input', {
        id: 'ce-preview-title', class: 'ce-ctx-input',
        placeholder: 'or type a title to preview…',
        style: { minWidth: '260px', flex: '1' },
        oninput: refreshPreview,
      });
      contextToolbar.append(
        el('span', { class: 'ce-ctx-lbl' }, 'Preview'),
        postSel,
        titleIn,
        el('span', { class: 'ce-ctx-spacer' }),
        el('span', { class: 'ce-dim' }, 'Click a rail icon on the left to add elements.'),
      );
    }

    function appendTextControls(l) {
      // Font family — grouped picker. Optgroups keep the long list
      // navigable; we group by f.group.
      const fam = el('select', { class: 'ce-ctx-input', title: 'Font',
        onchange: () => cmd('text-style', () => l.family = fam.value) });
      const groups = new Map();  // preserve insertion order
      for (const f of FONT_FAMILIES) {
        const g = f.group || 'Other';
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(f);
      }
      // If the layer's current family is one we don't have in the
      // curated list (e.g. a previously-loaded custom Google Font),
      // we still want it selectable — add a one-off option for it.
      const known = new Set(FONT_FAMILIES.map((f) => f.value));
      if (l.family && !known.has(l.family)) {
        const custom = el('optgroup', { label: 'Custom' });
        custom.appendChild(el('option', { value: l.family, selected: true }, l.family.replace(/^"|"$/g, '').split(',')[0]));
        fam.appendChild(custom);
      }
      for (const [groupName, items] of groups) {
        const og = el('optgroup', { label: groupName });
        for (const f of items) {
          og.appendChild(el('option', { value: f.value, selected: l.family === f.value }, f.label));
        }
        fam.appendChild(og);
      }
      // "Custom Google Font" mini-input. User types a family name,
      // hits Enter; we load it and switch the selected layer to it.
      const customIn = el('input', {
        type: 'text', class: 'ce-ctx-input', placeholder: 'or paste a Google Font name…',
        style: { width: '160px' }, title: 'Type any Google Font family (e.g. "Roboto Slab") and press Enter',
      });
      customIn.addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const name = customIn.value.trim();
        if (!name) return;
        customIn.disabled = true;
        const ok = await loadGoogleFont(name);
        customIn.disabled = false;
        if (!ok) {
          customIn.value = ''; customIn.placeholder = 'Invalid name — letters/digits/spaces only';
          setTimeout(() => { customIn.placeholder = 'or paste a Google Font name…'; }, 2500);
          return;
        }
        cmd('text-style', () => {
          l.family = `"${name}", sans-serif`;
        });
        customIn.value = '';
      });
      // Size.
      const size = el('input', {
        type: 'number', class: 'ce-ctx-input ce-ctx-size',
        min: 8, max: 400, value: l.size || 60, title: 'Size',
        oninput: () => cmd('text-style', () => l.size = clamp(parseInt(size.value, 10) || 60, 8, 400)),
      });
      // Bold toggle (jumps weight between 400 and 700).
      const bold = ctxIcon('B', 'Bold', () => cmd('text-style', () => {
        l.weight = (parseInt(l.weight, 10) || 400) >= 600 ? '400' : '700';
      }));
      bold.style.fontWeight = '800';
      bold.classList.toggle('is-on', (parseInt(l.weight, 10) || 400) >= 600);
      const italic = ctxIcon('I', 'Italic', () => cmd('text-style', () => { l.italic = !l.italic; }));
      italic.style.fontStyle = 'italic';
      italic.classList.toggle('is-on', !!l.italic);
      // Align: a single button that cycles through left → center →
      // right. Avoids the three-near-identical-icons problem the user
      // pointed out.
      const ALIGNS = ['left', 'center', 'right'];
      const ALIGN_GLYPHS = { left: '⫷', center: '═', right: '⫸' };
      const align = ctxIcon(ALIGN_GLYPHS[l.align || 'left'], 'Align (click to cycle)', () => {
        cmd('text-style', () => {
          const i = ALIGNS.indexOf(l.align || 'left');
          l.align = ALIGNS[(i + 1) % ALIGNS.length];
        });
      });
      // Color picker.
      const color = el('input', {
        type: 'color', class: 'ce-ctx-color', value: hexOnly(l.color || '#ffffff'), title: 'Text colour',
        oninput: () => cmd('text-style', () => l.color = color.value),
      });
      // Shadow toggle.
      const shadow = ctxIcon('☼', 'Drop shadow', () => cmd('text-style', () => { l.shadow = !l.shadow; }));
      shadow.classList.toggle('is-on', !!l.shadow);
      contextToolbar.append(fam, customIn, size, el('span', { class: 'ce-ctx-sep' }), bold, italic, align, color, shadow);
    }

    function appendBoxControls(l) {
      const baseHex = hexOnly(l.fill || '#000000');
      const baseAlpha = parseAlpha(l.fill, 0.55);
      const color = el('input', { type: 'color', class: 'ce-ctx-color', value: baseHex, title: 'Fill',
        oninput: () => cmd('box-style', () => { l.fill = hexToRgba(color.value, alpha.value); }) });
      const alpha = el('input', { type: 'range', class: 'ce-ctx-input ce-ctx-range',
        min: 0, max: 1, step: 0.05, value: String(baseAlpha), title: 'Fill alpha',
        oninput: () => cmd('box-style', () => { l.fill = hexToRgba(color.value, alpha.value); }) });
      const radius = el('input', { type: 'number', class: 'ce-ctx-input ce-ctx-size',
        min: 0, max: 999, value: l.radius || 0, title: 'Corner radius',
        oninput: () => cmd('box-style', () => { l.radius = parseInt(radius.value, 10) || 0; }) });
      contextToolbar.append(
        el('span', { class: 'ce-ctx-lbl' }, 'Fill'), color, alpha,
        el('span', { class: 'ce-ctx-sep' }),
        el('span', { class: 'ce-ctx-lbl' }, 'Radius'), radius,
      );
    }

    function appendLogoControls(l) {
      const sel = el('select', { class: 'ce-ctx-input', title: 'Logo source',
        onchange: () => cmd('logo-source', () => { l.url = sel.value || null; l.asset_id = null; }) });
      sel.appendChild(el('option', { value: '' }, '(no logo)'));
      for (const a of state.assets.logo) {
        sel.appendChild(el('option', { value: a.url, selected: l.url === a.url }, a.original_name || a.id));
      }
      contextToolbar.append(el('span', { class: 'ce-ctx-lbl' }, 'Source'), sel);
    }

    function appendMultiControls(sel) {
      const align = (axis, mode) => () => cmd('align', () => {
        const bbox = boundingBox(sel);
        for (const l of sel) {
          if (axis === 'x') {
            if (mode === 'left')   l.x = bbox.x;
            if (mode === 'center') l.x = bbox.x + (bbox.w - l.w) / 2;
            if (mode === 'right')  l.x = bbox.x + bbox.w - l.w;
          } else {
            if (mode === 'top')    l.y = bbox.y;
            if (mode === 'center') l.y = bbox.y + (bbox.h - l.h) / 2;
            if (mode === 'bottom') l.y = bbox.y + bbox.h - l.h;
          }
        }
      });
      contextToolbar.append(
        el('span', { class: 'ce-ctx-lbl' }, `${sel.length} selected`),
        el('span', { class: 'ce-ctx-sep' }),
        ctxIcon('⫷', 'Align left',    align('x', 'left')),
        ctxIcon('═', 'Center horiz.', align('x', 'center')),
        ctxIcon('⫸', 'Align right',   align('x', 'right')),
        el('span', { class: 'ce-ctx-sep' }),
        ctxIcon('⊤', 'Align top',     align('y', 'top')),
        ctxIcon('⌖', 'Center vert.',  align('y', 'center')),
        ctxIcon('⊥', 'Align bottom',  align('y', 'bottom')),
      );
      if (sel.length >= 3) {
        contextToolbar.append(
          el('span', { class: 'ce-ctx-sep' }),
          ctxIcon('⇔', 'Distribute horiz.', () => cmd('distribute', () => distribute(sel, 'x'))),
          ctxIcon('⇕', 'Distribute vert.',  () => cmd('distribute', () => distribute(sel, 'y'))),
        );
      }
    }

    function distribute(layers, axis) {
      const sorted = [...layers].sort((a, b) => (axis === 'x'
        ? a.x + a.w / 2 - (b.x + b.w / 2)
        : a.y + a.h / 2 - (b.y + b.h / 2)));
      if (sorted.length < 3) return;
      const first = sorted[0], last = sorted[sorted.length - 1];
      const start = axis === 'x' ? first.x + first.w / 2 : first.y + first.h / 2;
      const end   = axis === 'x' ? last.x  + last.w  / 2 : last.y  + last.h  / 2;
      const step  = (end - start) / (sorted.length - 1);
      for (let i = 1; i < sorted.length - 1; i++) {
        const c = start + i * step;
        const l = sorted[i];
        if (axis === 'x') l.x = c - l.w / 2;
        else l.y = c - l.h / 2;
      }
    }
    function ctxIcon(label, title, fn) {
      return el('button', { class: 'ce-ctx-icon', title, onclick: fn }, label);
    }

    // ── layers panel ─────────────────────────────────────────────
    // ── Text panel (rail) ────────────────────────────────────────
    // Canva-style "add a heading / subheading / body text" presets,
    // plus a plain "+ Add a text box" button at the top.
    function renderTextPanel(inner) {
      inner.appendChild(el('button', { class: 'ce-btn ce-btn-ghost ce-upload-tile',
        onclick: () => { addLayer('text'); closeRail(); } }, '+ Add a text box'));
      const presets = el('div', { class: 'ce-presets' });
      presets.append(
        el('button', { class: 'ce-preset-card is-heading',
          onclick: () => { addLayer('text', { text: 'Add a heading', size: 72, weight: '700' }); closeRail(); } }, 'Add a heading'),
        el('button', { class: 'ce-preset-card is-subheading',
          onclick: () => { addLayer('text', { text: 'Add a subheading', size: 44, weight: '600' }); closeRail(); } }, 'Add a subheading'),
        el('button', { class: 'ce-preset-card is-body',
          onclick: () => { addLayer('text', { text: 'Add body text', size: 22, weight: '400' }); closeRail(); } }, 'Add a little bit of body text'),
      );
      inner.appendChild(presets);
      // Also expose the box layer here, since it's a structural
      // shape commonly used behind text.
      inner.appendChild(el('div', { class: 'ce-panel-sec' },
        el('h4', { class: 'ce-panel-sec-h' }, 'Shapes'),
        el('button', { class: 'ce-btn ce-btn-ghost ce-upload-tile',
          onclick: () => { addLayer('box'); closeRail(); } }, '+ Add a box'),
      ));
    }

    // ── Uploads panel (rail) ─────────────────────────────────────
    // Single mixed grid of backgrounds + logos with a badge to tell
    // them apart, plus one Upload button (kind chosen via small
    // segmented control at the top).
    function renderUploadsPanel(inner) {
      // Two upload tiles — separate for clarity. Background = will
      // replace the canvas background; Logo = drops onto canvas as a
      // movable layer.
      const tile = (kind, label) => {
        const lbl = el('label', { class: 'ce-upload-tile' }, '+ ', label);
        lbl.appendChild(el('input', {
          type: 'file', accept: 'image/*', hidden: true,
          onchange: (e) => {
            const f = e.target.files[0];
            if (f) uploadAsset(kind, f);
            e.target.value = '';
          },
        }));
        return lbl;
      };
      inner.append(tile('background', 'Upload background'), tile('logo', 'Upload logo'));
      // Mixed grid.
      const all = [
        ...(state.assets.background || []).map((a) => ({ ...a, kind: 'background' })),
        ...(state.assets.logo       || []).map((a) => ({ ...a, kind: 'logo' })),
      ];
      if (!all.length) {
        inner.appendChild(el('div', { class: 'ce-dim' }, 'No uploads yet. Drop an image above, or drag straight onto the canvas.'));
        return;
      }
      const grid = el('div', { class: 'ce-asset-grid' });
      for (const a of all) {
        const card = el('div', { class: 'ce-asset', draggable: true });
        card.appendChild(el('img', { src: a.url, loading: 'lazy', alt: a.original_name || '' }));
        card.appendChild(el('span', { class: 'ce-asset-badge' }, a.kind === 'background' ? 'BG' : 'Logo'));
        const del = el('button', {
          class: 'ce-asset-del', title: 'Delete',
          onclick: async (e) => {
            e.stopPropagation();
            if (!confirm('Delete this asset?')) return;
            await api('/api/admin/cover/upload?id=' + encodeURIComponent(a.id), { method: 'DELETE' });
            await loadAssets();
            if (activeRail === 'uploads') renderRailPanel('uploads');
          },
        }, '×');
        card.appendChild(del);
        card.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('application/x-cover-asset', JSON.stringify({ kind: a.kind, id: a.id, url: a.url }));
          e.dataTransfer.effectAllowed = 'copy';
        });
        card.addEventListener('click', () => {
          if (a.kind === 'background') {
            cmd('set-bg', () => { state.template.background = { asset_id: a.id, url: a.url }; });
          } else {
            addLayer('logo', { url: a.url, asset_id: a.id });
          }
        });
        grid.appendChild(card);
      }
      inner.appendChild(grid);
    }

    // ── Templates panel (rail) ───────────────────────────────────
    function renderTemplatesPanel(inner) {
      // Top: "Install premium template" affordance.
      inner.appendChild(el('button', {
        class: 'ce-btn ce-btn-ghost ce-upload-tile',
        title: 'Install the maintainer\'s curated premium template (black + gold serif). Marks it default so new posts use it when hero_image_mode = cover.',
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true; btn.textContent = 'Installing…';
          const r = await api('/api/admin/cover/install-official', { method: 'POST' });
          btn.disabled = false; btn.textContent = '✨ Install premium template';
          if (r.body?.ok) {
            await loadTemplates();
            const fresh = state.templates.find((t) => t.id === r.body.id);
            if (fresh) loadTemplateSpec(fresh);
            if (activeRail === 'templates') renderRailPanel('templates');
          } else {
            notify('Install failed: ' + (r.body?.error || r.status), 'bad', { errorCode: r.body?.error });
          }
        },
      }, '✨ Install premium template'));

      // Import tile. Hidden file input + label styled as a button. We
      // wire the change handler to read the .template file, POST its
      // JSON to /import, and refresh the panel on success.
      const importLabel = el('label', {
        class: 'ce-btn ce-btn-ghost ce-upload-tile',
        title: 'Pick a .template file you (or someone else) exported from a cover editor. Backgrounds and logos travel inside the file — no manual re-upload needed.',
      }, '⤓ Import .template…');
      const importInput = el('input', {
        type: 'file', accept: '.template,application/json,.json', hidden: true,
        onchange: async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          await importTemplateFile(file);
        },
      });
      importLabel.appendChild(importInput);
      inner.appendChild(importLabel);

      if (!state.templates.length) {
        inner.appendChild(el('div', { class: 'ce-dim' }, 'Or build a design and click “Save as template” in the header.'));
        return;
      }
      const ul = el('ul', { class: 'ce-tpl-list' });
      for (const t of state.templates) {
        const li = el('li', { class: 'ce-tpl-item' });
        li.appendChild(el('strong', null, t.name));
        if (t.is_default) li.appendChild(el('span', { class: 'ce-pill' }, 'default'));
        if (t.spec?.__official) {
          li.appendChild(el('span', { class: 'ce-pill ce-pill-official', title: 'Official maintainer template' }, '✓ official'));
        }
        li.appendChild(el('button', { class: 'ce-btn ce-btn-ghost ce-btn-sm',
          onclick: () => { loadTemplateSpec(t); closeRail(); } }, 'Load'));
        // Export — downloads the template + every embedded asset as
        // a self-contained .template JSON file. Browser navigates to
        // the URL with the Content-Disposition header set, so it
        // saves to the user's Downloads folder.
        li.appendChild(el('button', {
          class: 'ce-btn ce-btn-ghost ce-btn-sm',
          title: 'Download this template (with embedded backgrounds + logos) as a .template file you can share with another install.',
          onclick: () => {
            // Pop a new tab pointing at the export endpoint. Browser
            // honours Content-Disposition: attachment so the file
            // saves rather than opening as JSON in-tab.
            const a = document.createElement('a');
            a.href = '/api/admin/cover/templates/export?id=' + encodeURIComponent(t.id);
            a.rel = 'noopener';
            document.body.appendChild(a);
            a.click();
            a.remove();
          },
        }, '⤴ Export'));
        li.appendChild(el('button', { class: 'ce-btn ce-btn-ghost ce-btn-sm ce-tpl-del',
          onclick: async () => {
            if (!confirm('Delete template "' + t.name + '"?')) return;
            await api('/api/admin/cover/templates?id=' + encodeURIComponent(t.id), { method: 'DELETE' });
            await loadTemplates();
            if (activeRail === 'templates') renderRailPanel('templates');
          },
        }, '✕'));
        ul.appendChild(li);
      }
      inner.appendChild(ul);
    }

    // Read a .template file (JSON) from disk, POST it to the import
    // endpoint, refresh the panel and load the new template on
    // success. Used by the Import tile in the Templates rail.
    async function importTemplateFile(file) {
      // 30MB cap on disk read, mirrors the server's MAX_TOTAL_BYTES.
      if (file.size > 60 * 1024 * 1024) {
        notify('That .template file is too large (over 60MB).', 'warn');
        return;
      }
      const text = await file.text().catch(() => null);
      if (!text) { notify('Could not read the file.', 'bad'); return; }
      let payload;
      try { payload = JSON.parse(text); }
      catch (e) {
        notify('That doesn\'t look like a .template file (invalid JSON).', 'bad');
        return;
      }
      if (payload?.format !== 'pages-seo-cover-template') {
        notify('Wrong file format — expected a pages-seo cover template export.', 'bad', { errorCode: 'wrong_format' });
        return;
      }
      const setDefault = confirm(
        'Import "' + (payload?.template?.name || 'untitled') + '"?\n\n' +
        'Click OK to import and also make it the default template (it will replace ' +
        'your current default). Click Cancel to import without changing the default.'
      );
      // We honor the user's intent regardless of their click — Cancel
      // here doesn't abort, it just declines the "set default" flag.
      // To actually abort, they hit Escape on the dialog (returns
      // null), which we treat as cancel via the confirm semantics
      // (Cancel = false, set_default stays false).
      const r = await api('/api/admin/cover/templates/import', {
        method: 'POST',
        body: JSON.stringify({ ...payload, set_default: !!setDefault }),
      });
      if (!r.body?.ok) {
        notify(r.body?.detail || ('Import failed: ' + (r.body?.error || r.status)), 'bad', { errorCode: r.body?.error });
        return;
      }
      await loadTemplates();
      const fresh = state.templates.find((t) => t.id === r.body.id);
      if (fresh) loadTemplateSpec(fresh);
      if (activeRail === 'templates') renderRailPanel('templates');
      const summary = `Imported "${r.body.name}". ${r.body.assets_imported} assets restored` +
                      (r.body.assets_missing ? `, ${r.body.assets_missing} missing.` : '.');
      notify(summary, 'good');
    }

    // ── Layers panel (rail) ──────────────────────────────────────
    function renderLayersPanel(inner) {
      // Add-layer controls at the top of the panel.
      inner.appendChild(el('div', { class: 'ce-add-row' },
        el('button', { class: 'ce-btn ce-btn-ghost ce-btn-sm', onclick: () => addLayer('text') }, '+ Text'),
        el('button', { class: 'ce-btn ce-btn-ghost ce-btn-sm', onclick: () => addLayer('box') }, '+ Box'),
        el('button', { class: 'ce-btn ce-btn-ghost ce-btn-sm', onclick: () => addLayer('logo') }, '+ Logo'),
      ));
      const ul = el('ul', { class: 'ce-layers' });
      // Drawn top-of-stack first so visually the layer panel matches
      // z-order (top item in panel = front of canvas).
      const layers = [...state.template.layers].reverse();
      if (!layers.length) {
        ul.appendChild(el('li', { class: 'ce-dim' }, 'No layers yet. Use the Text / Uploads rails to add some.'));
      }
      for (const l of layers) {
        const li = el('li', { class: 'ce-layer' + (state.selectedIds.has(l.id) ? ' is-selected' : '') });
        const icon = l.kind === 'text' ? '𝐓' : l.kind === 'box' ? '▭' : '🖼';
        // For text layers with {title} placeholder, show "Title
        // placeholder" instead of the raw token — far more readable.
        const labelText = (() => {
          if (l.kind === 'box') return 'Box';
          if (l.kind === 'logo') return 'Logo';
          const raw = (l.text || '').trim();
          if (!raw) return '(empty text)';
          if (raw === '{title}') return 'Title placeholder';
          return raw;
        })();
        li.append(
          el('span', { class: 'ce-layer-icon' }, icon),
          el('span', { class: 'ce-layer-label' }, labelText.slice(0, 28)),
        );
        li.addEventListener('click', (e) => {
          if (e.shiftKey) {
            if (state.selectedIds.has(l.id)) state.selectedIds.delete(l.id);
            else state.selectedIds.add(l.id);
          } else {
            state.selectedIds = new Set([l.id]);
          }
          redraw();
        });
        if (l.locked) li.appendChild(el('span', { class: 'ce-layer-lock', title: 'Locked' }, '🔒'));
        ul.appendChild(li);
      }
      inner.appendChild(ul);
    }

    function loadTemplateSpec(t) {
      if (!t.spec) return;
      cmd('load-template', () => {
        state.template = JSON.parse(JSON.stringify(t.spec));
        for (const l of state.template.layers) l.id = l.id || uid();
        state.selectedIds.clear();
        updateSizeLabel(); syncPresetSelect();
        fitToContainer();
      });
      // Pre-warm any custom fonts referenced by text layers in this
      // template. The curated set is already loaded via injectFont-
      // Stylesheet(); anything else (a font the user typed into the
      // custom input in a previous session) needs an explicit load
      // before redraw or it'll render in the fallback family.
      const known = new Set(FONT_FAMILIES.map((f) => f.value));
      const customFamilies = new Set();
      for (const l of state.template.layers) {
        if (l.kind === 'text' && l.family && !known.has(l.family)) {
          // Extract the first quoted name from the stack, e.g.
          // '"Roboto Slab", sans-serif' → 'Roboto Slab'.
          const m = String(l.family).match(/^"([^"]+)"/) || String(l.family).match(/^([^,]+)/);
          if (m) customFamilies.add(m[1].trim());
        }
      }
      if (customFamilies.size) {
        Promise.all([...customFamilies].map(loadGoogleFont)).then(() => redraw());
      }
    }

    // ── add layer (button or DnD) ────────────────────────────────
    function addLayer(kind, opts = {}) {
      const { width, height } = state.template;
      const base = { id: uid(), kind, x: opts.x ?? 80, y: opts.y ?? 80, locked: false };
      if (kind === 'text') {
        // Defaults first, opts override. Order matters: any opt key
        // present in opts should win, so we spread it last.
        Object.assign(base, {
          w: Math.min(width - 160, 800), h: 200,
          text: '{title}',
          size: 72, family: FONT_FAMILIES[0].value, weight: '700',
          align: 'left', color: '#ffffff', shadow: true, lineHeight: 1.15,
        }, opts);
      } else if (kind === 'box') {
        Object.assign(base, {
          w: opts.w ?? Math.min(width - 160, 800), h: opts.h ?? 250,
          fill: 'rgba(0,0,0,0.55)', radius: 12,
        });
      } else if (kind === 'logo') {
        const w = opts.w ?? 200, h = opts.h ?? 80;
        Object.assign(base, {
          w, h,
          x: opts.x ?? width - w - 40,
          y: opts.y ?? height - h - 40,
          url: opts.url ?? state.assets.logo[0]?.url ?? null,
          asset_id: opts.asset_id ?? null,
        });
      }
      cmd('add-layer', () => {
        state.template.layers.push(base);
        state.selectedIds = new Set([base.id]);
      });
    }

    // ── drag-from-sidebar onto canvas ────────────────────────────
    function bindDnD() {
      canvasWrap.addEventListener('dragover', (e) => {
        if (Array.from(e.dataTransfer?.types || []).includes('application/x-cover-asset')
            || Array.from(e.dataTransfer?.types || []).includes('Files')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      });
      canvasWrap.addEventListener('drop', (e) => {
        const { x, y } = toCanvasCoords(e);
        const payload = e.dataTransfer.getData('application/x-cover-asset');
        if (payload) {
          e.preventDefault();
          try {
            const a = JSON.parse(payload);
            if (a.kind === 'background') {
              cmd('set-bg', () => { state.template.background = { asset_id: a.id, url: a.url }; });
            } else {
              addLayer('logo', { url: a.url, asset_id: a.id, x: Math.round(x - 100), y: Math.round(y - 40) });
            }
          } catch { /* */ }
          return;
        }
        if (e.dataTransfer.files && e.dataTransfer.files.length) {
          e.preventDefault();
          const file = e.dataTransfer.files[0];
          if (!file.type.startsWith('image/')) return;
          // Heuristic: file dropped near a corner → background; else logo.
          const cw = state.template.width, ch = state.template.height;
          const margin = 100;
          const isBg = (x < margin || x > cw - margin || y < margin || y > ch - margin);
          uploadAsset(isBg ? 'background' : 'logo', file).then(() => {
            if (!isBg) {
              // Most-recently-uploaded logo, placed at the drop point.
              const a = state.assets.logo[state.assets.logo.length - 1] || state.assets.logo[0];
              if (a) addLayer('logo', { url: a.url, asset_id: a.id, x: Math.round(x - 100), y: Math.round(y - 40) });
            }
          });
        }
      });
    }

    // ── keyboard ─────────────────────────────────────────────────
    function bindGlobalKeys() {
      const handler = (ev) => {
        // Don't capture while the user is typing in an input.
        if (textEditor) return;
        const target = ev.target;
        const inField = target && (target.matches('input, textarea, select') || target.isContentEditable);
        // Cmd/Ctrl-Z / Cmd-Shift-Z work even inside the editor's inputs.
        const cmdKey = ev.metaKey || ev.ctrlKey;
        if (cmdKey && (ev.key === 'z' || ev.key === 'Z')) {
          if (ev.shiftKey) { redo(); ev.preventDefault(); return; }
          undo(); ev.preventDefault(); return;
        }
        if (cmdKey && (ev.key === 'd' || ev.key === 'D')) {
          if (state.selectedIds.size) { duplicateSelection(); ev.preventDefault(); }
          return;
        }
        if (cmdKey && ev.key === '0') { state.autoFit = true; fitToContainer(); redraw(); ev.preventDefault(); return; }
        if (cmdKey && (ev.key === '=' || ev.key === '+')) { setZoom(state.zoom * 1.25); ev.preventDefault(); return; }
        if (cmdKey && ev.key === '-') { setZoom(state.zoom / 1.25); ev.preventDefault(); return; }
        if (inField) return;
        if ((ev.key === 'Delete' || ev.key === 'Backspace') && state.selectedIds.size) {
          deleteSelection(); ev.preventDefault(); return;
        }
        if (ev.key === 'Escape') { state.selectedIds.clear(); redraw(); return; }
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(ev.key) && state.selectedIds.size) {
          const step = ev.shiftKey ? 10 : 1;
          const dx = (ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0);
          const dy = (ev.key === 'ArrowUp'   ? -step : ev.key === 'ArrowDown'  ? step : 0);
          cmd('nudge', () => {
            for (const l of selectedLayers()) { l.x += dx; l.y += dy; }
          });
          ev.preventDefault();
        }
      };
      // Bound at root only so other admin tabs aren't affected.
      root.addEventListener('keydown', handler);
      root.tabIndex = 0;
      // Also catch global Cmd-Z on document while the editor is mounted.
      const docHandler = (ev) => {
        if (!root.contains(document.activeElement) && document.activeElement !== document.body) return;
        if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'z' || ev.key === 'Z')) {
          handler(ev);
        }
      };
      document.addEventListener('keydown', docHandler);
    }

    // ── upload + load helpers (talk to admin.js's API helper) ───
    function fileToBase64(file) {
      return new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result).replace(/^data:[^;]+;base64,/, ''));
        fr.onerror = () => rej(new Error('read_failed'));
        fr.readAsDataURL(file);
      });
    }

    // Compress an image file to WebP via the browser's canvas API
    // before we send it. Backgrounds get capped at 1600×1600 (more
    // than enough for the OG default 1200×630 plus retina), logos
    // at 600×600. Output WebP at quality 0.82 is roughly 10-15× smaller
    // than an uncompressed PNG at the same dimensions. SVG inputs
    // pass through untouched — they're already lean and rasterising
    // them would lose scalability.
    //
    // Falls back to the original file if anything throws (canvas
    // unavailable, browser doesn't support webp encode, OOM on
    // huge inputs). Honest about the limit: this is best-effort
    // client-side compression; the user can still drop a 50MB PNG
    // through the legacy path if their browser refuses canvas.
    async function compressForUpload(file, kind) {
      // SVG: don't touch.
      if (/svg/i.test(file.type)) return { blob: file, mime: file.type, ext: 'svg' };

      const maxDim = kind === 'background' ? 1600 : 600;
      // Bail on very small files — compressing 30KB → 28KB isn't
      // worth a canvas round trip.
      if (file.size < 80 * 1024 && /webp|jpe?g/i.test(file.type)) {
        return { blob: file, mime: file.type, ext: file.type.includes('jpeg') ? 'jpg' : 'webp' };
      }

      try {
        // Use createImageBitmap to decode off the main thread when
        // possible. Falls back to <img> + load event otherwise.
        let bitmap;
        if (typeof createImageBitmap === 'function') {
          bitmap = await createImageBitmap(file);
        } else {
          const url = URL.createObjectURL(file);
          const img = new Image();
          await new Promise((res, rej) => {
            img.onload = () => res();
            img.onerror = rej;
            img.src = url;
          });
          bitmap = img;
          // Leak the URL on next tick (not strictly necessary; GC will
          // collect, but explicit is cleaner on long-lived editors).
          setTimeout(() => URL.revokeObjectURL(url), 5_000);
        }

        let w = bitmap.width, h = bitmap.height;
        const ratio = Math.min(maxDim / w, maxDim / h, 1);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);

        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, w, h);
        if (typeof bitmap.close === 'function') bitmap.close();

        const blob = await new Promise((resolve, reject) => {
          canvas.toBlob(
            (b) => b ? resolve(b) : reject(new Error('toBlob_null')),
            'image/webp',
            0.82,
          );
        });
        // Sanity check: WebP might be bigger than the original
        // (already-optimised PNGs do this). Use whichever is smaller.
        if (blob.size >= file.size * 0.95) {
          return { blob: file, mime: file.type, ext: file.type.includes('jpeg') ? 'jpg' : file.type.includes('png') ? 'png' : 'bin' };
        }
        return { blob, mime: 'image/webp', ext: 'webp' };
      } catch {
        return { blob: file, mime: file.type, ext: file.type.includes('jpeg') ? 'jpg' : file.type.includes('png') ? 'png' : 'bin' };
      }
    }

    async function uploadAsset(kind, file) {
      // Compress first. Common case: a 2.4MB PNG hero-photo → ~180KB
      // WebP. Worst case (already a small WebP): we no-op and ship
      // the original. notify() surfaces the saving so the user knows
      // their click did something.
      const originalSize = file.size;
      const { blob, mime, ext } = await compressForUpload(file, kind);
      if (blob.size < originalSize * 0.9) {
        const saved = Math.round((1 - blob.size / originalSize) * 100);
        notify(`Compressed ${kind} from ${fmtBytes(originalSize)} to ${fmtBytes(blob.size)} (saved ${saved}%).`, 'good', { duration: 3500 });
      }

      // The server's upload endpoint expects { base64, content_type, filename }.
      // base64-encode the (possibly compressed) blob.
      const buf = await blob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let s = ''; const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      const b64 = btoa(s);

      // Filename: keep the user's name but swap the extension to
      // match the compressed format. helps audit logs read clearly.
      const baseName = (file.name || (kind + '.bin')).replace(/\.[^.]+$/, '');
      const filename = `${baseName}.${ext}`;

      const r = await api('/api/admin/cover/upload', {
        method: 'POST',
        body: JSON.stringify({
          kind,
          filename,
          content_type: mime,
          base64: b64,
        }),
      });
      if (r.body?.ok) {
        await loadAssets();
      }
      return r.body?.asset || null;
    }
    async function loadAssets() {
      const [bgs, logos] = await Promise.all([
        api('/api/admin/cover/upload?kind=background'),
        api('/api/admin/cover/upload?kind=logo'),
      ]);
      state.assets.background = bgs.body?.assets || [];
      state.assets.logo = logos.body?.assets || [];
      // Re-render the uploads rail if it's currently open.
      if (activeRail === 'uploads') renderRailPanel('uploads');
    }
    async function loadTemplates() {
      const { body } = await api('/api/admin/cover/templates');
      state.templates = body?.templates || [];
      if (activeRail === 'templates') renderRailPanel('templates');
    }
    async function loadPosts() {
      const r = await api('/api/admin/blog/list');
      state.posts = (r.body?.posts || []).filter((p) => p.status === 'published').slice(0, 200);
      // The post picker now lives in the header (always visible) AND
      // in the idle context toolbar. Populate whichever is mounted.
      const headerSel = $('#ce-header-post', root);
      if (headerSel) populatePostSelect(headerSel);
      if (selectedLayers().length === 0) renderContextToolbar();
    }

    function populatePostSelect(selectEl) {
      const current = selectEl.value;
      while (selectEl.options.length > 1) selectEl.remove(1);
      for (const p of (state.posts || [])) {
        selectEl.appendChild(el('option', { value: p.id }, p.title.slice(0, 60)));
      }
      // Restore selection if the post still exists.
      if (current && state.posts.some((p) => p.id === current)) selectEl.value = current;
    }

    // Keep header + toolbar pickers in sync. Whichever the user
    // touched is the source of truth; copy to the other so a later
    // read finds the same value.
    function syncHeaderToPreview() {
      const headerSel = $('#ce-header-post', root);
      const toolbarSel = $('#ce-preview-post', root);
      if (headerSel && toolbarSel) toolbarSel.value = headerSel.value;
    }
    function syncPreviewToHeader() {
      const headerSel = $('#ce-header-post', root);
      const toolbarSel = $('#ce-preview-post', root);
      if (headerSel && toolbarSel) headerSel.value = toolbarSel.value;
    }

    // Build the full template context used by the canvas renderer and
    // server-side template engine. Factored out so apply-all can call
    // it once per post without re-fetching settings each iteration.
    // Mirror of functions/_lib/template.js buildBrandContext. We keep
    // them in lockstep so what the editor previews IS what the server
    // renders for real visitors. Any new variable added here must
    // also be added there, and vice versa.
    async function buildPreviewCtx(opts = {}) {
      let settings = opts.settings || {};
      let whoami = opts.whoami || {};
      if (!opts.settings) {
        try { const s = await api('/api/admin/settings'); settings = s.body?.settings || {}; } catch { /* */ }
      }
      if (!opts.whoami) {
        try { const w = await api('/api/admin/whoami'); whoami = w.body || {}; } catch { /* */ }
      }
      const post = opts.post || null;
      const title = opts.title || post?.title || '';

      const pubDate    = post?.published_at ? new Date(post.published_at * 1000) : new Date();
      const updateDate = post?.modified_at  ? new Date(post.modified_at * 1000)
                       : post?.updated_at   ? new Date(post.updated_at * 1000)
                       : pubDate;
      const body  = post?.body_markdown || '';
      const words = body ? body.trim().split(/\s+/).filter(Boolean).length : 0;
      const readMins = Math.max(1, Math.round(words / 220));
      const excerpt = body
        .replace(/^#+\s*/gm, '')
        .replace(/\[(.*?)\]\(.*?\)/g, '$1')
        .replace(/[*_`>]/g, '')
        .replace(/\s+/g, ' ').trim().slice(0, 200);

      const host = (() => { try { return location.host; } catch { return ''; } })();
      const baseUrl = host ? `https://${host}` : (settings.site_url || whoami?.site_url || '');

      return {
        // post
        title,
        slug:            post?.slug || '',
        excerpt,
        keywords:        post?.keywords || '',
        primary_keyword: post?.primary_query || '',
        provider:        post?.ai_provider || '',
        word_count:      words,
        reading_time:    `${readMins} min read`,
        body_chars:      body.length,
        // dates
        pub_date:        pubDate,
        update_date:     updateDate,
        date:            pubDate,
        now:             new Date(),
        pub_date_long:   pubDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
        pub_date_short:  pubDate.toISOString().slice(0, 10),
        pub_year:        String(pubDate.getUTCFullYear()),
        pub_month:       pubDate.toLocaleDateString('en-GB', { month: 'long' }),
        pub_day:         String(pubDate.getUTCDate()),
        pub_dow:         pubDate.toLocaleDateString('en-GB', { weekday: 'long' }),
        today_long:      new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
        today_short:     new Date().toISOString().slice(0, 10),
        year:            String(new Date().getUTCFullYear()),
        // brand
        brand: {
          name:           whoami?.site_name || settings.site_name || 'this site',
          url:            whoami?.site_url  || settings.site_url  || '/',
          domain:         host,
          tagline:        settings.site_tagline || settings.brand_tagline || '',
          cta:            settings.site_cta || '',
          tone:           settings.brand_voice_tone || settings.site_tone || '',
          audience:       settings.brand_target_audience || settings.site_audience || '',
          business_type:  settings.brand_business_type || '',
          service_area:   settings.brand_service_area  || '',
          key_themes:     settings.brand_key_themes    || '',
          topics_to_avoid: settings.brand_topics_to_avoid || '',
          logo_url:       settings.brand_logo_url || '',
          primary_color:  settings.brand_primary_color || '#0a0c10',
          accent_color:   settings.brand_accent_color  || '#d4af62',
        },
        // site
        site: {
          host,
          url:       baseUrl,
          canonical: post?.slug ? `${baseUrl}/blog/${post.slug}` : baseUrl,
          indexnow_key: settings.indexnow_key || '',
        },
        // booleans
        has_image:       !!post?.hero_image_key,
        has_logo:        state.template.layers.some((l) => l.kind === 'logo' && l.url),
        is_blog:         true,
        is_programmatic: false,
      };
    }

    async function refreshPreview() {
      // Title input lives in the idle toolbar; post pickers live in
      // both header and toolbar. Read whichever exists.
      const titleField = ($('#ce-preview-title', root)?.value || '').trim();
      const postId = ($('#ce-header-post', root)?.value || $('#ce-preview-post', root)?.value || '');
      const post = postId ? state.posts.find((p) => p.id === postId) : null;
      const title = titleField || post?.title || '';
      if (!title) {
        state.previewCtx = null; redraw(); return;
      }
      // Keep the two pickers in sync.
      syncPreviewToHeader();
      syncHeaderToPreview();
      state.previewCtx = await buildPreviewCtx({ title, post });
      redraw();
    }

    // ── save / apply dialogs ────────────────────────────────────
    async function openSaveTemplateDialog() {
      const name = prompt('Template name', '');
      if (!name) return;
      const setDefault = confirm('Make this the default template for new posts?');
      const spec = JSON.parse(JSON.stringify(state.template));
      const r = await api('/api/admin/cover/templates', {
        method: 'POST',
        body: JSON.stringify({ name, spec, is_default: setDefault }),
      });
      if (r.body?.ok) {
        await loadTemplates();
        notify('Template saved.', 'good');
      } else {
        notify('Save failed: ' + (r.body?.error || r.status), 'bad', { errorCode: r.body?.error });
      }
    }
    // Render the current template at native canvas resolution into a
    // base64 data URL for a specific post. Pure: doesn't touch the
    // user's selection or trigger a redraw at the end.
    async function renderPostToBase64(post) {
      const savedSel = new Set(state.selectedIds);
      const savedCtx = state.previewCtx;
      state.selectedIds.clear();
      state.previewCtx = await buildPreviewCtx({ post, title: post.title });
      try {
        await drawCanvas();
        const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
        if (!blob) return null;
        const fr = new FileReader();
        return await new Promise((res) => {
          fr.onload = () => res(fr.result);
          fr.readAsDataURL(blob);
        });
      } finally {
        state.selectedIds = savedSel;
        state.previewCtx = savedCtx;
      }
    }

    async function openApplyDialog() {
      const postId = ($('#ce-header-post', root)?.value || $('#ce-preview-post', root)?.value || '');
      if (!postId) { notify('Pick a post in the header dropdown first.', 'warn'); return; }
      const post = state.posts.find((p) => p.id === postId);
      if (!post) return;
      const dataUrl = await renderPostToBase64(post);
      redraw();
      if (!dataUrl) { notify('Render failed.', 'bad'); return; }
      const r = await api('/api/admin/cover/apply', {
        method: 'POST',
        body: JSON.stringify({ target: 'post', id: postId, base64: dataUrl }),
      });
      if (r.body?.ok) {
        notify(`Applied to “${post.title.slice(0, 60)}…”.`, 'good');
      } else {
        notify('Apply failed: ' + (r.body?.error || r.status), 'bad', { errorCode: r.body?.error });
      }
    }

    // Apply the current template to every published post. Renders
    // each one client-side (we don't have server-side rendering yet),
    // posts the resulting PNG, updates a small progress overlay so
    // the user knows what's happening.
    async function openApplyAllDialog() {
      const posts = state.posts || [];
      if (!posts.length) { notify('No published posts to apply to.', 'warn'); return; }
      const ok = confirm(
        `Apply this template to all ${posts.length} published posts? ` +
        `This re-renders every cover and replaces it. Future posts will ` +
        `also use this template if you set "Hero image mode" to "cover" ` +
        `in Settings (and pick this template as default).`
      );
      if (!ok) return;

      const overlay = el('div', { class: 'ce-apply-overlay' },
        el('div', { class: 'ce-apply-card' },
          el('h3', null, 'Applying template…'),
          (() => { const p = el('p', { class: 'ce-apply-status' }, 'Starting…'); return p; })(),
          el('div', { class: 'ce-apply-bar' }, el('div', { class: 'ce-apply-bar-fill' })),
        ),
      );
      document.body.appendChild(overlay);
      const status = $('.ce-apply-status', overlay);
      const barFill = $('.ce-apply-bar-fill', overlay);

      // Pre-fetch settings + whoami once; pass into each iteration so
      // we don't pay the round-trip per post.
      let settings = {}, whoami = {};
      try { settings = (await api('/api/admin/settings')).body?.settings || {}; } catch { /* */ }
      try { whoami = (await api('/api/admin/whoami')).body || {}; } catch { /* */ }

      let okCount = 0, failCount = 0;
      const errors = [];

      for (let i = 0; i < posts.length; i++) {
        const post = posts[i];
        status.textContent = `(${i + 1}/${posts.length}) ${post.title.slice(0, 70)}`;
        barFill.style.width = `${((i + 1) / posts.length) * 100}%`;

        try {
          const savedSel = new Set(state.selectedIds);
          const savedCtx = state.previewCtx;
          state.selectedIds.clear();
          state.previewCtx = await buildPreviewCtx({ post, title: post.title, settings, whoami });
          await drawCanvas();
          state.selectedIds = savedSel;
          state.previewCtx = savedCtx;

          const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
          if (!blob) { failCount++; errors.push(`${post.slug}: blob_null`); continue; }
          const fr = new FileReader();
          const dataUrl = await new Promise((res) => { fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });

          const r = await api('/api/admin/cover/apply', {
            method: 'POST',
            body: JSON.stringify({ target: 'post', id: post.id, base64: dataUrl }),
          });
          if (r.body?.ok) okCount++;
          else { failCount++; errors.push(`${post.slug}: ${r.body?.error || r.status}`); }
        } catch (e) {
          failCount++;
          errors.push(`${post.slug}: ${String(e?.message || e).slice(0, 80)}`);
        }
      }

      // Also: try to make sure future posts use this template too.
      // Two things to do (best-effort, non-blocking):
      //   1. Save the current template as default (if not already).
      //   2. Set hero_image_mode = 'cover' in settings.
      try {
        const def = state.templates.find((t) => t.is_default);
        if (!def) {
          await api('/api/admin/cover/templates', {
            method: 'POST',
            body: JSON.stringify({ name: 'main', spec: state.template, is_default: true }),
          });
          await loadTemplates();
        }
        // Settings PUT takes a flat { key: value } body; setting
        // hero_image_mode='cover' here means future blog jobs will
        // try the server-side renderer first (and fall back to AI
        // until that's implemented — see blog/image.js).
        await api('/api/admin/settings', {
          method: 'PUT',
          body: JSON.stringify({ hero_image_mode: 'cover' }),
        });
      } catch { /* non-fatal */ }

      // Redraw the editor canvas with whatever the user had selected
      // before, so the workspace state is restored.
      redraw();

      status.textContent = `Done: ${okCount} applied, ${failCount} failed.`;
      barFill.style.width = '100%';
      // Allow the user to read the result; click to dismiss.
      overlay.addEventListener('click', () => overlay.remove(), { once: true });
      const dismiss = el('button', { class: 'ce-btn',
        style: { marginTop: '14px' },
        onclick: () => overlay.remove() },
        failCount ? 'Close' : 'Done',
      );
      $('.ce-apply-card', overlay).appendChild(dismiss);
      if (errors.length) {
        const det = el('details', { style: { marginTop: '10px', fontSize: '11px', color: 'var(--ink-dim)' } },
          el('summary', null, `${errors.length} errors — show`),
          el('pre', { style: { whiteSpace: 'pre-wrap', maxHeight: '200px', overflow: 'auto' } }, errors.join('\n')),
        );
        $('.ce-apply-card', overlay).appendChild(det);
      }
    }

    // ── misc helpers ────────────────────────────────────────────
    function hexOnly(s) {
      const m = String(s || '#ffffff').match(/^#?([0-9a-f]{6})/i);
      return m ? '#' + m[1] : '#ffffff';
    }
    function parseAlpha(s, fallback) {
      const m = String(s || '').match(/rgba\([^)]*?,\s*([0-9.]+)\s*\)/);
      return m ? parseFloat(m[1]) : fallback;
    }
    function hexToRgba(hex, a) {
      const m = String(hex).match(/^#?([0-9a-f]{6})$/i);
      const alpha = clamp(parseFloat(a) || 0, 0, 1);
      if (!m) return `rgba(0,0,0,${alpha})`;
      const n = parseInt(m[1], 16);
      const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    function clamp(n, lo, hi) {
      n = parseFloat(n);
      if (isNaN(n)) n = lo;
      return Math.min(hi, Math.max(lo, n));
    }
    function fmtBytes(n) {
      if (!Number.isFinite(n)) return '?';
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
      return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }

    // ── public-ish: load + apply default template from server ──
    async function bootstrap() {
      await Promise.all([loadAssets(), loadTemplates(), loadPosts()]);
      // Auto-load default template if one exists.
      const def = state.templates.find((t) => t.is_default);
      if (def && def.spec) loadTemplateSpec(def);
      else redraw();
    }

    // ── public surface ─────────────────────────────────────────
    return {
      init: (opts) => {
        init(opts);
        bootstrap();
      },
      // Allow admin.js to re-run bootstrap on tab activation.
      refresh: bootstrap,
      get state() { return state; },
    };
  }

  // Expose singleton.
  window.CoverEditor = CoverEditor();
})();
