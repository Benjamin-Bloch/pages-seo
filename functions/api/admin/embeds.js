// GET    /api/admin/embeds            list all embeds
// POST   /api/admin/embeds            { name, settings? }  → create
// PUT    /api/admin/embeds?id=X       { name?, settings? } → update
// DELETE /api/admin/embeds?id=X       remove
//
// The embed id is the public token in the <script src=> URL. We use a
// 32-char url-safe random string (not a UUID) so it's terse but still
// unguessable.
import { json, newId, nowSec, audit } from '../../_lib/util.js';
import { adminGate } from '../../_lib/auth.js';

const SETTINGS_MAX_BYTES = 8 * 1024;

// 32 url-safe chars, ~190 bits of entropy.
function newEmbedId() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  // base64url
  let b64 = btoa(String.fromCharCode.apply(null, Array.from(bytes)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function safeSettings(settings) {
  if (!settings || typeof settings !== 'object') return '{}';
  const out = {};
  if (settings.title)  out.title  = String(settings.title).slice(0, 100);
  if (settings.accent) out.accent = String(settings.accent).slice(0, 24);
  if (settings.limit != null) {
    const n = parseInt(settings.limit, 10);
    if (Number.isFinite(n) && n > 0 && n <= 100) out.limit = n;
  }
  const j = JSON.stringify(out);
  if (j.length > SETTINGS_MAX_BYTES) throw new Error('settings_too_large');
  return j;
}

export const onRequestGet = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  const r = await env.DB.prepare(
    `SELECT id, name, settings_json, created_at, updated_at
       FROM blog_embeds ORDER BY updated_at DESC LIMIT 100`
  ).all();
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  const embeds = (r?.results || []).map((e) => {
    let settings = {};
    try { settings = JSON.parse(e.settings_json || '{}'); } catch {}
    return {
      ...e, settings,
      embed_url:   `${origin}/api/embed/${e.id}`,
      snippet:     `<div id="ps-blog"></div>\n<script src="${origin}/api/embed/${e.id}" defer></script>`,
      settings_json: undefined,
    };
  });
  return json(200, { ok: true, embeds });
};

export const onRequestPost = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }
  const name = String(body?.name || '').trim().slice(0, 120);
  if (!name) return json(400, { error: 'missing_name' });
  let settings_json;
  try { settings_json = safeSettings(body?.settings); }
  catch (e) { return json(400, { error: String(e.message || e) }); }
  const id = newEmbedId();
  const t = nowSec();
  await env.DB.prepare(
    `INSERT INTO blog_embeds (id, name, settings_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(id, name, settings_json, t, t).run();
  audit(env, 'admin', 'embed_create', id, { name });
  return json(200, { ok: true, id });
};

export const onRequestPut = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  const url = new URL(request.url);
  const id = String(url.searchParams.get('id') || '').trim();
  if (!id) return json(400, { error: 'missing_id' });
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }
  const sets = [];
  const binds = [];
  if (body.name != null) {
    const n = String(body.name).trim().slice(0, 120);
    if (!n) return json(400, { error: 'empty_name' });
    sets.push('name=?'); binds.push(n);
  }
  if (body.settings != null) {
    try { sets.push('settings_json=?'); binds.push(safeSettings(body.settings)); }
    catch (e) { return json(400, { error: String(e.message || e) }); }
  }
  if (!sets.length) return json(400, { error: 'no_updates' });
  sets.push('updated_at=?'); binds.push(nowSec());
  binds.push(id);
  const r = await env.DB.prepare(
    `UPDATE blog_embeds SET ${sets.join(', ')} WHERE id = ?`
  ).bind(...binds).run();
  audit(env, 'admin', 'embed_update', id, {});
  return json(200, { ok: true, changed: r?.meta?.changes || 0 });
};

export const onRequestDelete = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  const url = new URL(request.url);
  const id = String(url.searchParams.get('id') || '').trim();
  if (!id) return json(400, { error: 'missing_id' });
  await env.DB.prepare('DELETE FROM blog_embeds WHERE id = ?').bind(id).run();
  audit(env, 'admin', 'embed_delete', id, {});
  return json(200, { ok: true });
};
