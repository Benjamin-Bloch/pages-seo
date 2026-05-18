// GET — list keywords in the queue (any status).
import { json } from '../../../_lib/util.js';
import { requireAdmin } from '../../../_lib/auth.js';

export const onRequestGet = async ({ request, env }) => {
  if (!requireAdmin(env, request)) return json(401, { error: 'unauthorized' });
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'pending';
  const limit = Math.min(500, parseInt(url.searchParams.get('limit'), 10) || 100);
  const r = await env.DB.prepare(
    `SELECT id, keyword, status, attempts, page_id, error, created_at, updated_at
       FROM prog_keywords WHERE status=? ORDER BY created_at LIMIT ?`
  ).bind(status, limit).all();
  return json(200, { keywords: r.results || [] });
};
