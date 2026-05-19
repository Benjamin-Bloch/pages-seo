// Upload a cover-editor asset (background image or logo) to R2.
//
// POST /api/admin/cover/upload
//   Body: { kind: 'background' | 'logo',
//           filename: 'hero.jpg',
//           content_type: 'image/jpeg',
//           base64: '...',
//           width?: 1920, height?: 1080 }
//
// Why JSON-base64 rather than multipart: Pages Functions handle multipart
// fine but accessing the bytes is awkward, and bg/logos are small enough
// (≤ 10MB after the limit below) that the base64 overhead is fine.
//
// R2 keys live under `cover/<kind>/<id>.<ext>` so admin housekeeping
// is straightforward: `wrangler r2 object delete <bucket> cover/...`.
import { json, newId, nowSec, audit } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';

const MAX_BYTES = 10 * 1024 * 1024;        // 10 MB
const ALLOWED_KINDS = new Set(['background', 'logo']);
const ALLOWED_MIME  = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml']);

// Build a /image/<path> URL. The R2 key contains literal "/" segments
// (e.g. cover/background/<id>.png) and the Pages route reads those as
// distinct path params. encodeURIComponent on the whole string would
// turn each "/" into "%2F", which makes the route 404. Encode each
// segment separately and re-join with literal slashes.
function imageUrlFor(key) {
  return '/image/' + key.split('/').map(encodeURIComponent).join('/');
}

function extFor(mime) {
  return ({
    'image/jpeg': 'jpg',
    'image/png':  'png',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
  })[mime] || 'bin';
}

function decodeBase64(b64) {
  // Strip a data: URL prefix if the client included one.
  const m = String(b64 || '').match(/^data:[^;]+;base64,(.+)$/i);
  const raw = m ? m[1] : String(b64 || '');
  const bin = atob(raw.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const onRequestPost = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  if (!env.IMAGES) return json(500, { error: 'r2_binding_missing' });

  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }

  const kind = String(body?.kind || '').toLowerCase();
  if (!ALLOWED_KINDS.has(kind)) return json(400, { error: 'kind_must_be_background_or_logo' });

  const mime = String(body?.content_type || '').toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    return json(400, { error: 'unsupported_mime', allowed: [...ALLOWED_MIME] });
  }

  let bytes;
  try { bytes = decodeBase64(body?.base64); }
  catch { return json(400, { error: 'base64_decode_failed' }); }
  if (!bytes.length) return json(400, { error: 'empty_body' });
  if (bytes.length > MAX_BYTES) {
    return json(413, { error: 'too_large', max_bytes: MAX_BYTES, got_bytes: bytes.length });
  }

  const id = newId();
  const key = `cover/${kind}/${id}.${extFor(mime)}`;
  try {
    await env.IMAGES.put(key, bytes, {
      httpMetadata: {
        contentType: mime,
        // Aggressive caching is safe: keys include a random id, never
        // overwritten. The bytes are immutable for the lifetime of the
        // asset.
        cacheControl: 'public, max-age=31536000, immutable',
      },
    });
  } catch (e) {
    return json(500, { error: 'r2_put_failed', detail: String(e?.message || e).slice(0, 200) });
  }

  const t = nowSec();
  await env.DB.prepare(
    `INSERT INTO cover_assets
       (id, kind, r2_key, original_name, mime, size_bytes, width, height, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, kind, key,
    String(body?.filename || '').slice(0, 200),
    mime, bytes.length,
    body?.width  ? parseInt(body.width, 10)  : null,
    body?.height ? parseInt(body.height, 10) : null,
    t,
  ).run();

  audit(env, 'admin', 'cover_upload', id, { kind, mime, size_bytes: bytes.length });

  return json(200, {
    ok: true,
    asset: {
      id, kind, r2_key: key,
      url: imageUrlFor(key),
      mime, size_bytes: bytes.length,
      width: body?.width || null,
      height: body?.height || null,
    },
  });
};

// List assets, newest first. Filter with ?kind=background|logo.
export const onRequestGet = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  const url = new URL(request.url);
  const kind = url.searchParams.get('kind');
  const limit = Math.min(200, parseInt(url.searchParams.get('limit'), 10) || 60);
  const params = kind ? [kind, limit] : [limit];
  const where = kind ? 'WHERE kind = ?' : '';
  const r = await env.DB.prepare(
    `SELECT id, kind, r2_key, original_name, mime, size_bytes, width, height, created_at
       FROM cover_assets ${where} ORDER BY created_at DESC LIMIT ?`
  ).bind(...params).all();
  const assets = (r?.results || []).map((a) => ({
    ...a, url: imageUrlFor(a.r2_key),
  }));
  return json(200, { ok: true, assets });
};

// Delete an asset. Removes the R2 object too.
export const onRequestDelete = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  const url = new URL(request.url);
  const id = String(url.searchParams.get('id') || '');
  if (!id) return json(400, { error: 'missing_id' });
  const row = await env.DB.prepare('SELECT r2_key FROM cover_assets WHERE id = ? LIMIT 1').bind(id).first();
  if (!row) return json(404, { error: 'not_found' });
  try { await env.IMAGES.delete(row.r2_key); } catch { /* keep going */ }
  await env.DB.prepare('DELETE FROM cover_assets WHERE id = ?').bind(id).run();
  audit(env, 'admin', 'cover_delete', id, {});
  return json(200, { ok: true });
};
