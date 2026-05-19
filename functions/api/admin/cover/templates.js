// Cover-template CRUD.
//
//   GET    /api/admin/cover/templates           → all templates, newest first
//   POST   /api/admin/cover/templates           → { name, spec, is_default? }
//   PUT    /api/admin/cover/templates?id=X      → patch one
//   DELETE /api/admin/cover/templates?id=X      → remove
//
// `spec` is the JSON the canvas editor produces. We don't validate the
// inner shape here — the renderer in admin.js is responsible. We do cap
// it at 64KB to prevent obviously-broken pastes from filling the DB.
import { json, newId, nowSec, audit } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';

const MAX_SPEC_BYTES = 64 * 1024;

function shrinkSpec(spec) {
  // Stringify so we can cap by serialized length. Throwing here means
  // the caller sent something non-serialisable.
  const s = JSON.stringify(spec);
  if (s.length > MAX_SPEC_BYTES) throw new Error('spec_too_large');
  return s;
}

export const onRequestGet = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  const r = await env.DB.prepare(
    `SELECT id, name, is_default, spec_json, thumb_r2_key, created_at, updated_at
       FROM cover_templates ORDER BY updated_at DESC LIMIT 100`
  ).all();
  const templates = (r?.results || []).map((t) => {
    let spec = null;
    try { spec = JSON.parse(t.spec_json); } catch { /* corrupted row — skip */ }
    return { ...t, spec, spec_json: undefined };
  });
  return json(200, { ok: true, templates });
};

export const onRequestPost = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }
  const name = String(body?.name || '').trim().slice(0, 120);
  if (!name) return json(400, { error: 'missing_name' });
  if (!body?.spec || typeof body.spec !== 'object') {
    return json(400, { error: 'missing_spec' });
  }
  let spec_json;
  try { spec_json = shrinkSpec(body.spec); }
  catch (e) { return json(400, { error: String(e?.message || e) }); }

  const id = newId();
  const t = nowSec();
  const isDefault = body.is_default ? 1 : 0;

  // If marking default, demote any previous default first.
  if (isDefault) {
    await env.DB.prepare('UPDATE cover_templates SET is_default = 0 WHERE is_default = 1').run();
  }
  await env.DB.prepare(
    `INSERT INTO cover_templates (id, name, is_default, spec_json, thumb_r2_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, name, isDefault, spec_json, body?.thumb_r2_key || null, t, t).run();

  audit(env, 'admin', 'cover_template_create', id, { name });
  return json(200, { ok: true, id });
};

export const onRequestPut = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  const url = new URL(request.url);
  const id = String(url.searchParams.get('id') || '');
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
  if (body.is_default != null) {
    const d = body.is_default ? 1 : 0;
    if (d === 1) {
      await env.DB.prepare('UPDATE cover_templates SET is_default = 0 WHERE is_default = 1 AND id != ?').bind(id).run();
    }
    sets.push('is_default=?'); binds.push(d);
  }
  if (body.spec) {
    try { sets.push('spec_json=?'); binds.push(shrinkSpec(body.spec)); }
    catch (e) { return json(400, { error: String(e?.message || e) }); }
  }
  if (body.thumb_r2_key != null) {
    sets.push('thumb_r2_key=?'); binds.push(String(body.thumb_r2_key) || null);
  }
  if (!sets.length) return json(400, { error: 'no_updates' });

  sets.push('updated_at=?'); binds.push(nowSec());
  binds.push(id);
  const r = await env.DB.prepare(
    `UPDATE cover_templates SET ${sets.join(', ')} WHERE id = ?`
  ).bind(...binds).run();

  audit(env, 'admin', 'cover_template_update', id, {});
  return json(200, { ok: true, changed: r?.meta?.changes || 0 });
};

export const onRequestDelete = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  const url = new URL(request.url);
  const id = String(url.searchParams.get('id') || '');
  if (!id) return json(400, { error: 'missing_id' });
  await env.DB.prepare('DELETE FROM cover_templates WHERE id = ?').bind(id).run();
  audit(env, 'admin', 'cover_template_delete', id, {});
  return json(200, { ok: true });
};
