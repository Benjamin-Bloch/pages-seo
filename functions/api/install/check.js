// GET /api/install/check?url=https://<slug>.pages.dev
//
// Cheap liveness probe the install page polls after the Pages-create
// call. Pages takes 1–3 minutes to compile the Functions bundle and
// roll out, and the create response returns immediately — so we can't
// just hand the user the URL and hope. This endpoint does the probe
// for them from a CORS-friendly origin and returns a boolean.
//
// Strict allow-list: only *.pages.dev URLs to avoid being a generic
// SSRF probe.
//
// Liveness signal:
//   - GET /api/setup on the new site. That endpoint is defined in
//     this repo (functions/api/setup.js), so a 2xx + JSON body with
//     `ok:true` proves the Functions bundle is deployed AND the D1
//     binding works.
//   - Anything else (404, 500, ECONNREFUSED, timeout) = not live yet.

import { json } from '../../_lib/util.js';

const URL_RX = /^https:\/\/[a-z0-9-]+\.pages\.dev$/i;

export const onRequestGet = async ({ request }) => {
  const u = new URL(request.url).searchParams.get('url') || '';
  if (!URL_RX.test(u)) return json(400, { ok: false, error: 'bad_url' });

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(u + '/api/setup', { signal: ctrl.signal, redirect: 'manual' });
    clearTimeout(timeout);
    if (r.status !== 200) {
      return json(200, { ok: true, live: false, status: r.status });
    }
    const body = await r.json().catch(() => null);
    // body.ok === true comes from functions/api/setup.js — it's only
    // there once the Functions bundle has rolled out.
    return json(200, { ok: true, live: !!(body && body.ok), needs_setup: !!body?.needs_setup });
  } catch (e) {
    clearTimeout(timeout);
    return json(200, { ok: true, live: false, error: String(e?.message || e).slice(0, 120) });
  }
};
