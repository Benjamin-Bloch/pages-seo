// GET /api/health
//
// Lightweight liveness probe. Returns 200 + JSON when the worker
// runtime is up and the D1 binding answers a 1-row SELECT.
//
// Used by:
//   - external uptime monitors (no auth required, cheap to call)
//   - /api/ai-prompt/diagnose's black-box scan
//   - the install/repair flows to confirm a deployment is live
//
// Not authenticated. Returns no secrets; the only data leaked is
// "DB binding healthy" which we already imply on every blog page.
//
// Response (200):
//   { ok: true, db: 'ok' | 'unbound' | 'error', ts: <unix> }
// Response (503):
//   returned only if the function itself can't return a Response,
//   which never happens — we always succeed at returning JSON.

import { json } from '../_lib/util.js';

export const onRequestGet = async ({ env }) => {
  let db = 'unbound';
  if (env?.DB) {
    try {
      // Pulling COUNT(*) from sqlite_master is cheaper than touching
      // any of our tables (no row scan, no app-data lock). If this
      // round-trips we know the binding is healthy AND D1 isn't down.
      const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM sqlite_master').first();
      db = (r && typeof r.n === 'number') ? 'ok' : 'error';
    } catch {
      db = 'error';
    }
  }

  return json(200, {
    ok: true,
    db,
    ts: Math.floor(Date.now() / 1000),
  }, {
    // Never cache — monitors should see the current state.
    'cache-control': 'no-store',
  });
};
