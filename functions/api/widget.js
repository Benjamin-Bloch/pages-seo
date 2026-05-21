// /api/widget — JSON feed for the embeddable blog widget.
//
// Public, CORS-open, paginated, searchable. Used by /widget.js and
// /api/embed/<id>.js to render and navigate.
//
// Query params:
//   q          — search term, matched LIKE against title +
//                meta_description + slug. Trimmed, capped at 100.
//   page       — 1-based page number. Default 1.
//   per_page   — items per page. Default 10, min 1, max 50.
//   tag        — single keyword to filter by (matches keywords CSV).
//
// Response:
//   { posts: [...], total, page, per_page, total_pages, q, tag }
// Each post: { slug, title, excerpt, image, date, iso, keywords }
//
// Backwards compat: the old `?count=5` query is still supported and
// behaves like per_page=count.

import { imageUrlFor } from '../_lib/widget_render.js';

const MAX_PER_PAGE = 50;
const MAX_Q_LENGTH = 100;
const MAX_TAG_LENGTH = 200;

function fmtDate(secs) {
  if (!secs) return { date: '', iso: '' };
  const d = new Date(secs * 1000);
  if (isNaN(d.getTime())) return { date: '', iso: '' };
  return {
    date: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    iso: d.toISOString(),
  };
}

export const onRequestGet = async ({ env, request }) => {
  if (!env?.DB) {
    return new Response(JSON.stringify({ error: 'no_db_binding', posts: [], total: 0 }), {
      status: 503,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
    });
  }
  const url = new URL(request.url);
  const q = String(url.searchParams.get('q') || '').trim().slice(0, MAX_Q_LENGTH);
  const tag = String(url.searchParams.get('tag') || '').trim().slice(0, MAX_TAG_LENGTH).toLowerCase();
  // Backwards-compat: legacy callers passed ?count=N. Map to per_page.
  const legacyCount = parseInt(url.searchParams.get('count'), 10);
  const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
  const perPage = Math.max(1, Math.min(MAX_PER_PAGE,
    parseInt(url.searchParams.get('per_page'), 10) || legacyCount || 10));

  const where = ["status = 'published'"];
  const binds = [];

  if (q) {
    where.push("(title LIKE ? OR meta_description LIKE ? OR slug LIKE ?)");
    const like = `%${q}%`;
    binds.push(like, like, like);
  }
  if (tag) {
    where.push("(',' || LOWER(keywords) || ',') LIKE ?");
    binds.push(`%,${tag},%`);
  }
  const whereSQL = 'WHERE ' + where.join(' AND ');

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM blog_posts ${whereSQL}`
  ).bind(...binds).first().catch(() => ({ n: 0 }));
  const total = countRow?.n || 0;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * perPage;

  const rows = await env.DB.prepare(
    `SELECT slug, title, meta_description, hero_image_key, keywords, published_at
       FROM blog_posts ${whereSQL}
       ORDER BY published_at DESC
       LIMIT ? OFFSET ?`
  ).bind(...binds, perPage, offset).all().catch(() => ({ results: [] }));

  const posts = (rows.results || []).map((r) => {
    const d = fmtDate(r.published_at);
    return {
      slug: r.slug,
      title: r.title,
      excerpt: r.meta_description || '',
      image: imageUrlFor(r.hero_image_key),
      date: d.date,
      iso: d.iso,
      keywords: r.keywords || '',
    };
  });

  return new Response(JSON.stringify({
    posts,
    total,
    page: safePage,
    per_page: perPage,
    total_pages: totalPages,
    q,
    tag,
  }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=60, s-maxage=300',
      'access-control-allow-origin': '*',
    },
  });
};
