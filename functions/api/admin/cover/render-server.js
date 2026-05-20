// POST /api/admin/cover/render-server
//
// Server-side cover rendering. NOT YET IMPLEMENTED.
//
// Cloudflare Workers don't expose a 2D canvas API. To render a
// cover-template spec into a PNG on the server we need:
//
//   - satori (npm: 'satori') — JSX/HTML → SVG, with Google-fonts
//     compatible font loading via ArrayBuffer.
//   - resvg-wasm (npm: '@resvg/resvg-wasm') — SVG → PNG bytes.
//
// Wiring sketch:
//   1. Import satori + resvg, both as WASM modules. Bundle the WOFF2
//     files for the fonts referenced by the template (or load on
//     demand from fonts.gstatic.com — they cache).
//   2. Translate spec.layers to a JSX-ish tree satori can render.
//     Text layers become <div> with the right style; logo layers
//     become <img> pointing at the R2 public URL; box layers become
//     <div>.
//   3. Run satori → SVG → resvg → PNG bytes.
//   4. Return as base64 so the caller can re-use /api/admin/cover/apply
//     (which already accepts base64 PNG and writes it to R2).
//
// Until that's built, this endpoint returns 501 deliberately so the
// caller (blog/image.js, or a future apply-all-future job) falls
// back to whatever non-template path is configured. Returning a
// distinct error code instead of crashing means the system stays
// usable while the satori integration is iterated on.

import { json } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';

export const onRequestPost = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  return json(501, {
    ok: false,
    error: 'not_implemented',
    detail: 'Server-side template rendering is not yet wired up. See functions/api/admin/cover/render-server.js for the integration sketch (satori + resvg-wasm).',
    hint: 'Use the browser editor’s "Apply to all past posts" button for retrospective application. New-post rendering will pick up automatically once this endpoint is implemented.',
  });
};
