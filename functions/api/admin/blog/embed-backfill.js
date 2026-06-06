// POST /api/admin/blog/embed-backfill
//
// One-shot maintenance endpoint: embed and store vectors for every
// published post that doesn't already have one. Safe to run repeatedly
// — skips posts with embeddings already populated.
//
// Returns { ok, embedded, skipped, errors } so the caller can see what
// happened. Per-call cap of 25 posts to stay well inside the Worker
// CPU budget.

import { json, nowSec } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';
import { storeEmbedding } from '../../../_lib/dedup.js';

const BATCH_LIMIT = 25;

export const onRequestPost = async ({ request, env }) => {
  const gate = await adminGate(env, request); if (gate) return gate;

  const rows = await env.DB.prepare(
    `SELECT slug, title, meta_description, body_markdown
       FROM blog_posts
      WHERE status = 'published' AND embedding IS NULL
      ORDER BY published_at ASC LIMIT ?`
  ).bind(BATCH_LIMIT).all().catch(() => ({ results: [] }));

  const todo = rows.results || [];
  const out = { ok: true, candidates: todo.length, embedded: 0, errors: [] };

  for (const r of todo) {
    const res = await storeEmbedding(env, r.slug, {
      title: r.title,
      body_markdown: r.body_markdown,
      meta_description: r.meta_description,
    });
    if (res.ok) out.embedded++;
    else out.errors.push({ slug: r.slug, reason: res.reason });
  }

  out.remaining_estimate = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM blog_posts WHERE status='published' AND embedding IS NULL`
  ).first().then((r) => r?.n || 0).catch(() => null);
  out.finished_at = nowSec();
  return json(200, out);
};
