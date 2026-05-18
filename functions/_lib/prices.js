// LLM price catalogue.
//
// Resolution order:
//   1. cached refresh from models.dev (settings.price_cache_json, refreshed
//      manually from the Settings tab; falls back to bundled snapshot if
//      the cache is missing or older than the staleness threshold)
//   2. bundled snapshot (this file) — current as of Jan 2026
//
// Prices are USD per 1M tokens for text (in / out) and USD per image
// for image generation.
//
// The cache key (`price_cache_json`) stores the entire fetched payload
// + the timestamp; we don't try to clever-merge per-provider so a
// refresh that only returns some providers doesn't accidentally zero
// out the others.

import { loadSettings, setSetting } from './settings.js';
import { nowSec } from './util.js';

// Bundled snapshot. Maps internal provider name → { in, out, image }.
// In/out are USD per 1M tokens; image is USD per image.
export const BUNDLED_PRICES = {
  'workers-ai': { in: 0,    out: 0,     image: 0    },
  'openai':     { in: 1.25, out: 10.00, image: 0.04 }, // gpt-5
  'anthropic':  { in: 15.00,out: 75.00, image: null },  // claude-opus-4-7
  'gemini':     { in: 1.25, out: 10.00, image: 0.04 }, // gemini-2.5-pro / imagen-4
  'groq':       { in: 0.59, out: 0.79,  image: null }, // llama-3.3-70b
  'deepseek':   { in: 0.27, out: 1.10,  image: null },
  'mistral':    { in: 2.00, out: 6.00,  image: null }, // mistral-large
  'together':   { in: 0.88, out: 0.88,  image: null }, // llama-3.3-70b
  'cerebras':   { in: 0.85, out: 1.20,  image: null }, // llama-3.3-70b
};

// Map our internal provider name → the models.dev provider id and
// model id we use by default. models.dev returns per-model rows, so we
// pick the closest match for the model each provider helper actually
// calls. Update both this map and the helpers in ai.js if you change
// default models.
const MODELS_DEV_MAP = {
  'openai':    { provider: 'openai',          model: 'gpt-5' },
  'anthropic': { provider: 'anthropic',       model: 'claude-opus-4-7' },
  'gemini':    { provider: 'google',          model: 'gemini-2.5-pro' },
  'groq':      { provider: 'groq',            model: 'llama-3.3-70b-versatile' },
  'deepseek':  { provider: 'deepseek',        model: 'deepseek-chat' },
  'mistral':   { provider: 'mistral',         model: 'mistral-large-latest' },
  'together':  { provider: 'together',        model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  'cerebras':  { provider: 'cerebras',        model: 'llama-3.3-70b' },
};

const CACHE_STALENESS_SEC = 7 * 24 * 3600; // a week

// Parse a models.dev-style payload into our internal shape. The real
// API shape is { providers: { <id>: { models: { <id>: { cost: {input, output, ...} } } } } }.
// We're tolerant to missing fields — anything we can't map falls back
// to the bundled snapshot.
function parseModelsDev(payload) {
  const out = {};
  const providers = payload?.providers || payload;
  if (!providers || typeof providers !== 'object') return out;
  for (const [name, map] of Object.entries(MODELS_DEV_MAP)) {
    const p = providers[map.provider];
    const m = p?.models?.[map.model];
    if (!m?.cost) continue;
    // models.dev expresses cost as USD per 1M tokens already.
    const inP  = Number(m.cost.input);
    const outP = Number(m.cost.output);
    if (!Number.isFinite(inP) || !Number.isFinite(outP)) continue;
    out[name] = { in: inP, out: outP, image: BUNDLED_PRICES[name]?.image ?? null };
  }
  return out;
}

// Fetch the live catalogue and persist it in settings.price_cache_json
// alongside a fetched_at timestamp. Returns the merged price map.
export async function refreshPricesFromModelsDev(env) {
  const r = await fetch('https://models.dev/api.json', {
    headers: { Accept: 'application/json' },
  });
  if (!r.ok) throw new Error('models_dev_http_' + r.status);
  const payload = await r.json();
  const live = parseModelsDev(payload);
  const merged = { ...BUNDLED_PRICES };
  for (const [k, v] of Object.entries(live)) merged[k] = v;
  await setSetting(env, 'price_cache_json', JSON.stringify({
    fetched_at: nowSec(),
    source: 'models.dev',
    prices: merged,
  }));
  return { prices: merged, source: 'models.dev', fetched_at: nowSec(), count_updated: Object.keys(live).length };
}

// Return the active price map. Caller-friendly — never throws, always
// returns something usable.
export async function loadPrices(env) {
  const settings = await loadSettings(env);
  const cached = settings.price_cache_json;
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      const fetched = parsed.fetched_at || 0;
      if (parsed?.prices && (nowSec() - fetched) < CACHE_STALENESS_SEC) {
        return { prices: parsed.prices, source: parsed.source || 'cache', fetched_at: fetched, stale: false };
      }
      // Cache exists but stale — still return its values, mark stale.
      if (parsed?.prices) {
        return { prices: parsed.prices, source: parsed.source || 'cache', fetched_at: fetched, stale: true };
      }
    } catch { /* ignore corrupted cache */ }
  }
  return { prices: BUNDLED_PRICES, source: 'bundled', fetched_at: 0, stale: false };
}

// Convenience: look up one price field.
export function priceFor(prices, provider, direction /* 'in' | 'out' | 'image' */) {
  const row = prices?.[provider];
  if (!row) return 0;
  const v = row[direction];
  return Number.isFinite(v) && v >= 0 ? v : 0;
}
