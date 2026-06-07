// Top-level middleware. Two jobs on every request:
//
//   1. Lock down installer/updater routes on user installs.
//      /install, /install/*, /update, /update/*, and the
//      installer-API namespace (/api/install/*, /api/update/*) only
//      make sense on the upstream maintainer's deployment. On a
//      user's install of the same code they're noise that exposes
//      the maintainer-only surface area to their visitors. We 404
//      those routes when isMaintainer(env) is false.
//
//   2. Rewrite the root `/` on user installs to a minimal sign-in
//      landing instead of the maintainer's marketing page. The
//      marketing page in public/index.html only makes sense on the
//      upstream — on a user's domain it leaks the maintainer's
//      branding + screenshots and confuses their visitors.
//
// Maintainer detection is via env.IS_MAINTAINER==='1' or
// settings.is_maintainer==='1'. See _lib/maintainer.js. Cached on
// env after the first read.

import { isMaintainer } from './_lib/maintainer.js';

const INSTALLER_RX = /^\/(install|update)(\/.*)?$/;
const INSTALLER_API_RX = /^\/api\/(install|update)(\/.*)?$/;

export const onRequest = async ({ request, env, next }) => {
  const url = new URL(request.url);
  const path = url.pathname;

  const isInstallerSurface = INSTALLER_RX.test(path) || INSTALLER_API_RX.test(path);
  const isRoot = path === '/' || path === '/index.html';

  if (!isInstallerSurface && !isRoot) {
    return next();
  }

  const maintainer = await isMaintainer(env);
  if (maintainer) {
    return next();
  }

  // User install: gate.
  if (isInstallerSurface) {
    return new Response('Not Found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  // Root → minimal sign-in landing. We serve the dedicated file
  // public/sign-in.html via the ASSETS binding rather than
  // redirecting, so the URL stays clean.
  const signin = await env.ASSETS.fetch(new URL('/sign-in.html', url));
  if (signin.ok) {
    const headers = new Headers(signin.headers);
    headers.set('Cache-Control', 'public, max-age=300');
    return new Response(signin.body, { status: signin.status, headers });
  }
  // Fallback if the file is missing for any reason — redirect to /admin.
  return Response.redirect(new URL('/admin', url).toString(), 302);
};
