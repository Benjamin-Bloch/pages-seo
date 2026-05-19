// API-key vault management. Stores LLM provider keys encrypted in D1
// so the admin can configure them without round-tripping through
// `wrangler pages secret put`.
//
//   GET    /api/admin/secrets        → status only: per-key source
//                                     ('pages-secret' | 'vault' | 'unset').
//                                     Never returns plaintext.
//   POST   /api/admin/secrets        { name, value }
//                                     Encrypts + stores. value="" deletes.
//   DELETE /api/admin/secrets?name=X Removes one row.
//
// Allowed names are restricted to a known set — no arbitrary keys.
import { json, audit } from '../../_lib/util.js';
import { adminGate } from '../../_lib/auth.js';
import { setVaultSecret, describeKeys } from '../../_lib/secret_vault.js';

// The same list as PROVIDER_SECRET_NAMES in ai.js — keep them in sync.
const ALLOWED = [
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY',
  'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY',
  'TOGETHER_API_KEY', 'CEREBRAS_API_KEY',
];

// Per-provider minimal length sanity check. Doesn't validate against
// the provider — just catches obvious paste mistakes. The actual key
// gets validated the first time it's used.
const MIN_LEN = 16;
const MAX_LEN = 512;

export const onRequestGet = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  const status = await describeKeys(env, ALLOWED);
  return json(200, { ok: true, keys: status, allowed: ALLOWED });
};

export const onRequestPost = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }

  const name = String(body?.name || '').trim().toUpperCase();
  if (!ALLOWED.includes(name)) return json(400, { error: 'unknown_key', allowed: ALLOWED });

  const value = typeof body?.value === 'string' ? body.value.trim() : '';
  if (value && (value.length < MIN_LEN || value.length > MAX_LEN)) {
    return json(400, { error: 'value_length_out_of_range', min: MIN_LEN, max: MAX_LEN });
  }

  let result;
  try {
    result = await setVaultSecret(env, name, value);
  } catch (e) {
    return json(500, { error: 'vault_error', detail: String(e?.message || e).slice(0, 200) });
  }
  // Never log the value. Only log the action.
  audit(env, 'admin', value ? 'secret_set' : 'secret_delete', name, {});
  return json(200, { ok: true, name, ...result });
};

export const onRequestDelete = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  const url = new URL(request.url);
  const name = String(url.searchParams.get('name') || '').trim().toUpperCase();
  if (!ALLOWED.includes(name)) return json(400, { error: 'unknown_key', allowed: ALLOWED });
  try {
    await setVaultSecret(env, name, '');
  } catch (e) {
    return json(500, { error: 'vault_error', detail: String(e?.message || e).slice(0, 200) });
  }
  audit(env, 'admin', 'secret_delete', name, {});
  return json(200, { ok: true, name, deleted: true });
};
