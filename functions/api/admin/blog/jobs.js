// GET — list unpublished jobs for the admin "drafts & failed" panel.
import { json } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';

export const onRequestGet = async ({ request, env }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  const r = await env.DB.prepare(
    `SELECT id, status, topic_key, slug, title, hero_image_key, ai_provider,
            error, created_at, updated_at
       FROM blog_jobs
      WHERE status != 'published'
      ORDER BY updated_at DESC LIMIT 50`
  ).all();
  return json(200, { jobs: r.results || [] });
};
