// Upload a keyword list. Body: { keywords: ["how to ...","best ...", ...] }
// or { csv: "kw1\nkw2\nkw3" }. Returns counts of inserted vs duplicate.
import { json, newId, nowSec, audit } from '../../../_lib/util.js';
import { requireAdmin } from '../../../_lib/auth.js';

export const onRequestPost = async ({ request, env }) => {
  if (!requireAdmin(env, request)) return json(401, { error: 'unauthorized' });
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }

  // Accept either an array or a CSV/newline string.
  let list = [];
  if (Array.isArray(body?.keywords)) list = body.keywords;
  else if (typeof body?.csv === 'string') list = body.csv.split(/\r?\n/);
  list = list.map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
  if (!list.length) return json(400, { error: 'no_keywords' });
  if (list.length > 5000) return json(400, { error: 'too_many', max: 5000 });

  const t = nowSec();
  let inserted = 0, duplicate = 0;
  for (const kw of list) {
    const id = newId();
    try {
      const r = await env.DB.prepare(
        `INSERT INTO prog_keywords (id, keyword, status, attempts, created_at, updated_at)
         VALUES (?, ?, 'pending', 0, ?, ?)`
      ).bind(id, kw, t, t).run();
      if (r?.meta?.changes) inserted++; else duplicate++;
    } catch {
      duplicate++; // UNIQUE constraint
    }
  }
  audit(env, 'admin', 'prog_upload', null, { inserted, duplicate, total: list.length });
  return json(200, { ok: true, inserted, duplicate, total: list.length });
};
