# pages-seo · agent guidance

Self-hosted programmatic-SEO + daily-AI-blog toolkit for Cloudflare
Pages. Workers AI by default; 8 cloud providers as fallback. D1 for
storage, R2 for images. Source:
<https://github.com/Benjamin-Bloch/pages-seo>.

This file is loaded automatically by code-agent tools (ChatGPT Codex
reads `AGENTS.md`; Claude Code reads `CLAUDE.md` — they're linked).
Treat it as the canonical operating manual for any change in this
repo.

---

## What lives where

| Path | Role |
|---|---|
| `functions/api/**.js` | Cloudflare Pages Functions (HTTP routes) |
| `functions/_lib/**.js` | Shared helpers — auth, util, settings, schema, dedup, etc. |
| `public/**` | Static assets (HTML, CSS, JS for /install, /admin, /ai-setup, /repair, /docs) |
| `schema/init.sql` | Authoritative D1 schema. **Must stay additive.** |
| `functions/_lib/schema.js` | Bundled output of `schema/init.sql`. Regenerate with `node scripts/bundle-schema.js`. Never edit by hand. |
| `cron-worker/` | Separate Cloudflare Worker that POSTs to `/api/admin/blog/cron-tick` daily |
| `cli/index.js` | Single-file Node installer used by `public/install/run.js` (the canonical install path) |
| `public/install/run.{sh,py,js}` | Three identical installers shipped at `seo.benjaminb.xyz/install/run.*` |
| `wrangler.template.toml` | Template shipped in the repo. The real `wrangler.toml` (with the user's D1/R2 ids) is **gitignored** — never commit it. |

## Hard rules — never violate

- ❌ Do not commit `wrangler.toml`. It has real account-specific ids.
- ❌ Do not delete a D1 database in any script or instruction. D1
  holds every post ever generated.
- ❌ Do not weaken `adminGate` in `functions/_lib/auth.js`. Every
  admin endpoint must call it before doing anything.
- ❌ Do not `console.log` anything containing the admin password,
  the magic-link URL, or `Bearer` tokens. The installer specifically
  delivers credentials via clipboard / 0600 tmpfile to avoid this.
- ❌ Do not edit `functions/_lib/schema.js` directly. Edit
  `schema/init.sql` and re-bundle.
- ❌ Do not introduce destructive schema migrations (DROP TABLE,
  DROP COLUMN, NOT NULL on populated columns). Use
  `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE … ADD COLUMN`.
- ❌ Do not add a `try/catch` that swallows the error silently. If
  you must catch, either fix the upstream cause or rethrow with
  more context.

## Style + conventions

- ESM only. Cloudflare Pages Functions are `.js` files with
  `export const onRequestGet`, `onRequestPost`, etc.
- Error responses go through `json(status, body)` in
  `functions/_lib/util.js`. The helper scrubs raw `Error` objects
  via a JSON.stringify replacer — never embed a raw Error.
- Cache headers: personalised content → `cache-control: no-store`.
  Public content → `public, max-age=<short>, s-maxage=<longer>, stale-while-revalidate=…`.
- IDs are 32-char hex (`newId()` in util.js). Don't introduce UUIDs.
- Use `audit(env, actor, action, targetId, details)` from util.js
  for any admin write. Fire-and-forget (don't await).

## Common change patterns

### Adding a new admin endpoint
1. Create `functions/api/admin/<name>.js`.
2. Start with `const gate = await adminGate(env, request); if (gate) return gate;`.
3. Validate input. Return via `json()`.
4. Log via `audit()` if it mutates anything.

### Adding a schema column
1. Edit `schema/init.sql` with `ALTER TABLE … ADD COLUMN <name> <type> DEFAULT …`.
   (Cloudflare D1 SQLite supports this since 2024.)
2. Run `node scripts/bundle-schema.js` to regenerate
   `functions/_lib/schema.js`.
3. Commit both files.
4. The next `/api/setup` call (or any install) applies it idempotently.

### Adding an AI provider
1. New module at `functions/_lib/providers/<name>.js` exporting
   `{ id, label, env_required, generate(prompt, opts) }`.
2. Register in the provider index.
3. Add `<name>_API_KEY` to the secrets the installer prompts for
   (optional — providers without keys are skipped).

## Release flow

1. Bump `package.json` version.
2. Update `CHANGELOG.md` (sections: Added / Fixed / Changed).
3. Commit with message `feat: v<x.y.z> — <one-line headline>`.
4. Tag: `git tag -a v<x.y.z> -m "<release name>"` and push the tag.
5. Mirror to the upstream `Benjamin-Bloch/pages-seo` repo so
   `/api/version` external pollers see the new tag.
6. Create a GitHub Release on the upstream repo with the changelog
   section as the body.

## Per-task playbooks

For step-by-step install / update / repair guidance, use the prompts
at `https://seo.benjaminb.xyz/api/ai-prompt?tool=codex&mode=<mode>`.
The same playbooks are also shipped as Copilot prompt files at
`.github/prompts/pages-seo-{install,update,repair}.prompt.md` and as
a Claude Code skill at `.claude/skills/pages-seo/SKILL.md`.

## When you're unsure

- Schema or auth change → ask before editing. Both are load-bearing.
- Upstream API contract change (`/api/version`, `/api/health`) →
  ask. External installs and uptime monitors depend on the shape.
- A "small fix" that requires editing `wrangler.toml` → it doesn't.
  Edit `wrangler.template.toml` instead.
