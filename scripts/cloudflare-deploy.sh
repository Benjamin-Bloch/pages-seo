#!/usr/bin/env bash
# Workers Builds deploy wrapper.
#
# Wraps `wrangler pages deploy` so a first-build "Authentication
# error [code: 10000]" — caused by Cloudflare's auto-generated CI
# token lacking Pages:Edit on Deploy-to-Cloudflare-button installs
# — produces an actionable build log instead of a confusing
# wrangler stack trace.
#
# Behaviour:
#   1. Run `npx wrangler pages deploy public`, captured.
#   2. On success: print stdout, exit 0.
#   3. On failure: scan stderr for code 10000 / "Pages: Edit" /
#      similar auth markers. If found, replace the output with a
#      step-by-step fix message and exit 1 anyway (so the build is
#      flagged failed and the user investigates).
#   4. On any other failure: pass through verbatim so the real
#      error is visible.
#
# This script is invoked from package.json:
#   "deploy": "npm run bundle-schema && bash scripts/cloudflare-deploy.sh"

set -uo pipefail
cd "$(dirname "$0")/.."

# Capture both streams without losing ordering. We don't `tee` to
# the parent because wrangler buffers; instead we let it speak,
# then parse the captured copy for known failure markers.
LOG_FILE=$(mktemp -t ps-deploy-XXXXXX)
trap 'rm -f "$LOG_FILE"' EXIT

set +e
npx wrangler pages deploy public 2>&1 | tee "$LOG_FILE"
WRANGLER_EXIT=${PIPESTATUS[0]}
set -e

if [[ $WRANGLER_EXIT -eq 0 ]]; then
  exit 0
fi

# Look for the auth-scope marker that Workers Builds emits when its
# auto-token lacks Pages:Edit. Cloudflare error 10000 is generic
# auth, but it surfaces during pages.projects.* writes specifically
# on this codepath.
if grep -qE 'code:\s*10000|Authentication error|missing.*Pages.*Edit' "$LOG_FILE"; then
  cat <<'EOF'

═══════════════════════════════════════════════════════════════════
 pages-seo · first-deploy auth quirk detected
═══════════════════════════════════════════════════════════════════

The build failed because Cloudflare's auto-generated API token for
this new Pages project does not include the `Pages:Edit` permission.
This is a known limitation of the "Deploy to Cloudflare" button —
not something the repo can fix.

FIX (60 seconds):

 1. Create a new API token at
    https://dash.cloudflare.com/profile/api-tokens
    → Create Token → Custom token
    Permissions (all Account-scoped):
      • Cloudflare Pages        — Edit
      • D1                      — Edit
      • Workers R2 Storage      — Edit
      • Workers AI              — Edit
      • Workers Scripts         — Edit
      • Account Settings        — Read

 2. Paste the token into this Pages project:
    Cloudflare dashboard → Workers & Pages → this project
    → Settings → Build & deployments → API token

 3. Re-trigger the deploy from the Deployments tab.

Alternatively, the CLI installer at https://seo.benjaminb.xyz/install
avoids this entirely (uses `wrangler login` OAuth, not a token).

More detail: https://seo.benjaminb.xyz/docs#err-deploy-button-auth-10000

═══════════════════════════════════════════════════════════════════
EOF
fi

exit $WRANGLER_EXIT
