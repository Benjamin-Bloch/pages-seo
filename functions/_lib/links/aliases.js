// Internal link aliases the AI is told about. The prompt mentions
// these by name; the sanitiser expands them at insert time.
//
// Empty by default — the operator curates them in the Aliases admin
// tab. Two flavours live in the `site_aliases` D1 table:
//
//   kind = 'manual'   operator-curated (login → /login, "user sign-in")
//   kind = 'sitemap'  auto-imported from existing blog / prog pages,
//                     so the LLM can link to "/blog/<slug>" by name
//
// On lookup, manual wins if both rows share the same name.

import { nowSec } from '../util.js';

// Reserved names — protected pages every install owns. We always
// include them with sensible defaults so the LLM has a baseline
// vocabulary even when the operator hasn't curated anything yet.
const RESERVED = {
  blog:    { url: '/blog',         description: 'The main blog index of this site.' },
  home:    { url: '/',             description: 'The homepage of this site.' },
  rss:     { url: '/rss.xml',      description: 'The RSS feed.' },
  sitemap: { url: '/sitemap.xml',  description: 'The XML sitemap.' },
};

// Build the resolved alias map for a request.
//   { name: { url, description, kind } }
// Order of precedence (later overrides earlier):
//   reserved → sitemap rows → manual rows
export async function buildAliasMap(env) {
  const map = Object.fromEntries(
    Object.entries(RESERVED).map(([k, v]) => [k, { ...v, kind: 'reserved' }])
  );
  if (!env?.DB) return map;
  const r = await env.DB.prepare(
    `SELECT name, url, description, kind FROM site_aliases ORDER BY
       CASE kind WHEN 'sitemap' THEN 1 WHEN 'manual' THEN 2 ELSE 3 END`
  ).all().catch(() => ({ results: [] }));
  for (const row of (r.results || [])) {
    map[String(row.name || '').toLowerCase()] = {
      url: row.url,
      description: row.description || '',
      kind: row.kind || 'manual',
    };
  }
  return map;
}

// Flat { name: url } shape — keeps the existing sanitiser happy.
// New code should use buildAliasMap() instead.
export async function buildAliases(env) {
  const m = await buildAliasMap(env);
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.url]));
}

// Human-readable list for inclusion in the AI prompt. Includes the
// description column so the LLM knows what each link is for.
export async function aliasesForPrompt(env) {
  const m = await buildAliasMap(env);
  const lines = Object.entries(m).map(([name, v]) => {
    const desc = v.description ? ` — ${v.description}` : '';
    return `- "${name}" → ${v.url}${desc}`;
  });
  return lines.join('\n');
}

// Refresh the sitemap-kind rows from the latest published content.
// Removes stale entries (hidden posts) and adds new ones with a
// generated short description. Manual-kind rows are untouched.
export async function syncSitemapAliases(env) {
  if (!env?.DB) return { added: 0, removed: 0 };
  const now = nowSec();

  const [posts, progs, existing] = await Promise.all([
    env.DB.prepare(
      `SELECT slug, title, meta_description FROM blog_posts WHERE status='published' ORDER BY published_at DESC LIMIT 500`
    ).all().catch(() => ({ results: [] })),
    env.DB.prepare(
      `SELECT slug, title, meta_description FROM prog_pages WHERE status='published' ORDER BY published_at DESC LIMIT 500`
    ).all().catch(() => ({ results: [] })),
    env.DB.prepare(
      `SELECT name FROM site_aliases WHERE kind='sitemap'`
    ).all().catch(() => ({ results: [] })),
  ]);

  // Desired set of sitemap-kind rows. Name is the slug (lowercased).
  // If a slug collides with a manual row, the manual row wins on
  // lookup so it's safe to insert ours.
  const desired = new Map();
  for (const p of (posts.results || [])) {
    const name = String(p.slug || '').toLowerCase();
    if (!name) continue;
    desired.set(name, {
      url: `/blog/${p.slug}`,
      description: `Blog post: ${(p.meta_description || p.title || '').slice(0, 160)}`,
    });
  }
  for (const p of (progs.results || [])) {
    const name = String(p.slug || '').toLowerCase();
    if (!name) continue;
    if (desired.has(name)) continue;
    desired.set(name, {
      url: `/p/${p.slug}`,
      description: `Landing page: ${(p.meta_description || p.title || '').slice(0, 160)}`,
    });
  }

  const existingNames = new Set((existing.results || []).map((r) => r.name));
  const desiredNames  = new Set(desired.keys());

  const toAdd    = [...desiredNames].filter((n) => !existingNames.has(n));
  const toRemove = [...existingNames].filter((n) => !desiredNames.has(n));

  const batch = [];
  for (const name of toAdd) {
    const v = desired.get(name);
    batch.push(env.DB.prepare(
      `INSERT INTO site_aliases (name, url, description, kind, created_at, updated_at)
       VALUES (?, ?, ?, 'sitemap', ?, ?)
       ON CONFLICT(name) DO UPDATE SET url=excluded.url, description=excluded.description, updated_at=excluded.updated_at
       WHERE site_aliases.kind='sitemap'`
    ).bind(name, v.url, v.description, now, now));
  }
  if (toRemove.length) {
    const placeholders = toRemove.map(() => '?').join(',');
    batch.push(env.DB.prepare(
      `DELETE FROM site_aliases WHERE kind='sitemap' AND name IN (${placeholders})`
    ).bind(...toRemove));
  }
  if (batch.length) await env.DB.batch(batch);
  return { added: toAdd.length, removed: toRemove.length, total: desired.size };
}

export const RESERVED_NAMES = Object.keys(RESERVED);
