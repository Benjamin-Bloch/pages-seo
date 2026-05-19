// GET /widget.js — generic Soro-style embed snippet.
//
// Usage on the host page:
//   <div id="ps-blog"></div>
//   <script src="https://<your-site>/widget.js" defer></script>
//
// Renders the latest published posts as cards; clicking a card opens
// the article in place (deep-linkable via ?post=<slug>). For a named
// embed with custom settings (title, accent, limit), use /api/embed/<id>.

import { widgetBody, loadArticles } from './_lib/widget_render.js';

export const onRequestGet = async ({ env, request }) => {
  const url = new URL(request.url);
  const apiBase = `${url.protocol}//${url.host}`;
  const title = env?.SITE_NAME ? `${env.SITE_NAME} · Blog` : 'Blog';
  const articles = env?.DB ? await loadArticles(env, 30) : [];
  const js = widgetBody({ title, apiBase, articles });
  return new Response(js, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=300, s-maxage=600',
      'access-control-allow-origin': '*',
    },
  });
};
