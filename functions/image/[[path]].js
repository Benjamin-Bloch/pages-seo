// /image/<key> — streams a hero image out of R2.
//
// Catch-all path so we can serve both flat blog/prog covers (e.g.
// "my-slug-cover-123.png") and namespaced cover-editor assets
// (e.g. "cover/background/abc.png"). The R2 key is reconstructed by
// joining `params.path` segments with "/".
//
// Allowed key characters: letters, digits, dot, dash, underscore, slash.
// Anything else 404s — defends against path traversal and exotic chars.
export const onRequestGet = async ({ env, params }) => {
  const parts = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);
  const key = parts.join('/');
  if (!key || !/^[a-zA-Z0-9._/-]+$/.test(key) || key.includes('..')) {
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }
  if (!env.IMAGES) return new Response('R2 not bound', { status: 500 });
  const obj = await env.IMAGES.get(key);
  if (!obj) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  headers.set('etag', obj.httpEtag);
  // CORS: same-origin doesn't strictly need this, but the cover editor
  // uses canvas + img.crossOrigin to enable canvas.toBlob() output, and
  // a future custom-domain split (e.g. images.benjaminb.xyz) would
  // require CORS to avoid tainted-canvas errors. Cheap to always set.
  headers.set('access-control-allow-origin', '*');
  return new Response(obj.body, { headers });
};
