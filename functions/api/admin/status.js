// GET /api/admin/status
//
// One-shot health check. The /admin Status page calls this on load
// and renders a green/yellow/red checklist so the operator can see
// what's wired up correctly and what isn't, without having to ask
// support or read 500-level logs.
//
// Each check returns { ok, detail? }. We never throw — a failed
// check returns ok:false with a short reason. Some checks (cron,
// audit) need DB; if DB itself is unavailable they degrade to
// "unknown" rather than cascade-failing.

import { json } from '../../_lib/util.js';
import { adminGate } from '../../_lib/auth.js';
import { loadSettings } from '../../_lib/settings.js';

async function checkDb(env) {
  if (!env.DB) return { ok: false, detail: 'env.DB binding missing' };
  try {
    const r = await env.DB.prepare('SELECT 1 AS ok').first();
    return r?.ok === 1 ? { ok: true } : { ok: false, detail: 'unexpected response' };
  } catch (e) {
    return { ok: false, detail: String(e?.message || e).slice(0, 200) };
  }
}

async function checkR2(env) {
  if (!env.IMAGES) return { ok: false, detail: 'env.IMAGES binding missing' };
  try {
    // Cheapest probe — list one object with a prefix that almost
    // certainly doesn't exist. The call itself proves the binding
    // works.
    await env.IMAGES.list({ prefix: '__status_probe__', limit: 1 });
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: String(e?.message || e).slice(0, 200) };
  }
}

async function checkAI(env) {
  if (!env.AI) return { ok: false, detail: 'env.AI binding missing — Workers AI not bound on this Pages project' };
  return { ok: true, detail: 'binding present (not invoked — call /api/admin/providers/test to probe end-to-end)' };
}

// Count how many published blog posts + prog pages we have. Useful
// signal: zero published = cron isn't producing content.
async function checkContent(env) {
  if (!env.DB) return { ok: false, detail: 'DB unavailable' };
  try {
    const blogs = await env.DB.prepare(
      `SELECT COUNT(*) AS n, MAX(published_at) AS last FROM blog_posts WHERE status='published'`
    ).first();
    const progs = await env.DB.prepare(
      `SELECT COUNT(*) AS n, MAX(published_at) AS last FROM prog_pages WHERE status='published'`
    ).first();
    const lastBlogTs = blogs?.last || 0;
    const ageDays = lastBlogTs ? Math.floor((Date.now() / 1000 - lastBlogTs) / 86400) : null;
    return {
      ok: true,
      blogs: blogs?.n || 0,
      blogs_last_published_at: lastBlogTs || null,
      blogs_age_days: ageDays,
      progs: progs?.n || 0,
      progs_last_published_at: progs?.last || 0,
    };
  } catch (e) {
    return { ok: false, detail: String(e?.message || e).slice(0, 200) };
  }
}

// Inspect recent audit entries to surface failures. Anything with
// action containing 'fail' or 'error' in the last 7 days counts.
async function checkRecentFailures(env) {
  if (!env.DB) return { ok: true, count: 0, detail: 'DB unavailable' };
  try {
    const since = Math.floor(Date.now() / 1000) - 7 * 86400;
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_log
       WHERE created_at >= ? AND (action LIKE '%fail%' OR action LIKE '%error%')`
    ).bind(since).first();
    const count = r?.n || 0;
    return {
      ok: count === 0,
      count,
      detail: count ? `${count} failure-flagged audit entries in the last 7d` : 'no failures in last 7d',
    };
  } catch (e) {
    return { ok: false, detail: String(e?.message || e).slice(0, 200) };
  }
}

// Spend snapshot — surface budget pressure at status-load time.
async function checkBudget(env) {
  if (!env.DB) return { ok: true, detail: 'DB unavailable' };
  try {
    const monthStart = (() => {
      const d = new Date();
      d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0);
      return Math.floor(d.getTime() / 1000);
    })();
    const r = await env.DB.prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM ai_usage WHERE ts >= ?`
    ).bind(monthStart).first().catch(() => ({ spent: 0 }));
    const settings = await loadSettings(env).catch(() => ({}));
    const cap = parseFloat(settings?.monthly_budget_usd || '10') || 10;
    const spent = parseFloat(r?.spent || 0);
    const pct = cap ? Math.round((spent / cap) * 100) : 0;
    const warnPct = parseInt(settings?.budget_warn_pct || '80', 10) || 80;
    return {
      ok: pct < 100,
      detail: `$${spent.toFixed(4)} / $${cap.toFixed(2)} (${pct}%)`,
      spent_usd: spent,
      cap_usd: cap,
      pct,
      warn_at_pct: warnPct,
      warning: pct >= warnPct,
    };
  } catch (e) {
    return { ok: true, detail: 'budget table not present yet' };
  }
}

// Provider config snapshot. Doesn't ping the providers (use
// /api/admin/providers/test for that) — just reports which are
// configured with a non-empty key/setting.
async function checkProviders(env) {
  const settings = await loadSettings(env).catch(() => ({}));
  const list = [];
  // The settings keys for provider secrets follow a pattern; we
  // grep the whole settings blob and report any *_api_key keys.
  for (const [k, v] of Object.entries(settings || {})) {
    if (/_api_key$|^openai_|^anthropic_|^groq_|^google_ai_|^together_/.test(k)) {
      list.push({ key: k, configured: !!String(v || '').trim() });
    }
  }
  const ai = !!env.AI;
  return {
    ok: ai || list.some((p) => p.configured),
    workers_ai_binding: ai,
    providers: list,
  };
}

// Pages secrets the install flow set. Surface them so the user can
// see whether self-repair is wired up.
function checkRepairSecrets(env) {
  const need = ['CF_API_TOKEN', 'CF_ACCOUNT_ID', 'CF_PROJECT', 'CF_D1_ID', 'CF_R2_NAME'];
  const missing = need.filter((k) => !env?.[k] || !String(env[k]).trim());
  return {
    ok: missing.length === 0,
    missing,
    detail: missing.length
      ? `${missing.length} secret(s) missing — site can't self-repair bindings`
      : 'all CF_* secrets present',
  };
}

export const onRequestGet = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;

  const [db, r2, ai, content, failures, budget, providers] = await Promise.all([
    checkDb(env),
    checkR2(env),
    checkAI(env),
    checkContent(env),
    checkRecentFailures(env),
    checkBudget(env),
    checkProviders(env),
  ]);
  const repair = checkRepairSecrets(env);

  const checks = [
    { id: 'db',         label: 'D1 database',          ...db },
    { id: 'r2',         label: 'R2 bucket',            ...r2 },
    { id: 'ai',         label: 'Workers AI',           ...ai },
    { id: 'content',    label: 'Published content',    ...content },
    { id: 'failures',   label: 'Recent failures (7d)', ...failures },
    { id: 'budget',     label: 'Monthly spend',        ...budget },
    { id: 'providers',  label: 'AI providers',         ...providers },
    { id: 'repair',     label: 'Self-repair secrets',  ...repair },
  ];

  const all_ok = checks.every((c) => c.ok !== false);

  return json(200, {
    ok: true,
    all_ok,
    checked_at: Math.floor(Date.now() / 1000),
    checks,
  });
};
