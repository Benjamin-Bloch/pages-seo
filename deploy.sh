#!/usr/bin/env bash
# Re-deploy after code changes. Doesn't touch resources or secrets.
set -euo pipefail
cd "$(dirname "$0")"

PROJECT_NAME=$(awk -F\" '/^name *=/{print $2; exit}' wrangler.toml)
[[ -n "$PROJECT_NAME" ]] || { echo "Could not read project name from wrangler.toml" >&2; exit 1; }

echo "▸ Deploying Pages site → $PROJECT_NAME"
wrangler pages deploy public --project-name="$PROJECT_NAME" --commit-dirty=true

if [[ -d cron-worker ]]; then
  echo "▸ Deploying cron Worker"
  (cd cron-worker && wrangler deploy)
fi

echo "✓ Done."
