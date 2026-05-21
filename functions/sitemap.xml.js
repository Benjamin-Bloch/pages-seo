// Dynamic sitemap. Two endpoints:
//   /sitemap.xml         — sitemap index (or a single urlset when small)
//   /sitemap-pages.xml   — every URL with image extensions
//
// For sites under 5k pages the index is mildly silly but harmless;
// at >50k Google requires splitting via a sitemap index, so we always
// emit one as a forward-compatible move.
//
// Image extensions (image:image inside each <url>) let Google index
// the hero image alongside the page. Image Search is a real source
// of organic for blogs.

import { esc } from './_lib/util.js';
import { PAGE_SIZE } from './blog/index.js';

const SITEMAP_NS = 'http://www.sitemaps.org/schemas/sitemap/0.9';
const IMAGE_NS   = 'http://www.google.com/schemas/sitemap-image/1.1';

function isoDay(secOrZero) {
  const ms = (secOrZero || 0) * 1000;
  if (!ms) return new Date().toISOString().slice(0, 10);
  return new Date(ms).toISOString().slice(0, 10);
}

// Sitemap index — points crawlers at the real urlset. We currently
// only emit one urlset (pages); structured as an index so future
// splits (one per N URLs) are a small change.
function renderIndex(site, lastmod) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<sitemapindex xmlns="${SITEMAP_NS}">`,
    '  <sitemap>',
    `    <loc>${site}/sitemap-pages.xml</loc>`,
    `    <lastmod>${lastmod}</lastmod>`,
    '  </sitemap>',
    '</sitemapindex>',
  ].join('\n');
}

function renderUrlset(site, entries) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<urlset xmlns="${SITEMAP_NS}" xmlns:image="${IMAGE_NS}">`,
    ...entries.map((e) => {
      const imgs = (e.images || []).map((img) =>
        `    <image:image>
      <image:loc>${esc(img.loc)}</image:loc>${img.title ? `
      <image:title>${esc(img.title)}</image:title>` : ''}${img.caption ? `
      <image:caption>${esc(img.caption)}</image:caption>` : ''}
    </image:image>`
      ).join('\n');
      return `  <url>
    <loc>${site}${e.path}</loc>
    <lastmod>${e.lastmod}</lastmod>
    <changefreq>${e.changefreq}</changefreq>
    <priority>${e.priority}</priority>
${imgs ? imgs + '\n' : ''}  </url>`;
    }),
    '</urlset>',
  ].join('\n');
}

async function fetchEntries(env, host) {
  const site = `https://${host}`;

  const blogs = await env.DB.prepare(
    `SELECT slug, title, meta_description, hero_image_key, hero_image_alt, published_at
       FROM blog_posts WHERE status='published' ORDER BY published_at DESC LIMIT 5000`
  ).all().catch(() => ({ results: [] }));

  const progs = await env.DB.prepare(
    `SELECT slug, title, meta_description, hero_image_key, hero_image_alt, published_at
       FROM prog_pages WHERE status='published' ORDER BY published_at DESC LIMIT 10000`
  ).all().catch(() => ({ results: [] }));

  // Find out how many blog index pages exist (1 + total/PAGE_SIZE).
  // PAGE_SIZE is sourced from blog/index.js so we never drift out of
  // sync — sitemap pages have to match what /blog/page/N actually
  // serves or crawlers hit empty/duplicate archives.
  const totalBlogsRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM blog_posts WHERE status='published'`
  ).first().catch(() => ({ n: 0 }));
  const totalPages = Math.max(1, Math.ceil((totalBlogsRow?.n || 0) / PAGE_SIZE));

  const today = isoDay(0);
  const entries = [
    { path: '/',     priority: '1.0', changefreq: 'weekly', lastmod: today },
    { path: '/blog', priority: '0.9', changefreq: 'daily',  lastmod: today },
  ];
  // /blog/page/2, /3, … — Google indexes paginated archive pages.
  for (let i = 2; i <= totalPages; i++) {
    entries.push({ path: `/blog/page/${i}`, priority: '0.5', changefreq: 'weekly', lastmod: today });
  }

  for (const p of (blogs.results || [])) {
    const images = p.hero_image_key ? [{
      loc: `${site}/image/${p.hero_image_key}`,
      title: p.title,
      caption: p.hero_image_alt || p.meta_description || '',
    }] : [];
    entries.push({
      path: `/blog/${p.slug}`,
      priority: '0.7', changefreq: 'monthly',
      lastmod: isoDay(p.published_at),
      images,
    });
  }
  for (const p of (progs.results || [])) {
    const images = p.hero_image_key ? [{
      loc: `${site}/image/${p.hero_image_key}`,
      title: p.title,
      caption: p.hero_image_alt || p.meta_description || '',
    }] : [];
    entries.push({
      path: `/p/${p.slug}`,
      priority: '0.6', changefreq: 'monthly',
      lastmod: isoDay(p.published_at),
      images,
    });
  }
  return entries;
}

export const onRequestGet = async ({ env, request }) => {
  const host = new URL(request.url).hostname;
  const site = `https://${host}`;
  const body = renderIndex(site, isoDay(0));
  return new Response(body, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
};

// Exported for /sitemap-pages.xml.js to reuse.
export async function pagesUrlset({ env, request }) {
  const host = new URL(request.url).hostname;
  const site = `https://${host}`;
  const entries = await fetchEntries(env, host);
  const body = renderUrlset(site, entries);
  return new Response(body, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
}
