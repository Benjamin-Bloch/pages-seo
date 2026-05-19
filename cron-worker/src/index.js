// pages-seo cron Worker. Pages Functions kill background work after the
// response closes, so we keep all multi-step orchestration in this Worker
// — each step is a short HTTP call back to the Pages app, well within the
// 30s subrequest budget.
//
// Cron schedules:
//   - 0 8 * * *         daily blog start (or resume any draft first)
//   - 0 10,14,18 * * *  retry-only windows for unfinished drafts
//   - 0 9 * * *         programmatic-SEO batch (10 keywords per run)
//
// Secrets: BLOG_URL, PROG_URL, ADMIN_TOKEN.

export default {
  async scheduled(event, env, ctx) {
    const cron = event.cron || '';
    if (cron === '0 8 * * *') {
      ctx.waitUntil(runBlogChain(env, 'daily', { resumeOnly: false }));
    } else if (cron === '0 10,14,18 * * *') {
      ctx.waitUntil(runBlogChain(env, 'retry', { resumeOnly: true }));
    } else if (cron === '0 9 * * *') {
      ctx.waitUntil(runProgrammaticBatch(env, 'daily_prog', { limit: 10 }));
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const auth = request.headers.get('Authorization') || '';
    const m = auth.match(/^Bearer\s+(.+)$/);
    if (!m || m[1] !== env.ADMIN_TOKEN) return new Response('unauthorized', { status: 401 });

    let result;
    if (url.pathname === '/run/blog') {
      result = await runBlogChain(env, 'manual', { resumeOnly: false });
    } else if (url.pathname === '/run/blog/retry') {
      result = await runBlogChain(env, 'manual', { resumeOnly: true });
    } else if (url.pathname === '/run/prog') {
      const limit = parseInt(url.searchParams.get('limit'), 10) || 5;
      result = await runProgrammaticBatch(env, 'manual', { limit });
    } else {
      return new Response('not found', { status: 404 });
    }
    return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
  },
};

async function call(env, url, body = '{}', method = 'POST') {
  const init = {
    method,
    headers: {
      'Authorization': `Bearer ${env.ADMIN_TOKEN}`,
      'Content-Type': 'application/json',
      // Identifies this caller as the cron Worker so the admin API can
      // apply the cron budget hard-stop (admin clicks aren't gated).
      'X-Source-Cron': '1',
    },
  };
  if (method !== 'GET' && method !== 'HEAD') init.body = body;
  const r = await fetch(url, init);
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  return { ok: r.ok, status: r.status, body: parsed || text.slice(0, 500) };
}

async function runBlogChain(env, source, { resumeOnly = false } = {}) {
  const base = (env.BLOG_URL || '').replace(/\/+$/, '');
  if (!base || !env.ADMIN_TOKEN) return { ok: false, error: 'missing_config', source };

  // Try to resume oldest draft first.
  const drafts = await call(env, `${base}/jobs`, null, 'GET').catch(() => null);
  const oldest = drafts?.body?.jobs?.[drafts.body.jobs.length - 1];
  let jobId;
  let resumed = false;
  if (oldest && oldest.status !== 'published') {
    jobId = oldest.id;
    resumed = true;
    await call(env, `${base}/retry-job`, JSON.stringify({ id: jobId })).catch(() => {});
  } else if (resumeOnly) {
    return { ok: true, source, resumed: false, no_op: true };
  } else {
    // Prefer the next due calendar slot; falls back to the legacy
    // topic picker on the server side if no slot is due.
    const startR = await call(env, `${base}/start`, JSON.stringify({ from_calendar: true }));
    jobId = startR?.body?.job_id;
    if (!startR.ok || !jobId) return { ok: false, step: 'start', source, ...startR };
  }
  const payload = JSON.stringify({ job_id: jobId });
  const textR = await call(env, `${base}/text`, payload);
  if (!textR.ok) return { ok: false, step: 'text', job_id: jobId, source, resumed, ...textR };
  const imgR = await call(env, `${base}/image`, payload);
  if (!imgR.ok) return { ok: false, step: 'image', job_id: jobId, source, resumed, ...imgR };
  const pubR = await call(env, `${base}/publish`, payload);
  if (!pubR.ok) return { ok: false, step: 'publish', job_id: jobId, source, resumed, ...pubR };
  return { ok: true, job_id: jobId, slug: pubR.body?.slug, source, resumed };
}

async function runProgrammaticBatch(env, source, { limit = 10 } = {}) {
  const url = env.PROG_URL;
  if (!url || !env.ADMIN_TOKEN) return { ok: false, error: 'missing_config', source };
  const results = [];
  for (let i = 0; i < limit; i++) {
    const r = await call(env, url);
    results.push({ step: i, status: r.status, body: r.body });
    if (r.body && r.body.drained) break;
    if (!r.ok) break; // stop on the first hard failure; cron can retry next window
  }
  return { ok: true, source, generated: results.length, results };
}
