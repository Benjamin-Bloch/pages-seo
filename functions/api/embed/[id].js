// GET /api/embed/<id>
//
// Returns a self-contained embed widget for a named embed.
// Settings (title, accent, per_page, theme, palette) come from the
// blog_embeds row.
//
// Host page:
//   <div id="ps-blog"></div>
//   <script src="https://<your-site>/api/embed/<id>" defer></script>
//
// Like /widget.js, the bundle fetches /api/widget at runtime rather
// than embedding posts inline. That keeps the cached bundle small
// and means publishing a new post is reflected without re-fetching
// the embed JS.

import { json } from '../../_lib/util.js';
import { widgetBody } from '../../_lib/widget_render.js';

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

  // Settings: title, accent, per_page (was "limit" — kept for back-
  // compat), theme, palette. Anything missing falls back to defaults.
  const perPage = Math.min(50, Math.max(1,
    parseInt(settings.per_page, 10) || parseInt(settings.limit, 10) || 10));
  const title  = String(settings.title || embed?.name || 'Blog').slice(0, 100);
  const accent = String(settings.accent || '#0a0a0a').slice(0, 24);
  const theme  = ['auto', 'light', 'dark'].includes(settings.theme) ? settings.theme : 'auto';

  // Sanitise the palette: only known keys with short hex/rgba/css-name
  // values pass through.
  const palette = {};
  if (settings.palette && typeof settings.palette === 'object') {
    for (const k of ['bg', 'fg', 'muted', 'line', 'accent']) {
      const v = settings.palette[k];
      if (typeof v === 'string' && v.length <= 32 && /^[#a-zA-Z0-9(),.%/\s-]+$/.test(v)) {
        palette[k] = v;
      }
    }
  }

  const url = new URL(request.url);
  const apiBase = `${url.protocol}//${url.host}`;
  const js = widgetBody({ title, accent, apiBase, embedId: id, perPage, theme, palette });

  return new Response(js, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': `public, max-age=${CACHE_SEC}`,
      'access-control-allow-origin': '*',
    },
  });
};
