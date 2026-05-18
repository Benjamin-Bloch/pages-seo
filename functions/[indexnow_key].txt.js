// Serves /<INDEXNOW_KEY>.txt — the IndexNow verification file.
// Bing/Yandex/Seznam fetch this URL to prove we own the host.
//
// The key itself is stored as a secret so it never lives in the repo;
// the Function compares the requested path-segment against the secret.
export const onRequestGet = ({ params, env }) => {
  const requested = String(params.indexnow_key || '').toLowerCase();
  const expected = String(env.INDEXNOW_KEY || '').toLowerCase();
  if (!expected || requested !== expected) {
    return new Response('not found', { status: 404 });
  }
  return new Response(env.INDEXNOW_KEY, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
};
