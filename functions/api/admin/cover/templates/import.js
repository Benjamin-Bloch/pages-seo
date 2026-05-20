// POST /api/admin/cover/templates/import
//
// Inverse of export.js: takes a .template file (JSON), re-uploads
// every embedded asset to THIS install's R2, rewrites the URLs in
// the template spec, then INSERTs a new cover_templates row.
//
// Body shape (matches export.js):
//   {
//     "format":   "pages-seo-cover-template",
//     "template": { "name", "is_default", "spec" },
//     "assets":   { "<original-url>": { kind, filename, mime, base64, width?, height? } }
//   }
//
// On success:
//   200 { ok: true, id: <new template id>, assets_imported: N,
//         assets_missing: M, name: <name used> }
//
// Failure modes (all 4xx so clients can show specific errors):
//   400 bad_json | missing_spec | wrong_format
//   413 asset_too_large | too_many_assets
//   500 r2_put_failed
//
// Idempotency: re-importing the same file just creates another
// template with a "(2)" name suffix; we never overwrite by name. The
// admin can delete duplicates from the editor.

import { json, newId, nowSec, audit } from '../../../../_lib/util.js';
import { adminGate } from '../../../../_lib/auth.js';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ASSETS = 50;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;   // hard cap across all assets
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml']);

function decodeBase64(b64) {
  const m = String(b64 || '').match(/^data:[^;]+;base64,(.+)$/i);
  const raw = m ? m[1] : String(b64 || '');
  const bin = atob(raw.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function extFor(mime) {
  return ({
    'image/jpeg': 'jpg',
    'image/png':  'png',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
  })[mime] || 'bin';
}

function imageUrlFor(key) {
  return '/image/' + key.split('/').map(encodeURIComponent).join('/');
}

// Walk the spec and replace every occurrence of the URLs in the
// urlMap with their new values. We do this by string replacement on
// background.url and any layer.url. The keys are exact URL matches
// so no regex weirdness.
function rewriteSpecUrls(spec, urlMap) {
  if (spec?.background?.url && urlMap.has(spec.background.url)) {
    spec.background.url = urlMap.get(spec.background.url);
  }
  for (const l of (spec?.layers || [])) {
    if (l?.kind === 'logo' && l?.url && urlMap.has(l.url)) {
      l.url = urlMap.get(l.url);
    }
  }
  return spec;
}

// Make a destination template name unique. We DO NOT replace by name —
// that would silently clobber the user's existing template.
async function uniqueName(env, baseName) {
  const trim = (s) => String(s || '').slice(0, 110);
  let name = trim(baseName) || 'imported template';
  let n = 1;
  // Cap at 50 attempts so a deranged caller can't pin us.
  while (n < 50) {
    const row = await env.DB.prepare(
      'SELECT 1 FROM cover_templates WHERE name = ? LIMIT 1'
    ).bind(name).first();
    if (!row) return name;
    n++;
    name = trim(`${baseName} (${n})`);
  }
  return `${trim(baseName)} (${Date.now()})`;
}

export const onRequestPost = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  if (!env.IMAGES) return json(500, { error: 'r2_binding_missing' });

  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }

  // Header check. Treat older versions tolerantly (we'll only ever
  // *expand* the format), but refuse anything that isn't our format.
  if (body?.format !== 'pages-seo-cover-template') {
    return json(400, { error: 'wrong_format', expected: 'pages-seo-cover-template', got: body?.format });
  }

  const tpl = body?.template;
  if (!tpl?.spec || typeof tpl.spec !== 'object') return json(400, { error: 'missing_spec' });
  if (typeof tpl.spec !== 'object' || !Array.isArray(tpl.spec.layers)) {
    return json(400, { error: 'spec_layers_invalid' });
  }

  const assets = body?.assets && typeof body.assets === 'object' ? body.assets : {};
  const assetEntries = Object.entries(assets);
  if (assetEntries.length > MAX_ASSETS) {
    return json(413, { error: 'too_many_assets', max: MAX_ASSETS, got: assetEntries.length });
  }

  // ── Re-upload each asset to this install's R2. ──────────────────
  const urlMap = new Map();   // old URL → new URL
  let importedCount = 0;
  let missingCount = 0;
  let totalBytes = 0;

  for (const [oldUrl, meta] of assetEntries) {
    if (meta?.missing || !meta?.base64) {
      // Exporter marked this asset as gone — skip. The spec keeps
      // the old URL; the renderer will produce its built-in
      // placeholder.
      missingCount++;
      continue;
    }
    const mime = String(meta.mime || '').toLowerCase();
    if (!ALLOWED_MIME.has(mime)) {
      missingCount++;
      continue;
    }
    let bytes;
    try { bytes = decodeBase64(meta.base64); }
    catch { missingCount++; continue; }
    if (!bytes.length) { missingCount++; continue; }
    if (bytes.length > MAX_BYTES) {
      return json(413, { error: 'asset_too_large', max_bytes: MAX_BYTES, asset: oldUrl });
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return json(413, { error: 'total_too_large', max_bytes: MAX_TOTAL_BYTES });
    }

    const kind = meta.kind === 'background' ? 'background' : 'logo';
    const assetId = newId();
    const key = `cover/${kind}/${assetId}.${extFor(mime)}`;

    try {
      await env.IMAGES.put(key, bytes, {
        httpMetadata: {
          contentType: mime,
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
      assetId, kind, key,
      String(meta.filename || 'imported').slice(0, 200),
      mime, bytes.length,
      meta.width  ? parseInt(meta.width, 10)  : null,
      meta.height ? parseInt(meta.height, 10) : null,
      t,
    ).run();

    urlMap.set(oldUrl, imageUrlFor(key));
    importedCount++;
  }

  // ── Rewrite spec URLs to the new local ones. ────────────────────
  const rewrittenSpec = rewriteSpecUrls(JSON.parse(JSON.stringify(tpl.spec)), urlMap);

  // ── Name collision handling. ───────────────────────────────────
  const name = await uniqueName(env, tpl.name || 'imported template');

  // ── Default flag handling. Importing with is_default=true does
  // demote the previous default, matching POST behaviour in
  // templates.js. We default to is_default=false on import so a
  // sloppy share doesn't silently take over the host's brand.
  const isDefault = body?.set_default ? 1 : 0;
  if (isDefault) {
    await env.DB.prepare('UPDATE cover_templates SET is_default = 0 WHERE is_default = 1').run();
  }

  const id = newId();
  const t = nowSec();
  let spec_json;
  try { spec_json = JSON.stringify(rewrittenSpec); }
  catch { return json(400, { error: 'spec_serialise_failed' }); }
  if (spec_json.length > 64 * 1024) {
    return json(413, { error: 'spec_too_large_after_rewrite', size: spec_json.length });
  }

  await env.DB.prepare(
    `INSERT INTO cover_templates (id, name, is_default, spec_json, thumb_r2_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, name, isDefault, spec_json, null, t, t).run();

  audit(env, 'admin', 'cover_template_import', id, {
    name, assets_imported: importedCount, assets_missing: missingCount,
  });

  return json(200, {
    ok: true,
    id, name,
    assets_imported: importedCount,
    assets_missing: missingCount,
    is_default: !!isDefault,
  });
};
