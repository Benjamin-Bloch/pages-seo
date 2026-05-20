// /og/<slug>.svg
//
// Dynamic Open-Graph image generator for posts that don't have a
// hero_image_key. Returns an SVG at 1200×630 (the OG default size)
// with the post's title and the brand name baked in.
//
// Why SVG instead of PNG: Cloudflare Workers don't have a 2D canvas
// API, so generating a PNG would need WASM (satori + resvg-wasm).
// SVG is text — we can build it from a string template, no
// dependencies. Twitter/X, LinkedIn, Discord, Slack and Facebook all
// accept SVG og:image (Facebook rasterizes server-side). The PNG
// path remains the only blocker for the handful of platforms that
// don't yet accept SVG, and is the existing /api/admin/cover/render-
// server stub's eventual job.
//
// Slug rules: a-z 0-9 dashes only, length ≤ 200. We look the post up
// in both blog_posts and prog_pages — falling back to a generic
// title if not found, so social cards still render for arbitrary
// URLs (e.g. shared 404 links don't break the link unfurler).

import { esc } from '../_lib/util.js';

const W = 1200, H = 630;

function brand(env) {
  return {
    name: env?.SITE_NAME || 'pages-seo',
    description: env?.SITE_DESCRIPTION || '',
  };
}

// Break long titles into ≤3 lines of approximately equal width.
// SVG <text> doesn't do automatic wrapping, so we do a greedy break
// at word boundaries with a rough character budget per line.
function wrapTitle(title, maxCharsPerLine, maxLines) {
  const words = String(title || '').split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let line = '';
  for (const w of words) {
    const trial = line ? line + ' ' + w : w;
    if (trial.length <= maxCharsPerLine) {
      line = trial;
    } else {
      if (line) lines.push(line);
      line = w;
      if (lines.length >= maxLines) break;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && (lines.join(' ').length < words.join(' ').length)) {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/\s*\S*$/, '') + '…';
  }
  return lines.slice(0, maxLines);
}

export const onRequestGet = async ({ env, request, params }) => {
  const slug = String(params.slug || '').toLowerCase();
  if (!/^[a-z0-9-]{1,200}$/.test(slug)) {
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }
  const site = brand(env);

  // Look up the post in both tables. Either is fine; we only need
  // the title for the card.
  let post = null;
  try {
    post = await env.DB.prepare(
      `SELECT title FROM blog_posts WHERE slug = ? AND status='published' LIMIT 1`
    ).bind(slug).first();
    if (!post) {
      post = await env.DB.prepare(
        `SELECT title FROM prog_pages WHERE slug = ? AND status='published' LIMIT 1`
      ).bind(slug).first();
    }
  } catch { /* DB unavailable — fall through to a generic card */ }

  const title = post?.title || site.description || site.name;
  const lines = wrapTitle(title, 28, 3); // ~28 chars/line @ 72px serif

  // SVG composition: solid black backdrop, gold rule, brand eyebrow,
  // multi-line title, footer signature. Mirrors the "main — official"
  // template the editor produces — keeps the visual identity
  // consistent across cover-templated and fallback covers.
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#0a0c10"/>
      <stop offset="100%" stop-color="#05070a"/>
    </linearGradient>
    <style>
      .eyebrow { font: 600 22px "JetBrains Mono", ui-monospace, monospace; fill: #d4af62; letter-spacing: 0.12em; }
      .title   { font: 700 76px "Playfair Display", Georgia, serif; fill: #f5f0e6; }
      .sig     { font: 500 16px "JetBrains Mono", ui-monospace, monospace; fill: rgba(245,240,230,0.55); letter-spacing: 0.04em; }
    </style>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect x="80" y="60" width="200" height="2" fill="#d4af62"/>
  <text x="80" y="110" class="eyebrow">${esc(String(site.name).toUpperCase())}</text>
  <g>
    ${lines.map((ln, i) => `<text x="80" y="${360 + i * 88}" class="title">${esc(ln)}</text>`).join('\n    ')}
  </g>
  <text x="80" y="${H - 60}" class="sig">verified · ${esc(site.name)}</text>
  <g transform="translate(${W - 100}, 80)">
    <circle r="30" cx="30" cy="30" fill="#d4af62"/>
    <circle r="24" cx="30" cy="30" fill="#05070a"/>
    <text x="30" y="42" text-anchor="middle" font-family="Inter, sans-serif" font-size="32" font-weight="700" fill="#d4af62">✓</text>
  </g>
</svg>`;

  return new Response(svg, {
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      // Cache for an hour at the edge, week in the browser. Title is
      // a content-addressed key (the slug), so once it's been
      // generated the SVG can ride the cache for ages — we bust
      // implicitly when the post's slug changes (almost never).
      'cache-control': 'public, max-age=604800, s-maxage=3600',
    },
  });
};
