// Serves the admin SPA shell for /admin and any sub-path.
// Auth is client-side — the page itself is harmless without the token;
// every /api/admin/* call still gates on Bearer.
export const onRequest = async ({ request, env, next }) => {
  const url = new URL(request.url);
  if (url.pathname === '/admin' || url.pathname === '/admin/') {
    const html = await env.ASSETS.fetch(new URL('/admin.html', url));
    const headers = new Headers(html.headers);
    headers.set('Cache-Control', 'no-store');
    return new Response(html.body, { status: html.status, headers });
  }
  return next();
};
