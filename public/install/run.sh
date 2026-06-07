#!/usr/bin/env bash
# pages-seo terminal installer (bash flavour).
#
# Downloaded and piped from https://seo.benjaminb.xyz/install/run.sh.
# Provisions a fresh pages-seo install on the user's Cloudflare
# account using wrangler. No GitHub App, no API token paste — uses
# `wrangler login` (browser OAuth) to authenticate.
#
# Steps:
#   1. Ensure wrangler is installed + the user is logged in.
#   2. Prompt for project slug, site name, admin email, password.
#   3. Create (or reuse) a D1 database + an R2 bucket.
#   4. Download the latest pages-seo source.
#   5. Patch wrangler.toml with the new resource IDs.
#   6. Run `wrangler pages project create` + `wrangler pages deploy`.
#   7. Set SITE_NAME + SITE_URL as Pages env vars.
#   8. Print the seed URL the user can open to land in /admin with
#      their email + password pre-filled (URL fragment, never sent
#      over the wire).
#
# Safe to re-run. Idempotent.

set -euo pipefail

# When run as `curl … | bash`, stdin IS the script, so any `read`
# inside gets immediate EOF and skips every prompt. Re-attach stdin
# to the controlling terminal so prompts work. If there's no tty
# (CI, automation), fall through and let `read` fail loudly later
# rather than silently accepting empty answers.
if [[ ! -t 0 && -e /dev/tty ]]; then
  exec </dev/tty
fi

C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
C_CYAN=$'\033[36m'; C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'
say()  { printf "%s▸%s %s%s%s\n" "$C_CYAN" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
ok()   { printf "  %s✓%s %s\n" "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf "  %s!%s %s\n" "$C_YELLOW" "$C_RESET" "$*"; }
die()  { printf "%s✗ %s%s\n" "$C_RED" "$*" "$C_RESET"; exit 1; }

printf "\n%s╭──────────────────────────────────────────────╮%s\n" "$C_CYAN" "$C_RESET"
printf "%s│%s  %spages-seo · install%s                       %s│%s\n" "$C_CYAN" "$C_RESET" "$C_BOLD" "$C_RESET" "$C_CYAN" "$C_RESET"
printf "%s│%s  %sone command, no GitHub App, no SQL%s         %s│%s\n" "$C_CYAN" "$C_RESET" "$C_DIM" "$C_RESET" "$C_CYAN" "$C_RESET"
printf "%s╰──────────────────────────────────────────────╯%s\n\n" "$C_CYAN" "$C_RESET"

# ── wrangler ──────────────────────────────────────────────────────
if ! command -v wrangler >/dev/null 2>&1; then
  warn "wrangler not found on PATH."
  if command -v npm >/dev/null 2>&1; then
    read -rp "  Install it now with \`npm install -g wrangler\`? (Y/n) " yn
    case "${yn:-Y}" in y|Y|yes|YES|Yes|"") npm install -g wrangler ;;
      *) die "Install wrangler manually and re-run: npm install -g wrangler" ;;
    esac
  else
    die "wrangler not found and npm isn't installed either. Install Node (https://nodejs.org), then \`npm install -g wrangler\` and re-run."
  fi
fi
ok "wrangler installed"

# Check login. wrangler whoami prints the account id on success.
if ! wrangler whoami >/dev/null 2>&1; then
  warn "Not logged in to Cloudflare."
  echo "  Running \`wrangler login\` — your browser will open."
  wrangler login || die "wrangler login failed."
fi
ok "logged in to Cloudflare"

# ── prompts ───────────────────────────────────────────────────────
echo
say "Tell us about your install"
read -rp "  Project slug (letters/digits/dashes, e.g. my-blog): " PROJECT
PROJECT=$(echo "$PROJECT" | tr '[:upper:]' '[:lower:]')
[[ "$PROJECT" =~ ^[a-z][a-z0-9-]{1,32}$ ]] || die "Invalid project slug. Letters/digits/dashes, 2-33 chars, must start with a letter."

read -rp "  Site name [$PROJECT]: " SITE_NAME
SITE_NAME="${SITE_NAME:-$PROJECT}"

read -rp "  Admin email: " EMAIL
[[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "Invalid email."

# Masked password input. Shows the LAST typed char in plain, replaces
# it with '*' when the next char is typed (familiar phone-keyboard feel)
# so users can verify they're typing the right keys without a fully
# visible password on screen. Reads from /dev/tty so the prompt works
# even when this script is being piped through bash (stdin is the
# script itself in that case, not the terminal).
read_password() {
  local prompt="$1" __var="$2" buf="" ch
  if [[ ! -r /dev/tty ]]; then
    # Headless / no tty — fall back to fully hidden (safest).
    read -rsp "$prompt" buf </dev/stdin; printf '\n'
    printf -v "$__var" '%s' "$buf"; return
  fi
  printf '%s' "$prompt" >/dev/tty
  while IFS= read -rs -n1 ch </dev/tty; do
    if [[ -z "$ch" ]]; then
      # Enter: mask the last plain-shown char with '*' so the finished
      # prompt is all stars, then newline.
      if [[ -n "$buf" ]]; then printf '\b*' >/dev/tty; fi
      printf '\n' >/dev/tty
      break
    fi
    if [[ "$ch" == $'\x7f' || "$ch" == $'\b' ]]; then              # Backspace
      if [[ -n "$buf" ]]; then buf="${buf%?}"; printf '\b \b' >/dev/tty; fi
      continue
    fi
    # Mask the previously-shown plain char (if any), then show this
    # new char in plain. On the next keypress, it'll be masked too.
    if [[ -n "$buf" ]]; then printf '\b*' >/dev/tty; fi
    buf+="$ch"
    printf '%s' "$ch" >/dev/tty
  done
  printf -v "$__var" '%s' "$buf"
}
read_password "  Admin password (8+ chars): " PASSWORD
[[ ${#PASSWORD} -ge 8 ]] || die "Password must be 8+ characters."
read_password "  Confirm password: " PASSWORD2
[[ "$PASSWORD" == "$PASSWORD2" ]] || die "Passwords did not match."

# ── provisioning ──────────────────────────────────────────────────
echo
say "Provisioning resources"

D1_ID=""
# Try to find an existing one first via the json list.
if wrangler d1 list --json 2>/dev/null | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
rows = data if isinstance(data, list) else data.get('result', [])
for row in rows:
    if row.get('name') == '$PROJECT':
        print(row.get('uuid') or row.get('database_id') or '', end='')
        break
" > /tmp/pages_seo_d1.id 2>/dev/null; then
  D1_ID=$(cat /tmp/pages_seo_d1.id || true)
fi
rm -f /tmp/pages_seo_d1.id

if [[ -n "$D1_ID" ]]; then
  ok "reusing existing D1 \"$PROJECT\" ($D1_ID)"
else
  echo "  creating D1 database \"$PROJECT\"…"
  CREATE_OUT=$(wrangler d1 create "$PROJECT" 2>&1) || die "D1 create failed:\n$CREATE_OUT"
  # Wrangler changed its output across versions. Accept both formats:
  # legacy TOML (database_id = "uuid") and current JSON ("database_id":
  # "uuid"); fall back to any bare UUID.
  D1_ID=$(printf '%s' "$CREATE_OUT" | grep -oE '"?database_id"?\s*[=:]\s*"[0-9a-f-]{36}"' | head -1 | grep -oE '[0-9a-f-]{36}' || true)
  if [[ -z "$D1_ID" ]]; then
    D1_ID=$(printf '%s' "$CREATE_OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)
  fi
  [[ -n "$D1_ID" ]] || die "Could not parse database_id from wrangler output:\n$CREATE_OUT"
  ok "created D1 \"$PROJECT\" ($D1_ID)"
fi

R2_NAME="$PROJECT-images"
echo "  creating R2 bucket \"$R2_NAME\"…"
R2_OUT=$(wrangler r2 bucket create "$R2_NAME" 2>&1 || true)
if echo "$R2_OUT" | grep -qi "already exists"; then
  ok "reusing existing R2 bucket \"$R2_NAME\""
elif echo "$R2_OUT" | grep -qiE "(error|fail)"; then
  die "R2 create failed:\n$R2_OUT"
else
  ok "created R2 bucket \"$R2_NAME\""
fi

# ── source download ───────────────────────────────────────────────
echo
say "Preparing source"
WORK=$(mktemp -d -t pages-seo-install-XXXXXX)
trap 'rm -rf "$WORK"' EXIT

# PAGES_SEO_REF lets advanced users target main / a branch / a SHA.
# Default is the latest tagged release, which is what 99% of installs
# want — main can be ahead of "what we've actually tested end-to-end".
REF="${PAGES_SEO_REF:-v1.0.4}"
echo "  downloading pages-seo source ($REF)…"
# /tags/<TAG>.tar.gz works for annotated tags; falls back to /heads/<ref>
# if the user passed a branch name instead.
if curl -fsSL -o "$WORK/src.tar.gz" "https://github.com/Benjamin-Bloch/pages-seo/archive/refs/tags/$REF.tar.gz" 2>/dev/null; then
  :
else
  curl -fsSL -o "$WORK/src.tar.gz" "https://github.com/Benjamin-Bloch/pages-seo/archive/refs/heads/$REF.tar.gz" \
    || die "Failed to download source for ref '$REF'. Set PAGES_SEO_REF=main to use the bleeding edge."
fi
tar -xzf "$WORK/src.tar.gz" -C "$WORK" --strip-components=1 || die "Failed to extract source."
ok "source extracted"

# Patch wrangler.toml in place. Some releases (incl. v1.0.4) ship only
# wrangler.template.toml so the repo doesn't carry the maintainer's real
# D1/R2 IDs — materialise wrangler.toml from the template if missing.
TOML="$WORK/wrangler.toml"
if [[ ! -f "$TOML" ]]; then
  if [[ -f "$WORK/wrangler.template.toml" ]]; then
    cp "$WORK/wrangler.template.toml" "$TOML"
  else
    die "No wrangler.toml or wrangler.template.toml in source archive."
  fi
fi
# Use sed -i with empty backup arg form that works on macOS + linux.
sed_inplace() {
  if [[ "$(uname)" == "Darwin" ]]; then sed -i '' "$@"; else sed -i "$@"; fi
}
sed_inplace -E "s|^name *= *\".*\"|name = \"$PROJECT\"|" "$TOML"
sed_inplace -E "s|database_name *= *\".*\"|database_name = \"$PROJECT\"|" "$TOML"
sed_inplace -E "s|database_id *= *\".*\"|database_id = \"$D1_ID\"|" "$TOML"
sed_inplace -E "s|bucket_name *= *\".*\"|bucket_name = \"$R2_NAME\"|" "$TOML"
ok "wrangler.toml patched"

# ── deploy ────────────────────────────────────────────────────────
echo
say "Deploying to Cloudflare Pages"
cd "$WORK"

echo "  creating Pages project \"$PROJECT\"…"
PROJ_OUT=$(wrangler pages project create "$PROJECT" --production-branch=main 2>&1 || true)
if echo "$PROJ_OUT" | grep -qi "already exists"; then
  ok "reusing existing project \"$PROJECT\""
elif echo "$PROJ_OUT" | grep -qiE "(error|fail)"; then
  die "Pages project create failed:\n$PROJ_OUT"
else
  ok "created project \"$PROJECT\""
fi

echo "  deploying assets + functions (30–60s)…"
wrangler pages deploy public --project-name="$PROJECT" --commit-dirty=true --branch=main \
  || die "wrangler pages deploy failed."

# Resolve the subdomain.
SUBDOMAIN=$(wrangler pages project list 2>/dev/null | grep -oE "${PROJECT}[^ ]*\.pages\.dev" | head -1 || true)
[[ -n "$SUBDOMAIN" ]] || SUBDOMAIN="${PROJECT}.pages.dev"
PAGES_URL="https://$SUBDOMAIN"
ok "deployed to $PAGES_URL"

# ── env vars ──────────────────────────────────────────────────────
echo
say "Setting environment variables"
# `wrangler pages secret put` reads from stdin.
printf '%s\n' "$SITE_NAME" | wrangler pages secret put SITE_NAME --project-name="$PROJECT" >/dev/null 2>&1 || true
printf '%s\n' "$PAGES_URL" | wrangler pages secret put SITE_URL  --project-name="$PROJECT" >/dev/null 2>&1 || true
ok "SITE_NAME + SITE_URL set"

# ── done ──────────────────────────────────────────────────────────
echo
say "All set"
SEED_JSON=$(printf '{"email":"%s","password":"%s","site_name":"%s"}' "$EMAIL" "$PASSWORD" "$SITE_NAME")
SEED_B64=$(printf '%s' "$SEED_JSON" | base64 | tr '+/' '-_' | tr -d '=\n')
ADMIN_URL="$PAGES_URL/admin#install=$SEED_B64"

echo
printf "  %s%sYour install is live.%s\n" "$C_BOLD" "$C_GREEN" "$C_RESET"
echo
printf "  Site:   %s%s%s\n" "$C_CYAN" "$PAGES_URL" "$C_RESET"
printf "  Admin:  %s%s/admin%s\n" "$C_CYAN" "$PAGES_URL" "$C_RESET"
echo
echo "  Open this link to auto-create your admin account and land in the onboarding wizard:"
echo
printf "  %s%s%s\n" "$C_DIM" "$ADMIN_URL" "$C_RESET"
echo
printf "  %sNote:%s the link above carries your email + password in a URL fragment\n" "$C_YELLOW" "$C_RESET"
echo "  so the first-run setup card on /admin can submit it for you automatically."
echo "  After it's used once (which marks setup complete), it stops working."
echo

# Best-effort browser open.
if command -v open >/dev/null 2>&1; then open "$ADMIN_URL" >/dev/null 2>&1 || true
elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$ADMIN_URL" >/dev/null 2>&1 || true
fi
