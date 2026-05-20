// Step 3/4 — generate hero image and upload to R2. Non-fatal if it fails
// (the job advances to image_done without a key).
//
// Two paths, chosen by the hero_image_mode setting:
//
//   'ai'    — call generateImage() (Workers AI / Flux / configured
//             provider) with the post's hero_image_prompt. The
//             historical default.
//   'cover' — render the default cover_template with this post's
//             title as the {title} context. Server-side rendering
//             via /api/admin/cover/render-server. If that endpoint
//             returns 501 (not yet implemented), we transparently
//             fall back to the AI path so the job still completes.
//
// The 'cover' path is the maintainer's "exclusive" route: it uses a
// template they designed (e.g. the "main — official" one installed
// via /api/admin/cover/install-official) instead of letting the AI
// pick. Users who want the AI look keep mode='ai'.
import { json, nowSec } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';
import { generateImage } from '../../../_lib/ai.js';
import { loadSettings } from '../../../_lib/settings.js';

export const onRequestPost = async ({ request, env }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }
  const jobId = String(body.job_id || '');
  if (!jobId) return json(400, { error: 'missing_job_id' });

  const job = await env.DB.prepare('SELECT * FROM blog_jobs WHERE id = ? LIMIT 1').bind(jobId).first();
  if (!job) return json(404, { error: 'job_not_found' });
  if (['image_done', 'published'].includes(job.status)) {
    return json(200, { ok: true, job_id: jobId, status: job.status, idempotent: true });
  }
  if (job.status !== 'text_done') {
    return json(409, { error: 'wrong_state', current: job.status, hint: 'call /text first' });
  }
  if (!job.hero_image_prompt) {
    await env.DB.prepare("UPDATE blog_jobs SET status='image_done', updated_at=? WHERE id=?")
      .bind(nowSec(), jobId).run();
    return json(200, { ok: true, job_id: jobId, status: 'image_done', image_skipped: true });
  }

  let imageKey = null;
  let imageError = null;
  let imageProvider = null;

  // Decide path: 'cover' (server-side template render) or 'ai'.
  // Default is 'ai' if the setting is unset or empty.
  let mode = 'ai';
  try {
    const settings = await loadSettings(env);
    mode = String(settings?.hero_image_mode || 'ai').toLowerCase() === 'cover' ? 'cover' : 'ai';
  } catch { /* fall back to ai */ }

  // ── cover path ───────────────────────────────────────────────────
  // Look up the default template; if there isn't one, silently
  // downgrade to the AI path (the user hasn't actually set up a
  // template yet, so we shouldn't refuse to render).
  let didRenderViaCover = false;
  if (mode === 'cover') {
    try {
      const tplRow = await env.DB.prepare(
        'SELECT id, name, spec_json FROM cover_templates WHERE is_default = 1 LIMIT 1'
      ).first();
      if (tplRow?.spec_json) {
        const spec = JSON.parse(tplRow.spec_json);
        // Call the server-side renderer. Today this is a stub that
        // returns 501 — we treat that exactly like "cover mode not
        // available" and fall through to AI. Once the satori
        // integration ships in render-server.js, this path will
        // start working without further changes here.
        const u = new URL(request.url);
        u.pathname = '/api/admin/cover/render-server';
        const r = await fetch(u.toString(), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // Forward the admin auth so render-server's adminGate
            // accepts us. Pass cookie + bearer if present; one of
            // them will let the inner request through.
            cookie: request.headers.get('cookie') || '',
            authorization: request.headers.get('authorization') || '',
          },
          body: JSON.stringify({ spec, title: job.title, slug: job.slug, post_id: job.id }),
        });
        if (r.ok) {
          const out = await r.json().catch(() => ({}));
          if (out?.base64) {
            // The renderer returns base64. Decode + put to R2 here
            // so the audit trail matches the AI path's location.
            const m = String(out.base64).match(/^data:image\/png;base64,(.+)$/i);
            const raw = m ? m[1] : String(out.base64);
            const bin = atob(raw.replace(/\s+/g, ''));
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            imageKey = `${job.slug}-${Date.now()}.png`;
            if (!env.IMAGES) throw new Error('r2_binding_missing');
            await env.IMAGES.put(imageKey, bytes, {
              httpMetadata: { contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable' },
            });
            imageProvider = 'cover-template:' + (tplRow.name || tplRow.id);
            didRenderViaCover = true;
          }
        }
        // r.status === 501 → render-server isn't built yet, fall
        // through. Any other error also falls through to AI rather
        // than blocking the job.
      }
    } catch (e) {
      // Record the fallback reason but keep going; the AI path
      // below will populate hero_image_key for real.
      imageError = 'cover_fallback: ' + String(e?.message || e).slice(0, 200);
    }
  }

  // ── AI path (default + fallback) ─────────────────────────────────
  if (!didRenderViaCover) {
    try {
      const source = request.headers.get('X-Source-Cron') === '1' ? 'cron-blog' : 'admin-blog';
      const r = await generateImage(env, { prompt: job.hero_image_prompt, provider: body.provider, source });
      imageProvider = r.ai_provider;
      imageKey = `${job.slug}-${Date.now()}.png`;
      if (!env.IMAGES) throw new Error('r2_binding_missing');
      await env.IMAGES.put(imageKey, r.bytes, {
        httpMetadata: { contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable' },
      });
    } catch (e) {
      imageError = String(e.message || e).slice(0, 800);
      imageKey = null;
    }
  }

  await env.DB.prepare(
    `UPDATE blog_jobs SET status='image_done', hero_image_key=?, error=?, updated_at=? WHERE id=?`
  ).bind(imageKey, imageError ? 'image:' + imageError : null, nowSec(), jobId).run();

  return json(200, {
    ok: true, job_id: jobId, status: 'image_done',
    image_uploaded: !!imageKey,
    image_error: imageError,
    image_provider: imageProvider,
  });
};
