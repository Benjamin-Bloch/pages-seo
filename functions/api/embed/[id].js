// GET /api/embed/<id>
//
// Returns a self-contained Soro-style widget for a named embed.
// Settings (title, accent, limit) come from the blog_embeds row.
//
// Host page:
//   <div id="ps-blog"></div>
//   <script src="https://<your-site>/api/embed/<id>" defer></script>

import { json } from '../../_lib/util.js';
import { widgetBody, loadArticles } from '../../_lib/widget_render.js';

const CACHE_SEC = 300;

export const onRequestGet = async ({ env, params, request }) => {
  if (!env?.DB) return json(500, { error: 'no_db' });
  const id = String(params.id || '').trim();
  if (!id || !/^[a-zA-Z0-9_-]{6,64}$/.test(id)) {
    return new Response('// embed: invalid id\n', {
      status: 404,
      headers: { 'content-type': 'application/javascript; charset=utf-8' },
    });
  }

  const embed = await env.DB.prepare(
    `SELECT id, name, settings_json FROM blog_embeds WHERE id = ? LIMIT 1`
  ).bind(id).first().catch(() => null);

  let settings = {};
  if (embed?.settings_json) {
    try { settings = JSON.parse(embed.settings_json) || {}; } catch { /* default */ }
  }

  const limit = Math.min(100, Math.max(1, parseInt(settings.limit, 10) || 30));
  const title = String(settings.title || embed?.name || 'Blog').slice(0, 100);
  const accent = String(settings.accent || '#0a0a0a').slice(0, 24);

  const url = new URL(request.url);
  const apiBase = `${url.protocol}//${url.host}`;
  const articles = await loadArticles(env, limit);
  const js = widgetBody({ title, accent, apiBase, embedId: id, articles });

  return new Response(js, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': `public, max-age=${CACHE_SEC}`,
      'access-control-allow-origin': '*',
    },
  });
};
