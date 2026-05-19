// Onboarding wizard state.
//
// GET  /api/admin/onboarding  → { complete, has_brand_dna, has_future_slots, providers_configured }
// POST /api/admin/onboarding  → mark the wizard complete (sets settings.onboarding_complete)
// DELETE /api/admin/onboarding → reset (lets the operator re-run the wizard from the help menu)
//
// The wizard itself runs entirely client-side and reuses existing
// endpoints (brand-dna POST/PUT, secrets POST, calendar/plan). This
// route just persists "did the operator finish it?".

import { json, nowSec } from '../../_lib/util.js';
import { adminGate } from '../../_lib/auth.js';
import { loadSettings, setSetting } from '../../_lib/settings.js';
import { listProviders } from '../../_lib/ai.js';

export const onRequestGet = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  const s = await loadSettings(env);
  const has_brand_dna = !!(s.brand_business_type || s.brand_target_audience);
  const today = new Date().toISOString().slice(0, 10);
  const future = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM content_calendar
      WHERE scheduled_for >= ? AND status IN ('scheduled','generating','draft')`
  ).bind(today).first().catch(() => ({ n: 0 }));
  const providers = await listProviders(env);
  return json(200, {
    ok: true,
    complete: !!s.onboarding_complete,
    has_brand_dna,
    has_future_slots: !!(future?.n),
    providers_configured: providers.text || [],
  });
};

export const onRequestPost = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  await setSetting(env, 'onboarding_complete', new Date().toISOString());
  return json(200, { ok: true, marked_at: nowSec() });
};

export const onRequestDelete = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  await setSetting(env, 'onboarding_complete', '');
  return json(200, { ok: true });
};
