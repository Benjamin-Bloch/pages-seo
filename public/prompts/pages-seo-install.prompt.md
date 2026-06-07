---
mode: agent
description: Install pages-seo (self-hosted SEO + daily-AI-blog toolkit for Cloudflare Pages) end to end. Drives wrangler from the IDE terminal one step at a time.
---

# Install pages-seo

Walk me through installing pages-seo
(<https://github.com/Benjamin-Bloch/pages-seo>) on my Cloudflare
account. I am at my IDE; you give me terminal commands and I run
them. **One step at a time.** Wait for me to paste output before
giving the next.

## Working agreement

1. ONE command per turn, in a fenced bash block.
2. Parse my output and react to what is actually there. Don't move
   on if a step errored.
3. Never tell me to paste an API token into chat — the installer
   uses `wrangler`, which already has my Cloudflare session.
4. Never log my admin password into chat history.

## Path

The canonical installer is at
`https://seo.benjaminb.xyz/install/run.sh`. It uses `wrangler` (no
GitHub App, no API tokens), provisions D1 + R2 + Pages, and hands me
a one-time admin link.

## Step 1 — Prereq check

Ask me to run:

```bash
node --version
wrangler --version
wrangler whoami
```

Expectations:
- Node 20+ (if missing, send me to <https://nodejs.org/>).
- `wrangler` present (if missing: `npm install -g wrangler`).
- `wrangler whoami` returns my email (if not: `wrangler login`).

## Step 2 — Collect inputs (ask in one message)

- Project slug (lowercase, dashes, 2–33 chars, must start with a
  letter; validate against `^[a-z][a-z0-9-]{1,32}$`).
- Site name (display name).
- Admin email.
- Admin password (8+ chars; do NOT echo back to me).

## Step 3 — Run the installer

```bash
curl -fsSL https://seo.benjaminb.xyz/install/run.sh | bash
```

Tell me to enter the four values from step 2 as the script prompts
for them. Do not pre-fill via env vars — the script masks the
password.

## Step 4 — Verify

```bash
curl -sI https://<my-slug>.pages.dev/api/health
curl -s  https://<my-slug>.pages.dev/api/health | jq
```

Expect HTTP 200 and `db: "ok"`. If not, switch to the repair prompt
(`/pages-seo-repair`).

## Step 5 — First login

The installer copies a "first-run" magic link to my clipboard AND
writes it to a 0600 tmpfile (path printed in the installer output).
Tell me to either paste from clipboard or `cat` that tmpfile path
into my browser. The link works exactly once.

## Constraints

- Do not propose installing arbitrary npm packages.
- Do not edit files in the installer's working copy (it works in a
  tempdir, not in my project).
- Do not propose `wrangler d1 delete` or
  `wrangler pages project delete` under any circumstances.

## Start now

Ask me the prereq-check question (step 1). Wait for output.
