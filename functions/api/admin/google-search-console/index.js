// /api/admin/google-search-console
//
// GET   → { configured, client_email?, project_id?, property?,
//           use_indexing_api: bool }
// POST  → save credentials and/or settings.
//         Body: { sa_json?: string, property?: string, use_indexing_api?: bool }
//         - sa_json: paste of the entire service-account JSON from
//           Google Cloud. Stored in the vault as GOOGLE_SA_JSON.
//           Pass '' to clear (vault deletes the row).
//         - property: GSC property identifier
//           ('https://example.com/' or 'sc-domain:example.com').
//           Empty string auto-derives from SITE_URL.
//         - use_indexing_api: opt into per-URL Indexing API pings.
//           Default off — Indexing API is ToS-grey for blog content.
// DELETE → clear all (vault row + the two settings keys).
//
// Auth: admin gate.

import { json, audit } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';
import { setVaultSecret } from '../../../_lib/secret_vault.js';
import { loadSettings, setSetting } from '../../../_lib/settings.js';
import { describeConfig } from '../../../_lib/google_indexing.js';

export const onRequestGet = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  const s = await loadSettings(env);
  const desc = await describeConfig(env);
  return json(200, {
    ...desc,
    explicit_property: String(s.google_sc_property || '').trim(),
    use_indexing_api: String(s.google_use_indexing_api || '') === '1',
  });
};

export const onRequestPost = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }

  // sa_json: undefined = leave alone, '' = clear, '{...}' = parse + store.
  let savedJson = false;
  if (body.sa_json !== undefined) {
    const raw = String(body.sa_json || '').trim();
    if (!raw) {
      await setVaultSecret(env, 'GOOGLE_SA_JSON', '');
      savedJson = true;
    } else {
      // Validate before storing — refuse to save a malformed JSON
      // since the runtime would silently treat it as unset.
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch { return json(400, { error: 'invalid_json', detail: 'sa_json is not valid JSON' }); }
      if (!parsed.client_email || !parsed.private_key) {
        return json(400, { error: 'invalid_service_account', detail: 'JSON is missing client_email and/or private_key — paste the full service-account file from Google Cloud.' });
      }
      await setVaultSecret(env, 'GOOGLE_SA_JSON', raw);
      savedJson = true;
    }
  }

  if (body.property !== undefined) {
    await setSetting(env, 'google_sc_property', String(body.property || '').trim().slice(0, 200));
  }
  if (body.use_indexing_api !== undefined) {
    await setSetting(env, 'google_use_indexing_api', body.use_indexing_api ? '1' : '');
  }

  audit(env, 'admin', 'gsc_settings_save', null, {
    saved_json: savedJson,
    changed_property: body.property !== undefined,
    changed_use_indexing_api: body.use_indexing_api !== undefined,
  });

  return json(200, { ok: true });
};

export const onRequestDelete = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  await setVaultSecret(env, 'GOOGLE_SA_JSON', '');
  await setSetting(env, 'google_sc_property', '');
  await setSetting(env, 'google_use_indexing_api', '');
  audit(env, 'admin', 'gsc_settings_clear', null, {});
  return json(200, { ok: true, cleared: true });
};
