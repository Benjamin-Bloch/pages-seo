#!/usr/bin/env bash
# Re-deploy after code changes (CLI / maintainer path only).
#
# DO NOT run this from Cloudflare's Workers Builds CI — the build
# environment isn't authenticated to your account, and Pages auto-
# deploys whatever's in ./public after the build command. The right
# Workers Builds command is `npm run build` (which just bundles the
# schema; Cloudflare uploads ./public).
#
# Set CF_PAGES (Cloudflare sets it automatically in Workers Builds)
# to make this script no-op so an accidental wiring as the deploy
# command doesn't fail the build.

set -euo pipefail
cd "$(dirname "$0")"

if [[ -n "${CF_PAGES:-}" ]]; then
  echo "▸ Detected Cloudflare Workers Builds (CF_PAGES is set)."
  echo "  Skipping wrangler invocation — Cloudflare auto-deploys ./public."
  echo "  Configure your build command as 'npm run build' (no deploy command needed)."
  exit 0
fi

# Prefer npx so this works on machines without a globally-installed wrangler.
WRANGLER="${WRANGLER:-npx --yes wrangler}"

PROJECT_NAME=$(awk -F\" '/^name *=/{print $2; exit}' wrangler.toml)
[[ -n "$PROJECT_NAME" ]] || { echo "Could not read project name from wrangler.toml" >&2; exit 1; }

echo "▸ Deploying Pages site → $PROJECT_NAME"
$WRANGLER pages deploy public --project-name="$PROJECT_NAME" --commit-dirty=true

if [[ -d cron-worker ]]; then
  echo "▸ Deploying cron Worker"
  (cd cron-worker && $WRANGLER deploy)
fi

echo "✓ Done."
