# Changelog

All notable changes to **pages-seo**. When you upgrade your install
via the Updates tab in the admin, the commit list shows the raw git
log — this file is the friendlier "what's new for me as an operator"
version.

The format is loosely Keep-a-Changelog, dates in ISO order.

## Unreleased

### Added
- **Updates tab** in the admin dashboard. Shows the commit list
  between your installed version and upstream main, with diff stats
  and a one-click "trigger rebuild" for browser-installed sites.
  CLI-installed sites see the re-run command they need.
- A "N" badge appears on the Updates tab when commits are available.
- One-command terminal installers at `seo.benjaminb.xyz/install/run.{sh,py,js}`.
- Pre-flight existence checks for D1 and R2 in the browser installer
  so "already exists" stops blocking subsequent retries.

### Changed
- Browser installer requires you to fork the repo on GitHub first
  (Cloudflare's Pages-from-Git can only see repos owned by an
  account that has authorised the Workers & Pages GitHub App).
- Admin password minimum lowered from 12 to 8 characters.
- `wrangler.toml` is no longer tracked in git; copy
  `wrangler.template.toml` to `wrangler.toml` after install if you
  want to deploy from CLI.

### Fixed
- `curl … | bash|python|node` installers now read from `/dev/tty`
  so prompts work when the script is piped from curl.
- Pages-create silently dropping D1/R2 bindings — installer now
  PATCHes the project config after creation as a belt-and-braces.
- Soro mentions removed from copy + comments (copyright hygiene).
