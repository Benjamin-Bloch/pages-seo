# Changelog

All notable changes to **pages-seo**. When you upgrade your install
via the Updates tab in the admin, the commit list shows the raw git
log — this file is the friendlier "what's new for me as an operator"
version.

The format is loosely Keep-a-Changelog, dates in ISO order.

## 1.0.2 — 2026-05-21

Content-quality release. Targets the "Workers AI generates short generic blogs" complaint.

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
