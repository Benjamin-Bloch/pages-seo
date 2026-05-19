// GET — admin's view of every blog post (published + hidden).
import { json } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';

export const onRequestGet = async ({ request, env }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  const r = await env.DB.prepare(
    `SELECT id, slug, title, status, hero_image_key, keywords, ai_provider,
            published_at, hidden_at
       FROM blog_posts ORDER BY published_at DESC LIMIT 200`
  ).all();
  return json(200, { posts: r.results || [] });
};
