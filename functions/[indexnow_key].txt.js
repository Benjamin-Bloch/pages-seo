// Serves /<INDEXNOW_KEY>.txt — the IndexNow verification file.
// Bing/Yandex/Seznam fetch this URL to prove we own the host.
//
// The key resolves the same way as ADMIN_TOKEN: Pages secret first,
// D1-stored setting second. That covers both the CLI install path
// (sets the secret) and the browser / 1-click Deploy install paths
// (which store it in D1 via /api/setup).

import { getIndexNowKey } from './_lib/indexnow_key.js';

export const onRequestGet = async ({ params, env }) => {
  const requested = String(params.indexnow_key || '').toLowerCase();
  const expected = (await getIndexNowKey(env)).toLowerCase();
  if (!expected || requested !== expected) {
    return new Response('not found', { status: 404 });
  }
  return new Response(expected, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
};
