// GET /api/admin/cover/templates/export?id=<template-id>
//
// Dumps a cover template — spec + every R2 asset it references — into
// a single self-contained .template file. The file is plain JSON; the
// extension is just labelling so users know what they've downloaded.
//
// Why bundle the assets:
//   Cover templates reference backgrounds + logos by their /image/...
//   URL. Those URLs only work on the install that uploaded the
//   binaries — they 404 on a different domain. To make a template
//   genuinely transferrable, the export has to carry the binary
//   bytes inline so the receiver can re-upload to their own R2.
//
// File shape (see import.js for the inverse):
//
//   {
//     "format":         "pages-seo-cover-template",
//     "format_version": 1,
//     "exported_at":    1779280000,
//     "source": { "host": "<exporting host>", "brand_name": "<brand>" },
//     "template": {
//       "name":       "main — official",
//       "is_default": false,
//       "spec":       { …unchanged layer JSON… }
//     },
//     "assets": {
//       "<original-r2-key-or-url>": {
//         "kind": "background"|"logo",
//         "filename": "...",
//         "mime": "image/png",
//         "width": 1200, "height": 630,
//         "base64": "iVBOR..."
//       },
//       …
//     }
//   }
//
// The receiver (import.js) re-uploads each asset, rewrites every
// matching URL in the spec to the new local /image/... URL, and
// saves the rewritten template.

import { json, audit } from '../../../../_lib/util.js';
import { adminGate } from '../../../../_lib/auth.js';
import { loadSettings } from '../../../../_lib/settings.js';

const MAX_ASSETS = 50;
const MAX_ASSET_BYTES = 12 * 1024 * 1024;  // matches the 10MB import side + headroom

// Pull every /image/cover/<...> URL out of the spec. Backgrounds live
// at spec.background.url; logos at layer.url for kind:'logo' layers.
// Returns a Set of unique URLs.
function collectAssetUrls(spec) {
  const urls = new Set();
  const push = (u) => {
    if (typeof u === 'string' && u.startsWith('/image/')) urls.add(u);
  };
  if (spec?.background?.url) push(spec.background.url);
  for (const l of (spec?.layers || [])) {
    if (l?.kind === 'logo' && l?.url) push(l.url);
  }
  return urls;
}

// Convert /image/cover/<kind>/<id>.<ext> back to the R2 key. The URL
// uses encoded slashes per-segment (see upload.js); reverse that here.
function urlToR2Key(url) {
  // /image/cover/background/abc.png → cover/background/abc.png
  const path = url.replace(/^\/image\//, '');
  return path.split('/').map(decodeURIComponent).join('/');
}

function bytesToBase64(bytes) {
  let s = '';
  // Chunk to avoid call-stack overflow on big buffers.
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export const onRequestGet = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  if (!env.IMAGES) return json(500, { error: 'r2_binding_missing' });

  const u = new URL(request.url);
  const id = String(u.searchParams.get('id') || '');
  if (!id) return json(400, { error: 'missing_id' });

  const row = await env.DB.prepare(
    'SELECT id, name, is_default, spec_json, created_at, updated_at FROM cover_templates WHERE id = ? LIMIT 1'
  ).bind(id).first();
  if (!row) return json(404, { error: 'not_found' });

  let spec;
  try { spec = JSON.parse(row.spec_json); }
  catch { return json(500, { error: 'spec_corrupt' }); }

  // Walk the spec for asset URLs we need to bundle.
  const urls = [...collectAssetUrls(spec)];
  if (urls.length > MAX_ASSETS) {
    return json(413, { error: 'too_many_assets', max: MAX_ASSETS, got: urls.length });
  }

  const assets = {};
  for (const url of urls) {
    const key = urlToR2Key(url);
    // Look up the asset row for metadata (mime, filename, dimensions).
    const meta = await env.DB.prepare(
      'SELECT kind, original_name, mime, width, height, size_bytes FROM cover_assets WHERE r2_key = ? LIMIT 1'
    ).bind(key).first();

    const obj = await env.IMAGES.get(key);
    if (!obj) {
      // Asset row may have been deleted from DB but spec still
      // references it. Skip with a note rather than fail the whole
      // export — the importer will see the missing entry and fall
      // back to a placeholder.
      assets[url] = { missing: true, kind: meta?.kind || 'logo' };
      continue;
    }
    if ((meta?.size_bytes || 0) > MAX_ASSET_BYTES) {
      assets[url] = { missing: true, reason: 'too_large', kind: meta?.kind || 'logo' };
      continue;
    }
    const buf = await obj.arrayBuffer();
    assets[url] = {
      kind:     meta?.kind || 'logo',
      filename: meta?.original_name || 'asset',
      mime:     meta?.mime || obj.httpMetadata?.contentType || 'application/octet-stream',
      width:    meta?.width || null,
      height:   meta?.height || null,
      base64:   bytesToBase64(new Uint8Array(buf)),
    };
  }

  const settings = await loadSettings(env).catch(() => ({}));
  const host = new URL(request.url).hostname;

  const fileObj = {
    format:         'pages-seo-cover-template',
    format_version: 1,
    exported_at:    Math.floor(Date.now() / 1000),
    source: {
      host,
      brand_name: env?.SITE_NAME || settings?.site_name || '',
    },
    template: {
      name:       row.name,
      is_default: !!row.is_default,
      spec,
    },
    assets,
  };

  // Sanitise filename for Content-Disposition.
  const safeName = String(row.name || 'cover').toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 64) || 'cover';

  audit(env, 'admin', 'cover_template_export', id, { name: row.name, assets: Object.keys(assets).length });

  return new Response(JSON.stringify(fileObj, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // The .template extension is what the user sees in their
      // downloads. Browsers honour the extension here, regardless
      // of the content-type.
      'content-disposition': `attachment; filename="${safeName}.template"`,
      'cache-control': 'no-store',
    },
  });
};
