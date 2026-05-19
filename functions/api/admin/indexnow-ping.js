// Pings IndexNow with the full sitemap (or a caller-supplied URL list).
import { json, audit } from '../../_lib/util.js';
import { adminGate } from '../../_lib/auth.js';
import { pingIndexNow } from '../../_lib/indexnow.js';

function extractLocs(xml) {
  const out = [];
  const rx = /<loc>([^<]+)<\/loc>/g;
  let m;
  while ((m = rx.exec(xml)) !== null) {
    const u = m[1].trim();
    if (u) out.push(u);
  }
  return out;
}

export const onRequestPost = async ({ request, env }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  let body = {};
  try { body = await request.json(); } catch { /* empty body ok */ }
  let urls;
  let source;
  if (Array.isArray(body?.urls) && body.urls.length) {
    urls = body.urls; source = 'caller_supplied';
  } else {
    try {
      const r = await fetch(new URL('/sitemap.xml', request.url).toString());
      if (!r.ok) throw new Error('sitemap_http_' + r.status);
      urls = extractLocs(await r.text());
      source = 'sitemap';
    } catch {
      urls = []; source = 'failed';
    }
  }
  if (!urls.length) return json(400, { error: 'no_urls', source });
  const r = await pingIndexNow(env, urls, request);
  audit(env, 'admin', 'indexnow_ping', null, { url_count: urls.length, ok: r.ok, source });
  return json(r.ok ? 200 : 502, { ...r, urls, source });
};
