#!/usr/bin/env bash
# pages-seo terminal UNINSTALLER (bash flavour).
#
#   curl -fsSL https://seo.benjaminb.xyz/install/uninstall.sh | bash
#   curl -fsSL https://seo.benjaminb.xyz/install/uninstall.sh | bash -s -- --yes my-project
#
# Removes the Cloudflare Pages project, D1 database, and R2 bucket that
# install/run.sh created. Asks before each destructive step (unless
# --yes is passed).

set -uo pipefail

C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
C_CYAN=$'\033[36m'; C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'
say()  { printf '%s▸%s %s%s%s\n' "$C_CYAN" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
ok()   { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
err()  { printf '  %s✗%s %s\n' "$C_RED" "$C_RESET" "$*"; }
die()  { printf '%s✗ %s%s\n' "$C_RED" "$*" "$C_RESET"; exit 1; }

# Read confirmations from /dev/tty so prompts work when this script is
# piped through bash (stdin is the script body, not the terminal).
ask() {
  local prompt="$1" default="${2:-}" ans label
  if [[ -n "$default" ]]; then label="$prompt [$default]: "; else label="$prompt: "; fi
  if [[ -r /dev/tty ]]; then
    printf '%s' "$label" >/dev/tty
    read -r ans </dev/tty || ans=""
  else
    printf '%s' "$label"; read -r ans || ans=""
  fi
  printf '%s' "${ans:-$default}"
}
ask_yes_no() {
  local prompt="$1" default_no="${2:-yes}" suffix ans
  if [[ "$default_no" == "yes" ]]; then suffix='[y/N]'; else suffix='[Y/n]'; fi
  ans=$(ask "$prompt $suffix")
  ans=$(printf '%s' "$ans" | tr '[:upper:]' '[:lower:]')
  if [[ -z "$ans" ]]; then [[ "$default_no" != "yes" ]] && return 0 || return 1; fi
  [[ "$ans" == y || "$ans" == yes ]]
}

YES=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --yes|-y) YES=1 ;;
    *) ARGS+=("$a") ;;
  esac
done

printf '\n'
printf '%s╭──────────────────────────────────────────────╮%s\n' "$C_CYAN" "$C_RESET"
printf '%s│%s  %spages-seo · UNINSTALL%s                     %s│%s\n' "$C_CYAN" "$C_RESET" "$C_BOLD" "$C_RESET" "$C_CYAN" "$C_RESET"
printf '%s│%s  %sremoves the Pages project + D1 + R2%s        %s│%s\n' "$C_CYAN" "$C_RESET" "$C_DIM" "$C_RESET" "$C_CYAN" "$C_RESET"
printf '%s╰──────────────────────────────────────────────╯%s\n\n' "$C_CYAN" "$C_RESET"

command -v wrangler >/dev/null 2>&1 || die "wrangler is not installed. Install it first: npm install -g wrangler"
if ! wrangler whoami >/dev/null 2>&1; then
  warn "Not logged in to Cloudflare - running 'wrangler login'..."
  wrangler login || true
  wrangler whoami >/dev/null 2>&1 || die "Login failed."
fi
ok "logged in to Cloudflare"

PROJECT="${ARGS[0]:-}"
if [[ -z "$PROJECT" ]]; then
  PROJECT=$(ask "Project slug to uninstall (the one you used when installing)")
fi
PROJECT=$(printf '%s' "$PROJECT" | tr '[:upper:]' '[:lower:]')
[[ "$PROJECT" =~ ^[a-z][a-z0-9-]{1,32}$ ]] || die "Project slug must be lowercase letters/digits/dashes (e.g. my-blog)."

R2_NAME="${PROJECT}-images"

printf '\n'
say "Looking up resources for \"$PROJECT\""

# Pages project
HAVE_PAGES=0
if wrangler pages project list 2>/dev/null | grep -qE "(^|[[:space:]])${PROJECT}([[:space:]]|$)"; then
  HAVE_PAGES=1
fi

# D1 (id)
D1_ID=""
D1_JSON=$(wrangler d1 list --json 2>/dev/null || true)
if [[ -n "$D1_JSON" ]]; then
  # Try to grab the UUID for the row whose "name": matches PROJECT.
  D1_ID=$(printf '%s' "$D1_JSON" | python3 -c "
import sys, re, json
m=re.search(r'\[[\s\S]*\]', sys.stdin.read())
rows=json.loads(m.group(0)) if m else []
for r in rows:
  if r.get('name')=='$PROJECT':
    print(r.get('uuid') or r.get('database_id') or ''); break
" 2>/dev/null || true)
fi

# R2 bucket
HAVE_R2=0
if wrangler r2 bucket list 2>/dev/null | grep -qE "(^|[[:space:]])${R2_NAME}([[:space:]]|$)"; then
  HAVE_R2=1
fi

FOUND=0
echo "  Found:"
if [[ "$HAVE_PAGES" == "1" ]]; then echo "    · Pages project \"$PROJECT\""; FOUND=1; fi
if [[ -n "$D1_ID" ]];           then echo "    · D1 database \"$PROJECT\" ($D1_ID)"; FOUND=1; fi
if [[ "$HAVE_R2" == "1" ]];     then echo "    · R2 bucket \"$R2_NAME\""; FOUND=1; fi

if [[ "$FOUND" == "0" ]]; then
  warn "Nothing found to delete for that slug."
  warn "Common cause: typo in the slug. Re-run with the exact name you gave the installer."
  exit 0
fi

printf '\n  %sThis is destructive and cannot be undone.%s\n' "$C_YELLOW" "$C_RESET"
if [[ "$YES" != "1" ]]; then
  ask_yes_no "Proceed with deletion?" || die "Aborted."
fi
printf '\n'

say "Removing resources"
if [[ "$HAVE_PAGES" == "1" ]]; then
  if [[ "$YES" == "1" ]] || ask_yes_no "Delete Pages project \"$PROJECT\"?"; then
    OUT=$(wrangler pages project delete "$PROJECT" --yes 2>&1) && ok "deleted Pages project \"$PROJECT\"" || {
      if echo "$OUT" | grep -qi 'not found'; then ok "Pages project already gone"; else err "Pages delete failed: $OUT"; fi
    }
  else warn "skipped Pages project"; fi
fi
if [[ -n "$D1_ID" ]]; then
  if [[ "$YES" == "1" ]] || ask_yes_no "Delete D1 database \"$PROJECT\" ($D1_ID)? This wipes all blog posts."; then
    OUT=$(wrangler d1 delete "$D1_ID" --skip-confirmation 2>&1) && ok "deleted D1 database \"$PROJECT\"" || {
      if echo "$OUT" | grep -qi 'not found'; then ok "D1 already gone"; else err "D1 delete failed: $OUT"; fi
    }
  else warn "skipped D1 database"; fi
fi
if [[ "$HAVE_R2" == "1" ]]; then
  if [[ "$YES" == "1" ]] || ask_yes_no "Delete R2 bucket \"$R2_NAME\"? This wipes all hero images."; then
    OUT=$(wrangler r2 bucket delete "$R2_NAME" --force 2>&1) || OUT=$(wrangler r2 bucket delete "$R2_NAME" 2>&1)
    if [[ $? -eq 0 ]] || echo "$OUT" | grep -qiE 'not found|does not exist'; then
      ok "deleted R2 bucket \"$R2_NAME\""
    else err "R2 delete failed: $OUT"
    fi
  else warn "skipped R2 bucket"; fi
fi

printf '\n  %s%sUninstall complete.%s\n' "$C_BOLD" "$C_GREEN" "$C_RESET"
printf '  Your Cloudflare account no longer has any pages-seo resources for "%s".\n\n' "$PROJECT"
