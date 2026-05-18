// /image/<key> — streams a hero image out of R2.
// Public-read. Keys are slug-prefixed timestamps so enumeration isn't useful.
export const onRequestGet = async ({ env, params }) => {
  const key = String(params.key || '');
  if (!key || !/^[a-zA-Z0-9._-]+$/.test(key)) {
    return new Response('Not found', { status: 404 });
  }
  if (!env.IMAGES) return new Response('R2 not bound', { status: 500 });
  const obj = await env.IMAGES.get(key);
  if (!obj) return new Response('Not found', { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  headers.set('etag', obj.httpEtag);
  return new Response(obj.body, { headers });
};
