// POST { seed: "...", limit?: 50, queue?: true|false }
//
// Pulls keyword suggestions from Google Autocomplete starting from `seed`
// and either:
//   queue=true (default) → inserts straight into prog_keywords with
//     status='pending' so the daily cron picks them up.
//   queue=false → returns the list for admin review without writing.
//
// Returns { ok, seed, pulled, inserted, duplicate, keywords }.
import { json, newId, nowSec, audit } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';
import { pullKeywords } from '../../../_lib/keyword_puller.js';

export const onRequestPost = async ({ request, env }) => {
  const gate = adminGate(env, request); if (gate) return gate;
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }

  const seed = String(body?.seed || '').trim();
  if (!seed) return json(400, { error: 'missing_seed' });
  const limit = Math.max(1, Math.min(200, parseInt(body?.limit, 10) || 50));
  const shouldQueue = body?.queue !== false; // default true

  let pulled;
  try {
    pulled = await pullKeywords(seed, { limit });
  } catch (e) {
    return json(502, { error: 'autocomplete_failed', detail: String(e.message || e) });
  }

  if (!shouldQueue) {
    return json(200, { ok: true, seed: pulled.seed, pulled: pulled.total, keywords: pulled.keywords, inserted: 0, duplicate: 0 });
  }

  const t = nowSec();
  let inserted = 0, duplicate = 0;
  for (const kw of pulled.keywords) {
    try {
      const r = await env.DB.prepare(
        `INSERT INTO prog_keywords (id, keyword, status, attempts, created_at, updated_at)
         VALUES (?, ?, 'pending', 0, ?, ?)`
      ).bind(newId(), kw, t, t).run();
      if (r?.meta?.changes) inserted++; else duplicate++;
    } catch {
      duplicate++; // UNIQUE on keyword
    }
  }
  audit(env, 'admin', 'prog_pull', null, { seed, pulled: pulled.total, inserted, duplicate });
  return json(200, {
    ok: true, seed: pulled.seed, pulled: pulled.total,
    inserted, duplicate, keywords: pulled.keywords,
  });
};
