-- pages-seo: D1 schema.
--
-- Apply with:  wrangler d1 execute pages-seo --remote --file=schema/init.sql
--
-- Five concepts:
--   blog_posts        — daily-cron-generated long-form blog posts.
--   blog_jobs         — multi-step generation state, persists between
--                       the 4 short HTTP calls that produce one post.
--                       Cloudflare Pages Functions kill background work
--                       aggressively, so we serialise via the DB instead.
--   blog_topic_usage  — dedupes the topic pool (60-day cooldown).
--   prog_pages        — programmatic landing pages, one per keyword.
--   prog_keywords     — the imported keyword list with status per row
--                       (pending / done / failed). Lets a big batch run
--                       across multiple cron windows without losing state.

CREATE TABLE IF NOT EXISTS blog_posts (
  id              TEXT PRIMARY KEY,                  -- 16-byte hex
  slug            TEXT UNIQUE NOT NULL,
  title           TEXT NOT NULL,
  meta_description TEXT NOT NULL,
  body_markdown   TEXT NOT NULL,
  hero_image_key  TEXT,                              -- R2 object key (nullable)
  hero_image_alt  TEXT,
  status          TEXT NOT NULL DEFAULT 'published', -- published | hidden
  topic_seed      TEXT,
  keywords        TEXT,                              -- comma-separated long-tails
  ai_provider     TEXT,                              -- 'workers-ai' | 'openai'
  created_at      INTEGER NOT NULL,
  published_at    INTEGER NOT NULL,
  hidden_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_blog_status_published_at
  ON blog_posts(status, published_at DESC);

CREATE TABLE IF NOT EXISTS blog_jobs (
  id              TEXT PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'created',   -- created | text_done | image_done | published | failed
  topic_key       TEXT,
  topic_angle     TEXT,
  -- /text outputs
  primary_query   TEXT,
  title           TEXT,
  slug            TEXT,
  meta_description TEXT,
  body_markdown   TEXT,
  keywords        TEXT,
  hero_image_prompt TEXT,
  hero_image_alt  TEXT,
  -- /image output
  hero_image_key  TEXT,
  -- /publish output
  blog_post_id    TEXT,
  -- any step's failure
  error           TEXT,
  ai_provider     TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blog_jobs_status_created
  ON blog_jobs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS blog_topic_usage (
  topic_key       TEXT PRIMARY KEY,
  last_used_at    INTEGER NOT NULL,
  times_used      INTEGER NOT NULL DEFAULT 1
);

-- Programmatic-SEO landing pages — one per imported keyword.
CREATE TABLE IF NOT EXISTS prog_pages (
  id              TEXT PRIMARY KEY,
  slug            TEXT UNIQUE NOT NULL,
  keyword         TEXT NOT NULL,                     -- the source keyword phrase
  title           TEXT NOT NULL,
  meta_description TEXT NOT NULL,
  body_markdown   TEXT NOT NULL,
  hero_image_key  TEXT,
  hero_image_alt  TEXT,
  status          TEXT NOT NULL DEFAULT 'published', -- published | hidden
  ai_provider     TEXT,
  created_at      INTEGER NOT NULL,
  published_at    INTEGER NOT NULL,
  hidden_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_prog_status
  ON prog_pages(status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_prog_keyword
  ON prog_pages(keyword);

-- The uploaded keyword pool. Cron processes pending rows in priority
-- order. `score`/`intent` come from the heuristic scorer; `priority`
-- can be overridden by the admin (defaults to score). `canonical` is
-- the normalised form used for dedupe.
CREATE TABLE IF NOT EXISTS prog_keywords (
  id              TEXT PRIMARY KEY,
  keyword         TEXT UNIQUE NOT NULL,
  canonical       TEXT,                              -- normalised form for dedupe
  intent          TEXT,                              -- transactional|commercial|informational|navigational|junk
  score           INTEGER NOT NULL DEFAULT 0,        -- 0-100, from scorer
  priority        INTEGER NOT NULL DEFAULT 0,        -- admin-overridable; defaults to score
  status          TEXT NOT NULL DEFAULT 'pending',   -- pending | processing | done | failed
  page_id         TEXT,                              -- links to prog_pages when done
  error           TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prog_kw_status
  ON prog_keywords(status, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_prog_kw_canonical
  ON prog_keywords(canonical);

-- Brand/voice/SEO settings. Single-row key/value store the admin UI
-- edits. The blog + programmatic generation chain reads these and
-- injects them into the LLM prompt so every post inherits the same
-- voice, tone, audience, and CTA without re-passing per-request.
-- Common keys:
--   site_cta         — call-to-action injected into the closing paragraph
--   site_tone        — voice description (e.g. "warm but authoritative…")
--   site_audience    — who you're writing for
--   site_signup_url  — overrides /signup alias
--   site_pricing_url — overrides /pricing alias
--   site_contact_url — overrides /contact alias
--   article_min_words, article_max_words   — length targets (numeric strings)
--   prog_min_words, prog_max_words         — length targets for prog pages
--   default_ai_provider                    — preferred provider name
CREATE TABLE IF NOT EXISTS settings (
  key             TEXT PRIMARY KEY,
  value           TEXT,
  updated_at      INTEGER NOT NULL
);

-- Cover image editor: uploaded background/logo assets, plus saved
-- composition templates.
--
-- Workflow:
--   1. Admin uploads background images + logos via /api/admin/cover/upload.
--      The bytes go to R2; one row per asset in cover_assets.
--   2. Admin builds a template in the canvas editor: chooses a bg + logo,
--      adds text layers, drags everything into place. Saves to
--      cover_templates with a JSON spec (see functions/_lib/cover_render.js
--      for the spec shape).
--   3. When generating a blog post, the admin can pick a saved template;
--      the editor renders the final PNG client-side from { title } +
--      template, and uploads it as the post's hero_image_key.
CREATE TABLE IF NOT EXISTS cover_assets (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,                 -- background | logo
  r2_key          TEXT NOT NULL,                 -- R2 object key
  original_name   TEXT,
  mime            TEXT,
  size_bytes      INTEGER NOT NULL DEFAULT 0,
  width           INTEGER,                       -- optional, client-supplied
  height          INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cover_assets_kind ON cover_assets(kind, created_at DESC);

CREATE TABLE IF NOT EXISTS cover_templates (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  is_default      INTEGER NOT NULL DEFAULT 0,    -- 1 = use for new posts unless overridden
  spec_json       TEXT NOT NULL,                 -- JSON: { width, height, layers: [...] }
  thumb_r2_key    TEXT,                          -- optional preview PNG
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cover_templates_updated ON cover_templates(updated_at DESC);

-- Per-call AI usage log. Every LLM/image generation writes one row.
-- We compute cost client-side from a per-provider price table (see
-- functions/_lib/usage.js + the pricing_* keys in `settings`). Workers
-- AI rows have estimated tokens (no API returns them) and cost 0 on
-- the free tier.
CREATE TABLE IF NOT EXISTS ai_usage (
  id                TEXT PRIMARY KEY,                -- 16-byte hex
  provider          TEXT NOT NULL,                   -- workers-ai | openai | anthropic | …
  model             TEXT,                            -- specific model variant
  kind              TEXT NOT NULL,                   -- text | image | brand-dna | brand-filter
  source            TEXT,                            -- blog | prog | preview | admin | cron
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  estimated         INTEGER NOT NULL DEFAULT 0,      -- 1 = tokens are estimates (no API)
  cost_usd          REAL    NOT NULL DEFAULT 0,
  ok                INTEGER NOT NULL DEFAULT 1,      -- 0 = error, 1 = success
  error             TEXT,
  created_at        INTEGER NOT NULL                 -- unix seconds
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_provider_created ON ai_usage(provider, created_at DESC);

-- Admin user accounts. Email + password (PBKDF2-SHA256 with a
-- per-user salt, 200k iterations). The original ADMIN_TOKEN bearer
-- header still works as a recovery / cron credential, so even if the
-- users table is empty or corrupted you can always reach the admin.
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,                -- 16-byte hex
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash   TEXT NOT NULL,                   -- base64
  password_salt   TEXT NOT NULL,                   -- base64, 16 bytes
  created_at      INTEGER NOT NULL,
  last_login_at   INTEGER
);

-- Active login sessions. One row per signed-in browser session. We
-- store the token's id (not the token itself); the cookie value is
-- `<id>.<hmac>` and the HMAC is verified using ADMIN_TOKEN as the
-- shared secret. Lets us revoke individual sessions without rotating
-- the master token.
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,                -- 16-byte hex
  user_id         TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  user_agent      TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, expires_at);

-- Rate limit table: tracks login attempts per email + IP combo so
-- brute-force attempts hit a wall after 5 failures.
CREATE TABLE IF NOT EXISTS login_attempts (
  key             TEXT PRIMARY KEY,                -- email + '|' + ip (or 'ip:' + ip)
  failures        INTEGER NOT NULL DEFAULT 0,
  locked_until    INTEGER,                          -- unix seconds; null when unlocked
  updated_at      INTEGER NOT NULL
);

-- Encrypted-at-rest API key vault. Used when the admin wants to set
-- LLM provider keys from the dashboard rather than via
-- `wrangler pages secret put`. Ciphertext is AES-GCM with a key derived
-- from ADMIN_TOKEN. See functions/_lib/secret_vault.js.
CREATE TABLE IF NOT EXISTS secrets_vault (
  key_name        TEXT PRIMARY KEY,                  -- e.g. OPENAI_API_KEY
  ciphertext      TEXT NOT NULL,                     -- base64(IV || ciphertext-with-tag)
  updated_at      INTEGER NOT NULL
);

-- Audit log: every action (cron, manual, errors) for visibility.
CREATE TABLE IF NOT EXISTS audit_log (
  id              TEXT PRIMARY KEY,
  actor           TEXT,
  action          TEXT NOT NULL,
  target_id       TEXT,
  details         TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_action_created
  ON audit_log(action, created_at DESC);
