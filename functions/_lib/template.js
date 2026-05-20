// Templating engine for cover layers + prompt blocks.
//
// Syntax:
//   { field }                  → looked up in the context
//   { a.b.c }                  → nested path
//   { name | filter }          → filter
//   { name | filter:arg }      → filter with literal arg (string or number)
//   { name | filter:'arg' }    → filter with quoted string arg
//   { if path } ... { /if }    → keep contents when path is truthy
//   { if !path } ... { /if }   → keep contents when path is falsy
//
// The engine is intentionally tiny: no &&/||, no else, no loops. If you
// need composition, write two ifs. Brace whitespace is allowed
// (`{ title }` and `{title}` both work). Filters chain: `{x|a|b:2|c}`.
//
// Unknown filters pass through unchanged. Unknown fields render as
// empty string. This is deliberate: a template authored against an
// older catalogue keeps working even if a field is removed.

const FILTERS = {
  upper:    (v) => String(v ?? '').toUpperCase(),
  lower:    (v) => String(v ?? '').toLowerCase(),
  title:    (v) => String(v ?? '').replace(/\w\S*/g, (t) => t[0].toUpperCase() + t.slice(1).toLowerCase()),
  // capitalize ≠ title: only the first letter of the whole string.
  capitalize: (v) => {
    const s = String(v ?? '');
    return s ? s[0].toUpperCase() + s.slice(1) : '';
  },
  truncate: (v, n) => {
    const s = String(v ?? '');
    const max = parseInt(n, 10) || 60;
    return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
  },
  default:  (v, fallback) => {
    const s = String(v ?? '').trim();
    return s ? v : (fallback ?? '');
  },
  slug:     (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
  // kebab and snake are common asks (CSS class names, file names).
  kebab:    (v) => String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
  snake:    (v) => String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
  escape:   (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  trim:     (v) => String(v ?? '').trim(),
  // first_word — quick way to extract the first word for a tag chip etc.
  first_word: (v) => String(v ?? '').trim().split(/\s+/)[0] || '',
  // domain — strip protocol + path from a URL. Useful for footer credit.
  domain:   (v) => {
    try { return new URL(String(v ?? '')).hostname.replace(/^www\./, ''); }
    catch { return String(v ?? '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0]; }
  },
  // ordinal — turn a number into "1st", "2nd", etc.
  ordinal:  (v) => {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return String(v ?? '');
    const s = ['th', 'st', 'nd', 'rd'];
    const v100 = n % 100;
    return n + (s[(v100 - 20) % 10] || s[v100] || s[0]);
  },
  // pad — left-pad with zeros, useful for date components.
  pad:      (v, n) => String(v ?? '').padStart(parseInt(n, 10) || 2, '0'),
  // number_format — thousand separators with locale-aware grouping.
  number_format: (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n.toLocaleString('en-US') : String(v ?? '');
  },
  // pluralize — "{n|pluralize:'post'}" → "1 post" / "2 posts".
  // arg can be 'noun' or 'noun:plural' for irregulars.
  pluralize: (v, arg) => {
    const n = Number(v);
    const [singular, plural] = String(arg || '').split(':');
    const word = (Math.abs(n) === 1) ? (singular || '')
                                     : (plural || (singular ? singular + 's' : ''));
    return Number.isFinite(n) ? `${n} ${word}` : String(v ?? '');
  },
  // replace — '{title|replace:"old:new"}'. Colon-separated to fit the
  // existing single-arg syntax; we split on the first colon.
  replace:  (v, arg) => {
    if (!arg) return String(v ?? '');
    const idx = arg.indexOf(':');
    if (idx < 0) return String(v ?? '');
    const from = arg.slice(0, idx);
    const to   = arg.slice(idx + 1);
    return String(v ?? '').split(from).join(to);
  },
  prepend:  (v, s) => (s || '') + String(v ?? ''),
  append:   (v, s) => String(v ?? '') + (s || ''),
  // read_time — estimate reading time from a body of text. 220wpm is
  // the common content-marketing assumption. arg is the suffix to
  // append (' min read' by default).
  read_time: (v, arg) => {
    const words = String(v ?? '').trim().split(/\s+/).filter(Boolean).length;
    const mins = Math.max(1, Math.round(words / 220));
    return `${mins}${arg ? arg : ' min read'}`;
  },
  // word_count — explicit count of whitespace-separated tokens.
  word_count: (v) => {
    return String(v ?? '').trim().split(/\s+/).filter(Boolean).length;
  },
  date:     (v, fmt) => {
    // v is expected to be a Date or anything Date can parse; falls back
    // to "now" when v is empty. fmt accepts:
    //   long      → "18 May 2026"
    //   short     → "2026-05-18"
    //   medium    → "18 May 2026"   (alias for long for compat)
    //   us        → "May 18, 2026"
    //   iso       → "2026-05-18T09:34:55.000Z"
    //   relative  → "3 days ago" / "in 2 hours"
    //   year      → "2026"
    //   month     → "May"
    //   day       → "18"
    //   dow       → "Wednesday"
    //   <template> → any string with YYYY MM DD HH mm DOW tokens
    const d = v ? new Date(v) : new Date();
    if (isNaN(d.getTime())) return '';
    const fmt2 = String(fmt || 'short');
    if (fmt2 === 'long' || fmt2 === 'medium') {
      return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    }
    if (fmt2 === 'short') return d.toISOString().slice(0, 10);
    if (fmt2 === 'us') {
      return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    }
    if (fmt2 === 'iso') return d.toISOString();
    if (fmt2 === 'year') return String(d.getUTCFullYear());
    if (fmt2 === 'month') return d.toLocaleDateString('en-GB', { month: 'long' });
    if (fmt2 === 'day') return String(d.getUTCDate());
    if (fmt2 === 'dow') return d.toLocaleDateString('en-GB', { weekday: 'long' });
    if (fmt2 === 'relative') {
      const diffSec = (Date.now() - d.getTime()) / 1000;
      const abs = Math.abs(diffSec);
      const past = diffSec >= 0;
      const pick = (n, unit) => {
        const rounded = Math.round(n);
        const word = unit + (rounded === 1 ? '' : 's');
        return past ? `${rounded} ${word} ago` : `in ${rounded} ${word}`;
      };
      if (abs < 60) return past ? 'just now' : 'in a moment';
      if (abs < 3600) return pick(abs / 60, 'minute');
      if (abs < 86400) return pick(abs / 3600, 'hour');
      if (abs < 86400 * 30) return pick(abs / 86400, 'day');
      if (abs < 86400 * 365) return pick(abs / (86400 * 30), 'month');
      return pick(abs / (86400 * 365), 'year');
    }
    return fmt2
      .replace(/YYYY/g, d.getUTCFullYear())
      .replace(/MM/g, String(d.getUTCMonth() + 1).padStart(2, '0'))
      .replace(/DD/g, String(d.getUTCDate()).padStart(2, '0'))
      .replace(/HH/g, String(d.getUTCHours()).padStart(2, '0'))
      .replace(/mm/g, String(d.getUTCMinutes()).padStart(2, '0'))
      .replace(/DOW/g, d.toLocaleDateString('en-GB', { weekday: 'long' }));
  },
};

// Walk a dot-path through the context. Returns undefined on miss.
function lookup(ctx, path) {
  if (!path) return undefined;
  const parts = path.split('.');
  let cur = ctx;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

// Parse a single expression like `name | f1 | f2:'arg'` into
// { path, filters: [{ name, arg }] }.
function parseExpr(raw) {
  const parts = raw.split('|').map((s) => s.trim());
  const path = parts.shift();
  const filters = parts.map((p) => {
    const colon = p.indexOf(':');
    if (colon < 0) return { name: p.trim(), arg: undefined };
    const name = p.slice(0, colon).trim();
    let arg = p.slice(colon + 1).trim();
    const qm = arg.match(/^['"](.*)['"]$/);
    if (qm) arg = qm[1];
    return { name, arg };
  });
  return { path, filters };
}

function applyFilters(value, filters) {
  let v = value;
  for (const f of filters) {
    const fn = FILTERS[f.name];
    if (typeof fn !== 'function') continue; // unknown filter → pass through
    try { v = fn(v, f.arg); } catch { /* swallow filter errors */ }
  }
  return v;
}

// Truthy semantics: '', null, undefined, 0, false, '0', 'false', NaN → false.
function truthy(v) {
  if (v == null) return false;
  if (v === false || v === 0) return false;
  if (typeof v === 'string') {
    const s = v.trim();
    return !!s && s !== '0' && s.toLowerCase() !== 'false';
  }
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

// First pass: handle conditionals. Greedy match `{ if X } … { /if }`.
// We allow nesting by repeated passes until no more matches.
function expandConditionals(input, ctx) {
  const re = /\{\s*if\s+(!)?\s*([a-zA-Z_][\w.]*)\s*\}([\s\S]*?)\{\s*\/if\s*\}/;
  let out = input;
  // Cap iterations so a pathological template can't loop forever.
  for (let i = 0; i < 100; i++) {
    const m = out.match(re);
    if (!m) break;
    const negate = m[1] === '!';
    const path = m[2];
    const inner = m[3];
    const v = lookup(ctx, path);
    const keep = truthy(v) !== negate ? inner : '';
    out = out.slice(0, m.index) + keep + out.slice(m.index + m[0].length);
  }
  return out;
}

// Second pass: replace `{ expr }` with the resolved + filtered value.
function expandTokens(input, ctx) {
  return input.replace(/\{\s*([^{}|][^{}]*?)\s*\}/g, (full, raw) => {
    // Skip `if` / `/if` blocks — they should already be gone after the
    // first pass, but if a malformed one slips through, leave it.
    if (/^\s*(if\s+|\/if)/i.test(raw)) return full;
    const { path, filters } = parseExpr(raw);
    const v = lookup(ctx, path);
    const final = applyFilters(v, filters);
    return final == null ? '' : String(final);
  });
}

// Public entry point. Pass any plain object as context.
export function renderTemplate(template, ctx = {}) {
  if (template == null) return '';
  let s = String(template);
  s = expandConditionals(s, ctx);
  s = expandTokens(s, ctx);
  return s;
}

// Build a normalised template context for cover layers + prompt blocks.
// The same shape powers both the server-side cover renderer
// (functions/_lib/cover_svg.js) and the browser editor's preview, so
// every variable that works in one works in the other.
//
// Field catalogue (top-level unless noted):
//
//   Post identity
//     title, slug, excerpt, keywords, primary_keyword, provider
//     word_count, reading_time ("X min read"), body_chars
//
//   Dates (every date field is a Date object; pipe through |date:fmt)
//     pub_date   — when the post went live
//     update_date — last modified
//     date        — alias for pub_date (legacy templates)
//     now         — render time
//
//   Convenience date shortcuts (pre-formatted strings)
//     pub_date_long  ("18 May 2026")
//     pub_date_short ("2026-05-18")
//     pub_year       ("2026")
//     today_long, today_short, year
//
//   Brand (from env + settings)
//     brand.name, brand.url, brand.tagline, brand.cta,
//     brand.tone, brand.audience, brand.business_type,
//     brand.service_area, brand.key_themes, brand.topics_to_avoid,
//     brand.logo_url, brand.primary_color, brand.accent_color,
//     brand.domain (host only, no scheme)
//
//   Site identity
//     site.host, site.url, site.canonical, site.total_posts
//
//   Booleans (for {if X})
//     has_image, has_logo, is_blog, is_programmatic
//
//   Any caller-supplied extras override built-ins by being spread last.
export function buildBrandContext({ env, settings, post, request, extras, kind } = {}) {
  const pubDate    = post?.published_at ? new Date(post.published_at * 1000) : null;
  const updateDate = post?.modified_at ? new Date(post.modified_at * 1000)
                   : post?.updated_at  ? new Date(post.updated_at * 1000)
                   : pubDate;
  const body = post?.body_markdown || '';
  const words = body ? body.trim().split(/\s+/).filter(Boolean).length : 0;
  const readingMins = Math.max(1, Math.round(words / 220));

  // Host derivation — request URL when available, else SITE_URL env.
  let host = '';
  try { host = request ? new URL(request.url).hostname : new URL(env?.SITE_URL || '').hostname; }
  catch { host = ''; }
  const baseUrl = host ? `https://${host}` : (env?.SITE_URL || '');
  const canonical = post?.urlPath ? `${baseUrl}${post.urlPath}` : baseUrl;

  // Excerpt — first 200 chars of body with markdown stripped to plain
  // text. Good enough for a hero subtitle.
  const excerpt = body
    .replace(/^#+\s*/gm, '')              // strip leading hashes
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')   // unwrap inline links
    .replace(/[*_`>]/g, '')               // strip markdown decorations
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

  // Brand colours — settings might encode them; fall back to a sane
  // monochrome scheme so {brand.primary_color} always resolves.
  const brandDomain = (() => {
    try { return host || new URL(env?.SITE_URL || '').hostname.replace(/^www\./, ''); }
    catch { return ''; }
  })();

  return {
    // ── post identity ──
    title:           post?.title || '',
    slug:            post?.slug || '',
    excerpt,
    keywords:        post?.keywords || '',
    primary_keyword: post?.primary_query || post?.keyword || '',
    provider:        post?.ai_provider || '',
    word_count:      words,
    reading_time:    `${readingMins} min read`,
    body_chars:      body.length,

    // ── dates ──
    // The raw Date is preferred — templates do `{pub_date|date:long}`.
    // pre-formatted aliases below cover the common cases.
    pub_date:        pubDate || new Date(),
    update_date:     updateDate || new Date(),
    date:            pubDate || new Date(),   // legacy alias
    now:             new Date(),
    pub_date_long:   pubDate ? pubDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '',
    pub_date_short:  pubDate ? pubDate.toISOString().slice(0, 10) : '',
    pub_year:        pubDate ? String(pubDate.getUTCFullYear()) : '',
    pub_month:       pubDate ? pubDate.toLocaleDateString('en-GB', { month: 'long' }) : '',
    pub_day:         pubDate ? String(pubDate.getUTCDate()) : '',
    pub_dow:         pubDate ? pubDate.toLocaleDateString('en-GB', { weekday: 'long' }) : '',
    today_long:      new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    today_short:     new Date().toISOString().slice(0, 10),
    year:            String(new Date().getUTCFullYear()),

    // ── brand ──
    brand: {
      name:           env?.SITE_NAME || settings?.site_name || 'this site',
      url:            env?.SITE_URL  || settings?.site_url  || '/',
      domain:         brandDomain,
      tagline:        settings?.site_tagline || settings?.brand_tagline || '',
      cta:            settings?.site_cta || '',
      tone:           settings?.brand_voice_tone || settings?.site_tone || '',
      audience:       settings?.brand_target_audience || settings?.site_audience || '',
      business_type:  settings?.brand_business_type || '',
      service_area:   settings?.brand_service_area || '',
      key_themes:     settings?.brand_key_themes || '',
      topics_to_avoid: settings?.brand_topics_to_avoid || '',
      logo_url:       env?.SITE_LOGO_URL || settings?.brand_logo_url || '',
      primary_color:  settings?.brand_primary_color || '#0a0c10',
      accent_color:   settings?.brand_accent_color  || '#d4af62',
    },

    // ── site ──
    site: {
      host,
      url:       baseUrl,
      canonical,
      indexnow_key: settings?.indexnow_key || '',
    },

    // ── booleans ──
    has_image:       !!post?.hero_image_key,
    has_logo:        !!(env?.SITE_LOGO_URL || settings?.brand_logo_url),
    is_blog:         kind === 'blog',
    is_programmatic: kind === 'programmatic' || kind === 'prog',

    ...(extras || {}),
  };
}
