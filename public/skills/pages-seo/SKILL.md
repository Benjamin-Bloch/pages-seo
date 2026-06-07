---
name: pages-seo
description: Use this skill whenever the user mentions pages-seo (the self-hosted programmatic-SEO + daily-AI-blog toolkit for Cloudflare Pages), or asks how to install / update / repair a pages-seo site, or asks about the AI prompt setup at seo.benjaminb.xyz/ai-setup. Loads the project's install paths, common failure modes, and per-mode playbooks so the user does not have to re-explain context every conversation.
---

# pages-seo

Self-hosted programmatic-SEO + daily-AI-blog toolkit for Cloudflare
Pages. Workers AI by default, 8 cloud providers as fallback. D1 for
storage, R2 for images. Source: <https://github.com/Benjamin-Bloch/pages-seo>.
Live demo + docs: <https://seo.benjaminb.xyz>.

## Quick router — pick the right playbook

| User's situation | Playbook |
|---|---|
| "Install pages-seo" / "Set up a new site" | [Install](#install-playbook) |
| "Update to the latest version" / "Sync upstream" | [Update](#update-playbook) |
| "It's broken" / "cron stopped" / "admin 404" | [Repair](#repair-playbook) |
| "Add a feature" / "Edit the code" | [Code-change conventions](#code-conventions) |

If the user gives you their slug or site URL, use the URLs throughout
instead of placeholders like `<my-slug>`. Always validate slug against
`^[a-z][a-z0-9-]{1,32}$`.

## Install playbook

Use the canonical installer at
`https://seo.benjaminb.xyz/install/run.sh`. It uses `wrangler`
(no GitHub App, no API tokens to paste) and is idempotent.

Steps when running this yourself:
1. `wrangler whoami` — halt if not authenticated.
2. `curl -fsSL https://seo.benjaminb.xyz/install/run.sh -o /tmp/pages-seo-install.sh`.
3. Read the script first so you know what it does.
4. Ask the user (in one message, not four) for: project slug, site
   name, admin email, admin password. Validate slug syntax.
5. Run the installer, piping answers in order. Stream stdout.
6. Verify: `GET https://<slug>.pages.dev/api/health` returns 200 with
   `db: "ok"`.
7. Verify: `GET https://<slug>.pages.dev/admin` returns 200.
8. Surface the magic-link tmpfile path (NEVER print the link itself —
   it contains the admin password in a URL fragment).

Done criteria: `/api/health` is healthy AND `/admin` returns 200 AND
the user knows where the first-run link file lives.

## Update playbook

Updates are idempotent — re-running the installer with the same slug
detects existing D1/R2/Pages project and only re-uploads code. **Do
not drop or recreate the D1 database**.

Steps:
1. `curl -s <site>/api/version` — check current vs latest tag. Stop
   if `up_to_date: true`.
2. `curl -s https://api.github.com/repos/Benjamin-Bloch/pages-seo/releases/latest`
   — summarise what's new in 3 bullets max, **flag breaking changes**.
3. Re-run installer with the same slug.
4. Poll `<site>/api/version` (10s interval, 5min max) until `sha`
   matches the new release.
5. Verify `<site>/api/health`: `db: ok`, `cron_likely_alive: true`,
   `jobs.in_flight_stuck: 0`.

If the in-admin "N commits behind" banner persists after a successful
deploy, that's a known marker-staleness UX quirk. Either click "Mark
as up to date" in /admin → Updates, OR `POST /api/admin/update/dismiss`
with the admin bearer.

## Repair playbook

Diagnose by ladder — cheapest check first, only escalate on failure.
**Never delete D1 or the Pages project.** D1 holds every post the user
has ever generated.

| Rung | Check | If it fails… |
|---|---|---|
| 1 | `curl -sI <site>` | Connection refused → Pages project gone. `wrangler pages project list`. |
| 2 | `curl -s <site>/api/health \| jq` | See [Health field interpretation](#health-field-interpretation) below. |
| 3 | `wrangler tail pages-seo-cron` | Most common: ADMIN_TOKEN drift. See [Token rotation](#token-rotation). |
| 4 | D1 stuck-jobs query | See [Stuck-job recovery](#stuck-job-recovery). |
| 5 | `wrangler pages deployment list` | Latest deploy may have failed. Redeploy. |

### Health field interpretation

`/api/health` JSON fields and what they mean:

- `db: "ok"` → backend reachable.
- `db: "unbound"` → D1 binding lost. Re-bind:
  `wrangler pages project edit --d1 DB=<d1-id>`. Look up `<d1-id>` in
  `wrangler d1 list`.
- `db: "error"` → schema drift or D1 outage. Re-apply
  `schema/init.sql` via `wrangler d1 execute <db-name> --remote --file=schema/init.sql`.
- `posts.cron_likely_alive: false` → no post in 36+ hours. Go to
  rung 3.
- `jobs.in_flight_stuck > 0` → a generation step died silently. Go
  to rung 4.

### Token rotation

Cron `ADMIN_TOKEN` drift is the most common silent failure. Rotate
**both sides in the same step** or the cron stays 401-locked:

```bash
NEW=$(openssl rand -hex 32)
echo "$NEW" | wrangler pages secret put ADMIN_TOKEN --project-name <slug>
echo "$NEW" | wrangler secret put ADMIN_TOKEN --name pages-seo-cron
```

### Stuck-job recovery

```bash
wrangler d1 execute <db-name> --remote --command="
  SELECT id, status, error, updated_at FROM blog_jobs
  WHERE status NOT IN ('published','failed')
  ORDER BY updated_at DESC LIMIT 5"
```

Read `error`. Typical causes:
- `provider_budget_exceeded` → AI free-tier exhausted; add a fallback
  provider key in /admin.
- `provider_timeout` → flaky upstream; mark failed and rerun.

## Code conventions

If the user asks for a code change in their fork:

- **File layout**: Cloudflare Pages Functions in `functions/api/**.js`,
  static assets in `public/`, cron Worker in `cron-worker/`, D1 schema
  in `schema/init.sql` (bundled into `functions/_lib/schema.js` via
  `node scripts/bundle-schema.js`).
- **Schema changes**: edit `schema/init.sql`, then re-run the bundler.
  Schema must stay additive (`CREATE TABLE IF NOT EXISTS`,
  `ALTER TABLE … ADD COLUMN`) — no destructive migrations.
- **Auth**: every admin endpoint must call `adminGate(env, request)`
  before doing anything. Do not weaken this.
- **Error responses**: use `json(status, body)` from `functions/_lib/util.js`.
  Never put a raw Error in the body — it strips `.stack`/`.cause` for
  you, but only via the replacer.
- **Cache headers**: personalised content `cache-control: no-store`;
  public content `public, max-age=…, s-maxage=…, stale-while-revalidate=…`.
- **Never commit `wrangler.toml`** — only `wrangler.template.toml`
  ships in the repo (real D1/R2 ids stay local).

## What NOT to do (under any circumstances)

- ❌ `wrangler d1 delete` — destroys every post.
- ❌ `wrangler pages project delete`.
- ❌ Edit `wrangler.toml` with the user's real ids and commit it.
- ❌ Modify `functions/_lib/auth.js` to widen `adminGate`.
- ❌ Print the magic-link URL to a chat or stdout — it contains the
  admin password in a fragment.
- ❌ Run `git push --force` on the user's fork.

## Reference URLs

- Install: <https://seo.benjaminb.xyz/install>
- Repair UI: <https://seo.benjaminb.xyz/repair>
- AI prompt picker: <https://seo.benjaminb.xyz/ai-setup>
- Docs + error reference: <https://seo.benjaminb.xyz/docs>
- Version API: <https://seo.benjaminb.xyz/api/version>
- Source: <https://github.com/Benjamin-Bloch/pages-seo>

For the tool-specific prompt variants (Claude Code, Codex, Copilot,
chat), see `GET /api/ai-prompt?tool=…&mode=…`. The prompts at
seo.benjaminb.xyz/ai-setup and this skill share the same playbooks.
