// GET /widget.js — generic embed snippet.
//
// Usage on the host page:
//   <div id="ps-blog"></div>
//   <script src="https://<your-site>/widget.js" defer></script>
//
// Renders the latest published posts as cards with search, pagination,
// hash-deeplink to /article view. For a named embed with custom
// settings (title, accent, limit, theme), use /api/embed/<id>.
//
// The bundle no longer pre-bakes posts — it fetches /api/widget at
// runtime — so the file size is constant regardless of how many
// posts the site has.

import { widgetBody } from './_lib/widget_render.js';
import { getSiteIdentity } from './_lib/site_identity.js';

export const onRequestGet = async ({ env, request }) => {
  const url = new URL(request.url);
  const apiBase = `${url.protocol}//${url.host}`;
  // Resolve via Pages secret first, D1 setting second so 1-click
  // Deploy installs get a proper title without needing a secret.
  const id = await getSiteIdentity(env);
  const title = id.name ? `${id.name} · Blog` : 'Blog';
  const js = widgetBody({ title, apiBase, perPage: 10 });
  return new Response(js, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=300, s-maxage=600',
      'access-control-allow-origin': '*',
    },
  });
};
