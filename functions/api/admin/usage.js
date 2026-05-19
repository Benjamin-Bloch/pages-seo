// AI usage stats for the admin dashboard.
//
// GET /api/admin/usage[?window=month|7d|24h]
//   Returns the current-window summary plus a per-day series and a
//   per-provider breakdown. The Usage tab in the admin UI renders
//   directly from this — one trip, no client-side aggregation.
//
// Default window is the current calendar month, which matches the
// budget enforcement period.
import { json } from '../../_lib/util.js';
import { adminGate } from '../../_lib/auth.js';
import { loadSettings } from '../../_lib/settings.js';
import { monthSpend, checkBudget } from '../../_lib/usage.js';

function windowStart(name) {
  const now = Date.now();
  if (name === '24h') return Math.floor((now - 24 * 3600_000) / 1000);
  if (name === '7d')  return Math.floor((now - 7  * 24 * 3600_000) / 1000);
  // 'month' (default): first of the current UTC month.
  const d = new Date();
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0));
  return Math.floor(m.getTime() / 1000);
}

export const onRequestGet = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  const url = new URL(request.url);
  const window = url.searchParams.get('window') || 'month';
  const since = windowStart(window);

  const settings = await loadSettings(env);
  const budget = parseFloat(settings.monthly_budget_usd) || 0;
  const warnPct = parseFloat(settings.budget_warn_pct) || 80;

  // Totals + provider breakdown + by-kind breakdown.
  const [total, byProvider, byKind, daily, recent] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
              COALESCE(SUM(total_tokens), 0) AS total_tokens,
              COALESCE(SUM(cost_usd), 0) AS cost_usd,
              SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS errors
         FROM ai_usage WHERE created_at >= ?`
    ).bind(since).first(),
    env.DB.prepare(
      `SELECT provider, COUNT(*) AS calls,
              COALESCE(SUM(total_tokens),0) AS tokens,
              COALESCE(SUM(cost_usd),0) AS cost
         FROM ai_usage WHERE created_at >= ?
         GROUP BY provider ORDER BY cost DESC`
    ).bind(since).all(),
    env.DB.prepare(
      `SELECT kind, COUNT(*) AS calls,
              COALESCE(SUM(total_tokens),0) AS tokens,
              COALESCE(SUM(cost_usd),0) AS cost
         FROM ai_usage WHERE created_at >= ?
         GROUP BY kind ORDER BY cost DESC`
    ).bind(since).all(),
    env.DB.prepare(
      // Daily rollup. SQLite has no DATE_TRUNC; floor-divide unix
      // timestamp into 86400-second buckets, then humanise client-side.
      `SELECT (created_at / 86400) * 86400 AS bucket,
              COUNT(*) AS calls,
              COALESCE(SUM(cost_usd),0) AS cost
         FROM ai_usage WHERE created_at >= ?
         GROUP BY bucket ORDER BY bucket ASC`
    ).bind(since).all(),
    env.DB.prepare(
      `SELECT created_at, provider, model, kind, source,
              prompt_tokens, completion_tokens, total_tokens, cost_usd, ok, error
         FROM ai_usage ORDER BY created_at DESC LIMIT 25`
    ).all(),
  ]);

  // Current month spend (always, regardless of selected window) so the
  // budget banner stays accurate.
  const monthBudgetSpend = window === 'month' ? (total?.cost_usd || 0) : await monthSpend(env);
  const budgetState = await checkBudget(env, 'admin'); // admin always allowed, but we want pct/spend

  return json(200, {
    ok: true,
    window,
    since,
    total: {
      calls: total?.calls || 0,
      prompt_tokens: total?.prompt_tokens || 0,
      completion_tokens: total?.completion_tokens || 0,
      total_tokens: total?.total_tokens || 0,
      cost_usd: +(total?.cost_usd || 0).toFixed(4),
      errors: total?.errors || 0,
    },
    by_provider: (byProvider?.results || []).map((r) => ({ ...r, cost: +Number(r.cost).toFixed(4) })),
    by_kind:     (byKind?.results || []).map((r) => ({ ...r, cost: +Number(r.cost).toFixed(4) })),
    daily:       (daily?.results || []).map((r) => ({ date: new Date(r.bucket * 1000).toISOString().slice(0, 10), calls: r.calls, cost: +Number(r.cost).toFixed(4) })),
    recent:      (recent?.results || []).map((r) => ({
      ...r, cost_usd: +Number(r.cost_usd).toFixed(6),
    })),
    budget: {
      monthly_usd: budget,
      month_spend_usd: +monthBudgetSpend.toFixed(4),
      pct: budget > 0 ? +((monthBudgetSpend / budget) * 100).toFixed(1) : 0,
      warn_pct: warnPct,
      over_warn: budget > 0 && monthBudgetSpend >= (budget * warnPct / 100),
      over_budget: budget > 0 && monthBudgetSpend >= budget,
      cron_blocked: budgetState.allowed === false,
    },
  });
};
