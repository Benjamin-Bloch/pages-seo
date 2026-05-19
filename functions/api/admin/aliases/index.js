// Site aliases — named shortcuts the LLM uses inside markdown links.
//
// GET    /api/admin/aliases                → list (with reserved + sitemap)
// POST   /api/admin/aliases   {name,url,description}   → upsert manual
// PATCH  /api/admin/aliases   {name,url?,description?} → update
// DELETE /api/admin/aliases?name=…         → remove manual
// POST   /api/admin/aliases/sync           → refresh sitemap-kind rows
//
// Manual rows are operator-curated. Sitemap rows are auto-imported from
// published blog posts + programmatic pages so the LLM can suggest
// internal links to existing content. Reserved names (blog/home/rss/
// sitemap) are baked in and not stored — see _lib/links/aliases.js.

import { json, nowSec, audit } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';
import { buildAliasMap, RESERVED_NAMES } from '../../../_lib/links/aliases.js';

const NAME_RX = /^[a-z0-9][a-z0-9_-]{0,40}$/;

function validUrl(u) {
  if (typeof u !== 'string') return false;
  const s = u.trim();
  if (!s) return false;
  if (s.startsWith('/')) return true;        // root-relative
  if (/^https?:\/\/.+/i.test(s)) return true; // absolute http(s)
  return false;
}

export const onRequestGet = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  const map = await buildAliasMap(env);
  const items = Object.entries(map).map(([name, v]) => ({ name, ...v }));
  // Stable order: reserved first, then manual (alpha), then sitemap (alpha).
  const order = (i) => i.kind === 'reserved' ? 0 : i.kind === 'manual' ? 1 : 2;
  items.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  return json(200, { ok: true, aliases: items, reserved: RESERVED_NAMES });
};

export const onRequestPost = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }
  const name = String(body?.name || '').trim().toLowerCase();
  const u    = String(body?.url || '').trim();
  const desc = String(body?.description || '').trim().slice(0, 300);
  if (!NAME_RX.test(name)) return json(400, { error: 'bad_name', detail: 'lowercase letters, digits, _ or -; up to 40 chars.' });
  if (RESERVED_NAMES.includes(name)) return json(409, { error: 'reserved_name', detail: 'Built-in alias; pick a different name.' });
  if (!validUrl(u))     return json(400, { error: 'bad_url', detail: 'Must be root-relative (/path) or absolute https://…' });

  const now = nowSec();
  await env.DB.prepare(
    `INSERT INTO site_aliases (name, url, description, kind, created_at, updated_at)
     VALUES (?, ?, ?, 'manual', ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       url = excluded.url,
       description = excluded.description,
       kind = 'manual',
       updated_at = excluded.updated_at`
  ).bind(name, u, desc || null, now, now).run();
  await audit(env, 'admin', 'aliases.upsert', name, JSON.stringify({ url: u }));
  return json(200, { ok: true, name });
};

export const onRequestPatch = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }
  const name = String(body?.name || '').trim().toLowerCase();
  if (!name) return json(400, { error: 'missing_name' });
  if (RESERVED_NAMES.includes(name)) return json(409, { error: 'reserved_name' });

  const sets = [];
  const args = [];
  if (body.url !== undefined) {
    if (!validUrl(body.url)) return json(400, { error: 'bad_url' });
    sets.push('url = ?'); args.push(body.url.trim());
  }
  if (body.description !== undefined) {
    sets.push('description = ?'); args.push(String(body.description || '').trim().slice(0, 300) || null);
  }
  if (!sets.length) return json(400, { error: 'nothing_to_update' });
  sets.push('updated_at = ?'); args.push(nowSec());
  args.push(name);
  const r = await env.DB.prepare(
    `UPDATE site_aliases SET ${sets.join(', ')} WHERE name = ?`
  ).bind(...args).run();
  if (!r?.meta?.changes) return json(404, { error: 'not_found' });
  await audit(env, 'admin', 'aliases.update', name, '');
  return json(200, { ok: true });
};

export const onRequestDelete = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  const name = (new URL(request.url).searchParams.get('name') || '').toLowerCase();
  if (!name) return json(400, { error: 'missing_name' });
  if (RESERVED_NAMES.includes(name)) return json(409, { error: 'reserved_name' });
  const r = await env.DB.prepare(
    `DELETE FROM site_aliases WHERE name = ? AND kind = 'manual'`
  ).bind(name).run();
  if (!r?.meta?.changes) return json(404, { error: 'not_found_or_not_manual' });
  await audit(env, 'admin', 'aliases.delete', name, '');
  return json(200, { ok: true });
};
