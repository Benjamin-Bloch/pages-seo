// GET  → current effective settings (with env fallbacks merged in)
// PUT  → patch one or more setting keys. Body: { key: value, ... }
import { json, audit } from '../../_lib/util.js';
import { adminGate } from '../../_lib/auth.js';
import { loadSettings, setSetting, listSettingKeys } from '../../_lib/settings.js';

export const onRequestGet = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  const settings = await loadSettings(env);
  return json(200, { ok: true, settings, keys: listSettingKeys() });
};

export const onRequestPut = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'invalid_json' }); }
  if (!body || typeof body !== 'object') return json(400, { error: 'body_required' });
  const keys = listSettingKeys();
  const updated = [];
  const errors = {};
  for (const [k, v] of Object.entries(body)) {
    if (!keys.includes(k)) { errors[k] = 'unknown_key'; continue; }
    try {
      await setSetting(env, k, v);
      updated.push(k);
    } catch (e) {
      errors[k] = String(e?.message || e).slice(0, 200);
    }
  }
  audit(env, 'admin', 'settings_update', null, { updated });
  return json(200, { ok: true, updated, errors });
};
