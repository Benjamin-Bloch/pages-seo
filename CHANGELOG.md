# Changelog

All notable changes to **pages-seo**. When you upgrade your install
via the Updates tab in the admin, the commit list shows the raw git
log — this file is the friendlier "what's new for me as an operator"
version.

The format is loosely Keep-a-Changelog, dates in ISO order.

## 1.0.6 — 2026-06-07

### Removed
- **The "Deploy to Cloudflare" 1-click button.** Cloudflare's auto-
  generated CI token for new Pages projects doesn't include
  `Pages:Edit`, so the very first build fails with
  `Authentication error [code: 10000]`. Until Cloudflare ships a
  fix, the button created more confusion than convenience —
  every install hit the wall, half the users abandoned. The
  browser installer at `/install` now becomes the no-terminal
  path, and it actually works end-to-end. Removed from the
  marketing hero CTA row, the install-page section, the
  `/install` chooser, and the README. The
  `err-deploy-button-auth-10000` entry in `/docs#errors`
  documents the trace for anyone who already had a half-broken
  project.

### Added
- **First-run zero-secret install.** The deploy flow no longer
  requires any user-supplied secrets. `ADMIN_TOKEN` and
  `INDEXNOW_KEY` auto-generate on first `/api/setup` call;
  `SITE_NAME` / `SITE_URL` auto-resolve from the request host or
  the operator's input in the first-run setup card. The full
  list of "optional" Pages secrets in `.env.example` is now
  commented out by default so Cloudflare's deploy UI shows zero
  required fields. `package.json` ships a `cloudflare.bindings`
  block with descriptions so any forker who DOES uncomment a key
  gets context.

### Changed
- **`/install` step 3 redesigned for token paste.** Three numbered
  cards (open token page → paste token → name site), each visually
  locked/active/done as the user progresses. Big animated CTA on
  the create-token step, real-time validation on the token field
  (regex-match + status line), auto-paste detection on
  tab-refocus, auto-focus on the site-name input once the token
  validates. The Install button stays disabled until all three
  steps are done — no more "submit then learn what's wrong".

### Fixed
- **IndexNow never worked on browser installs.** Both the ping
  client and the site-verification file route read `env.INDEXNOW_KEY`
  with no D1 fallback, so installs that never set the secret
  silently never pinged Bing/Yandex/Seznam. Added
  `functions/_lib/indexnow_key.js` mirroring the `admin_token.js`
  resolution pattern; both call sites now use it.
- **Site name fell back to "pages-seo" forever on browser installs.**
  `feed.xml`, `blog/index`, `page_render`, `widget.js`, and the
  admin generate endpoints read `settings.site_name`, but
  `/api/setup` was writing `site_name_db`. Added a derived alias
  in `loadSettings()` that resolves `site_name` from
  (env-or-`site_name_db`). One fix unblocked 5 call sites.
- **`getHost()` in IndexNow** also only checked `env.SITE_URL`. Now
  resolves through `getSiteIdentity()` (env-or-D1).
- **Workers Builds deploy command broke on `wrangler: command not found`.**
  `deploy.sh` called bare `wrangler`; Workers Builds CI doesn't
  install wrangler globally. Added wrangler as a `devDependency`,
  rewrote the `deploy` script to use `npx wrangler pages deploy`,
  added a `cloudflare-deploy.sh` wrapper that turns auth-10000
  errors into actionable build-log messages instead of a generic
  stack trace. The old script lives at `deploy:cli`.

## 1.0.5 — 2026-06-06

### Added
- **AI duplicate detection** (`functions/_lib/dedup.js`). Every
  candidate topic is embedded via Workers AI's BGE base model and
  cosine-compared against the 50 most recent published posts. The
  cron repicks on near-duplicates (similarity ≥ 0.80) up to 5 times,
  then falls back to the least-similar option. Calibrated against
  real posts: rewrites of an existing topic score ~0.83 (blocked);
  family-related but distinct topics score ~0.77 (allowed).
- **Pre-publish quality scoring** (`functions/_lib/quality.js`).
  Deterministic 0–100 check on word count, headings, lists,
  internal links, title/meta length. Posts scoring 'bad' (< 45)
  go to a new `status='review'` state instead of going live.
  Public site treats 'review' as 404; admin still sees them. The
  operator can `force_publish: true` to override.
- **Internal-link injection** (`functions/_lib/internal_links.js`).
  After generation, scan the body for phrases matching titles and
  keywords of other published posts, and inject up to 3 markdown
  links — skipping code blocks and existing links. Big SEO + reader-
  retention win; every new post becomes a link upgrade for older ones.
- **Slug cleanup + 301 redirects.** The AI occasionally prepended
  "Blog" to its own title/slug field, producing URLs like
  `/blog/blogoptimize-...`. Text generation now strips this via a
  title-level check (the AI's tell is a capital letter immediately
  after "Blog"), then re-slugifies. A new admin endpoint
  `POST /api/admin/blog/rename-slug` migrates broken legacy slugs
  with automatic 301 redirects (via a new `blog_post_redirects`
  table created on first use).
- **Category-aware topic rotation.** `functions/_lib/topics.js` now
  tags each topic with a `category` (on-page, technical, content,
  links, off-page, analytics, platform, ai). The cron picker
  prefers categories not used in the last 7 days, preventing the
  "three Cloudflare Pages posts in five days" clustering pattern.
- **Public RSS feed** at `/feed.xml`. RSS 2.0 with the 30 most
  recent posts, advertised via `<link rel="alternate">` in every
  blog page's `<head>` and a `Feed:` line in `robots.txt`. No
  config required — uses the request's own host.
- **Richer `/api/version`.** External tools and other installs now
  get `recent_commits[]` (last 20 on main), `release_notes` (body
  of the latest GH release), and `commits_since_tag` (count of
  main commits ahead of the latest tag). Backward-compatible: all
  v1 fields preserved.
- **Beefier `/api/health`.** Adds `posts.count`,
  `posts.last_published`, `posts.hours_since_last`,
  `posts.cron_likely_alive`, and `jobs.in_flight_stuck` so an
  uptime monitor can detect a silently-dead cron without you having
  to look at the admin UI.
- **Cron Worker `/diag`** (`pages-seo-cron`). Unauthenticated
  config probe that reports whether each secret is configured,
  whether the BLOG_URL/PROG_URL endpoints answer, the current UK
  offset, and the next scheduled run times. Doesn't leak any
  secret values.

### Fixed
- **Cron's `ADMIN_TOKEN` was stale.** The cron Worker had a
  different `ADMIN_TOKEN` from the Pages project, so every cron
  hour returned `{"error":"unauthorized"}`. Rotated to a fresh
  64-hex token on both sides — diagnosed via the new `/diag`.
- **Installer (`run.py`/`run.js`/`run.sh`) D1 parsing.** Wrangler
  changed its `d1 create` output from a TOML snippet to JSON;
  installers now accept both, with a bare-UUID fallback for any
  future format change.
- **Installer source archive missing `wrangler.toml`.** Releases
  ship `wrangler.template.toml` so the demo's real D1/R2 IDs
  aren't carried into installs. All three installers now copy
  the template into place when the working file is absent.
- **Installer password input was fully hidden.** Both `run.py` and
  `run.sh` now read from `/dev/tty` (so curl-piped invocations
  don't swallow script bytes as input) and show the last typed
  character in plain before masking on the next keystroke —
  clearer than blind input without exposing the password.
- **Markdown rendering — full GFM support.** Tables, fenced code
  blocks, blockquotes, horizontal rules, nested lists, underscore
  bold/italic, strikethrough, images, and bare-URL autolinks all
  now render. Replaced the NUL-byte sentinel in the inline-code
  protection (which made the source a binary file) with a split-
  based approach. Bare-URL autolinks now correctly strip trailing
  sentence punctuation.
- **Cover SVGs serve the cream/sage background** for posts without
  a stored hero image. Falls back to the live `/cover/<slug>.svg`
  template via a `?v=<template_updated_at>` cache-buster, so
  template edits invalidate cached covers immediately.
- **`/install` page restyled** to match the marketing palette
  (was inheriting admin dashboard's dark/cyan theme). Black primary
  button + cream background. The "Stuck? Use AI" pill no longer
  overlaps the step list. Re-instated the Browser-vs-Terminal
  chooser as the first step.
- **README/CLI docs replaced `npx pages-seo-install`** with the
  real working install one-liners. The CLI was never published to
  npm.

### Changed
- Migration: `blog_posts` gains `embedding`, `embedding_model`,
  `embedding_at` columns (all nullable; backfilled via the new
  `POST /api/admin/blog/embed-backfill` endpoint).
- Migration: `blog_post_redirects` table created lazily by the
  rename-slug endpoint. No separate migration needed.
- `/api/version` cache headers now include
  `stale-while-revalidate=86400` so a GitHub blip never breaks
  external consumers.

## 1.0.4 — 2026-05-21

### Added
- **Google Search Console auto-indexing.** On every blog publish and
  programmatic-page generation, pages-seo now also re-submits your
  sitemap to GSC and (optionally) pings each new URL via the
  Indexing API.
  - Configure via /admin → Settings → Search engines. Paste your
    service-account JSON; the rest is auto-detected.
  - Sitemap re-submit is on by default — ToS-compliant for any
    content type. Indexing API is opt-in via a checkbox (faster
    crawl pickup but technically against Google's ToS for non-job
    posting content).
  - Credentials live in the vault (AES-GCM, keyed off ADMIN_TOKEN)
    — never written to the D1 settings table directly.
  - "Test connection" button runs a live sitemap submission so you
    can verify the service account has Owner permission in GSC
    before the next cron run.
- New endpoints:
  - `GET /api/admin/google-search-console` — describe current config
  - `POST /api/admin/google-search-console` — save JSON + options
  - `DELETE /api/admin/google-search-console` — clear all
  - `POST /api/admin/google-search-console/test` — live test

### Changed
- Blog publish + programmatic generate-next now fire BOTH IndexNow
  (Bing/Yandex/Seznam) AND GSC (Google) auto-indexing when the
  respective credentials are configured. Best-effort, non-blocking
  — failures don't block the publish.

## 1.0.3 — 2026-05-21

Hotfix for v1.0.2.

### Fixed
- **Infinite-refresh bug** when visiting `/admin → Distribution → SEO`
  multiple times. The new widget-snippet UI in v1.0.2 was binding
  click/input listeners every time the SEO tab was activated, and
  the live preview was cache-busting `widget.js` on every keystroke.
  After a few tab switches every keystroke triggered N stacked
  `build()` calls each fetching a fresh widget.js — the browser
  surfaced this as constant network activity / "page is refreshing".
  Listeners are now bound once via a `_widgetWired` guard; the
  preview script loads from the normal cached URL.

## 1.0.2 — 2026-05-21

Content-quality + admin-UX release.

### Added
- **Light/dark mode** in /admin. Topbar toggle (☀ / ☾), persisted in
  localStorage. Applied before first paint so there's no
  flash-of-wrong-theme. Same accent + status colours in both modes.
- **Widget copy-paste, three flavours.** /admin → Distribution → SEO
  now has a proper embed-snippet card with:
  - tabs for JavaScript, iframe, and link-only flavours
  - inline Copy button with ⌘C fallback when clipboard is denied
  - "Customise" options panel (container id, heading, post count,
    light/dark/auto theme)
  - live preview that re-mounts on every change

### Changed
- **Workers AI default text model upgraded** from `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
  to `@cf/qwen/qwen3-30b-a3b-fp8`. Qwen3 is an MoE model that only
  activates ~3B params per token (latency similar to a 7B dense model)
  but produces noticeably better long-form prose. Set
  `env.WORKERS_AI_TEXT_MODEL` to override.
- **Default article length bumped** from 900–1300 words → **2500–4000 words**.
  Long-form ranks better for long-tail queries and has more share value.
  Operators who prefer shorter posts can edit `article_min_words`
  and `article_max_words` in /admin → Settings.
- **`max_tokens` raised** from 4096 → 8192 across all providers
  (Workers AI, Anthropic, OpenAI-compat chat completions). 4096 was
  truncating the longer articles mid-section.
- **Prompt threads length targets** properly now. Previous prompts
  hardcoded "900-1300 words" regardless of settings; new prompts
  read from `article_min_words`/`article_max_words` and scale H2
  count + FAQ depth to match (≥3000 words → 6-10 H2s, 5-8 FAQ Qs).
- **Explicit length enforcement** in the prompt — the model is told to
  count its own words before returning JSON and to expand the weakest
  H2 if it finishes short.

## 1.0.1 — 2026-05-21

Patch release. Fixes Update flow regressions surfaced while smoke-testing 1.0.0.

### Fixed
- `/api/admin/update/apply` was POSTing an empty JSON body to Cloudflare's
  Pages deployments endpoint, which returned 400 *"A 'manifest' field was
  expected in the request body"*. The endpoint actually wants a
  `multipart/form-data` body with a `branch` field for Git-linked projects
  (the manifest path is for Direct Upload only). Now sends the right shape.
- `install_method='maintainer'` installs (i.e. `seo.benjaminb.xyz` itself)
  couldn't trigger an in-app update — `can_apply` was hard-gated on
  `'browser'`. Both `'browser'` and `'maintainer'` produce Git-linked
  Pages projects, so both now share the redeploy hook.
- Admin Updates tab shows transient GitHub 502/403/429 as a yellow
  "try again in 30s" warning instead of a red broken-system error.
  (Cloudflare edge IPs share the 60 req/hr unauth GitHub pool;
  occasional 502s are expected on busy edges.)
- `/api/version`, `/api/changes`, `/api/admin/update` no longer attempt
  the deprecated OAuth-client-credentials Basic-auth path. Only
  `env.GITHUB_TOKEN` is honoured (deployments without one fall back to
  Cloudflare's shared unauth pool).

## 1.0.0 — 2026-05-21

First stable release. Everything below has shipped and is considered the
supported surface; future 1.x releases are bug fixes + additive features
that won't break existing installs.

### Highlights for new users
- **One-click browser install** at `seo.benjaminb.xyz/install` — sign in
  with GitHub, paste a Cloudflare API token, click Install. The full
  D1 + R2 + Pages + schema + admin user flow runs in ~3 minutes.
- **One-line CLI install**: `curl -fsSL seo.benjaminb.xyz/install/run.sh | bash`
  (also `.py` / `.js`). Idempotent — re-running on an existing install
  upgrades it in place without losing data.
- **AI bootstrap**: `seo.benjaminb.xyz/ai-setup` generates a self-contained
  prompt you paste into ChatGPT/Claude/Gemini if you'd rather hand the
  install to an LLM than do it yourself.
- **Diagnose-then-fix**: the AI prompt for /repair scans your live site
  before generating the prompt, so the LLM gets a punch-list of what's
  actually broken instead of running through a generic playbook.

### Added (this release)
- **Updates tab** in the admin dashboard. Shows the commit list
  between your installed version and upstream main, with diff stats
  and a one-click "trigger rebuild" for browser-installed sites.
- **System → Status** page with 12 health checks (D1 binding, R2 binding,
  Workers AI, self-repair secrets, GitHub source, fork sync, last deploy,
  etc.) and per-check "Fix" buttons.
- **/repair** page (public, no admin needed) — black-box-diagnoses any
  install when you paste a Cloudflare API token. Auto-detects the
  project, runs the full check suite, offers one-click fixes.
- **`/api/health`** liveness endpoint (200 if the worker + D1 are up).
- **`/api/version`** + **`/api/changes`** canonical endpoints used by
  the admin Updates tab — cached at the edge so all installs share a
  warm cache.
- **AI help card** on /admin → System → Stuck? Personalises a one-click
  link to /ai-setup with the user's own slug + URLs.

### Changed
- Browser installer now creates a fork automatically (rather than
  requiring the user to fork first), as long as the Cloudflare Workers
  and Pages GitHub App has access to the user's account.
- Admin password minimum lowered from 12 to 8 characters.
- `wrangler.toml` is no longer tracked in git; copy
  `wrangler.template.toml` to `wrangler.toml` after install if you
  want to deploy from CLI.

### Fixed
- `curl … | bash|python|node` installers now read from `/dev/tty`
  so prompts work when the script is piped from curl.
- Pages-create silently dropping D1/R2 bindings — installer now
  PATCHes the project config after creation as a belt-and-braces.
- `/api/version`, `/api/changes`, and `/api/admin/update` now
  authenticate against GitHub via `GITHUB_OAUTH_CLIENT_ID/SECRET` (or
  `GITHUB_TOKEN`) so Cloudflare edge IPs don't burn through the 60/hr
  unauth limit and start returning 502.
- Cover SVGs now ship base64-inlined backgrounds so the live `/cover/<slug>.svg`
  endpoint doesn't break when the R2 bucket has CORS oddities.
- Client-side WebP compression in the cover editor (10–15× smaller
  uploads).
- Multiple CodeQL findings (workflow permissions, error-stack leakage,
  double-escaping in scrape, command-injection in CLI).
