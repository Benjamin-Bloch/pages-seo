// POST /api/install/diagnose
//
// The advanced diagnostic endpoint that powers /repair. Given a CF
// API token + project slug, runs every check we know how to run
// and returns a structured report. Each check has:
//
//   { id, label, severity, ok, detail, fix? }
//
//   id       — stable string for client → server "fix this" calls
//   label    — human description
//   severity — 'critical' | 'warning' | 'info'
//   ok       — true / false
//   detail   — what went wrong (or "all good" on success)
//   fix      — { action, args? } describing how to repair, OR null
//              when no automated fix is available
//
// Severities decide the UI surface:
//   critical → site is broken; user should fix before doing anything else.
//   warning  → site works but is missing some non-essential capability.
//   info     → informational; the user might care, no action required.
//
// Body: { token: string, project: string }
//
// Response: { ok, summary: { critical, warning, info, healthy }, checks: [...] }

import { json } from '../../_lib/util.js';

const CF_API = 'https://api.cloudflare.com/client/v4';
const UPSTREAM_OWNER = 'Benjamin-Bloch';
const UPSTREAM_REPO  = 'pages-seo';

async function cfFetch(token, path) {
  const r = await fetch(CF_API + path, {
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
  });
  let body = null;
  try { body = await r.json(); } catch { /* */ }
  return { status: r.status, ok: r.ok, body };
}

function firstError(body) {
  if (Array.isArray(body?.errors) && body.errors.length) {
    return body.errors.map((e) => e.message || String(e)).join(' · ');
  }
  return body?.error || null;
}

function check(id, label, severity, ok, detail, fix) {
  return { id, label, severity, ok, detail, fix: fix || null };
}

// Walk an env_vars object and return { name: hasValue } for the keys
// we care about. CF returns env_vars as { KEY: { type, value } } —
// 'value' is masked for secret_text, but the entry being present at
// all means the secret is set.
function envHas(envVars, name) {
  return !!envVars?.[name];
}

export const onRequestPost = async ({ request }) => {
  let payload;
  try { payload = await request.json(); }
  catch { return json(400, { ok: false, error: 'bad_json' }); }

  const token   = String(payload?.token || '').trim();
  const project = String(payload?.project || '').trim().toLowerCase();
  if (!token)   return json(400, { ok: false, error: 'missing_token' });
  if (!project) return json(400, { ok: false, error: 'missing_project' });

  const checks = [];

  // ── 1. Account resolves ──────────────────────────────────────
  let accountId = null;
  let accountName = null;
  {
    const r = await cfFetch(token, '/accounts');
    if (!r.ok || !r.body?.result?.length) {
      checks.push(check(
        'account', 'Cloudflare account access', 'critical', false,
        firstError(r.body) || ('HTTP ' + r.status),
        null,    // can't auto-fix a bad token; user has to recreate
      ));
      // Without an account ID, nothing else can run. Return early
      // with just the one failed check.
      return json(200, summarise(checks));
    }
    accountId   = r.body.result[0].id;
    accountName = r.body.result[0].name || '';
    checks.push(check(
      'account', 'Cloudflare account access', 'critical', true,
      `Token works for ${accountName || accountId}.`,
    ));
  }

  // ── 2. Pages project exists ──────────────────────────────────
  let projectData = null;
  {
    const r = await cfFetch(token, `/accounts/${accountId}/pages/projects/${project}`);
    if (!r.ok) {
      checks.push(check(
        'project_exists', 'Pages project exists', 'critical', false,
        `No Pages project named "${project}" on this account. Did you mistype the slug?`,
        null,
      ));
      return json(200, summarise(checks));
    }
    projectData = r.body?.result;
    checks.push(check(
      'project_exists', 'Pages project exists', 'critical', true,
      `Project found at ${projectData.subdomain || project + '.pages.dev'}.`,
    ));
  }

  const prodEnvVars  = projectData?.deployment_configs?.production?.env_vars || {};
  const prodBindings = projectData?.deployment_configs?.production || {};

  // ── 3. D1 binding ────────────────────────────────────────────
  let d1Id = null;
  {
    const dbBinding = prodBindings.d1_databases?.DB;
    if (!dbBinding?.id) {
      checks.push(check(
        'd1_bound', 'D1 database bound', 'critical', false,
        'env.DB binding is missing on production.',
        { action: 'rebind' },
      ));
    } else {
      d1Id = dbBinding.id;
      // Verify the DB actually exists.
      const dbR = await cfFetch(token, `/accounts/${accountId}/d1/database/${d1Id}`);
      if (!dbR.ok) {
        checks.push(check(
          'd1_bound', 'D1 database bound', 'critical', false,
          `Binding references D1 ${d1Id.slice(0, 8)}… but that database no longer exists.`,
          { action: 'rebind' },
        ));
      } else {
        checks.push(check(
          'd1_bound', 'D1 database bound', 'critical', true,
          `Bound to "${dbR.body?.result?.name || d1Id.slice(0, 12)}".`,
        ));
      }
    }
  }

  // ── 4. R2 binding ────────────────────────────────────────────
  let r2Name = null;
  {
    const r2Binding = prodBindings.r2_buckets?.IMAGES;
    if (!r2Binding?.name) {
      checks.push(check(
        'r2_bound', 'R2 bucket bound', 'critical', false,
        'env.IMAGES binding is missing on production.',
        { action: 'rebind' },
      ));
    } else {
      r2Name = r2Binding.name;
      // Bucket existence check by listing a bogus prefix.
      const probe = await cfFetch(token, `/accounts/${accountId}/r2/buckets/${r2Name}`);
      if (!probe.ok) {
        checks.push(check(
          'r2_bound', 'R2 bucket bound', 'critical', false,
          `Binding references "${r2Name}" but no R2 bucket of that name exists.`,
          { action: 'rebind' },
        ));
      } else {
        checks.push(check(
          'r2_bound', 'R2 bucket bound', 'critical', true,
          `Bound to ${r2Name}.`,
        ));
      }
    }
  }

  // ── 5. AI binding ────────────────────────────────────────────
  {
    const aiBinding = prodBindings.ai_bindings?.AI;
    if (!aiBinding) {
      checks.push(check(
        'ai_bound', 'Workers AI bound', 'warning', false,
        'env.AI binding missing. Daily blog hero-image generation needs this when in AI mode.',
        { action: 'rebind' },
      ));
    } else {
      checks.push(check(
        'ai_bound', 'Workers AI bound', 'warning', true,
        'Workers AI binding present.',
      ));
    }
  }

  // ── 6. Self-repair CF_* secrets ──────────────────────────────
  {
    const need = ['CF_API_TOKEN', 'CF_ACCOUNT_ID', 'CF_PROJECT', 'CF_D1_ID', 'CF_R2_NAME'];
    const missing = need.filter((k) => !envHas(prodEnvVars, k));
    if (missing.length) {
      checks.push(check(
        'cf_secrets', 'Self-repair secrets', 'warning', false,
        `${missing.length} missing: ${missing.join(', ')}. Site can't self-heal future binding drops without these.`,
        { action: 'add_secrets' },
      ));
    } else {
      checks.push(check(
        'cf_secrets', 'Self-repair secrets', 'warning', true,
        'All 5 CF_* secrets present.',
      ));
    }
  }

  // ── 7. Site identity env vars ────────────────────────────────
  {
    const need = ['SITE_NAME', 'SITE_URL', 'ADMIN_TOKEN'];
    const missing = need.filter((k) => !envHas(prodEnvVars, k));
    if (missing.length) {
      checks.push(check(
        'site_env', 'Site identity env vars', 'warning', false,
        `${missing.length} missing: ${missing.join(', ')}. /admin will refuse to load until these are present.`,
        null,    // user-supplied values; can't auto-fix
      ));
    } else {
      checks.push(check(
        'site_env', 'Site identity env vars', 'warning', true,
        'SITE_NAME, SITE_URL, ADMIN_TOKEN all set.',
      ));
    }
  }

  // ── 8. GitHub source ─────────────────────────────────────────
  let ghSource = null;
  {
    const src = projectData?.source;
    if (src?.type !== 'github' || !src?.config?.owner || !src?.config?.repo_name) {
      checks.push(check(
        'github_source', 'GitHub source connected', 'info', false,
        'Project is not connected to a GitHub source. Updates via /update or admin Updates tab won\'t work.',
        null,
      ));
    } else {
      ghSource = src.config;
      checks.push(check(
        'github_source', 'GitHub source connected', 'info', true,
        `Connected to ${ghSource.owner}/${ghSource.repo_name} (branch ${ghSource.production_branch || 'main'}).`,
      ));
    }
  }

  // ── 9. Fork sync with upstream ───────────────────────────────
  if (ghSource) {
    try {
      const upstream = await fetch(
        `https://api.github.com/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/commits/main`,
        { headers: { 'User-Agent': 'pages-seo-diagnose', Accept: 'application/vnd.github+json' } },
      );
      const fork = await fetch(
        `https://api.github.com/repos/${ghSource.owner}/${ghSource.repo_name}/commits/${ghSource.production_branch || 'main'}`,
        { headers: { 'User-Agent': 'pages-seo-diagnose', Accept: 'application/vnd.github+json' } },
      );
      if (upstream.ok && fork.ok) {
        const u = await upstream.json();
        const f = await fork.json();
        if (u.sha === f.sha) {
          checks.push(check(
            'fork_sync', 'Fork synced with upstream', 'info', true,
            `Fork is at upstream HEAD (${u.sha.slice(0, 7)}).`,
          ));
        } else {
          // Compare to count distance.
          const cmp = await fetch(
            `https://api.github.com/repos/${ghSource.owner}/${ghSource.repo_name}/compare/${ghSource.production_branch || 'main'}...${UPSTREAM_OWNER}:${UPSTREAM_REPO}:main`,
            { headers: { 'User-Agent': 'pages-seo-diagnose', Accept: 'application/vnd.github+json' } },
          );
          if (cmp.ok) {
            const c = await cmp.json();
            const ahead = c.ahead_by || 0;
            const behind = c.behind_by || 0;
            const detail = behind > 0
              ? `Fork is ${behind} commit${behind === 1 ? '' : 's'} behind upstream. New features + fixes haven't reached this install yet.`
              : (ahead > 0 ? `Fork is ${ahead} commit${ahead === 1 ? '' : 's'} ahead of upstream (you have local edits).` : 'Up to date.');
            checks.push(check(
              'fork_sync', 'Fork synced with upstream',
              behind > 0 ? 'info' : 'info',
              behind === 0, detail,
              behind > 0 ? { action: 'sync_fork', args: { owner: ghSource.owner, repo: ghSource.repo_name, branch: ghSource.production_branch || 'main' } } : null,
            ));
          } else {
            checks.push(check(
              'fork_sync', 'Fork synced with upstream', 'info', false,
              'Couldn\'t compare fork to upstream (GitHub API rate limit?). Try again in a minute.',
              null,
            ));
          }
        }
      } else {
        checks.push(check(
          'fork_sync', 'Fork synced with upstream', 'info', false,
          'Couldn\'t reach GitHub. Will re-check next run.',
          null,
        ));
      }
    } catch (e) {
      checks.push(check(
        'fork_sync', 'Fork synced with upstream', 'info', false,
        'GitHub lookup failed: ' + String(e?.message || e).slice(0, 120),
        null,
      ));
    }
  }

  // ── 10. Last deployment status ───────────────────────────────
  {
    const r = await cfFetch(token, `/accounts/${accountId}/pages/projects/${project}/deployments?per_page=1`);
    if (r.ok && r.body?.result?.length) {
      const last = r.body.result[0];
      // Precedence: || binds tighter than ?:, so the parens are required —
      // otherwise `stage` could only ever be 'pending'/'unknown'.
      const stage = last.latest_stage?.status || (last.deployment_trigger?.metadata?.commit_hash ? 'pending' : 'unknown');
      const phase = last.latest_stage?.name || '';
      const ok = stage === 'success';
      checks.push(check(
        'last_deploy', 'Last deployment',
        ok ? 'info' : 'warning',
        ok,
        ok
          ? `Last deploy succeeded ${new Date(last.modified_on || last.created_on).toLocaleDateString('en-GB')} (${(last.deployment_trigger?.metadata?.commit_hash || '').slice(0, 7) || 'manual'}).`
          : `Last deploy failed in phase "${phase}". Trigger a fresh deploy to retry.`,
        ok ? null : { action: 'redeploy' },
      ));
    } else {
      checks.push(check(
        'last_deploy', 'Last deployment', 'info', false,
        'No deployment history found. Trigger one to populate this.',
        { action: 'redeploy' },
      ));
    }
  }

  // ── 11. Custom domains ───────────────────────────────────────
  {
    const domains = projectData?.domains || [];
    const customDomains = domains.filter((d) => !d.endsWith('.pages.dev'));
    if (customDomains.length === 0) {
      checks.push(check(
        'custom_domain', 'Custom domain', 'info', true,
        'Using the default *.pages.dev domain. Add a custom domain in the CF dashboard if you want a branded URL.',
      ));
    } else {
      checks.push(check(
        'custom_domain', 'Custom domain', 'info', true,
        `Serving ${customDomains.length} custom domain${customDomains.length === 1 ? '' : 's'}: ${customDomains.join(', ')}.`,
      ));
    }
  }

  // ── 12. Source drift (compare to upstream) ───────────────────
  // Limited compared to a real diff (we can't fetch the live deployed
  // file contents), but we CAN flag when the fork is ahead of upstream
  // which signals local edits.
  if (ghSource) {
    try {
      const r = await fetch(
        `https://api.github.com/repos/${ghSource.owner}/${ghSource.repo_name}/compare/${UPSTREAM_OWNER}:${UPSTREAM_REPO}:main...${ghSource.production_branch || 'main'}`,
        { headers: { 'User-Agent': 'pages-seo-diagnose', Accept: 'application/vnd.github+json' } },
      );
      if (r.ok) {
        const c = await r.json();
        const ahead = c.ahead_by || 0;
        const files = (c.files || []).map((f) => f.filename).slice(0, 12);
        if (ahead > 0) {
          checks.push(check(
            'source_drift', 'Source code edits', 'info', false,
            `Fork has ${ahead} commit${ahead === 1 ? '' : 's'} on top of upstream${files.length ? ' touching: ' + files.join(', ') + (files.length === 12 ? '…' : '') : ''}. Update via /update will require resolving conflicts.`,
            null,
          ));
        } else {
          checks.push(check(
            'source_drift', 'Source code edits', 'info', true,
            'No local edits — fork matches upstream verbatim.',
          ));
        }
      }
    } catch { /* non-fatal */ }
  }

  return json(200, summarise(checks));
};

function summarise(checks) {
  const summary = { critical: 0, warning: 0, info: 0, healthy: 0 };
  for (const c of checks) {
    if (c.ok) summary.healthy++;
    else summary[c.severity] = (summary[c.severity] || 0) + 1;
  }
  return { ok: true, summary, checks };
}
