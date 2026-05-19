// GET  /api/admin/pricing             → current effective prices + source
// POST /api/admin/pricing/refresh     → re-fetch from models.dev, update cache
//
// Both methods on the same path; we route on `request.method`. This
// keeps the route file count down without adding subdirectory routing.
import { json } from '../../_lib/util.js';
import { adminGate } from '../../_lib/auth.js';
import { loadPrices, refreshPricesFromModelsDev } from '../../_lib/prices.js';

export const onRequestGet = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  const { prices, source, fetched_at, stale } = await loadPrices(env);
  return json(200, {
    ok: true,
    prices,
    source,
    fetched_at,
    stale,
  });
};

export const onRequestPost = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  try {
    const r = await refreshPricesFromModelsDev(env);
    return json(200, { ok: true, ...r });
  } catch (e) {
    return json(502, { error: 'refresh_failed', detail: String(e?.message || e).slice(0, 200) });
  }
};
