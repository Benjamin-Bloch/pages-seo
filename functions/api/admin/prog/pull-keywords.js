// POST { seed: "...", limit?: 50, queue?: true|false, min_score?: 0 }
//
// Pulls keyword suggestions from Google Autocomplete starting from
// `seed`, scores every result, dedupes near-duplicates (plural/article
// variants), and either:
//   queue=true (default) → inserts straight into prog_keywords with
//     status='pending' and priority=score so the cron picks the best
//     ones first.
//   queue=false → returns the scored list for admin review only.
//
// Returns { ok, seed, pulled, inserted, duplicate, kept, keywords }.
// `keywords` is now an array of { keyword, canonical, score, intent,
// signals } objects rather than plain strings — the admin UI uses this
// to show the queue with scoring info.
import { json, newId, nowSec, audit } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';
import { pullKeywords } from '../../../_lib/keyword_puller.js';

export const onRequestPost = async ({ request, env }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }

  const seed = String(body?.seed || '').trim();
  if (!seed) return json(400, { error: 'missing_seed' });
  const limit = Math.max(1, Math.min(200, parseInt(body?.limit, 10) || 50));
  const minScore = Math.max(0, Math.min(100, parseInt(body?.min_score, 10) || 0));
  const shouldQueue = body?.queue !== false; // default true

  let pulled;
  try {
    pulled = await pullKeywords(seed, { limit, minScore });
  } catch (e) {
    return json(502, { error: 'autocomplete_failed', detail: String(e.message || e) });
  }

  if (!shouldQueue) {
    return json(200, {
      ok: true, seed: pulled.seed, pulled: pulled.total,
      kept: pulled.total, inserted: 0, duplicate: 0,
      keywords: pulled.keywords,
    });
  }

  const t = nowSec();
  let inserted = 0, duplicate = 0;
  for (const k of pulled.keywords) {
    try {
      const r = await env.DB.prepare(
        `INSERT INTO prog_keywords (id, keyword, canonical, score, priority, intent, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`
      ).bind(newId(), k.keyword, k.canonical, k.score, k.score, k.intent, t, t).run();
      if (r?.meta?.changes) inserted++; else duplicate++;
    } catch {
      duplicate++; // UNIQUE on keyword
    }
  }
  audit(env, 'admin', 'prog_pull', null, { seed, pulled: pulled.total, inserted, duplicate });
  return json(200, {
    ok: true, seed: pulled.seed, pulled: pulled.total,
    kept: pulled.total, inserted, duplicate,
    keywords: pulled.keywords,
  });
};
