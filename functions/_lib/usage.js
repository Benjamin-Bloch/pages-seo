// AI usage logging, cost calculation, and budget enforcement.
//
// Every LLM/image call site builds a `usage` record and passes it to
// `recordUsage()`. Cost is computed from the active price catalogue
// (see functions/_lib/prices.js: live models.dev refresh + bundled
// fallback). Workers AI defaults to 0/0/0 since the free tier doesn't
// charge, but we still log the tokens (estimated, since the API
// doesn't return counts) so you can see where your neurons go.
//
// Budget enforcement: `checkBudget(env, source)` returns
//   { allowed, reason, spend, budget, pct }.
// Call it BEFORE the LLM call. Sources starting with 'cron' hard-stop
// at 100% of budget; admin sources allow the caller to override with
// `{ allow_over_budget: true }`.

import { newId, nowSec } from './util.js';
import { loadSettings } from './settings.js';
import { loadPrices, priceFor } from './prices.js';

// ~4 chars per token across English text. We use this only when the
// provider doesn't return counts (Workers AI, sometimes image models).
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(String(text).length / CHARS_PER_TOKEN));
}

// Compute cost in USD. For text: prices are $/1M tokens. For images:
// price is $/image.
export function computeCostUSD(prices, { provider, kind, prompt_tokens, completion_tokens }) {
  if (kind === 'image') {
    return +priceFor(prices, provider, 'image').toFixed(6);
  }
  const inP  = priceFor(prices, provider, 'in');
  const outP = priceFor(prices, provider, 'out');
  return +((prompt_tokens * inP + completion_tokens * outP) / 1_000_000).toFixed(6);
}

// Persist one usage row. Swallows DB errors so usage logging can never
// break a real generation — the request must succeed even if logging
// fails. `settings` arg kept for API stability with existing callers
// but no longer carries the rate table.
export async function recordUsage(env, settings, row) {
  try {
    // Always look up live prices fresh per call. Cheap (it's a cached
    // JSON string in settings) and means a manual refresh from the
    // Settings tab takes effect immediately.
    const { prices } = await loadPrices(env);
    const r = {
      id: newId(),
      provider: row.provider || 'unknown',
      model: row.model || null,
      kind: row.kind || 'text',
      source: row.source || 'admin',
      prompt_tokens: row.prompt_tokens | 0,
      completion_tokens: row.completion_tokens | 0,
      total_tokens: (row.prompt_tokens | 0) + (row.completion_tokens | 0),
      estimated: row.estimated ? 1 : 0,
      cost_usd: computeCostUSD(prices, {
        provider: row.provider, kind: row.kind,
        prompt_tokens: row.prompt_tokens | 0,
        completion_tokens: row.completion_tokens | 0,
      }),
      ok: row.ok === false ? 0 : 1,
      error: row.error ? String(row.error).slice(0, 400) : null,
      created_at: nowSec(),
    };
    await env.DB.prepare(
      `INSERT INTO ai_usage (id, provider, model, kind, source, prompt_tokens,
                              completion_tokens, total_tokens, estimated, cost_usd,
                              ok, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      r.id, r.provider, r.model, r.kind, r.source, r.prompt_tokens,
      r.completion_tokens, r.total_tokens, r.estimated, r.cost_usd,
      r.ok, r.error, r.created_at
    ).run();
    return r;
  } catch {
    return null; // never throw from logging
  }
}

// Unix timestamp for the start of the current UTC month.
function monthStartTs(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
  return Math.floor(d.getTime() / 1000);
}

export async function monthSpend(env) {
  const since = monthStartTs();
  const r = await env.DB.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM ai_usage WHERE created_at >= ?`
  ).bind(since).first().catch(() => null);
  return r?.total || 0;
}

// Returns { allowed, reason?, spend, budget, pct }.
//   allowed=false when source begins with 'cron' AND spend >= budget.
// Admin sources are always allowed (caller decides via allow_over_budget).
export async function checkBudget(env, source = 'admin') {
  const settings = await loadSettings(env);
  const budget = parseFloat(settings.monthly_budget_usd) || 0;
  const spend = await monthSpend(env);
  const pct = budget > 0 ? +((spend / budget) * 100).toFixed(1) : 0;
  if (budget > 0 && spend >= budget && String(source).startsWith('cron')) {
    return {
      allowed: false,
      reason: 'budget_exceeded',
      spend, budget, pct,
    };
  }
  return { allowed: true, spend, budget, pct };
}
