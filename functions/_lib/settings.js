// Read/write the single-row settings store. Used by the LLM prompt
// builders to layer brand/voice/length config on top of env vars.
//
// Reading is "settings table → env var → hard default", so an env var
// (e.g. SITE_CTA) is the fallback if the DB row isn't set yet. This
// preserves the original behaviour for installs that haven't touched
// the settings page.
import { nowSec } from './util.js';

const FALLBACK = {
  site_cta:         (env) => env.SITE_CTA || 'Sign up to get started.',
  site_tone:        (_)   => '',
  site_audience:    (_)   => '',
  site_signup_url:  (env) => env.SITE_SIGNUP_URL || '/signup',
  site_pricing_url: (env) => env.SITE_PRICING_URL || '/pricing',
  site_contact_url: (env) => env.SITE_CONTACT_URL || '/contact',
  article_min_words:   () => '900',
  article_max_words:   () => '1300',
  prog_min_words:      () => '700',
  prog_max_words:      () => '1000',
  default_ai_provider: () => '',
  // Brand DNA — generated from the user's own site, editable in the
  // admin UI. Plugged into every prompt so the LLM writes as if it
  // works for that business.
  brand_business_type:     () => '',
  brand_voice_tone:        () => '',
  brand_target_audience:   () => '',
  brand_key_themes:        () => '', // newline- or comma-separated
  brand_topics_to_avoid:   () => '',
  brand_service_area:      () => '',
  brand_source_url:        () => '', // the URL we scraped (informational)
  brand_generated_at:      () => '', // ISO timestamp of last generation
  // How the daily blog chain produces its hero image.
  //   'ai'     = generate a fresh image with the AI provider (current default)
  //   'cover'  = render a saved cover template (uses the default template + post title)
  // When 'ai', the Covers tab is shown but frozen with an explainer.
  hero_image_mode:         () => 'ai',
  // Cached LLM price catalogue (JSON). Refreshed via the Settings tab
  // from models.dev. See functions/_lib/prices.js.
  price_cache_json:        () => '',
  // Usage + budget. Cost values are USD per 1M tokens, separate input
  // and output rates. Prices come from prices.js (bundled snapshot +
  // optional models.dev cache) rather than per-key settings.
  monthly_budget_usd:      () => '10',     // hard-stop cron when this month's spend >= this
  budget_warn_pct:         () => '80',     // show banner at this % of budget
};

const KEYS = Object.keys(FALLBACK);

export async function loadSettings(env) {
  const out = {};
  try {
    const rows = await env.DB.prepare('SELECT key, value FROM settings').all();
    for (const row of (rows?.results || [])) {
      if (row.value != null) out[row.key] = row.value;
    }
  } catch {
    // table missing or DB unavailable — fall through to env fallbacks
  }
  for (const k of KEYS) {
    if (out[k] == null || out[k] === '') out[k] = FALLBACK[k](env);
  }
  return out;
}

export async function setSetting(env, key, value) {
  if (!KEYS.includes(key)) throw new Error('unknown_setting: ' + key);
  const t = nowSec();
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  ).bind(key, value == null ? '' : String(value), t).run();
}

export function listSettingKeys() { return [...KEYS]; }
