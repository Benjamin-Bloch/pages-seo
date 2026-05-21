// Layer-spec → SVG renderer.
//
// Same layer schema the browser editor produces (text / box / logo).
// Rendered server-side as SVG (the Workers runtime has no canvas);
// the SVG is sent to the client where the browser rasterizes it,
// the OG card scraper rasterizes it, or Twitter/Facebook caches a
// rasterized version.
//
// Key differences vs canvas rendering:
//
//   - Web fonts have to be requested by the BROWSER (or the OG
//     scraper) — we just reference them by family. The SVG <style>
//     block declares an @import from fonts.googleapis.com so a
//     fresh paint loads the right font. Google's OG previewer does
//     execute the @import and pick up the right typography; some
//     older scrapers don't and fall back to the family stack.
//
//   - Text wrapping isn't automatic. We measure char widths heuristic-
//     ally and break at word boundaries to fit the layer width. The
//     measurements aren't pixel-perfect (the browser does the real
//     layout) but they're close enough that titles don't overflow.
//
//   - Rotation is applied via a transform on the group, not a per-
//     layer matrix.

import { renderTemplate } from './template.js';

// SVG-attribute XML escape. NOT the same as HTML escape — we need to
// quote the five XML entities. Caller is responsible for ensuring
// strings going into class/font-family/href are safe.
function xml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

// Greedy word-wrap given an approximate "characters per line" budget.
// We compute that from the layer's pixel width and the font size,
// using a rough 0.55 em-width-per-character heuristic (works well for
// most proportional fonts at heading sizes).
function wrapText(text, fontSize, layerWidthPx, maxLines = 6) {
  const charBudget = Math.max(8, Math.floor(layerWidthPx / (fontSize * 0.55)));
  const lines = [];
  for (const para of String(text).split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(''); continue; }
    let line = '';
    for (const w of words) {
      const trial = line ? line + ' ' + w : w;
      if (trial.length <= charBudget) line = trial;
      else {
        if (line) lines.push(line);
        line = w;
        if (lines.length >= maxLines) break;
      }
    }
    if (line && lines.length < maxLines) lines.push(line);
  }
  // Add ellipsis if we ran out of room.
  if (lines.length >= maxLines) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S{1,8}$/, '') + '…';
  }
  return lines.slice(0, maxLines);
}

// Extract the first quoted family from a CSS family stack so we can
// declare an @import for it. Returns '' for system stacks where no
// @import is needed.
function googleFontFamily(stack) {
  const m = String(stack || '').match(/"([^"]+)"/);
  if (!m) return '';
  const fam = m[1].trim();
  // Skip families that are guaranteed to be in the system or aren't
  // on Google Fonts.
  if (/^(Times New Roman|Helvetica Neue|Courier New|Trebuchet MS|Arial|Impact)$/i.test(fam)) return '';
  return fam;
}

// Convert a hex/rgba colour into a string SVG accepts. SVG accepts
// CSS-style rgba() and hex directly, so we mostly pass through.
function colour(v) {
  if (!v) return '#000';
  return String(v);
}

// Convert a /image/<key> URL to its R2 key. Mirrors upload.js's
// imageUrlFor() in reverse: the path encodes each segment, so we
// decode segment-by-segment to recover the literal '/' separators.
function urlToR2Key(url) {
  return String(url || '')
    .replace(/^\/image\//, '')
    .split('/')
    .map(decodeURIComponent)
    .join('/');
}

// Detect references that need inlining for <img>-loaded SVG to
// render correctly. Anything starting with /image/ is a local R2
// asset; everything else (http://, data:, etc.) passes through
// unchanged.
function needsInlining(href) {
  return typeof href === 'string' && href.startsWith('/image/');
}

// Pull bytes from R2 + base64-encode into a data URL. Returns the
// original href on any failure so the SVG is still well-formed.
async function inlineFromR2(href, env) {
  if (!env?.IMAGES) return href;
  const key = urlToR2Key(href);
  if (!key) return href;
  try {
    const obj = await env.IMAGES.get(key);
    if (!obj) return href;
    const buf = await obj.arrayBuffer();
    // Chunked base64 — atob/btoa limits at ~65k arg length, so we
    // batch through fromCharCode.apply to stay safe on large
    // backgrounds.
    const bytes = new Uint8Array(buf);
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    const b64 = btoa(s);
    const mime = obj.httpMetadata?.contentType || 'image/png';
    return `data:${mime};base64,${b64}`;
  } catch {
    return href;
  }
}

// Walk a spec and inline every R2-referenced asset URL (background
// + each logo). Returns a Map<original_url, data_url> the layer
// renderer consults via getInlined(href).
async function buildInlineMap(spec, env) {
  const out = new Map();
  if (!env) return out;
  const urls = new Set();
  if (needsInlining(spec?.background?.url)) urls.add(spec.background.url);
  for (const l of (spec?.layers || [])) {
    if (l?.kind === 'logo' && needsInlining(l.url)) urls.add(l.url);
  }
  if (!urls.size) return out;
  const arr = [...urls];
  const resolved = await Promise.all(arr.map((u) => inlineFromR2(u, env)));
  arr.forEach((u, i) => out.set(u, resolved[i]));
  return out;
}

// Render one layer as an SVG fragment.
function renderLayer(layer, ctx, inlined) {
  const opacity = layer.opacity != null ? layer.opacity : 1;
  const rot = layer.rotation || 0;
  const cx = layer.x + layer.w / 2;
  const cy = layer.y + layer.h / 2;
  const transform = rot ? ` transform="rotate(${rot} ${cx} ${cy})"` : '';
  const opAttr = opacity < 1 ? ` opacity="${opacity}"` : '';

  if (layer.kind === 'box') {
    const fill = colour(layer.fill || 'rgba(0,0,0,0.55)');
    const r = layer.radius || 0;
    return `<rect x="${layer.x}" y="${layer.y}" width="${layer.w}" height="${layer.h}" rx="${r}" ry="${r}" fill="${xml(fill)}"${opAttr}${transform}/>`;
  }

  if (layer.kind === 'text') {
    const fontSize = layer.size || 60;
    const family   = layer.family || 'system-ui, sans-serif';
    const weight   = layer.weight || '600';
    const italic   = layer.italic ? 'italic' : 'normal';
    const align    = layer.align || 'left';
    const color    = colour(layer.color || '#ffffff');
    const lineH    = fontSize * (layer.lineHeight || 1.15);

    // Expand tokens in the text string against the context.
    const display  = renderTemplate(layer.text || '', ctx);
    const lines    = wrapText(display, fontSize, layer.w);

    // text-anchor maps from CSS text-align.
    const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
    const anchorX = align === 'center' ? (layer.x + layer.w / 2)
                  : align === 'right'  ? (layer.x + layer.w)
                  : layer.x;

    // Drop shadow: SVG supports the same shadow-blur via <filter>.
    // We define an inline filter per text layer that wants shadow.
    const shadowId = layer.shadow ? `shadow-${Math.random().toString(36).slice(2, 8)}` : '';
    const shadowDef = layer.shadow ? `
  <defs>
    <filter id="${shadowId}" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="2" stdDeviation="${(layer.shadowBlur != null ? layer.shadowBlur : 8) / 2}" flood-color="${xml(layer.shadowColor || 'rgba(0,0,0,0.6)')}"/>
    </filter>
  </defs>` : '';
    const filterAttr = shadowId ? ` filter="url(#${shadowId})"` : '';

    const tspans = lines.map((line, i) =>
      `<tspan x="${anchorX}" dy="${i === 0 ? 0 : lineH}">${xml(line)}</tspan>`
    ).join('');

    return `${shadowDef}<text x="${anchorX}" y="${layer.y + fontSize * 0.85}"
  font-family="${xml(family)}"
  font-size="${fontSize}"
  font-weight="${xml(weight)}"
  font-style="${italic}"
  fill="${xml(color)}"
  text-anchor="${anchor}"${opAttr}${filterAttr}${transform}>${tspans}</text>`;
  }

  if (layer.kind === 'logo' && layer.url) {
    // SVG <image> takes href + preserveAspectRatio. We use xMidYMid
    // meet so the logo scales to fit without distortion (same as the
    // canvas renderer's Math.min(w/iw, h/ih) cover-fit).
    //
    // Critical: when the SVG itself is loaded via <img src=…> on a
    // post page, browsers DO NOT fetch external resources from
    // inside the SVG. R2-hosted assets (/image/…) appear blank.
    // Resolve to the data URL we baked in via buildInlineMap()
    // when one's available; otherwise pass through the original
    // URL so the SVG at least renders when loaded as a DOM
    // document.
    const href = (inlined && inlined.get(layer.url)) || layer.url;
    return `<image href="${xml(href)}" x="${layer.x}" y="${layer.y}" width="${layer.w}" height="${layer.h}" preserveAspectRatio="xMidYMid meet"${opAttr}${transform}/>`;
  }

  return '';
}

// Public entry. Renders the entire template against ctx and returns
// a self-contained SVG document string.
//
// spec — the cover_template spec_json (parsed): { width, height,
//        background, layers: [...], __official?, __version? }
// ctx  — template context (see buildBrandContext in template.js)
// env  — optional Cloudflare env binding. When provided, R2-hosted
//        backgrounds + logos are fetched and base64-inlined into
//        the SVG so the cover renders correctly when the SVG is
//        loaded via <img src=…> (which browsers sandbox from
//        fetching external resources).
//
// Returns a Promise<string> of the SVG document, ready to send
// with content-type: image/svg+xml.
export async function renderCoverSvg(spec, ctx, env) {
  const W = spec?.width  || 1200;
  const H = spec?.height || 630;
  const layers = Array.isArray(spec?.layers) ? spec.layers : [];

  // Pre-fetch every R2-hosted asset and base64 it. The result map
  // (original URL → data URL) is consulted by the background +
  // logo renderers. Tiny perf hit at render time but the response
  // is edge-cached for an hour, so this only fires once per slug
  // per colo per cache cycle.
  const inlined = await buildInlineMap(spec, env);

  // Collect unique Google Fonts referenced by text layers.
  const families = new Set();
  for (const l of layers) {
    if (l.kind === 'text') {
      const fam = googleFontFamily(l.family);
      if (fam) families.add(fam);
    }
  }
  // Compose the @import URL. fonts.googleapis.com supports loading
  // multiple families in one stylesheet — concatenate with &.
  const fontImport = families.size
    ? '@import url("https://fonts.googleapis.com/css2?' +
      [...families].map((f) =>
        `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@300;400;500;600;700;800`
      ).join('&') + '&display=swap");'
    : '';

  // Background. Either an asset URL (covers the whole viewport) or a
  // solid colour from the first 'backdrop' box layer if present.
  // Same inlining caveat as logos: when the SVG is rendered via
  // <img src=…>, an external href won't fetch. We swap in the data
  // URL from the inline map when available.
  let backgroundEl = '';
  if (spec?.background?.url) {
    const bgHref = inlined.get(spec.background.url) || spec.background.url;
    backgroundEl = `<image href="${xml(bgHref)}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>`;
  } else {
    // Fall back to a near-black backdrop so transparent text doesn't
    // render on a transparent canvas.
    backgroundEl = `<rect x="0" y="0" width="${W}" height="${H}" fill="#0a0c10"/>`;
  }

  const layerEls = layers.map((l) => renderLayer(l, ctx, inlined)).filter(Boolean).join('\n  ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <style>${fontImport}</style>
  ${backgroundEl}
  ${layerEls}
</svg>`;
}
