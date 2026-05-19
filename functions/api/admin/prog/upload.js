// Upload a keyword list. Body: { keywords: ["how to ...","best ...", ...] }
// or { csv: "kw1\nkw2\nkw3" }. Returns counts of inserted vs duplicate vs
// dropped (junk). Each keyword is scored and dedupe'd by canonical form.
import { json, newId, nowSec, audit } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';
import { scoreKeyword, canonicaliseKeyword } from '../../../_lib/keyword_score.js';

export const onRequestPost = async ({ request, env }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }

  // Accept either an array or a CSV/newline string.
  let raw = [];
  if (Array.isArray(body?.keywords)) raw = body.keywords;
  else if (typeof body?.csv === 'string') raw = body.csv.split(/\r?\n/);
  raw = raw.map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
  if (!raw.length) return json(400, { error: 'no_keywords' });
  if (raw.length > 5000) return json(400, { error: 'too_many', max: 5000 });

  // Score + dedupe by canonical form before hitting the DB.
  const byCanonical = new Map();
  let droppedJunk = 0;
  for (const kw of raw) {
    const scored = scoreKeyword(kw);
    if (scored.intent === 'junk') { droppedJunk++; continue; }
    const canon = canonicaliseKeyword(kw);
    if (!canon) continue;
    const existing = byCanonical.get(canon);
    if (!existing || scored.score > existing.score) {
      byCanonical.set(canon, { keyword: kw, canonical: canon, score: scored.score, intent: scored.intent });
    }
  }

  const t = nowSec();
  let inserted = 0, duplicate = 0;
  for (const k of byCanonical.values()) {
    try {
      const r = await env.DB.prepare(
        `INSERT INTO prog_keywords (id, keyword, canonical, score, priority, intent, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`
      ).bind(newId(), k.keyword, k.canonical, k.score, k.score, k.intent, t, t).run();
      if (r?.meta?.changes) inserted++; else duplicate++;
    } catch {
      duplicate++; // UNIQUE constraint
    }
  }
  audit(env, 'admin', 'prog_upload', null, { inserted, duplicate, droppedJunk, total: raw.length });
  return json(200, { ok: true, inserted, duplicate, dropped_junk: droppedJunk, deduplicated_to: byCanonical.size, total: raw.length });
};
