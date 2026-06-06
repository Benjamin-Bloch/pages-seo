---
mode: agent
description: Update an existing pages-seo install to the latest release. Re-runs the idempotent installer; preserves all data.
---

# Update pages-seo

Walk me through updating my existing pages-seo install to the latest
upstream tag. One command at a time. Wait for my output. React.

## Working agreement

1. ONE command per turn, in a fenced bash block. After each, end
   with: "Reply 'done' when finished, or paste any error."
2. If a step errors, fix the error before moving on.
3. Don't suggest editing my codebase by hand. The supported update
   path is to re-run the installer with the same slug.

## What I need from you up front

Ask me my project slug and live site URL if I haven't told you. Use
those URLs in every subsequent command (no `<my-slug>` placeholders).

## Step 1 — Where am I?

```bash
curl -s <site>/api/version | jq '{tag, sha: .short, up_to_date, ahead}'
```

If `up_to_date: true` → stop, nothing to do.

## Step 2 — What's new?

```bash
curl -s https://api.github.com/repos/Benjamin-Bloch/pages-seo/releases/latest \
  | jq '{tag_name, name, body}' | head -40
```

Summarise the new release in 3 bullets. **Flag breaking changes
explicitly** (schema, env vars, removed endpoints).

## Step 3 — Re-run installer with the same slug

The installer is idempotent. It detects the existing D1, R2, and
Pages project by name and only re-uploads code. Data is preserved.

```bash
curl -fsSL https://seo.benjaminb.xyz/install/run.sh | bash
```

Tell me to use the same slug, same admin email. I can re-enter the
current password (it gets hashed fresh but my existing admin user
record is preserved).

## Step 4 — Verify

```bash
curl -s <site>/api/version | jq '{tag, sha: .short, up_to_date}'
curl -s <site>/api/health  | jq
```

Expect `up_to_date: true` AND `db: "ok"` AND
`posts.cron_likely_alive: true`. Anything else → switch to
`/pages-seo-repair`.

## Step 5 — Clear "N commits behind" banner

Known UX quirk: direct-upload deploys don't update D1's
`installed_sha`. Tell me to click "Mark as up to date" in
/admin → System → Updates, or `POST /api/admin/update/dismiss` with
my admin bearer.

## Constraints

- Do NOT `wrangler d1 execute … --command="DROP TABLE …"`. Schema
  is additive.
- Do NOT delete and recreate the Pages project.

## Start now

Ask me for my slug + site URL (if I haven't given them). Then give
me step 1's command.
