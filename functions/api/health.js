// GET /api/health
//
// Lightweight liveness + cron-alive probe. Public, no auth, no secrets
// leaked.
//
// Used by:
//   - external uptime monitors (UptimeRobot, healthchecks.io)
//   - the cron Worker's /diag and other ops tooling
//   - the install/repair flows to confirm a deployment is live
//
// Response (200):
//   {
//     ok: true,
//     db: 'ok' | 'unbound' | 'error',
//     ts: <unix>,
//     posts: { count, last_published, hours_since_last, cron_likely_alive },
//     jobs:  { in_flight_stuck }   // jobs older than 1h in non-terminal state
//   }
// Response (503): only if the Worker itself can't return — never in practice.

import { json } from '../_lib/util.js';

export const onRequestGet = async ({ env }) => {
  const now = Math.floor(Date.now() / 1000);
  let db = 'unbound';
  const posts = { count: null, last_published: null };
  const jobs = { in_flight_stuck: null };

  if (env?.DB) {
    try {
      // Single round-trip: posts count + last published + stuck-job count.
      // Cheaper than 3 separate calls.
      const r1 = await env.DB.prepare(
        `SELECT COUNT(*) AS n, MAX(published_at) AS last
           FROM blog_posts WHERE status = 'published'`
      ).first();
      db = (r1 && typeof r1.n === 'number') ? 'ok' : 'error';
      posts.count = r1?.n ?? 0;
      posts.last_published = r1?.last ?? null;

      // Jobs stuck > 1 hour in a non-terminal state — usually means a
      // generation step failed silently and the cron didn't retry.
      const r2 = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM blog_jobs
          WHERE status NOT IN ('published','failed')
            AND updated_at < ?`
      ).bind(now - 3600).first();
      jobs.in_flight_stuck = r2?.n ?? 0;
    } catch {
      db = 'error';
    }
  }

  // Cron-alive heuristic: if the last published post is older than 36
  // hours, the daily cron is probably broken. We return ok:true either
  // way so uptime monitors don't false-alarm on a quiet weekend, but
  // surface the flag so dashboards can light up.
  if (posts.last_published != null) {
    const ageH = (now - posts.last_published) / 3600;
    posts.hours_since_last = Math.round(ageH);
    posts.cron_likely_alive = ageH < 36;
  }

  return json(200, {
    ok: true,
    db,
    ts: now,
    posts,
    jobs,
  }, {
    // Never cache — monitors should see the current state.
    'cache-control': 'no-store',
  });
};
