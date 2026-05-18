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
  escape:   (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  date:     (v, fmt) => {
    // v is expected to be a Date or anything Date can parse; falls back
    // to "now" when v is empty. fmt accepts a tiny set of tokens:
    //   YYYY MM DD HH mm  for numeric values
    //   long  (e.g. "18 May 2026")
    //   short (e.g. "2026-05-18")
    const d = v ? new Date(v) : new Date();
    if (isNaN(d.getTime())) return '';
    const fmt2 = String(fmt || 'short');
    if (fmt2 === 'long') {
      return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    }
    if (fmt2 === 'short') return d.toISOString().slice(0, 10);
    return fmt2
      .replace(/YYYY/g, d.getUTCFullYear())
      .replace(/MM/g, String(d.getUTCMonth() + 1).padStart(2, '0'))
      .replace(/DD/g, String(d.getUTCDate()).padStart(2, '0'))
      .replace(/HH/g, String(d.getUTCHours()).padStart(2, '0'))
      .replace(/mm/g, String(d.getUTCMinutes()).padStart(2, '0'));
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

// Build a normalised "brand context" object from settings + per-request
// extras. This is the shape both the prompt builders and the cover
// editor see, so the same `{brand.name}` works in both places.
export function buildBrandContext({ env, settings, post, extras }) {
  return {
    title: post?.title || '',
    primary_keyword: post?.primary_query || post?.keyword || '',
    slug: post?.slug || '',
    provider: post?.ai_provider || '',
    has_image: !!post?.hero_image_key,
    date: new Date(),
    brand: {
      name:           env?.SITE_NAME || 'this site',
      url:            env?.SITE_URL  || '/',
      cta:            settings?.site_cta || '',
      tone:           settings?.brand_voice_tone || settings?.site_tone || '',
      audience:       settings?.brand_target_audience || settings?.site_audience || '',
      business_type:  settings?.brand_business_type || '',
      service_area:   settings?.brand_service_area || '',
      key_themes:     settings?.brand_key_themes || '',
      topics_to_avoid: settings?.brand_topics_to_avoid || '',
    },
    ...(extras || {}),
  };
}
