# Changelog

All notable changes to **pages-seo**. When you upgrade your install
via the Updates tab in the admin, the commit list shows the raw git
log — this file is the friendlier "what's new for me as an operator"
version.

The format is loosely Keep-a-Changelog, dates in ISO order.

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
