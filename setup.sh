#!/usr/bin/env bash
# pages-seo · one-shot setup (bash flavour, resumable).
#
# Writes progress to .setup-state after each step. Re-running this
# script picks up where it left off — answer the prompts once, then if
# any step fails (network, auth, quota), fix the underlying issue and
# re-run `bash setup.sh`. Steps already marked done are skipped.
#
# To start over, delete .setup-state.
#
# Prereqs:
#   - wrangler CLI + logged in (script will offer to install/login)

set -euo pipefail

cd "$(dirname "$0")"
STATE_FILE=".setup-state"

# ── helpers ─────────────────────────────────────────────────────────
say()    { printf "\033[1;36m▸\033[0m \033[1m%s\033[0m\n" "$*"; }
ok()     { printf "  \033[1;32m✓\033[0m %s\n" "$*"; }
warn()   { printf "  \033[1;33m!\033[0m %s\n" "$*"; }
die()    { printf "\033[1;31m✗ %s\033[0m\n" "$*"; exit 1; }
banner() {
  printf '\n\033[1;36m╭──────────────────────────────────────────────╮\033[0m\n'
  printf '\033[1;36m│\033[0m  \033[1mpages-seo · install\033[0m                       \033[1;36m│\033[0m\n'
  printf '\033[1;36m│\033[0m  \033[2mone-shot resumable setup for Cloudflare\033[0m    \033[1;36m│\033[0m\n'
  printf '\033[1;36m╰──────────────────────────────────────────────╯\033[0m\n\n'
}

# Portable yes-default prompt (macOS bash 3.2 has no ${var,,}).
ask_yes_default() {
  local prompt="$1" reply
  read -rp "  $prompt (Y/n): " reply || true
  case "$reply" in n|N|no|NO|No) return 1 ;; *) return 0 ;; esac
}

ask() {
  local prompt="$1" default="${2:-}" var
  if [[ -n "$default" ]]; then
    read -rp "  $prompt [$default]: " var || true
    printf '%s' "${var:-$default}"
  else
    read -rp "  $prompt: " var || true
    printf '%s' "$var"
  fi
}

# State file: simple KEY=value lines. Read by sourcing.
load_state() { [[ -f "$STATE_FILE" ]] && source "$STATE_FILE"; return 0; }
save_kv() {
  local key="$1" val="$2"
  if [[ -f "$STATE_FILE" ]] && grep -q "^${key}=" "$STATE_FILE"; then
    /usr/bin/sed -i.bak "s|^${key}=.*|${key}=${val}|" "$STATE_FILE" && rm -f "${STATE_FILE}.bak"
  else
    echo "${key}=${val}" >> "$STATE_FILE"
  fi
}
mark_done() { save_kv "STEP_$1" "done"; }
is_done()   { [[ -f "$STATE_FILE" ]] && grep -q "^STEP_$1=done$" "$STATE_FILE"; }

# Resolve a D1 database ID by name. We capture wrangler's stdout to a
# temp file rather than piping it directly into `python3 -` — the dash
# form treats stdin as the *script source*, so piped JSON would be read
# as Python and crash on `null` (which is `None` in Python).
resolve_db_id() {
  local target="$1" tmp
  tmp="$(mktemp)"
  wrangler d1 list --json > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 0; }
  python3 -c '
import json, sys
target = sys.argv[1]
try:
    data = json.load(open(sys.argv[2]))
except Exception:
    sys.exit(0)
for row in data if isinstance(data, list) else []:
    if row.get("name") == target:
        print(row.get("uuid") or row.get("database_id") or row.get("id") or "")
        break
' "$target" "$tmp"
  rm -f "$tmp"
}

push_secret() {
  local name="$1" val="${2:-}" project="$3"
  [[ -z "$val" ]] && return 0
  printf '%s' "$val" | wrangler pages secret put "$name" --project-name="$project"
}

# ── preflight ───────────────────────────────────────────────────────
if ! command -v wrangler >/dev/null; then
  warn "wrangler CLI not found."
  if command -v npm >/dev/null && ask_yes_default "Install it now with 'npm install -g wrangler'?"; then
    npm install -g wrangler || die "npm install failed."
  else
    die "Install wrangler (npm install -g wrangler) and re-run."
  fi
fi

if ! wrangler whoami >/dev/null 2>&1; then
  warn "wrangler is not logged in to Cloudflare."
  if ask_yes_default "Run 'wrangler login' now?"; then
    wrangler login
    wrangler whoami >/dev/null 2>&1 || die "wrangler still not logged in."
  else
    die "Run 'wrangler login' then re-run setup."
  fi
fi

[[ -f wrangler.toml ]] || die "wrangler.toml not found. Run from repo root."

banner
load_state

if [[ -f "$STATE_FILE" ]]; then
  printf "  \033[2mResuming from .setup-state. Delete it to start over.\033[0m\n\n"
else
  printf "  \033[2mWalking through the full setup. Each step is resumable\033[0m\n"
  printf "  \033[2mif it fails — just re-run \`bash setup.sh\`.\033[0m\n\n"
fi

# ── 1. inputs ───────────────────────────────────────────────────────
if ! is_done INPUTS; then
  PROJECT_NAME="$(ask 'Cloudflare Pages project name' "${PROJECT_NAME:-pages-seo}")"
  DB_NAME="$(ask 'D1 database name' "${DB_NAME:-$PROJECT_NAME}")"
  BUCKET_NAME="$(ask 'R2 bucket name (for hero images)' "${BUCKET_NAME:-$PROJECT_NAME-images}")"
  SITE_NAME="$(ask 'Site display name (shown in titles)' "${SITE_NAME:-pages-seo}")"
  SITE_URL="$(ask 'Site URL (used in OG tags)' "${SITE_URL:-https://$PROJECT_NAME.pages.dev}")"

  save_kv PROJECT_NAME "$PROJECT_NAME"
  save_kv DB_NAME      "$DB_NAME"
  save_kv BUCKET_NAME  "$BUCKET_NAME"
  save_kv SITE_NAME    "$SITE_NAME"
  save_kv SITE_URL     "$SITE_URL"
  mark_done INPUTS
else
  ok "inputs (project=$PROJECT_NAME, db=$DB_NAME, site=$SITE_URL)"
fi

# ── 2. tokens ───────────────────────────────────────────────────────
if ! is_done TOKENS; then
  say "Generating admin + indexnow tokens"
  ADMIN_TOKEN="$(openssl rand -hex 32)"
  INDEXNOW_KEY="$(openssl rand -hex 32)"
  save_kv ADMIN_TOKEN  "$ADMIN_TOKEN"
  save_kv INDEXNOW_KEY "$INDEXNOW_KEY"
  echo "  ADMIN_TOKEN  (paste into admin UI):  $ADMIN_TOKEN"
  echo "  INDEXNOW_KEY (served at /<key>.txt): $INDEXNOW_KEY"
  mark_done TOKENS
else
  ok "tokens"
fi

# ── 3. optional provider keys ───────────────────────────────────────
if ! is_done PROVIDERS; then
  echo ""
  echo "  Workers AI is on by default. Add keys for other providers if you want them"
  echo "  in the fallback chain. Leave blank to skip."
  echo ""
  ask_optional_secret() {
    local label="$1" var
    read -rsp "  $label (blank to skip): " var || true
    echo ""
    printf '%s' "$var"
  }
  OPENAI_API_KEY="$(ask_optional_secret 'OpenAI API key (gpt-5, gpt-image-1)')"
  ANTHROPIC_API_KEY="$(ask_optional_secret 'Anthropic API key (Claude)')"
  GEMINI_API_KEY="$(ask_optional_secret 'Google Gemini API key (Gemini + Imagen)')"
  GROQ_API_KEY="$(ask_optional_secret 'Groq API key')"
  DEEPSEEK_API_KEY="$(ask_optional_secret 'DeepSeek API key')"
  MISTRAL_API_KEY="$(ask_optional_secret 'Mistral API key')"
  TOGETHER_API_KEY="$(ask_optional_secret 'Together AI API key')"
  CEREBRAS_API_KEY="$(ask_optional_secret 'Cerebras API key')"

  [[ -n "$OPENAI_API_KEY"    ]] && save_kv OPENAI_API_KEY    "$OPENAI_API_KEY"
  [[ -n "$ANTHROPIC_API_KEY" ]] && save_kv ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"
  [[ -n "$GEMINI_API_KEY"    ]] && save_kv GEMINI_API_KEY    "$GEMINI_API_KEY"
  [[ -n "$GROQ_API_KEY"      ]] && save_kv GROQ_API_KEY      "$GROQ_API_KEY"
  [[ -n "$DEEPSEEK_API_KEY"  ]] && save_kv DEEPSEEK_API_KEY  "$DEEPSEEK_API_KEY"
  [[ -n "$MISTRAL_API_KEY"   ]] && save_kv MISTRAL_API_KEY   "$MISTRAL_API_KEY"
  [[ -n "$TOGETHER_API_KEY"  ]] && save_kv TOGETHER_API_KEY  "$TOGETHER_API_KEY"
  [[ -n "$CEREBRAS_API_KEY"  ]] && save_kv CEREBRAS_API_KEY  "$CEREBRAS_API_KEY"
  mark_done PROVIDERS
else
  ok "provider keys"
fi

# ── 4. .env mirror ──────────────────────────────────────────────────
if ! is_done ENV; then
  say "Writing .env"
  {
    echo "# Local-only mirror of the secrets pushed to Cloudflare. Never commit."
    echo "SITE_NAME=$SITE_NAME"
    echo "SITE_URL=$SITE_URL"
    echo "ADMIN_TOKEN=$ADMIN_TOKEN"
    echo "INDEXNOW_KEY=$INDEXNOW_KEY"
    [[ -n "${OPENAI_API_KEY:-}"    ]] && echo "OPENAI_API_KEY=$OPENAI_API_KEY"
    [[ -n "${ANTHROPIC_API_KEY:-}" ]] && echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"
    [[ -n "${GEMINI_API_KEY:-}"    ]] && echo "GEMINI_API_KEY=$GEMINI_API_KEY"
    [[ -n "${GROQ_API_KEY:-}"      ]] && echo "GROQ_API_KEY=$GROQ_API_KEY"
    [[ -n "${DEEPSEEK_API_KEY:-}"  ]] && echo "DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY"
    [[ -n "${MISTRAL_API_KEY:-}"   ]] && echo "MISTRAL_API_KEY=$MISTRAL_API_KEY"
    [[ -n "${TOGETHER_API_KEY:-}"  ]] && echo "TOGETHER_API_KEY=$TOGETHER_API_KEY"
    [[ -n "${CEREBRAS_API_KEY:-}"  ]] && echo "CEREBRAS_API_KEY=$CEREBRAS_API_KEY"
  } > .env
  mark_done ENV
else
  ok ".env"
fi

# ── 5. D1 ───────────────────────────────────────────────────────────
if ! is_done D1; then
  say "Creating D1 database \"$DB_NAME\""
  EXISTING_ID="$(resolve_db_id "$DB_NAME")"
  if [[ -n "$EXISTING_ID" ]]; then
    warn "D1 database $DB_NAME already exists — using it"
    DB_ID="$EXISTING_ID"
  else
    wrangler d1 create "$DB_NAME"
    DB_ID="$(resolve_db_id "$DB_NAME")"
  fi
  [[ -n "$DB_ID" ]] || die "Could not resolve D1 ID for $DB_NAME"
  save_kv DB_ID "$DB_ID"
  echo "  database_id: $DB_ID"
  mark_done D1
else
  ok "D1 ($DB_ID)"
fi

# ── 6. R2 ───────────────────────────────────────────────────────────
if ! is_done R2; then
  say "Creating R2 bucket \"$BUCKET_NAME\""
  if wrangler r2 bucket create "$BUCKET_NAME" 2>&1 | tee /tmp/r2.out | grep -q "already exists"; then
    warn "R2 bucket already exists — using it"
  fi
  mark_done R2
else
  ok "R2 bucket"
fi

# ── 7. patch wrangler.toml ──────────────────────────────────────────
if ! is_done TOML; then
  say "Patching wrangler.toml"
  python3 - "$DB_ID" "$DB_NAME" "$BUCKET_NAME" "$PROJECT_NAME" <<'PY'
import re, sys
db_id, db_name, bucket_name, project_name = sys.argv[1:5]
src = open('wrangler.toml').read()
src = re.sub(r'(name\s*=\s*")[^"]+(")', rf'\g<1>{project_name}\g<2>', src, count=1)
src = re.sub(r'(database_name\s*=\s*")[^"]+(")', rf'\g<1>{db_name}\g<2>', src)
src = re.sub(r'(database_id\s*=\s*")[^"]+(")', rf'\g<1>{db_id}\g<2>', src)
src = re.sub(r'(bucket_name\s*=\s*")[^"]+(")', rf'\g<1>{bucket_name}\g<2>', src)
open('wrangler.toml','w').write(src)
PY
  echo "  wrangler.toml updated"
  mark_done TOML
else
  ok "wrangler.toml"
fi

# ── 8. Pages project ────────────────────────────────────────────────
if ! is_done PROJECT; then
  say "Ensuring Pages project \"$PROJECT_NAME\" exists"
  if wrangler pages project list 2>/dev/null | awk '{print $2}' | grep -qx "$PROJECT_NAME"; then
    warn "project already exists"
  else
    wrangler pages project create "$PROJECT_NAME" --production-branch=main \
      || die "pages project create failed"
  fi
  mark_done PROJECT
else
  ok "Pages project"
fi

# ── 9. schema ───────────────────────────────────────────────────────
if ! is_done SCHEMA; then
  say "Applying schema/init.sql"
  wrangler d1 execute "$DB_NAME" --remote --file=schema/init.sql
  mark_done SCHEMA
else
  ok "schema applied"
fi

# ── 10. secrets ─────────────────────────────────────────────────────
if ! is_done SECRETS; then
  say "Pushing secrets to Pages project \"$PROJECT_NAME\""
  push_secret ADMIN_TOKEN       "$ADMIN_TOKEN"        "$PROJECT_NAME"
  push_secret INDEXNOW_KEY      "$INDEXNOW_KEY"       "$PROJECT_NAME"
  push_secret SITE_NAME         "$SITE_NAME"          "$PROJECT_NAME"
  push_secret SITE_URL          "$SITE_URL"           "$PROJECT_NAME"
  push_secret OPENAI_API_KEY    "${OPENAI_API_KEY:-}" "$PROJECT_NAME"
  push_secret ANTHROPIC_API_KEY "${ANTHROPIC_API_KEY:-}" "$PROJECT_NAME"
  push_secret GEMINI_API_KEY    "${GEMINI_API_KEY:-}" "$PROJECT_NAME"
  push_secret GROQ_API_KEY      "${GROQ_API_KEY:-}"   "$PROJECT_NAME"
  push_secret DEEPSEEK_API_KEY  "${DEEPSEEK_API_KEY:-}" "$PROJECT_NAME"
  push_secret MISTRAL_API_KEY   "${MISTRAL_API_KEY:-}" "$PROJECT_NAME"
  push_secret TOGETHER_API_KEY  "${TOGETHER_API_KEY:-}" "$PROJECT_NAME"
  push_secret CEREBRAS_API_KEY  "${CEREBRAS_API_KEY:-}" "$PROJECT_NAME"
  mark_done SECRETS
else
  ok "secrets pushed"
fi

# ── 11. deploy Pages ────────────────────────────────────────────────
if ! is_done DEPLOY; then
  say "Deploying Pages site"
  wrangler pages deploy public --project-name="$PROJECT_NAME" --commit-dirty=true
  mark_done DEPLOY
else
  ok "Pages deployed"
fi

# ── 12. deploy cron Worker ──────────────────────────────────────────
if ! is_done CRON; then
  echo ""
  if ask_yes_default "Deploy the cron Worker now?"; then
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
  fi
  mark_done CRON
else
  ok "cron Worker"
fi

printf '\n\033[1;32m╭──────────────────────────────────────────────╮\033[0m\n'
printf '\033[1;32m│\033[0m  \033[1m✓ All done\033[0m                                  \033[1;32m│\033[0m\n'
printf '\033[1;32m╰──────────────────────────────────────────────╯\033[0m\n\n'
printf '  Admin URL  \033[1m%s/admin\033[0m\n' "$SITE_URL"
printf '  Token      \033[2m%s\033[0m\n' "$ADMIN_TOKEN"
printf '  State      \033[2m%s (delete to re-run from scratch)\033[0m\n\n' "$STATE_FILE"
printf '  \033[2mNext: open the admin URL, paste the token, then go to\033[0m\n'
printf '  \033[2mthe \033[0m\033[1mSettings\033[0m\033[2m tab and configure your brand voice.\033[0m\n\n'
