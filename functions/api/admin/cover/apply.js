// Apply a rendered cover PNG to an existing blog post or blog job.
//
// POST /api/admin/cover/apply
//   { target: 'post' | 'job', id: '<row id>', base64: '<png data>' }
//
// Writes the PNG to R2 under a fresh key, updates the row's
// hero_image_key, and returns the public URL. Used by the cover editor
// after the user clicks "Use this for the current post".
//
// We don't render server-side — the client produces the final PNG via
// canvas.toBlob(). This keeps cover compositing off the Pages Functions
// CPU budget entirely, and lets the admin see exactly what gets shipped.
import { json, nowSec, audit } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB — covers shouldn't exceed this

function decodeBase64Png(b64) {
  const m = String(b64 || '').match(/^data:image\/png;base64,(.+)$/i);
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
  const target = String(body?.target || '').toLowerCase();
  const id = String(body?.id || '').trim();
  if (!['post', 'job'].includes(target)) return json(400, { error: 'target_must_be_post_or_job' });
  if (!id) return json(400, { error: 'missing_id' });

  // Look up the row + its current slug so the new R2 key is descriptive.
  let row, table, slugCol;
  if (target === 'post') {
    table = 'blog_posts'; slugCol = 'slug';
    row = await env.DB.prepare('SELECT id, slug FROM blog_posts WHERE id = ? LIMIT 1').bind(id).first();
  } else {
    table = 'blog_jobs'; slugCol = 'slug';
    row = await env.DB.prepare('SELECT id, slug FROM blog_jobs WHERE id = ? LIMIT 1').bind(id).first();
  }
  if (!row) return json(404, { error: 'target_not_found' });

  let bytes;
  try { bytes = decodeBase64Png(body?.base64); }
  catch { return json(400, { error: 'base64_decode_failed' }); }
  if (!bytes.length) return json(400, { error: 'empty_body' });
  if (bytes.length > MAX_BYTES) return json(413, { error: 'too_large', max_bytes: MAX_BYTES });

  const slug = row.slug || 'cover';
  const key = `${slug}-cover-${Date.now()}.png`;
  try {
    await env.IMAGES.put(key, bytes, {
      httpMetadata: { contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable' },
    });
  } catch (e) {
    return json(500, { error: 'r2_put_failed', detail: String(e?.message || e).slice(0, 200) });
  }

  await env.DB.prepare(
    `UPDATE ${table} SET hero_image_key = ? WHERE id = ?`
  ).bind(key, id).run();

  audit(env, 'admin', 'cover_apply', id, { target, r2_key: key, size_bytes: bytes.length });
  return json(200, {
    ok: true,
    hero_image_key: key,
    url: `/image/${encodeURIComponent(key)}`,
  });
};
