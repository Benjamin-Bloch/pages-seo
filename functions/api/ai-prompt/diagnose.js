// GET /api/ai-prompt/diagnose
//
// Black-box-probes the user's pages-seo install and returns BOTH a
// findings array AND a targeted LLM prompt that focuses on the
// specific failures. No Cloudflare API token required — we only
// hit the user's own public endpoints (/, /admin, /api/health,
// /api/setup, /sitemap.xml, /cover/test.svg).
//
// Query params:
//   site      = the user's deployed site origin (required).
//               e.g. https://my-site.pages.dev
//   slug      = project slug (optional, improves prompt accuracy)
//   admin     = admin URL (optional; defaults to <site>/admin)
//   gh        = GitHub fork URL (optional)
//   version   = pages-seo version hint (optional)
//   format    = 'text' (default, returns the prompt) or 'json'
//               (returns { findings, prompt }).
//
// Edge-rate-limited at 30 req/min/IP via Cloudflare's built-in
// (we just don't recommend hammering this from a client).
//
// The findings array is shape:
//   { id, severity: 'critical'|'warning'|'info'|'ok',
//     title, detail, url? }
//
// The prompt is the standard repair preamble + a "WHAT'S BROKEN"
// section that lists the concrete failures so the LLM knows exactly
// what to investigate first instead of running through its full
// playbook.

const PROBE_TIMEOUT_MS = 6_000;

function cleanUrl(input) {
  if (!input) return null;
  let s = String(input).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    return u.origin;
  } catch {
    return null;
  }
}

// Fetch with a hard timeout so a hung user-site doesn't stall the
// edge function. Returns { ok, status, body, contentType, error } —
// never throws.
async function probe(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: opts.method || 'GET',
      signal: ctrl.signal,
      headers: { 'user-agent': 'pages-seo-diagnose/1' },
      redirect: 'follow',
    });
    const ct = r.headers.get('content-type') || '';
    // Cap body read at 64KB — we only need a small slice to detect
    // setup-error messages, JSON shapes, or 5xx pages.
    let body = '';
    try {
      const buf = await r.arrayBuffer();
      body = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, 64 * 1024));
    } catch { /* unreadable body */ }
    return { ok: r.ok, status: r.status, body, contentType: ct };
  } catch (e) {
    return { ok: false, status: 0, body: '', contentType: '', error: String(e?.name || e?.message || 'fetch_failed') };
  } finally {
    clearTimeout(t);
  }
}

function tryJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// Run every probe in parallel; aggregate into findings.
async function runDiagnostics(site) {
  const u = (path) => site + path;

  const [home, admin, health, setup, sitemap, robots, cover, blog] = await Promise.all([
    probe(u('/')),
    probe(u('/admin')),
    probe(u('/api/health')),
    probe(u('/api/setup')),
    probe(u('/sitemap.xml')),
    probe(u('/robots.txt')),
    probe(u('/cover/_does-not-exist.svg')),
    probe(u('/blog')),
  ]);

  const findings = [];
  const add = (severity, id, title, detail, extra = {}) =>
    findings.push({ severity, id, title, detail, ...extra });

  // ─── Reachability ──────────────────────────────────────────────
  if (home.status === 0) {
    add('critical', 'site_unreachable',
      'Site is unreachable',
      `Couldn't reach ${site}. Network error: ${home.error || 'timeout'}. Domain may be wrong or the deployment is down.`,
      { url: site });
    return { findings, reachable: false };
  }
  if (home.status >= 500) {
    add('critical', 'site_5xx',
      `Homepage returns ${home.status}`,
      'Server-side error on the homepage. The Pages Function is probably crashing — usually a missing binding or env var.',
      { url: site });
  } else if (home.status >= 400) {
    add('warning', 'site_4xx',
      `Homepage returns ${home.status}`,
      'Homepage is rejecting requests. Likely a routing or auth issue.',
      { url: site });
  } else {
    add('ok', 'site_reachable', 'Site reachable', `Homepage returns ${home.status}.`);
  }

  // ─── /api/setup (most diagnostic endpoint) ────────────────────
  const setupJson = tryJson(setup.body);
  if (setup.status === 503 && setupJson?.error === 'no_db_binding') {
    add('critical', 'no_db_binding',
      'D1 database not bound',
      'The Pages project is missing the D1 binding called "DB". /repair → Fix D1 binding resolves this.',
      { url: 'https://seo.benjaminb.xyz/repair' });
  } else if (setup.status === 200 && setupJson?.needs_setup === true) {
    add('warning', 'needs_setup',
      'First-run setup not completed',
      'The site is deployed but the admin account hasn\'t been created. Open /admin to finish setup.',
      { url: u('/admin') });
  } else if (setup.status === 200 && setupJson?.ok === true) {
    add('ok', 'setup_ok', 'Setup status nominal', 'No setup gates blocking; admin should load.');
  } else if (setup.status === 0) {
    add('warning', 'setup_unreachable',
      '/api/setup unreachable',
      'Couldn\'t reach the setup endpoint. The deployment may not have Functions bound.');
  }

  // ─── /admin gate ──────────────────────────────────────────────
  const adminBody = admin.body || '';
  // The SPA returns 200 + HTML always; the runtime error surfaces
  // when /api/admin/whoami is called from JS. So we explicitly hit
  // whoami here to detect the same config_incomplete state.
  const whoami = await probe(u('/api/admin/whoami'));
  const whoamiJson = tryJson(whoami.body);
  if (whoami.status === 503 && whoamiJson?.error === 'config_incomplete') {
    const missing = whoamiJson.missing || [];
    add('critical', 'config_incomplete',
      `Missing config: ${missing.join(', ') || 'unknown'}`,
      `The admin endpoints require ${missing.join(', ')} — either as Pages secrets or in the D1 settings table. Restore them via \`wrangler pages secret put\` or by re-running /repair → "Add self-repair secrets".`,
      { missing });
  } else if (whoami.status === 401 || whoami.status === 200) {
    add('ok', 'admin_healthy', 'Admin endpoints healthy', `/api/admin/whoami returns ${whoami.status} (expected; means env+DB are wired).`);
  } else if (whoami.status >= 500) {
    add('critical', 'admin_5xx',
      `/api/admin/whoami returns ${whoami.status}`,
      'The admin API is crashing. Check Cloudflare → Pages → pages-seo → Logs for the stack trace.');
  }

  // ─── Sitemap + robots ─────────────────────────────────────────
  if (sitemap.status === 200 && /<urlset|<sitemapindex/.test(sitemap.body)) {
    add('ok', 'sitemap_ok', 'Sitemap valid', '/sitemap.xml returns a proper XML sitemap.');
  } else if (sitemap.status === 200) {
    add('warning', 'sitemap_bad',
      'Sitemap response not XML',
      '/sitemap.xml returns 200 but the body doesn\'t look like a sitemap. Likely the SPA fallback handler is intercepting.');
  } else if (sitemap.status === 0 || sitemap.status >= 500) {
    add('warning', 'sitemap_down',
      `Sitemap returns ${sitemap.status || 'timeout'}`,
      'Sitemap endpoint is failing — search engines can\'t crawl your posts. Usually means /sitemap.xml.js function crashed (missing DB binding).');
  }

  if (robots.status === 200 && /sitemap:/i.test(robots.body)) {
    add('ok', 'robots_ok', 'robots.txt present', 'robots.txt references the sitemap correctly.');
  } else if (robots.status !== 200) {
    add('info', 'robots_missing',
      `/robots.txt returns ${robots.status || 'timeout'}`,
      'Optional but recommended. Not blocking anything.');
  }

  // ─── Cover renderer (live SVG) ────────────────────────────────
  // We hit a slug that almost certainly doesn't exist; expectation
  // is either 404 (handler running, just no template) or a real SVG
  // with the maintainer's default template content. 500 = renderer
  // crashing.
  if (cover.status >= 500) {
    add('warning', 'cover_renderer_crash',
      `/cover/<slug>.svg returns ${cover.status}`,
      'The live cover SVG renderer is crashing. Daily blog hero images won\'t generate. Check the cover template config in /admin → Covers.');
  } else if (cover.status === 404 || (cover.status === 200 && cover.contentType.includes('svg'))) {
    add('ok', 'cover_ok', 'Cover renderer responding', `${cover.status} from /cover/.svg endpoint.`);
  }

  // ─── Public blog listing ──────────────────────────────────────
  if (blog.status >= 500) {
    add('warning', 'blog_5xx',
      `/blog returns ${blog.status}`,
      'The public blog index is crashing. Probably a DB query failure.');
  } else if (blog.status === 200 && /No posts yet|Waiting for the cron/.test(blog.body)) {
    add('info', 'no_posts',
      'No blog posts published yet',
      'Either the daily cron hasn\'t run, or it\'s running but failing. Check /admin → System → Audit log for cron errors.');
  } else if (blog.status === 200) {
    add('ok', 'blog_ok', 'Public blog listing healthy', '/blog returns 200 with post content.');
  }

  return { findings, reachable: true };
}

// Build a focused prompt that leads with the concrete failures.
function buildTargetedPrompt(site, findings, ctx) {
  const critical = findings.filter((f) => f.severity === 'critical');
  const warnings = findings.filter((f) => f.severity === 'warning');
  const ok       = findings.filter((f) => f.severity === 'ok');

  const summary = critical.length
    ? `${critical.length} CRITICAL issue${critical.length === 1 ? '' : 's'} found.`
    : warnings.length
      ? `${warnings.length} warning${warnings.length === 1 ? '' : 's'} found; site is mostly healthy.`
      : 'No critical issues. The site appears healthy.';

  const fmtFinding = (f) => {
    const lines = [`- [${f.severity.toUpperCase()}] ${f.title}`, `    ${f.detail}`];
    if (f.url) lines.push(`    Action URL: ${f.url}`);
    return lines.join('\n');
  };

  const detected = [
    ...critical.map(fmtFinding),
    ...warnings.map(fmtFinding),
  ].join('\n');

  const okList = ok.length
    ? `\nALSO PASSED (don't waste time on these):\n${ok.map((f) => `- ${f.title}`).join('\n')}`
    : '';

  const personal = [];
  if (ctx.slug)    personal.push(`- Project slug: ${ctx.slug}`);
  if (site)        personal.push(`- Live site:    ${site}`);
  if (ctx.admin)   personal.push(`- Admin panel:  ${ctx.admin}`);
  if (ctx.gh)      personal.push(`- GitHub fork:  ${ctx.gh}`);
  if (ctx.version) personal.push(`- Version:      ${ctx.version}`);

  return `You are helping me fix a broken pages-seo install. pages-seo is an open-source programmatic SEO toolkit that runs on Cloudflare Pages (Workers AI default, 8 cloud LLM providers as fallback). Source: github.com/Benjamin-Bloch/pages-seo. Docs + error reference: https://seo.benjaminb.xyz/docs and https://seo.benjaminb.xyz/docs#errors.

I have very little technical experience. Walk me through each fix ONE AT A TIME. After each step, wait for me to confirm I've done it. If a step errors, diagnose the error message before moving on.

MY INSTALL:
${personal.join('\n')}

DIAGNOSTIC SCAN RESULTS (${new Date().toISOString()}):
${summary}

WHAT'S BROKEN — fix these in order:
${detected || '(no specific failures detected by the black-box scan; ask me what symptom I\'m actually seeing)'}
${okList}

Standard pages-seo failure modes you may encounter:
- "no_db_binding" → /repair → "Fix D1 binding" PATCHes the Pages project to re-attach the DB binding.
- "config_incomplete" + missing SITE_NAME/SITE_URL/ADMIN_TOKEN → either set them as Pages secrets (\`wrangler pages secret put SITE_NAME\`) or write fallback rows to D1 (\`site_name_db\`, \`site_url_db\`, \`admin_token\` in the settings table).
- Self-repair secrets missing (CF_API_TOKEN/CF_ACCOUNT_ID/CF_PROJECT/CF_D1_ID/CF_R2_NAME) → /repair → "Add self-repair secrets" populates them.
- Cover SVG not rendering → check /admin → Covers, ensure a default template is installed.
- Daily cron not producing posts → /admin → System → Audit log will show the last failure; provider key may be unset.

Start by acknowledging which CRITICAL issue we're tackling first (if any), tell me concretely what to click or run, then wait for me to confirm before moving on.`;
}

export const onRequestGet = async ({ request }) => {
  const url = new URL(request.url);
  const site = cleanUrl(url.searchParams.get('site'));
  const format = String(url.searchParams.get('format') || 'text').toLowerCase();
  if (!site) {
    return new Response(JSON.stringify({ error: 'missing_site', detail: 'Pass ?site=https://my-site.pages.dev' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const ctx = {
    slug:    (url.searchParams.get('slug') || '').slice(0, 64) || null,
    admin:   cleanUrl(url.searchParams.get('admin')) || (site + '/admin'),
    gh:      (url.searchParams.get('gh') || '').slice(0, 120) || null,
    version: (url.searchParams.get('version') || '').slice(0, 40) || null,
  };

  const { findings } = await runDiagnostics(site);
  const prompt = buildTargetedPrompt(site, findings, ctx);

  if (format === 'json') {
    return new Response(JSON.stringify({
      ok: true,
      site,
      ran_at: Math.floor(Date.now() / 1000),
      summary: {
        critical: findings.filter((f) => f.severity === 'critical').length,
        warning:  findings.filter((f) => f.severity === 'warning').length,
        info:     findings.filter((f) => f.severity === 'info').length,
        ok:       findings.filter((f) => f.severity === 'ok').length,
      },
      findings,
      prompt,
    }), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      },
    });
  }

  return new Response(prompt, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
};
