#!/usr/bin/env bash
# pages-seo · one-shot setup script (bash flavour).
#
# Asks for the basics, creates the D1 database + R2 bucket, pushes
# secrets, applies the schema, and deploys both the Pages app and the
# cron Worker. Same flow as setup.py / setup.js — pick whichever you
# prefer.
#
# Prereqs:
#   - wrangler (`npm install -g wrangler` or use `npx wrangler`)
#   - logged in (`wrangler login`)
#   - `gh` is NOT required.

set -euo pipefail

# ── helpers ─────────────────────────────────────────────────────────
say()  { printf "\033[1;36m▸ %s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m! %s\033[0m\n" "$*"; }
die()  { printf "\033[1;31m✗ %s\033[0m\n" "$*"; exit 1; }
ask()  {
  local prompt="$1" default="${2:-}" var
  if [[ -n "$default" ]]; then
    read -rp "  $prompt [$default]: " var || true
    echo "${var:-$default}"
  else
    read -rp "  $prompt: " var || true
    echo "$var"
  fi
}
ask_secret() {
  local prompt="$1" var
  read -rsp "  $prompt: " var || true
  echo ""
  echo "$var"
}

# ── preflight ───────────────────────────────────────────────────────
if ! command -v wrangler >/dev/null; then
  warn "wrangler CLI not found."
  if command -v npm >/dev/null; then
    read -rp "  Install it now with 'npm install -g wrangler'? (Y/n): " yn
    if [[ "${yn,,}" != "n" ]]; then
      npm install -g wrangler || die "npm install failed. Install wrangler manually and re-run."
    else
      die "Install wrangler (npm install -g wrangler) and re-run."
    fi
  else
    die "Install Node.js + wrangler (npm install -g wrangler) and re-run."
  fi
fi

if ! wrangler whoami >/dev/null 2>&1; then
  warn "wrangler is not logged in to Cloudflare."
  read -rp "  Run 'wrangler login' now? (Y/n): " yn
  if [[ "${yn,,}" != "n" ]]; then
    wrangler login || die "wrangler login failed. Re-run setup once you've logged in."
    wrangler whoami >/dev/null 2>&1 || die "wrangler still not logged in. Re-run setup once login completes."
  else
    die "Run 'wrangler login' then re-run setup."
  fi
fi

cd "$(dirname "$0")"
[[ -f wrangler.toml ]] || die "wrangler.toml not found. Run setup from the repo root."

say "pages-seo setup"
echo "  This walks through creating the Cloudflare resources you need."
echo "  Each step prints what it will run before doing it."
echo ""

# ── inputs ──────────────────────────────────────────────────────────
PROJECT_NAME=$(ask "Cloudflare Pages project name" "pages-seo")
DB_NAME=$(ask "D1 database name" "$PROJECT_NAME")
BUCKET_NAME=$(ask "R2 bucket name (for hero images)" "$PROJECT_NAME-images")
SITE_NAME=$(ask "Site display name (shown in titles)" "pages-seo")
SITE_URL=$(ask "Site URL (used in OG tags)" "https://example.com")

echo ""
say "Generating admin + indexnow tokens"
ADMIN_TOKEN=$(openssl rand -hex 32)
INDEXNOW_KEY=$(openssl rand -hex 32)
echo "  ADMIN_TOKEN  (save this — you'll paste it into the admin UI):"
echo "    $ADMIN_TOKEN"
echo "  INDEXNOW_KEY (auto-served at /<key>.txt):"
echo "    $INDEXNOW_KEY"
echo ""

echo ""
echo "  Workers AI is enabled by default (free tier covers most usage)."
echo "  You can ALSO add keys for other providers — they'll be tried as fallbacks."
echo "  Leave blank to skip any of them."
echo ""
ask_optional_secret() {
  local label="$1" var
  read -rsp "  $label (blank to skip): " var || true
  echo ""
  echo "$var"
}
OPENAI_KEY=$(ask_optional_secret    "OpenAI API key (gpt-5, gpt-image-1)")
ANTHROPIC_KEY=$(ask_optional_secret "Anthropic API key (Claude)")
GEMINI_KEY=$(ask_optional_secret    "Google Gemini API key (Gemini + Imagen)")
GROQ_KEY=$(ask_optional_secret      "Groq API key (fast Llama)")
DEEPSEEK_KEY=$(ask_optional_secret  "DeepSeek API key")
MISTRAL_KEY=$(ask_optional_secret   "Mistral API key")
TOGETHER_KEY=$(ask_optional_secret  "Together AI API key")
CEREBRAS_KEY=$(ask_optional_secret  "Cerebras API key")

# ── write .env ──────────────────────────────────────────────────────
say "Writing .env"
{
  echo "# Local-only mirror of the secrets pushed to Cloudflare. Never commit."
  echo "SITE_NAME=$SITE_NAME"
  echo "SITE_URL=$SITE_URL"
  echo "ADMIN_TOKEN=$ADMIN_TOKEN"
  echo "INDEXNOW_KEY=$INDEXNOW_KEY"
  [[ -n "$OPENAI_KEY"    ]] && echo "OPENAI_API_KEY=$OPENAI_KEY"
  [[ -n "$ANTHROPIC_KEY" ]] && echo "ANTHROPIC_API_KEY=$ANTHROPIC_KEY"
  [[ -n "$GEMINI_KEY"    ]] && echo "GEMINI_API_KEY=$GEMINI_KEY"
  [[ -n "$GROQ_KEY"      ]] && echo "GROQ_API_KEY=$GROQ_KEY"
  [[ -n "$DEEPSEEK_KEY"  ]] && echo "DEEPSEEK_API_KEY=$DEEPSEEK_KEY"
  [[ -n "$MISTRAL_KEY"   ]] && echo "MISTRAL_API_KEY=$MISTRAL_KEY"
  [[ -n "$TOGETHER_KEY"  ]] && echo "TOGETHER_API_KEY=$TOGETHER_KEY"
  [[ -n "$CEREBRAS_KEY"  ]] && echo "CEREBRAS_API_KEY=$CEREBRAS_KEY"
} > .env
echo "  wrote .env (added to .gitignore)"

# ── create D1 ───────────────────────────────────────────────────────
say "Creating D1 database \"$DB_NAME\""
if wrangler d1 list 2>/dev/null | grep -q "\"name\":\\s*\"$DB_NAME\""; then
  warn "D1 database $DB_NAME already exists — skipping create"
else
  wrangler d1 create "$DB_NAME"
fi
DB_ID=$(wrangler d1 list --json 2>/dev/null | grep -A1 "\"name\":\\s*\"$DB_NAME\"" | grep '"uuid"' | head -1 | sed -E 's/.*"uuid":\s*"([^"]+)".*/\1/')
[[ -n "$DB_ID" ]] || die "Could not resolve D1 ID for $DB_NAME"
echo "  database_id: $DB_ID"

# ── create R2 ───────────────────────────────────────────────────────
say "Creating R2 bucket \"$BUCKET_NAME\""
wrangler r2 bucket create "$BUCKET_NAME" 2>&1 | grep -v "already exists" || true

# ── patch wrangler.toml ─────────────────────────────────────────────
say "Patching wrangler.toml with your resource names"
TMP=$(mktemp)
python3 - "$DB_ID" "$DB_NAME" "$BUCKET_NAME" "$PROJECT_NAME" <<'PY' > "$TMP"
import re, sys
db_id, db_name, bucket_name, project_name = sys.argv[1:5]
src = open('wrangler.toml').read()
src = re.sub(r'(name\s*=\s*")[^"]+(")', rf'\g<1>{project_name}\g<2>', src, count=1)
src = re.sub(r'(database_name\s*=\s*")[^"]+(")', rf'\g<1>{db_name}\g<2>', src)
src = re.sub(r'(database_id\s*=\s*")[^"]+(")', rf'\g<1>{db_id}\g<2>', src)
src = re.sub(r'(bucket_name\s*=\s*")[^"]+(")', rf'\g<1>{bucket_name}\g<2>', src)
sys.stdout.write(src)
PY
mv "$TMP" wrangler.toml
echo "  wrangler.toml updated"

# ── apply schema ────────────────────────────────────────────────────
say "Applying schema/init.sql"
wrangler d1 execute "$DB_NAME" --remote --file=schema/init.sql

# ── push secrets ────────────────────────────────────────────────────
say "Pushing secrets to Pages project \"$PROJECT_NAME\""
printf '%s' "$ADMIN_TOKEN" | wrangler pages secret put ADMIN_TOKEN --project-name="$PROJECT_NAME"
printf '%s' "$INDEXNOW_KEY" | wrangler pages secret put INDEXNOW_KEY --project-name="$PROJECT_NAME"
printf '%s' "$SITE_NAME" | wrangler pages secret put SITE_NAME --project-name="$PROJECT_NAME"
printf '%s' "$SITE_URL" | wrangler pages secret put SITE_URL --project-name="$PROJECT_NAME"

push_optional() {
  local name="$1" val="$2"
  [[ -z "$val" ]] && return 0
  printf '%s' "$val" | wrangler pages secret put "$name" --project-name="$PROJECT_NAME"
}
push_optional OPENAI_API_KEY    "$OPENAI_KEY"
push_optional ANTHROPIC_API_KEY "$ANTHROPIC_KEY"
push_optional GEMINI_API_KEY    "$GEMINI_KEY"
push_optional GROQ_API_KEY      "$GROQ_KEY"
push_optional DEEPSEEK_API_KEY  "$DEEPSEEK_KEY"
push_optional MISTRAL_API_KEY   "$MISTRAL_KEY"
push_optional TOGETHER_API_KEY  "$TOGETHER_KEY"
push_optional CEREBRAS_API_KEY  "$CEREBRAS_KEY"

# ── deploy Pages ────────────────────────────────────────────────────
say "Deploying Pages site"
wrangler pages deploy public --project-name="$PROJECT_NAME" --commit-dirty=true

# ── deploy cron worker (optional) ───────────────────────────────────
echo ""
read -rp "  Deploy the cron Worker now? (Y/n): " want_cron
if [[ "${want_cron,,}" != "n" ]]; then
  say "Deploying cron Worker"
  (
    cd cron-worker
    # Push the same shared secrets so the Worker can call our admin API.
    HOST=$(echo "$SITE_URL" | sed -E 's|^https?://||;s|/.*||')
    printf '%s' "$ADMIN_TOKEN" | wrangler secret put ADMIN_TOKEN
    printf '%s' "https://$HOST/api/admin/blog" | wrangler secret put BLOG_URL
    printf '%s' "https://$HOST/api/admin/prog/generate-next" | wrangler secret put PROG_URL
    wrangler deploy
  )
fi

echo ""
say "Done."
echo "  Admin: $SITE_URL/admin"
echo "  Token: $ADMIN_TOKEN"
echo "  (Token also saved in .env)"
