// GET /api/ai-prompt
//
// Returns a self-contained prompt the user can paste into a specific
// AI coding tool. Each (tool, mode) pair gets its OWN prompt that
// matches that tool's actual capabilities — Claude Code can run
// wrangler and edit files; Codex works in a sandboxed repo without
// Cloudflare auth; Copilot Chat lives in the user's editor; a plain
// chat (ChatGPT/Claude/Gemini web) walks the user through clicks.
//
// Query params:
//   tool    = claude-code | codex | copilot | chat     (default: chat)
//   mode    = install | update | repair                (default: install)
//   format  = text | json                              (default: text)
//   slug    = the user's project slug
//   site    = the user's deployed site URL
//   admin   = the user's admin URL
//   gh      = the user's GitHub fork URL
//   acct    = Cloudflare account hint (display only)
//   version = pages-seo version / git SHA
//
// When per-user context is supplied, the prompt references the user's
// real URLs instead of placeholders. Generic prompts are edge-cached;
// personalised ones are not.
//
// CORS-open so any pages-seo admin can fetch this from the browser.

import { json } from '../_lib/util.js';

// ── input sanitisation ────────────────────────────────────────────

function cleanUrl(input, fallback) {
  if (!input) return fallback;
  let s = String(input).trim();
  if (!s) return fallback;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    return u.origin + u.pathname.replace(/\/$/, '');
  } catch {
    return fallback;
  }
}

function cleanSlug(input) {
  if (!input) return null;
  const s = String(input).toLowerCase().trim().replace(/[^a-z0-9-]/g, '').slice(0, 64);
  return s || null;
}

function cleanGhUrl(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (!/^https?:\/\/github\.com\/[^/]+\/[^/]+/i.test(s)) return null;
  try {
    const u = new URL(s);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return 'https://github.com/' + parts[0] + '/' + parts[1];
  } catch {
    return null;
  }
}

// ── shared context helpers ────────────────────────────────────────

function ctxLines(ctx) {
  const out = [];
  if (ctx.slug)    out.push(`- Project slug: ${ctx.slug}`);
  if (ctx.site)    out.push(`- Live site: ${ctx.site}`);
  if (ctx.admin)   out.push(`- Admin: ${ctx.admin}`);
  if (ctx.gh)      out.push(`- GitHub fork: ${ctx.gh}`);
  if (ctx.acct)    out.push(`- CF account: ${ctx.acct}`);
  if (ctx.version) out.push(`- Version: ${ctx.version}`);
  return out;
}

function hasCtx(ctx) {
  return Object.values(ctx).some(Boolean);
}

// ── PROMPT MATRIX ─────────────────────────────────────────────────
//
// Each prompt is designed for a *specific* tool's runtime. They are
// NOT interchangeable. A Claude Code prompt assumes a local shell
// with wrangler; a Codex prompt assumes a sandbox with a repo and
// nothing else; etc. The prompts intentionally share zero copy.

// ═══════════════════════════════════════════════════════════════
// CLAUDE CODE prompts (CLI agent on the user's machine)
// ═══════════════════════════════════════════════════════════════
//
// Capabilities to lean on:
//   - Bash, Read, Write, Edit, Grep, WebFetch
//   - User's wrangler is already logged in (or can run `wrangler login`)
//   - Has filesystem write access in cwd
//
// Prompt style: imperative, fact-dense, single goal. Treat the agent
// as a colleague, not a tutor. End every prompt with one explicit
// "next action" so the agent doesn't stall on planning.

function ccInstall(ctx) {
  const ctxBlock = hasCtx(ctx)
    ? `\n## My environment\n\n${ctxLines(ctx).join('\n')}\n`
    : '';
  return `# Task: install pages-seo on my Cloudflare account

You are Claude Code running on my local machine. Install pages-seo
(open-source self-hosted programmatic-SEO + daily-AI-blog toolkit
for Cloudflare Pages) into my Cloudflare account, end to end. Do
not ask me to do anything you can do yourself.
${ctxBlock}
## Constraints (read before acting)

- The canonical installer is at https://seo.benjaminb.xyz/install/run.sh.
  Read it with WebFetch first. It is idempotent and uses \`wrangler\`
  exclusively — no GitHub App, no OAuth, no API tokens to paste.
- I have \`wrangler\` installed and logged in to my Cloudflare account.
  If \`wrangler whoami\` fails, stop and tell me to run \`wrangler login\`.
- Never \`rm -rf\` outside a tempdir you created yourself. The installer
  works from a fresh tempdir; respect that.
- Do not commit, push, or create GitHub PRs. The installer uses Direct
  Upload — no GitHub link is created.
- If a step needs a value I haven't given you (project slug, admin
  email, admin password), ask me ONCE in a single message that lists
  every value you need. Then proceed without further prompts.

## Step plan

1. \`wrangler whoami\` — confirm I'm authenticated. Halt if not.
2. Pull the installer: \`curl -fsSL https://seo.benjaminb.xyz/install/run.sh -o /tmp/pages-seo-install.sh\`
3. Read \`/tmp/pages-seo-install.sh\` so you understand what it will do.
4. Ask me for: project slug, site name, admin email, admin password.
   (Validate slug matches \`^[a-z][a-z0-9-]{1,32}$\` before continuing.)
5. Run the installer: \`bash /tmp/pages-seo-install.sh\`. Pipe answers via
   stdin in the order it asks. Stream stdout so I can see progress.
6. Verify install: GET \`https://<slug>.pages.dev/api/health\`. Expect
   HTTP 200, JSON with \`db: "ok"\`. If not, diagnose before reporting done.
7. Verify admin: GET \`https://<slug>.pages.dev/admin\`. Expect HTTP 200.
8. Tell me the magic-link URL the installer wrote to its tmpfile — do
   NOT print it to your final summary text (it contains my password).
   Print only the file path, like: "first-run link is at /tmp/.../admin-link.txt".

## Done criteria

\`/api/health\` returns 200 with \`db: ok\` AND \`/admin\` returns 200 AND
you have told me where the first-run link file is. Anything less is
not done — keep diagnosing.

## Start now

Run \`wrangler whoami\` and report what you find.`;
}

function ccUpdate(ctx) {
  const ctxBlock = hasCtx(ctx)
    ? `\n## My install\n\n${ctxLines(ctx).join('\n')}\n`
    : `\n## My install\n\nAsk me for my project slug and live site URL before doing anything else. Validate slug matches \`^[a-z][a-z0-9-]{1,32}$\`.\n`;
  const slugRef = ctx.slug ? `"${ctx.slug}"` : 'the slug I give you';
  const siteRef = ctx.site || `https://<slug>.pages.dev`;
  return `# Task: update my pages-seo install to the latest release

You are Claude Code on my machine. Bring my existing pages-seo deploy
up to the latest tagged release without losing data.
${ctxBlock}
## Constraints

- Upstream is \`Benjamin-Bloch/pages-seo\` on GitHub. The latest stable
  is whatever \`/api/version\` on my site reports as \`tag\`.
- \`wrangler\` is logged in to the same Cloudflare account that owns
  the existing project. If not, halt and tell me to fix that.
- DO NOT drop or recreate the D1 database. DO NOT delete the R2 bucket.
  D1 schema migrations are applied additively by the install script;
  it is safe to re-run.
- Preserve existing Pages env vars and secrets. The installer only
  sets values it owns (\`SITE_NAME\`, \`SITE_URL\`) and skips anything
  already present.

## Step plan

1. Get current version: \`curl -s ${siteRef}/api/version\`. Note the
   \`tag\` and \`sha\` fields. If \`up_to_date\` is true, stop here and
   tell me there's nothing to do.
2. Get latest upstream: \`curl -s https://api.github.com/repos/Benjamin-Bloch/pages-seo/releases/latest\`.
   Compare to step 1. Tell me what's new (release name + 1-line summary
   from the body).
3. Re-run the installer with the same slug: \`curl -fsSL https://seo.benjaminb.xyz/install/run.sh | bash\`,
   answering with slug ${slugRef} when asked. It detects the existing
   D1/R2/Pages project and only re-uploads code.
4. Wait for the Pages deploy to go live. Poll
   \`${siteRef}/api/version\` every 10 seconds (max 5 minutes) until
   \`sha\` matches the new release.
5. Verify health: GET \`${siteRef}/api/health\`. Expect \`db: ok\`,
   \`posts.cron_likely_alive: true\`, \`jobs.in_flight_stuck: 0\`.
6. Update the in-admin install marker so the dashboard stops showing
   "N commits behind": call \`POST ${siteRef}/api/admin/update/dismiss\`
   with my admin token if I have one set, OR tell me to click "Mark
   as up to date" in /admin → Updates.

## Done criteria

\`/api/version\` reports the new tag AND \`/api/health\` is healthy.
Otherwise keep working.

## Start now

Fetch \`${siteRef}/api/version\` and report the current vs latest.`;
}

function ccRepair(ctx) {
  const ctxBlock = hasCtx(ctx)
    ? `\n## My install\n\n${ctxLines(ctx).join('\n')}\n`
    : `\n## My install\n\nAsk me for my site URL before doing anything else.\n`;
  const siteRef = ctx.site || `https://<my-slug>.pages.dev`;
  return `# Task: diagnose and fix my broken pages-seo install

You are Claude Code on my machine. My pages-seo deploy is misbehaving.
Find the root cause and fix it — do not just describe what might be wrong.
${ctxBlock}
## Diagnostic ladder (run in order, stop at the first failure)

1. **DNS + TLS.** \`curl -sI ${siteRef}\` — expect HTTP 200 or 30x.
   - Connection refused / TLS error → custom domain or Pages project
     is gone. Run \`wrangler pages project list\` and look for the
     project.
2. **Site responds.** \`curl -s ${siteRef}/api/health | jq .\` —
   expect \`{ok: true, db: "ok"}\`.
   - \`db: "unbound"\` → D1 binding lost. Re-bind:
     \`wrangler pages project edit --d1 DB=<d1-id>\`. The D1 id is in
     \`wrangler d1 list\` (look for the one whose name matches my slug).
   - \`db: "error"\` → schema drift. Re-apply via
     \`wrangler d1 execute <db-name> --remote --file=schema/init.sql\`
     from a fresh clone of the repo.
3. **Cron alive.** Check \`posts.cron_likely_alive\` in the health
   response. \`false\` means no post in the last 36 hours.
   - The cron is a separate Worker named \`pages-seo-cron\` (or
     similar). \`wrangler tail pages-seo-cron\` and trigger a manual
     run: \`curl -X POST ${siteRef}/api/admin/blog/cron-tick\` with my
     ADMIN_TOKEN bearer. If 401, the cron's \`ADMIN_TOKEN\` is out of
     sync — rotate both with \`wrangler pages secret put ADMIN_TOKEN\`
     and \`wrangler secret put ADMIN_TOKEN --name pages-seo-cron\`.
4. **Stuck jobs.** \`jobs.in_flight_stuck > 0\` means a generation
   step died silently. Query D1 to see which job:
   \`wrangler d1 execute <db-name> --remote --command="SELECT id, status, updated_at FROM blog_jobs WHERE status NOT IN ('published','failed') ORDER BY updated_at DESC LIMIT 5"\`.
5. **Admin won't load.** \`curl -sI ${siteRef}/admin\` returns non-200.
   Check \`wrangler pages deployment list\` for the project — the
   latest deploy may have failed. If so, redeploy the latest commit.
6. **AI provider failing.** If posts show but content is blank,
   GET \`${siteRef}/api/admin/system/status\` (needs admin token) and
   look for provider error messages. Typical cause: missing
   \`OPENAI_API_KEY\` / billing exhausted on Workers AI free tier.

## Reporting

For each step you run, tell me the exact command, the result, and
your interpretation in one sentence. Do not move to the next step
until the current one is green.

## Constraints

- Never delete a D1 database without my explicit "yes, delete it"
  confirmation. D1 holds every post I've ever generated.
- Never \`wrangler pages project delete\`. Ever.
- If you suggest a fix that requires a secret rotation, generate the
  new value yourself with \`openssl rand -hex 32\` and rotate it in
  both the Pages project AND the cron Worker in the same step.

## Start now

What's the symptom? Give me your first \`curl\` command, then run it.`;
}

// ═══════════════════════════════════════════════════════════════
// CODEX prompts (ChatGPT Codex / cloud sandbox agent)
// ═══════════════════════════════════════════════════════════════
//
// Capabilities:
//   - Has the repo cloned at /workspace (or similar)
//   - Can run shell, edit files, run tests
//   - CANNOT authenticate to Cloudflare (no `wrangler login`)
//   - CANNOT touch the user's live infrastructure
//
// Strategy: Codex prepares a deploy-ready branch. The user runs the
// final wrangler step themselves locally. For repair, Codex analyses
// pasted diagnostic output and produces a fix patch.

function cxInstall(ctx) {
  return `# Task: prepare a pages-seo install branch I can deploy locally

You are running in a sandboxed environment with the upstream
\`Benjamin-Bloch/pages-seo\` repo (or my fork of it) cloned. You
do NOT have Cloudflare credentials, so you cannot deploy yourself —
your job is to produce a branch I can deploy with one \`bash\` command
on my own machine.

## What pages-seo is

Self-hosted programmatic-SEO + daily-AI-blog toolkit for Cloudflare
Pages. Workers AI by default, 8 cloud providers as fallback. D1 for
storage, R2 for images. The repo is structured as Cloudflare Pages
Functions (\`functions/api/**.js\`), static assets in \`public/\`, and
a cron Worker in \`cron-worker/\`.

## Read first (do this before touching anything)

1. \`cat README.md\` — overview, install paths, current version.
2. \`cat schema/init.sql\` — DB schema. You will not modify this.
3. \`ls public/install/\` — the installer scripts (run.sh, run.py, run.js).
4. \`cat wrangler.template.toml\` — the deploy config the installer
   uses. Real deploys substitute D1 / R2 ids into a working
   \`wrangler.toml\`.

## Your output

A single shell command for me to run on my local machine that:
1. Has \`wrangler\` and a Cloudflare account ready.
2. Provisions D1 + R2 + Pages project named after the slug.
3. Uploads the code.
4. Sets the first-run secrets.

The canonical one-liner is already maintained upstream:

\`\`\`
curl -fsSL https://seo.benjaminb.xyz/install/run.sh | bash
\`\`\`

Verify by reading \`public/install/run.sh\` that it still:
- Takes 4 prompts (slug, site name, admin email, admin password)
- Calls \`wrangler d1 create\`, \`wrangler r2 bucket create\`,
  \`wrangler pages deploy\`, \`wrangler pages secret put\`.
- Writes a 0600 tmpfile with the first-run admin link.

If any of those are missing or broken in the current repo, FIX them
and open a PR titled \`fix(install): <what>\`. Do not invent new
install paths or alternative scripts.

## What you must NOT do

- Do not embed Cloudflare API tokens in the repo.
- Do not edit \`schema/init.sql\` to add my data — schema changes are
  separate PRs.
- Do not modify \`functions/_lib/auth.js\` to weaken admin auth.
- Do not commit \`wrangler.toml\` (it has my real ids); the repo only
  ships \`wrangler.template.toml\`.

## When you're done

Reply with exactly this block, filling in the values:

\`\`\`
INSTALL COMMAND
---------------
$ curl -fsSL <url> | bash

YOU WILL BE ASKED FOR
---------------------
- Project slug (lowercase, dashes, e.g. my-blog)
- Site name
- Admin email
- Admin password (8+ chars)

EXPECTED RUNTIME
----------------
2–4 minutes; final magic link saved to a tmpfile, not stdout.

VERIFY
------
$ curl -sI https://<slug>.pages.dev/api/health    # expect HTTP 200
$ curl -s  https://<slug>.pages.dev/api/health    # expect db: "ok"
\`\`\`

## Start now

\`cat README.md | head -50\` and tell me which install path the
current repo recommends.`;
}

function cxUpdate(ctx) {
  const slugRef = ctx.slug ? `"${ctx.slug}"` : '<my-slug>';
  const siteRef = ctx.site || `https://<my-slug>.pages.dev`;
  return `# Task: bring my pages-seo fork up to date with upstream

You are in a sandboxed environment with my fork of
\`Benjamin-Bloch/pages-seo\` cloned. You can edit files, resolve
conflicts, and open PRs. You cannot deploy — that's my job.

## My install context

- Slug: ${slugRef}
- Live site: ${siteRef}
- Current version: ${ctx.version || 'check /api/version'}

## Step plan

1. \`git remote -v\` — confirm upstream is set to
   \`https://github.com/Benjamin-Bloch/pages-seo.git\`. If not, add it:
   \`git remote add upstream https://github.com/Benjamin-Bloch/pages-seo.git\`.
2. \`git fetch upstream --tags\` — pull in new commits and tags.
3. \`git log HEAD..upstream/main --oneline\` — show me the list of
   commits I'm behind.
4. \`git tag --sort=-creatordate | head -5\` — show me the latest tags.
5. Read upstream's \`CHANGELOG.md\` for the latest version's entry.
   Summarise:
   - What's added (1 bullet each)
   - What's fixed
   - Any breaking changes (schema, env vars, removed endpoints)
6. \`git merge upstream/main\` on a new branch
   \`update/<new-tag>\`. If there are conflicts:
   - **Generated files** (\`functions/_lib/schema.js\`,
     \`public/install/index.html\` cache-buster strings): always
     accept upstream.
   - **Code I've forked** (anything outside \`functions/\`,
     \`public/\`, \`schema/\`, \`cron-worker/\` that I clearly own):
     keep mine.
   - **Anything ambiguous**: stop, list the conflict files, and ask
     me before resolving.
7. If schema changed in upstream's \`schema/init.sql\`, do NOT delete
   any existing tables. \`init.sql\` is idempotent (uses
   \`CREATE TABLE IF NOT EXISTS\` and \`ALTER TABLE … ADD COLUMN\`).
8. Re-bundle the schema: \`node scripts/bundle-schema.js\`. Commit
   the regenerated \`functions/_lib/schema.js\`.
9. Push the branch and open a PR titled
   \`chore: update to <new-tag>\` with the changelog summary in the
   body.

## What I do next (after you finish)

\`\`\`
gh pr checkout <PR#>     # locally
bash deploy.sh           # rebuilds + wrangler pages deploy
\`\`\`

## Constraints

- Never \`git push --force\`. Use \`git push -u origin update/<tag>\`.
- Never resolve a conflict in \`auth.js\`, \`settings.js\`, or anywhere
  inside \`functions/api/admin/\` without telling me first. Those are
  security-sensitive.
- If upstream removed an endpoint I'm using, flag it in the PR body
  — don't silently delete my caller code.

## Start now

Run \`git remote -v\` then \`git fetch upstream --tags\`. Report what
you find.`;
}

function cxRepair(ctx) {
  const siteRef = ctx.site || `https://<my-slug>.pages.dev`;
  return `# Task: produce a code fix for my broken pages-seo install

You are in a sandboxed environment with my fork of
\`Benjamin-Bloch/pages-seo\` cloned. You cannot reach my live
infrastructure. I will paste diagnostic output below; your job is
to identify the bug in code and produce a PR.

## What I'll paste

The output of one or more of:
- \`curl -s ${siteRef}/api/health\`
- \`curl -s ${siteRef}/api/version\`
- The contents of \`/admin → System → Status\` (a list of red checks)
- A Cloudflare deployment log
- An error message from the admin UI
- A pasted screenshot description

## How to work

1. **Read what I paste before assuming anything.** Match it against
   the error catalogue in \`functions/_lib/errors.js\` (if present)
   and the docs at the upstream's \`/docs#errors\` anchor.
2. **Find the call site.** \`grep -rn '<error_code>' functions/\` to
   locate where the error originates.
3. **Trace forward and backward.** Where is the failing input set?
   Where is the failure consumed? Show me both ends.
4. **Propose a fix as a diff.** Use the \`Edit\` tool. Keep the change
   minimal — don't refactor surrounding code.
5. **Open a PR.** Title: \`fix(<scope>): <one-line>\`. Body MUST include:
   - The error or symptom I reported (quoted exactly).
   - The root cause (one paragraph).
   - Why this is the minimal fix (one sentence).
   - A test plan I can run locally to verify.

## Common failure modes (don't waste my time re-deriving these)

| Symptom | Root cause | Fix scope |
|---|---|---|
| \`/api/health\` returns \`db: "unbound"\` | Pages project lost D1 binding | Config fix, not a code change. Tell me to re-bind. |
| \`/api/health\` returns \`db: "error"\` | Schema drift or D1 outage | Re-apply \`schema/init.sql\` |
| \`cron_likely_alive: false\` | Cron \`ADMIN_TOKEN\` mismatch | Rotation, not code |
| \`jobs.in_flight_stuck > 0\` | A generation step crashed silently | Check \`functions/_lib/providers/*\` for swallowed errors |
| Posts publish empty | AI provider hit budget cap | Check \`/api/admin/system/status\` for provider error |
| \`/admin\` shows old version after deploy | \`installed_sha\` stale in D1 | Code fix in \`/api/admin/update/apply.js\` or a one-shot DB update |
| New install errors with \`no_db_binding\` immediately | \`wrangler.toml\` substitution failed | Fix in \`public/install/run.sh\` |

## Constraints

- Do NOT modify \`schema/init.sql\` unless the bug IS the schema.
- Do NOT widen \`adminGate\` or relax auth.
- Do NOT add a try/catch that swallows the error. Either fix the
  upstream cause or rethrow with more context.
- Do NOT commit secrets. If the bug requires a new env var, document
  it in the PR body for me to add via \`wrangler pages secret put\`.

## Start now

Reply with: "Paste the diagnostic output and I'll trace it." Then
wait for me. Do not start grepping random files yet.`;
}

// ═══════════════════════════════════════════════════════════════
// COPILOT CHAT prompts (in-IDE agent with editor + terminal)
// ═══════════════════════════════════════════════════════════════
//
// Capabilities:
//   - Sees the user's currently open workspace
//   - Can edit files, propose diffs the user accepts/rejects
//   - Can run terminal commands the user approves
//   - User is sitting at the IDE and can paste output back
//
// Strategy: more conversational than Codex (because the user is
// looking over its shoulder), but more capable than chat (because
// it can actually touch files).

function cpInstall(ctx) {
  return `# Task: walk me through installing pages-seo from this IDE

You are GitHub Copilot Chat in my IDE. Help me install pages-seo
(self-hosted SEO + daily-AI-blog toolkit for Cloudflare Pages). I am
sitting at the editor and will run every terminal command myself
after you propose it — you do NOT run anything unsupervised.

## Working agreement

1. Give me ONE command at a time in a fenced bash block. Wait for me
   to run it and paste the result before giving the next.
2. When I paste a result, parse it and react to what's actually there
   — don't move to the next step if the previous one errored.
3. If I report I haven't installed a prerequisite (Node, wrangler),
   pause and walk me through that prerequisite. Don't push forward.
4. Never tell me to paste an API token into a chat — the installer
   uses \`wrangler\` which has my Cloudflare session.

## The install path

There's an upstream one-command installer at
\`https://seo.benjaminb.xyz/install/run.sh\`. It uses \`wrangler\`
(no GitHub App, no API tokens to paste), provisions D1 + R2 + Pages,
and hands me a one-time admin link.

## Step 1 — Prereq check

Ask me to run these and paste output:

\`\`\`bash
node --version
wrangler --version
wrangler whoami
\`\`\`

If \`node\` is missing → I need Node 20+. Point me at
https://nodejs.org/.
If \`wrangler\` is missing → \`npm install -g wrangler\`.
If \`wrangler whoami\` fails → \`wrangler login\` opens a browser.

## Step 2 — Collect inputs

Ask me for these in ONE message:
- Project slug (lowercase, dashes, 2–33 chars, starts with a letter)
- Site name (display name, anything)
- Admin email
- Admin password (8+ chars, don't echo back to me when I send it)

## Step 3 — Run the installer

\`\`\`bash
curl -fsSL https://seo.benjaminb.xyz/install/run.sh | bash
\`\`\`

The script will prompt for the four values from step 2. Tell me to
type them as prompted (don't pre-fill via env vars — the script
masks the password).

## Step 4 — Verify

\`\`\`bash
curl -sI https://<my-slug>.pages.dev/api/health
curl -s  https://<my-slug>.pages.dev/api/health | jq
\`\`\`

Expect 200 + \`db: "ok"\`. If not, switch to the repair mode of this
prompt (I'll tell you).

## Step 5 — First login

The installer writes the magic-link URL to a tmpfile path and prints
the path. It also tries to copy the URL to my clipboard. Tell me to
either paste from clipboard or \`cat\` that tmpfile path into my
browser. The link works once.

## What you should NOT do

- Do not propose installing arbitrary npm packages.
- Do not propose editing files in the upstream repo's working copy —
  the installer works in a tempdir, not in my project.
- Do not log my admin password into the chat history.

## Start now

Ask me the prereq-check question (step 1). Wait for my output.`;
}

function cpUpdate(ctx) {
  const slugRef = ctx.slug ? `"${ctx.slug}"` : 'my slug';
  const siteRef = ctx.site || `https://<my-slug>.pages.dev`;
  return `# Task: update my pages-seo install to the latest release

You are GitHub Copilot Chat in my IDE. Walk me through updating my
existing pages-seo deploy. One command at a time, wait for my output,
react to what I actually paste.

## My install

- Slug: ${slugRef}
- Live site: ${siteRef}
- Current version: ${ctx.version || 'we will check'}

## Step 1 — See where I am

Ask me to run:

\`\`\`bash
curl -s ${siteRef}/api/version | jq '{tag, sha: .short, up_to_date, ahead}'
\`\`\`

If \`up_to_date\` is \`true\` → stop, there's nothing to do.
If \`up_to_date\` is \`false\` → note the \`ahead\` count and the
current \`tag\`.

## Step 2 — See what's new

\`\`\`bash
curl -s https://api.github.com/repos/Benjamin-Bloch/pages-seo/releases/latest | jq '{tag_name, name, published_at, body}' | head -40
\`\`\`

Summarise the new release in 3 bullets max. Flag any breaking changes
(schema, env vars, removed endpoints) explicitly — I need to know
before I deploy.

## Step 3 — Re-run the installer with the same slug

The installer is idempotent. It detects the existing D1, R2, and
Pages project by name and only re-uploads code. Existing data is
preserved.

\`\`\`bash
curl -fsSL https://seo.benjaminb.xyz/install/run.sh | bash
\`\`\`

Tell me to use slug ${slugRef} when prompted. Tell me to use the same
admin email; for password, I can re-enter the current one (it gets
hashed fresh but my existing admin user is preserved).

## Step 4 — Verify

\`\`\`bash
curl -s ${siteRef}/api/version | jq '{tag, sha: .short, up_to_date}'
curl -s ${siteRef}/api/health  | jq
\`\`\`

Expect \`up_to_date: true\` and \`db: "ok"\` and
\`posts.cron_likely_alive: true\`. If any are off, switch to repair.

## Step 5 — Clear the "N commits behind" banner

If the admin UI still shows "X commits behind" after a successful
deploy, that's a known UX quirk: the \`installed_sha\` setting in D1
isn't auto-updated by direct-upload deploys. Tell me to either:
- Click "Mark as up to date" in /admin → System → Updates, or
- Hit \`POST ${siteRef}/api/admin/update/dismiss\` with my admin
  bearer token.

## Constraints

- Do NOT propose \`wrangler d1 execute … --command="DROP TABLE\`
  anything. The installer's schema is additive.
- Do NOT propose deleting and recreating the Pages project.

## Start now

Give me step 1's command and wait for my paste.`;
}

function cpRepair(ctx) {
  const siteRef = ctx.site || `https://<my-slug>.pages.dev`;
  return `# Task: help me fix my broken pages-seo install

You are GitHub Copilot Chat in my IDE. Something on my pages-seo
deploy is broken. Diagnose by sequence, not by guessing. One
command at a time. React to my actual output.

## My install

- Live site: ${siteRef}

## How to triage

Always start at the cheapest check and only escalate if it fails.
The ladder is: DNS/TLS → health endpoint → schema → cron →
provider → admin route. Do not skip rungs.

## Step 1 — Is the site reachable?

\`\`\`bash
curl -sI ${siteRef}
\`\`\`

- HTTP 200/30x → site is up; go to step 2.
- Connection refused / TLS error → Pages project or custom domain
  is gone. Have me run \`wrangler pages project list\` and look
  for the project.
- HTTP 522 / 530 → Cloudflare edge can't reach origin (very rare for
  Pages; usually a region outage). Wait 5 min and retry.

## Step 2 — Is the backend alive?

\`\`\`bash
curl -s ${siteRef}/api/health | jq
\`\`\`

Interpret the response field by field:
- \`db: "unbound"\` → D1 binding lost. Fix:
  \`wrangler pages project edit\` and re-attach the D1 by id from
  \`wrangler d1 list\`.
- \`db: "error"\` → schema drift. Have me re-apply
  \`schema/init.sql\` via \`wrangler d1 execute\` with \`--remote\`.
- \`db: "ok"\` and \`posts.cron_likely_alive: false\` → cron stopped.
  Go to step 3.
- \`db: "ok"\` and \`jobs.in_flight_stuck > 0\` → a generation step
  died. Go to step 4.

## Step 3 — Cron is stale

The cron is a separate Worker (\`pages-seo-cron\` or similar). The
most common cause is \`ADMIN_TOKEN\` drift between the cron Worker
and the Pages project — the cron POSTs to the Pages API with its
token, gets a 401, and silently does nothing.

Have me run:

\`\`\`bash
wrangler tail pages-seo-cron --format=pretty
\`\`\`

Then trigger a manual run:

\`\`\`bash
curl -X POST ${siteRef}/api/admin/blog/cron-tick \\
  -H "authorization: Bearer $ADMIN_TOKEN"
\`\`\`

If the tail shows a 401, rotate the token on both sides:

\`\`\`bash
NEW_TOKEN=$(openssl rand -hex 32)
echo "$NEW_TOKEN" | wrangler pages secret put ADMIN_TOKEN --project-name <my-slug>
echo "$NEW_TOKEN" | wrangler secret put ADMIN_TOKEN --name pages-seo-cron
\`\`\`

## Step 4 — Stuck job

\`\`\`bash
wrangler d1 execute <db-name> --remote \\
  --command="SELECT id, status, error, updated_at FROM blog_jobs WHERE status NOT IN ('published','failed') ORDER BY updated_at DESC LIMIT 5"
\`\`\`

Read \`error\` for each row. Typical patterns:
- \`provider_budget_exceeded\` → AI free tier exhausted; add a
  fallback provider key in /admin.
- \`provider_timeout\` → flaky upstream; mark the job failed and
  rerun.

## Step 5 — Admin route is dead

If \`/admin\` 404s but \`/api/health\` is fine, the static build was
truncated. Re-run the installer (idempotent, no data loss):

\`\`\`bash
curl -fsSL https://seo.benjaminb.xyz/install/run.sh | bash
\`\`\`

## Constraints

- Never propose \`wrangler d1 delete\` or
  \`wrangler r2 bucket delete\`. D1 is the source of truth for every
  post I've written.
- If I mention I've already tried something, don't retry it.
- If diagnostics return something not in this prompt, say so and ask
  me before guessing.

## Start now

Ask me one question: "What's the symptom — what URL, what do you see,
what do you expect?" Then wait for my answer before running step 1.`;
}

// ═══════════════════════════════════════════════════════════════
// CHAT prompts (ChatGPT / Claude / Gemini web — no tools)
// ═══════════════════════════════════════════════════════════════
//
// Capabilities: text only. The user does everything in their own
// browser/terminal. Prompts must be VERY explicit about who does
// what and when.

function chInstall(ctx) {
  const ctxBlock = hasCtx(ctx)
    ? `\nMy install details (use these in your answers, not placeholders):\n${ctxLines(ctx).join('\n')}\n`
    : '';
  return `You are walking me through installing pages-seo, an open-source
self-hosted programmatic-SEO + daily-AI-blog toolkit for Cloudflare
Pages. I am not technical. You will be my pair-programmer over chat.

The upstream is at https://github.com/Benjamin-Bloch/pages-seo. The
maintainer's live demo is at https://seo.benjaminb.xyz.
${ctxBlock}
RULES FOR THIS CONVERSATION:

1. ONE STEP AT A TIME. After every step you give me, end with:
   "Reply 'done' when you've finished, or paste any error you see."
   Then stop. Do not give the next step until I reply.
2. If I paste an error, diagnose THAT error before doing anything
   else. Don't dump the next step on top of an unresolved problem.
3. Commands go in fenced code blocks. URLs go as clickable links.
4. If you genuinely don't know the answer, say "I don't know — let's
   check https://seo.benjaminb.xyz/docs". Don't guess.

WHAT WE'RE GOING TO DO:

We'll use the terminal installer (one curl command). It uses
\`wrangler\` (the Cloudflare CLI) — no GitHub App, no API tokens to
paste, just my Cloudflare login. It takes 2–4 minutes.

What I'll need:
- A Cloudflare account (free tier is enough). Sign up:
  https://dash.cloudflare.com/sign-up
- Node 20 or newer on my machine.
- About 5 minutes.

THE SEQUENCE (give me these one at a time, waiting between):

Step A — Check I have Node 20+:
   \`node --version\`
   If missing or older than 20: send me to https://nodejs.org/ to
   install it.

Step B — Install wrangler:
   \`npm install -g wrangler\`

Step C — Log in to Cloudflare:
   \`wrangler login\`
   This pops a browser. I click Allow.

Step D — Pick names:
   Ask me ONE question that lists all of:
   - Project slug (lowercase, dashes only, e.g. \`my-blog\`)
   - Site name (display name, anything)
   - Admin email
   - Admin password (8+ chars)

Step E — Run the installer:
   \`curl -fsSL https://seo.benjaminb.xyz/install/run.sh | bash\`
   It prompts for the four values from step D. Tell me to type them
   when asked.

Step F — Wait, then verify:
   \`curl -s https://<my-slug>.pages.dev/api/health\`
   Expect a JSON response with \`"db":"ok"\`.

Step G — Open admin:
   The installer either copied a "first-run" link to my clipboard or
   wrote it to a tmpfile path. Tell me how to use it. The link works
   once.

COMMON FAILURE MODES (you know these, so don't make me Google them):

- "wrangler: command not found" after npm install → my npm global
  bin isn't on PATH. Run \`npm config get prefix\`, add \`<that>/bin\`
  to PATH.
- "Authentication error" during install → \`wrangler login\` didn't
  complete. Re-run it.
- Installer says "D1 quota exceeded" → free tier limit is 10 D1
  databases. Delete old test ones in the Cloudflare dashboard or
  upgrade.
- \`/api/health\` returns \`"db":"unbound"\` after a clean install →
  binding race; wait 60 seconds and retry once.

START NOW:

Greet me in one sentence, then ask step A. Wait for my reply.`;
}

function chUpdate(ctx) {
  const slugRef = ctx.slug || '<my-slug>';
  const siteRef = ctx.site || `https://<my-slug>.pages.dev`;
  const ctxBlock = hasCtx(ctx)
    ? `\nMy install:\n${ctxLines(ctx).join('\n')}\n`
    : '';
  return `You are helping me update an existing pages-seo install
(self-hosted SEO + daily-AI-blog toolkit for Cloudflare Pages) to the
latest version. I am not technical. Pair-program with me over chat.
${ctxBlock}
RULES:

1. ONE STEP AT A TIME. After each step, end with: "Reply 'done' when
   finished, or paste any error." Then stop.
2. If I paste an error, fix it before moving on.
3. Don't suggest editing my codebase by hand — the supported update
   path is to re-run the installer.

WHAT WE'RE DOING:

Re-running the installer with the same project slug. It detects my
existing D1, R2, and Pages project by name and only updates the
code. My data is preserved. Takes 2 minutes.

THE SEQUENCE:

Step A — Confirm current version:
   \`curl -s ${siteRef}/api/version\`
   Tell me what tag I'm on and what's the latest. If I'm up to date,
   stop — there's nothing to do.

Step B — Show me what's new:
   \`curl -s https://api.github.com/repos/Benjamin-Bloch/pages-seo/releases/latest\`
   Read the release body. Summarise in 3 bullets max. Flag any
   breaking changes (schema, env vars).

Step C — Re-run installer:
   \`curl -fsSL https://seo.benjaminb.xyz/install/run.sh | bash\`
   Tell me to enter slug \`${slugRef}\` when prompted. Same admin
   email. I can re-enter the same password.

Step D — Verify:
   \`curl -s ${siteRef}/api/version\` → should show the new tag.
   \`curl -s ${siteRef}/api/health\` → should show \`db: ok\` and
   \`cron_likely_alive: true\`.

Step E — If admin still shows "N commits behind":
   That's a known UX quirk; tell me to click "Mark as up to date" in
   /admin → System → Updates.

COMMON FAILURES:

- Installer hangs after "Provisioning resources" → \`wrangler\` lost
  its session. Run \`wrangler login\` and re-run.
- New deploy is live (\`/api/version\` shows new tag) but \`/admin\`
  shows old version → hard refresh (Cmd-Shift-R / Ctrl-Shift-R).

START NOW:

Greet me, then ask step A. Wait.`;
}

function chRepair(ctx) {
  const slugRef = ctx.slug || '<my-slug>';
  const siteRef = ctx.site || `https://<my-slug>.pages.dev`;
  const ctxBlock = hasCtx(ctx)
    ? `\nMy install:\n${ctxLines(ctx).join('\n')}\n`
    : '';
  return `You are helping me fix a broken pages-seo install
(self-hosted SEO + daily-AI-blog toolkit for Cloudflare Pages). I am
not technical. Pair-program with me over chat — one step at a time,
wait for my output, then react.
${ctxBlock}
RULES:

1. Start by asking me what the symptom is. Don't guess.
2. ONE diagnostic at a time. End with: "Paste what you see."
3. Don't tell me to "check the logs" without telling me which log
   and how. Always give me the exact command.
4. If diagnostics return something unexpected, say so and ask before
   guessing what it means.

THE LADDER (use in order; only escalate if the previous rung passes):

Rung 1 — Is the site reachable?
   \`curl -sI ${siteRef}\`
   200 or 30x → up. Connection refused → Pages project gone.

Rung 2 — Is the backend alive?
   \`curl -s ${siteRef}/api/health\`
   Look for:
   - \`db: "ok"\` → good
   - \`db: "unbound"\` → D1 binding lost. Open Cloudflare dashboard
     → Pages → my project → Settings → Functions → D1 database
     bindings. Re-attach the D1 with binding name \`DB\`.
   - \`db: "error"\` → schema drift; tell me to visit
     /admin → System → Status and click "Repair schema".
   - \`posts.cron_likely_alive: false\` → no post in 36+ hours; go to
     rung 3.
   - \`jobs.in_flight_stuck > 0\` → a generation died; go to rung 4.

Rung 3 — Cron stopped:
   Visit \`${siteRef}/admin\` → System → Status. The "Cron last
   ping" card tells me when the daily cron last contacted the site.
   If it's been > 36 hours, the most common cause is an
   \`ADMIN_TOKEN\` mismatch between the cron Worker and the Pages
   project. The fix is in \`/admin → System → Repair → Rotate
   admin token\` — it updates both sides.

Rung 4 — Stuck job:
   /admin → Posts. Look for any post with status "review" or
   "pending" older than an hour. Click "Retry" on that job, or
   "Mark failed" to skip it.

Rung 5 — Admin won't load at all:
   Browser dev tools → Network tab → reload. Tell me the HTTP status
   of the /admin request and the first JS file it loads.

COMMON SYMPTOMS:

| What I see | What it means | First thing to try |
|---|---|---|
| Site shows the maintainer's marketing page, not my content | Fork sync issue (Direct Upload install) — usually means a re-deploy failed midway | Re-run installer |
| Posts appear but content is blank | AI provider hit budget cap | /admin → System → Status — check provider status |
| OG / cover images are missing | R2 binding lost or bucket renamed | Re-bind R2 in Pages settings |
| /admin says "N commits behind" forever | UX quirk, install marker stale | Click "Mark as up to date" |
| Cron used to work, now silent | Most likely \`ADMIN_TOKEN\` drift | Repair → Rotate admin token |

DON'T:

- Don't tell me to delete and reinstall. D1 holds every post I've
  ever generated.
- Don't suggest editing code. The supported repair path is the
  in-admin Repair UI or re-running the installer.

START NOW:

Ask me: "What URL are you on, and what do you see vs what you
expect?" Wait for my answer. Then pick the right rung based on what
I tell you.`;
}

// ─────────────────────────────────────────────────────────────────

const TOOLS = {
  'claude-code': { install: ccInstall, update: ccUpdate, repair: ccRepair },
  'codex':       { install: cxInstall, update: cxUpdate, repair: cxRepair },
  'copilot':     { install: cpInstall, update: cpUpdate, repair: cpRepair },
  'chat':        { install: chInstall, update: chUpdate, repair: chRepair },
};

const VALID_TOOLS = Object.keys(TOOLS);
const VALID_MODES = ['install', 'update', 'repair'];

// ─────────────────────────────────────────────────────────────────

export const onRequestGet = async ({ request }) => {
  const url = new URL(request.url);

  const toolRaw = String(url.searchParams.get('tool') || 'chat').toLowerCase();
  const tool = VALID_TOOLS.includes(toolRaw) ? toolRaw : 'chat';

  const modeRaw = String(url.searchParams.get('mode') || 'install').toLowerCase();
  const mode = VALID_MODES.includes(modeRaw) ? modeRaw : 'install';

  const format = String(url.searchParams.get('format') || 'text').toLowerCase();

  const ctx = {
    slug:    cleanSlug(url.searchParams.get('slug')),
    site:    cleanUrl(url.searchParams.get('site'), null),
    admin:   cleanUrl(url.searchParams.get('admin'), null),
    gh:      cleanGhUrl(url.searchParams.get('gh')),
    acct:    (url.searchParams.get('acct') || '').slice(0, 64) || null,
    version: (url.searchParams.get('version') || '').slice(0, 40) || null,
  };
  const isPersonal = Object.values(ctx).some(Boolean);

  const prompt = TOOLS[tool][mode](ctx);

  if (format === 'json') {
    return json(200, {
      ok: true,
      tool,
      mode,
      prompt,
      personalized: isPersonal,
      context: ctx,
      tools_available: VALID_TOOLS,
      modes_available: VALID_MODES,
      length: prompt.length,
    });
  }

  return new Response(prompt, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': isPersonal ? 'no-store' : 'public, max-age=300',
      'access-control-allow-origin': '*',
    },
  });
};
