// /blog/page/<n> — paginated archive page N (N>=2).
//
// Reuses renderBlogIndex() from ../index.js so we have a single
// rendering path; pagination semantics + canonical handling live
// over there.
import { renderBlogIndex } from '../index.js';

export const onRequestGet = ({ env, request, params }) => {
  const page = parseInt(params.page, 10);
  if (!Number.isFinite(page) || page < 1) {
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }
  // /blog/page/1 → 301 to /blog (canonical, prevents duplicate-content).
  if (page === 1) {
    const u = new URL(request.url);
    u.pathname = '/blog';
    return new Response(null, { status: 301, headers: { location: u.toString() } });
  }
  return renderBlogIndex({ env, request, page });
};
