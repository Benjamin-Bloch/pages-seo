// POST /api/admin/blog/rename-slug
//
// Body: { old_slug, new_slug }
//
// Atomically renames a published post's slug AND records the old slug
// in blog_post_redirects so /blog/<old> serves a 301 to /blog/<new>.
// The redirect table is created on first use (no separate migration).
//
// Refuses if:
//   - new_slug already in use by another post
//   - new_slug is malformed
//   - old_slug doesn't exist
//
// Used to clean up posts the AI gave a bad slug (e.g. the
// "blogoptimize-..." prefix bug).

import { json, slugify, audit } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';

async function ensureRedirectTable(env) {
  // Schema: row per renamed slug. UNIQUE on old_slug so the lookup is
  // O(log n). Created lazily so we don't need a separate migration.
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS blog_post_redirects (
       old_slug   TEXT PRIMARY KEY,
       new_slug   TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`
  ).run();
}

export const onRequestPost = async ({ request, env }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  let body;
  try { body = await request.json(); }
  catch { return json(400, { error: 'bad_json' }); }

  const oldSlug = String(body.old_slug || '').trim().toLowerCase();
  let newSlug   = String(body.new_slug || '').trim().toLowerCase();
  if (!oldSlug || !newSlug) return json(400, { error: 'missing_slugs' });
  newSlug = slugify(newSlug);
  if (!/^[a-z][a-z0-9-]{1,80}$/.test(newSlug)) return json(400, { error: 'bad_new_slug' });
  if (oldSlug === newSlug) return json(400, { error: 'same_slug' });

  const existing = await env.DB.prepare(
    `SELECT id FROM blog_posts WHERE slug = ? LIMIT 1`
  ).bind(oldSlug).first();
  if (!existing) return json(404, { error: 'old_slug_not_found' });

  const collision = await env.DB.prepare(
    `SELECT id FROM blog_posts WHERE slug = ? LIMIT 1`
  ).bind(newSlug).first();
  if (collision) return json(409, { error: 'new_slug_in_use' });

  await ensureRedirectTable(env);

  // Update + record redirect. We don't wrap in a tx because D1 prepared
  // statements run sequentially; failure of step 2 just leaves the
  // post renamed without a 301 (the operator can re-run to fix it).
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `UPDATE blog_posts SET slug = ? WHERE slug = ?`
  ).bind(newSlug, oldSlug).run();
  await env.DB.prepare(
    `INSERT INTO blog_post_redirects (old_slug, new_slug, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(old_slug) DO UPDATE SET new_slug = excluded.new_slug`
  ).bind(oldSlug, newSlug, now).run();

  await audit(env, 'admin', 'blog_rename_slug', existing.id, {
    old_slug: oldSlug, new_slug: newSlug,
  }).catch(() => {});

  return json(200, { ok: true, old_slug: oldSlug, new_slug: newSlug });
};
