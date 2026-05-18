#!/usr/bin/env bash
# Resume setup from after D1 creation. Use when setup.sh dies partway
# through and you don't want to re-run the whole thing.
#
# Reads existing values from .env, takes the D1 ID + project name as
# args, then runs the remaining steps: patch wrangler.toml → R2 → apply
# schema → push secrets → deploy Pages → deploy cron Worker.
#
# Usage:
#   bash scripts/resume.sh <project_name> <db_name> <db_id> <bucket_name>

set -euo pipefail

PROJECT_NAME="${1:?project name required}"
DB_NAME="${2:?db name required}"
DB_ID="${3:?db id required}"
BUCKET_NAME="${4:?bucket name required}"

cd "$(dirname "$0")/.."
[[ -f .env ]] || { echo "✗ .env not found — run setup.sh first" >&2; exit 1; }

# shellcheck disable=SC1091
source .env
SITE_NAME="${SITE_NAME:?SITE_NAME missing from .env}"
SITE_URL="${SITE_URL:?SITE_URL missing from .env}"
ADMIN_TOKEN="${ADMIN_TOKEN:?ADMIN_TOKEN missing from .env}"
INDEXNOW_KEY="${INDEXNOW_KEY:?INDEXNOW_KEY missing from .env}"

say()  { printf "\033[1;36m▸ %s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m! %s\033[0m\n" "$*"; }

say "Resuming setup for project '$PROJECT_NAME' (db=$DB_NAME, id=$DB_ID)"

# Create R2 bucket if needed.
say "Creating R2 bucket \"$BUCKET_NAME\" (idempotent)"
wrangler r2 bucket create "$BUCKET_NAME" 2>&1 | grep -v "already exists" || true

# Patch wrangler.toml with real IDs.
say "Patching wrangler.toml"
python3 - "$DB_ID" "$DB_NAME" "$BUCKET_NAME" "$PROJECT_NAME" <<'PY'
import re, sys
db_id, db_name, bucket_name, project_name = sys.argv[1:5]
src = open('wrangler.toml').read()
src = re.sub(r'(name\s*=\s*")[^"]+(")', rf'\g<1>{project_name}\g<2>', src, count=1)
src = re.sub(r'(database_name\s*=\s*")[^"]+(")', rf'\g<1>{db_name}\g<2>', src)
src = re.sub(r'(database_id\s*=\s*")[^"]+(")', rf'\g<1>{db_id}\g<2>', src)
src = re.sub(r'(bucket_name\s*=\s*")[^"]+(")', rf'\g<1>{bucket_name}\g<2>', src)
open('wrangler.toml', 'w').write(src)
PY
echo "  wrangler.toml updated"

# Ensure Pages project exists before we try to push secrets / deploy.
say "Ensuring Cloudflare Pages project \"$PROJECT_NAME\" exists"
if ! wrangler pages project list 2>/dev/null | grep -q "^[│|]\s*$PROJECT_NAME\s"; then
  wrangler pages project create "$PROJECT_NAME" --production-branch=main \
    || warn "pages project create returned non-zero — it may already exist; continuing"
fi

# Apply schema.
say "Applying schema/init.sql"
wrangler d1 execute "$DB_NAME" --remote --file=schema/init.sql

# Push secrets.
say "Pushing secrets to Pages project \"$PROJECT_NAME\""
push_secret() {
  local name="$1" val="${2:-}"
  [[ -z "$val" ]] && return 0
  printf '%s' "$val" | wrangler pages secret put "$name" --project-name="$PROJECT_NAME"
}
push_secret ADMIN_TOKEN     "$ADMIN_TOKEN"
push_secret INDEXNOW_KEY    "$INDEXNOW_KEY"
push_secret SITE_NAME       "$SITE_NAME"
push_secret SITE_URL        "$SITE_URL"
push_secret OPENAI_API_KEY    "${OPENAI_API_KEY:-}"
push_secret ANTHROPIC_API_KEY "${ANTHROPIC_API_KEY:-}"
push_secret GEMINI_API_KEY    "${GEMINI_API_KEY:-}"
push_secret GROQ_API_KEY      "${GROQ_API_KEY:-}"
push_secret DEEPSEEK_API_KEY  "${DEEPSEEK_API_KEY:-}"
push_secret MISTRAL_API_KEY   "${MISTRAL_API_KEY:-}"
push_secret TOGETHER_API_KEY  "${TOGETHER_API_KEY:-}"
push_secret CEREBRAS_API_KEY  "${CEREBRAS_API_KEY:-}"

# Deploy Pages.
say "Deploying Pages site"
wrangler pages deploy public --project-name="$PROJECT_NAME" --commit-dirty=true

# Deploy cron Worker.
echo ""
read -rp "  Deploy the cron Worker now? (Y/n): " want_cron
case "$want_cron" in
  n|N|no|NO|No) ;;
  *)
    say "Deploying cron Worker"
    HOST="${SITE_URL#http://}"
    HOST="${HOST#https://}"
    HOST="${HOST%%/*}"
    (
      cd cron-worker
      printf '%s' "$ADMIN_TOKEN" | wrangler secret put ADMIN_TOKEN
      printf '%s' "https://$HOST/api/admin/blog" | wrangler secret put BLOG_URL
      printf '%s' "https://$HOST/api/admin/prog/generate-next" | wrangler secret put PROG_URL
      wrangler deploy
    )
    ;;
esac

echo ""
say "Done."
echo "  Admin:  $SITE_URL/admin"
echo "  Token:  $ADMIN_TOKEN"
echo "  (also in .env)"
