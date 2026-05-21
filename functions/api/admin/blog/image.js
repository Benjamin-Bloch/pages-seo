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

  // Decide path: 'cover' (server-renders /cover/<slug>.svg on
  // demand) or 'ai' (generates a fresh PNG via the configured
  // provider). Cover mode is the right answer when the user has
  // designed a template — every post then gets a consistent
  // branded hero with the title baked in, and the page renderer
  // points the hero img/og:image at /cover/<slug>.svg.
  let mode = 'ai';
  try {
    const settings = await loadSettings(env);
    mode = String(settings?.hero_image_mode || 'ai').toLowerCase() === 'cover' ? 'cover' : 'ai';
  } catch { /* fall back to ai */ }

  // ── cover path ───────────────────────────────────────────────────
  // When the user has hero_image_mode=cover AND a default template
  // exists, we skip image generation entirely. The page renderer
  // routes the hero <img>, og:image, and JSON-LD Article.image to
  // /cover/<slug>.svg, which renders live from the template + post
  // variables. No per-post PNG to store; no AI credits burned.
  //
  // We don't write hero_image_key in this path — leaving it null
  // is the signal that "this post uses the cover endpoint, not a
  // stored asset." The Updates tab and admin calendar still show
  // the post as image-complete because we set status='image_done'.
  //
  // If no default template exists we silently downgrade to AI so
  // the job still finishes — users may set hero_image_mode=cover
  // before they've designed a template, and we don't want to block
  // the daily cron on that.
  let didRenderViaCover = false;
  if (mode === 'cover') {
    try {
      const tplRow = await env.DB.prepare(
        'SELECT id, name FROM cover_templates WHERE is_default = 1 LIMIT 1'
      ).first();
      if (tplRow?.id) {
        // Don't render anything. Don't write to R2. The /cover/<slug>.svg
        // endpoint does the rendering live per request, cached at the
        // edge. hero_image_key stays null; the page renderer in
        // page_render.js knows to use the cover endpoint instead of
        // /image/<key> when settings.hero_image_mode === 'cover' AND
        // settings._has_default_template (which is true here by
        // construction).
        imageProvider = 'cover-template:' + (tplRow.name || tplRow.id);
        didRenderViaCover = true;
      }
      // No template? Fall through to AI silently.
    } catch (e) {
      // Lookup error — fall through to AI rather than crash the job.
      imageError = 'cover_lookup_failed: ' + String(e?.message || e).slice(0, 200);
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
