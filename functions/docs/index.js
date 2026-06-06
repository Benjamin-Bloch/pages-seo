// /docs — single-page documentation for pages-seo.
//
// Why a Function (not a static HTML file): so the install + error
// pages can deep-link via short anchors (e.g. /docs#err-wrong_parent)
// and we can extend the page over time without a separate build step.
// Renders once, caches at the edge for an hour.
//
// Structure:
//   1. Quick start (browser install + CLI install)
//   2. Setup walkthrough — every step with screenshots-in-words
//   3. Troubleshooting — common errors keyed by symptom
//   4. Error code reference — every error code from the API,
//      one line each, with the actual fix
//   5. Update flow
//   6. Admin tour
//   7. Cover templates — what variables exist, how to share them
//   8. Self-hosting reference — env vars, settings keys, R2/D1 layout
//   9. API reference (the small handful of endpoints third-parties
//      might integrate against, e.g. widget.js + IndexNow)

import { esc } from '../_lib/util.js';

// The whole content tree lives in JS so it's easy to edit without
// touching layout. Each entry: { id, title, level, content } where
// content is an HTML string (we trust ourselves, no escaping needed
// for content blocks — only for user-supplied strings, which we
// don't have here).
const SECTIONS = [
  { id: 'quick-start', title: 'Quick start', level: 1, content: `
<p class="lede">Two ways to install pages-seo. Pick whichever you can run.</p>
<h3>Browser install (recommended)</h3>
<ol>
  <li>Go to <a href="/install">/install</a></li>
  <li>Click <em>Sign in with GitHub</em>. We use OAuth to look up your account and create a fork of <code>Benjamin-Bloch/pages-seo</code>.</li>
  <li>Click <em>Create a Cloudflare API token</em>. The link pre-selects the right permissions; click <em>Continue</em>, <em>Continue</em>, <em>Create</em>, then copy the token.</li>
  <li>Paste the token back into the install tab (we attempt to auto-paste from clipboard).</li>
  <li>Type your site name. The Pages subdomain comes from a slug auto-derived from the name.</li>
  <li>Click <em>Install</em>. The installer creates D1, R2, the Pages project, applies the schema, hands you a one-time magic link.</li>
  <li>Open the link to set your admin email + password on your new site.</li>
</ol>
<h3>CLI install</h3>
<p>If you'd rather stay in the terminal, paste one of these in your shell. Each is the same logic in a different language — pick what you have installed.</p>
<pre><code># bash
curl -fsSL https://seo.benjaminb.xyz/install/run.sh | bash

# python
curl -fsSL https://seo.benjaminb.xyz/install/run.py | python3

# node
curl -fsSL https://seo.benjaminb.xyz/install/run.js | node</code></pre>
<p>Both paths end in the same place: <code>https://&lt;your-slug&gt;.pages.dev/admin</code>.</p>
` },

  { id: 'setup', title: 'Setup walkthrough', level: 1, content: `
<p>The full happy-path install with what each step actually does.</p>

<h3 id="setup-prereqs">Prerequisites</h3>
<ul>
  <li>A Cloudflare account (free tier is enough).</li>
  <li>A GitHub account.</li>
  <li>If using the CLI: <code>node ≥ 18</code> + <code>npm</code> (wrangler bootstraps from there).</li>
</ul>

<h3 id="setup-github">Step 1 — Sign in with GitHub</h3>
<p>The OAuth scope we request is <code>public_repo read:user user:email</code>. We use these for: creating your fork (<code>public_repo</code>), listing your Cloudflare GitHub App installation (<code>read:user</code>), and prefilling your admin email (<code>user:email</code>). We do NOT request private-repo access. Your token never leaves the browser tab + the encrypted cookie that holds it for the duration of the install.</p>

<h3 id="setup-fork">Step 2 — Fork the upstream repo</h3>
<p>We create <code>&lt;your-login&gt;/pages-seo</code> via the GitHub API. If you already have that name taken by a non-fork repo, the installer tells you and asks you to rename it on GitHub first.</p>

<h3 id="setup-cf-app">Step 3 — Authorise the Cloudflare GitHub App</h3>
<p>Cloudflare Pages can only see GitHub repos owned by an account that has authorised the <em>Cloudflare Workers and Pages</em> app. The installer attempts to add your new fork to your existing installation automatically (via <code>PUT /user/installations/:id/repositories/:repo_id</code>). If you've never installed the app at all, you'll be sent to <a href="https://github.com/apps/cloudflare-workers-and-pages/installations/new" target="_blank">github.com/apps/cloudflare-workers-and-pages</a> to do that once.</p>

<h3 id="setup-cf-token">Step 4 — Cloudflare API token</h3>
<p>The token link pre-selects six permissions on your account: <code>Cloudflare Pages: Edit</code>, <code>D1: Edit</code>, <code>Workers R2: Edit</code>, <code>Workers AI: Edit</code>, <code>Workers Scripts: Edit</code>, <code>Account Settings: Read</code>. The token is account-scoped (NOT user-API-key-scoped) so the blast radius is minimal — anyone who steals it can manage Pages/D1/R2/AI on your account, nothing else.</p>

<h3 id="setup-provision">Step 5 — Provisioning</h3>
<p>The installer runs six idempotent steps:</p>
<ol>
  <li>Resolve your account id from the token.</li>
  <li>Create (or reuse) a D1 database named <code>&lt;your-slug&gt;</code>.</li>
  <li>Create (or reuse) an R2 bucket named <code>&lt;your-slug&gt;-images</code>.</li>
  <li>Create the Pages project bound to your fork + D1 + R2 + Workers AI.</li>
  <li>PATCH the project bindings (Cloudflare's POST sometimes silently drops them; we verify and retry).</li>
  <li>Trigger the first deployment.</li>
</ol>
<p>State is saved to the installer's own D1 keyed by <code>(project_slug, token_fingerprint)</code>. If you close the tab mid-install, re-opening <a href="/install">/install</a> and pasting the same token resumes from the last completed step.</p>

<h3 id="setup-magic-link">Step 6 — Magic link</h3>
<p>The installer hands you a one-time URL <code>/admin?setup=&lt;hex&gt;&amp;email=&lt;your-gh-email&gt;</code>. Visit it once to set your admin password. The token is consumed on first POST; re-using it returns 401.</p>
` },

  { id: 'troubleshooting', title: 'Troubleshooting', level: 1, content: `
<p>Symptom → cause → fix. If your symptom isn't here, check the <a href="#errors">error code reference</a> below.</p>

<h3 id="ts-marketing-page">My site shows the maintainer's marketing page</h3>
<p><strong>Cause:</strong> your fork is stale — you forked before the marketing/installer code was moved to a separate repo. Cloudflare Pages built the wrong commit.</p>
<p><strong>Fix:</strong> open <a href="/update">/update</a>, sign in with GitHub, click <em>Sync from upstream</em>, then redeploy. Or rerun <a href="/install">/install</a> with the same slug — the auto-sync step runs.</p>

<h3 id="ts-no-db-binding">/admin shows <code>no_db_binding</code></h3>
<p><strong>Cause:</strong> Cloudflare Pages occasionally drops D1/R2 bindings during a project update. The site's Functions can't see <code>env.DB</code>.</p>
<p><strong>Fix:</strong> if you installed before this fix shipped, visit <a href="/repair">/repair</a>, paste your CF token, repair runs the bindings PATCH that fixes you. If you installed after, the site fixes itself on first /admin visit by calling its own <code>/api/repair-bindings</code> endpoint. See also <a href="#err-no_db_binding">#err-no_db_binding</a>.</p>

<h3 id="ts-cron-not-firing">Daily blog isn't generating</h3>
<p><strong>Cause:</strong> either the cron trigger isn't set on the Pages project, your monthly budget is exceeded, no provider is configured, or the AI binding is missing.</p>
<p><strong>Fix:</strong> in /admin → Settings, check that at least one provider is configured with a non-zero rate limit. Check /admin → Usage for spend this month. Click <em>Test provider</em> next to each one to verify the key works. If the cron itself isn't firing, the Cloudflare dashboard's project → Settings → Cron Triggers should show one entry pointing at the rebuild endpoint.</p>

<h3 id="ts-images-broken">Hero images don't load</h3>
<p><strong>Cause:</strong> R2 binding missing (<code>r2_binding_missing</code>), or the image generator hit a provider error and the post shipped without a key.</p>
<p><strong>Fix:</strong> /admin → Status (when this page lands) shows R2 health. If R2 is fine, click into the post in the calendar; if <code>hero_image_key</code> is null, click <em>Regenerate image</em>. If you're on cover-mode the hero is server-rendered from <code>/cover/&lt;slug&gt;.svg</code> — no per-post storage needed.</p>

<h3 id="ts-install-cf-app">"Internal issue with your Cloudflare Pages Git installation"</h3>
<p><strong>Cause:</strong> Cloudflare can't see your fork because the <em>Cloudflare Workers and Pages</em> GitHub App either isn't installed or doesn't have access to the new fork.</p>
<p><strong>Fix:</strong> click the <em>Manage permissions</em> link in the install failure pane. You'll land on github.com pre-narrowed to your new fork; tick it, save. Retry install — it'll resume from where it stopped.</p>

<h3 id="ts-gh-rate-limit">"GitHub API rate limit exceeded"</h3>
<p><strong>Cause:</strong> the unauthenticated GitHub API has a 60-req/hr-per-IP cap, and the installer uses it for upstream commit lookups.</p>
<p><strong>Fix:</strong> wait an hour. Or sign in with GitHub first — the authenticated cap is 5000/hr.</p>

<h3 id="ts-stuck-install">Install tab crashed mid-flow</h3>
<p><strong>Cause:</strong> network blip, browser refresh, or just closing the tab.</p>
<p><strong>Fix:</strong> reopen <a href="/install">/install</a> in the same browser. The installer remembers the slug + token fingerprint and resumes from the last completed step. If you used a different browser, paste the same CF token — state is keyed by token fingerprint.</p>
` },

  { id: 'errors', title: 'Error code reference', level: 1, content: `
<p>Every error code emitted by the install and admin APIs. Searchable by URL anchor (e.g. <code>/docs#err-wrong_parent</code>).</p>

<dl class="err-dl">
  <dt id="err-bad_json"><code>bad_json</code></dt>
  <dd>The request body didn't parse as JSON. Usually a missing <code>Content-Type</code> header or a truncated body. Refresh the page and try again.</dd>

  <dt id="err-missing_id"><code>missing_id</code></dt>
  <dd>An endpoint that needs <code>?id=…</code> got called without one. Open the page again from the link that surfaced the action.</dd>

  <dt id="err-unauthorized"><code>unauthorized</code></dt>
  <dd>Your session cookie expired or the admin bearer token didn't match. Sign back in at <code>/admin</code>.</dd>

  <dt id="err-no_db_binding"><code>no_db_binding</code></dt>
  <dd>The Pages project lost its D1 binding. See <a href="#ts-no-db-binding">troubleshooting</a> for the repair path. Won't recur after a fresh install — the install flow now PATCHes and verifies bindings.</dd>

  <dt id="err-r2_binding_missing"><code>r2_binding_missing</code></dt>
  <dd>Same shape as no_db_binding but for the R2 bucket. Same repair flow at <a href="/repair">/repair</a>.</dd>

  <dt id="err-wrong_parent"><code>wrong_parent</code></dt>
  <dd>You have a repo called <code>pages-seo</code> on GitHub but it's a fork of something other than <code>Benjamin-Bloch/pages-seo</code>. Rename it on GitHub or use a different account.</dd>

  <dt id="err-name_taken"><code>name_taken</code></dt>
  <dd>You have a non-fork repo called <code>pages-seo</code> on GitHub. Rename or delete it, then retry the install.</dd>

  <dt id="err-fork_failed"><code>fork_failed</code></dt>
  <dd>GitHub refused the fork creation. Most common reason: you're a member of the <code>Benjamin-Bloch</code> org with conflicting permissions. Use a personal account.</dd>

  <dt id="err-github_app_required"><code>github_app_required</code></dt>
  <dd>The Cloudflare Workers and Pages GitHub App doesn't have access to your fork. The error response includes a deep link to authorise it. See <a href="#ts-install-cf-app">troubleshooting</a>.</dd>

  <dt id="err-token-rejected"><code>Token rejected by Cloudflare</code></dt>
  <dd>The CF API token failed the <code>/accounts</code> probe. Re-create the token from the install page — the link pre-selects the right scopes.</dd>

  <dt id="err-base64_decode_failed"><code>base64_decode_failed</code></dt>
  <dd>An uploaded asset or applied cover PNG wasn't valid base64. Re-upload from the original file.</dd>

  <dt id="err-too_large"><code>too_large / asset_too_large</code></dt>
  <dd>Cover assets are capped at 10MB; .template imports at 60MB total. Compress the image first.</dd>

  <dt id="err-spec_too_large"><code>spec_too_large</code></dt>
  <dd>A cover template's JSON spec is over 64KB. Usually means a runaway logo URL or duplicated layer; load the template, prune layers you don't need.</dd>

  <dt id="err-wrong_format"><code>wrong_format</code></dt>
  <dd>An imported <code>.template</code> file didn't declare <code>format: "pages-seo-cover-template"</code>. Make sure you exported it from a pages-seo install of this version or newer.</dd>

  <dt id="err-not_implemented"><code>not_implemented (501)</code></dt>
  <dd>Server-side template rendering for new blog covers isn't wired up yet (the satori integration is a follow-up). The blog generator falls back to AI image generation automatically — this is not a fatal error.</dd>
</dl>

<h3 id="errors-runtime">Runtime / operational</h3>

<p>Codes that show up after install, surfaced by <code>/api/health</code>, the admin status panel, or the cron tail.</p>

<dl class="err-dl">
  <dt id="err-db-unbound"><code>db: "unbound"</code></dt>
  <dd><strong>Cause:</strong> the Pages project lost its D1 binding (usually after a manual config edit in the Cloudflare dashboard, or a redeploy of an older commit without bindings). <strong>Fix:</strong> dashboard → Pages → your project → Settings → Functions → D1 bindings → re-attach the D1 with binding name <code>DB</code>. Or from CLI: <code>wrangler pages project edit --d1 DB=&lt;d1-id&gt;</code> with the id from <code>wrangler d1 list</code>. The repair UI at <code>/repair</code> does this automatically.</dd>

  <dt id="err-db-error"><code>db: "error"</code></dt>
  <dd><strong>Cause:</strong> schema drift (your D1 doesn't match what the code expects, usually because a deploy added a column but the schema was never re-applied) OR transient D1 outage. <strong>Fix:</strong> re-apply the schema — <code>wrangler d1 execute &lt;db-name&gt; --remote --file=schema/init.sql</code>. The schema is idempotent (uses <code>CREATE TABLE IF NOT EXISTS</code> / <code>ALTER TABLE ... ADD COLUMN</code>) so no data is lost. If the error persists, check the Cloudflare status page.</dd>

  <dt id="err-cron-stale"><code>cron_likely_alive: false</code></dt>
  <dd><strong>Cause:</strong> no post has been published in the last 36 hours, so the cron probably isn't ticking. By far the most common reason is <strong><code>ADMIN_TOKEN</code> drift</strong> — the cron Worker has a different token than the Pages project, the cron POSTs return 401, and the cron silently does nothing. <strong>Fix:</strong> rotate the token on <em>both sides in the same step</em>: <pre><code>NEW=$(openssl rand -hex 32)
echo "$NEW" | wrangler pages secret put ADMIN_TOKEN --project-name &lt;slug&gt;
echo "$NEW" | wrangler secret put ADMIN_TOKEN --name pages-seo-cron</code></pre>Trigger a manual run to verify: <code>curl -X POST &lt;site&gt;/api/admin/blog/cron-tick -H "authorization: Bearer $NEW"</code>.</dd>

  <dt id="err-jobs-stuck"><code>jobs.in_flight_stuck &gt; 0</code></dt>
  <dd><strong>Cause:</strong> a generation step crashed silently — typically because a Pages Function isolate was killed mid-run (the CPU/wall-clock cap), or an upstream AI provider returned a malformed response. Jobs older than 1 hour in a non-terminal state are flagged. <strong>Fix:</strong> query D1 for the stuck rows: <pre><code>wrangler d1 execute &lt;db-name&gt; --remote --command="SELECT id, status, error, updated_at FROM blog_jobs WHERE status NOT IN ('published','failed') ORDER BY updated_at DESC LIMIT 5"</code></pre>Read the <code>error</code> column. Most are <code>provider_timeout</code> or <code>provider_budget_exceeded</code> — see below.</dd>

  <dt id="err-provider_timeout"><code>provider_timeout</code></dt>
  <dd><strong>Cause:</strong> the AI provider didn't respond in time (Cloudflare Pages Functions cap at 30s wall-clock). Workers AI under heavy load is the usual culprit. <strong>Fix:</strong> in <code>/admin → System → Providers</code>, add a fallback (OpenAI / Anthropic / Groq are fastest). The provider chain retries the next one automatically when one fails. Mark the stuck job failed with the admin UI's "Retry" / "Skip" buttons.</dd>

  <dt id="err-provider_budget_exceeded"><code>provider_budget_exceeded</code></dt>
  <dd><strong>Cause:</strong> Workers AI free tier (10k Neurons/day) ran out, OR a paid provider hit its rate limit / billing cap. <strong>Fix:</strong> wait until midnight UTC for Workers AI to reset, OR add a fallback provider key in <code>/admin → System → Providers</code>. Each provider entry has an optional daily budget cap — check it's not set to something low.</dd>

  <dt id="err-admin-token-drift"><code>ADMIN_TOKEN drift</code> (cron returns 401 silently)</dt>
  <dd><strong>Cause:</strong> the cron Worker's <code>ADMIN_TOKEN</code> secret doesn't match what the Pages project expects. Happens after a manual token rotation that only updated one side. <strong>Fix:</strong> the <code>cron_likely_alive: false</code> remedy above rotates both in one step. Verify with <code>wrangler tail pages-seo-cron --format=pretty</code> — a healthy tick logs a 200; a 401 confirms the drift.</dd>

  <dt id="err-installed-sha-stale"><code>installed_sha</code> stale (admin shows "N commits behind" forever)</dt>
  <dd><strong>Cause:</strong> Direct-Upload deploys (the default for CLI installs) don't update D1's <code>installed_sha</code> setting because there's no GitHub webhook to fire. The deployed code IS up to date — only the marker is stale. <strong>Fix:</strong> click <em>Mark as up to date</em> in <code>/admin → System → Updates</code>, OR <code>POST /api/admin/update/dismiss</code> with the admin bearer token. Cosmetic, never blocks anything.</dd>

  <dt id="err-cf-token-missing-scope"><code>Cloudflare API token missing scope</code></dt>
  <dd><strong>Cause:</strong> the CF API token used by the browser installer / repair flow doesn't have one of the six required permissions. <strong>Fix:</strong> recreate the token at <a href="https://dash.cloudflare.com/profile/api-tokens" rel="noopener" target="_blank">dash.cloudflare.com/profile/api-tokens</a> with exactly: Cloudflare Pages: Edit, D1: Edit, Workers R2: Edit, Workers AI: Edit, Workers Scripts: Edit, Account Settings: Read. The token-create link on <code>/install</code> pre-selects these.</dd>

  <dt id="err-deploy-button-auth-10000"><code>Authentication error [code: 10000]</code> (Deploy to Cloudflare button)</dt>
  <dd><strong>Cause:</strong> the API token Cloudflare auto-generates for Workers Builds on new projects sometimes lacks <code>Pages:Edit</code> scope, so the very first build can't deploy. Cloudflare-side limitation of the 1-click button — not something the repo can fix. <strong>Fix:</strong> create a fresh token at <a href="https://dash.cloudflare.com/profile/api-tokens" rel="noopener" target="_blank">dash.cloudflare.com/profile/api-tokens</a> with the six Account permissions above (Pages, D1, R2, Workers AI, Workers Scripts, Account Settings). Then in your Pages project: Settings → Build &amp; deployments → API token → paste it. Re-trigger the deploy from the Deployments tab.</dd>

  <dt id="err-pages-deploy-failed"><code>Pages deploy failed</code></dt>
  <dd><strong>Cause:</strong> the most recent deployment attempt errored — usually a Functions bundle size cap (~10MB) or a syntax error in code pushed from a custom fork. <strong>Fix:</strong> <code>wrangler pages deployment list --project-name=&lt;slug&gt;</code> to see the failed deployment id, then open the build log link in the Cloudflare dashboard. If the issue is bundle size, check that <code>node_modules/</code> isn't being uploaded — only <code>public/</code> + <code>functions/</code> ship.</dd>

  <dt id="err-r2-bucket-renamed"><code>R2 bucket renamed or missing</code></dt>
  <dd><strong>Cause:</strong> R2 bucket was deleted or renamed in the dashboard; hero images return 404 but the site otherwise works. <strong>Fix:</strong> re-create or rename the bucket back to <code>&lt;slug&gt;-images</code>, OR update the binding: dashboard → Pages → your project → Settings → Functions → R2 bindings. The schema and posts table are unaffected — images regenerate on next cron tick.</dd>

  <dt id="err-cf-rate-limit"><code>Cloudflare rate-limited</code> (during install / repair)</dt>
  <dd><strong>Cause:</strong> the CF API enforces ~1200 requests per 5-minute window per token. Re-running the installer repeatedly can hit it. <strong>Fix:</strong> wait 5 minutes. The installer is idempotent — re-run with the same slug and it resumes from where it stopped.</dd>
</dl>
` },

  { id: 'update', title: 'Updating your install', level: 1, content: `
<p>Two ways to pull the latest pages-seo into your fork + redeploy:</p>

<h3>In /admin → Updates</h3>
<p>The Updates tab compares your installed commit SHA to upstream <code>main</code> and shows a diff summary. Click <em>Sync &amp; deploy</em> to merge upstream into your fork and trigger a Pages rebuild. Works for browser-installed sites (which have a GitHub fork to sync from). CLI installs see a message explaining how to <code>git pull</code> + <code>wrangler pages deploy</code> manually.</p>

<h3>At seo.benjaminb.xyz/update</h3>
<p>Hosted equivalent — useful if your /admin is broken. Sign in with GitHub, we look up your fork automatically, show the diff, sync, and trigger a deploy. Works on any pages-seo install on any Cloudflare account.</p>

<h3>If sync fails with merge conflicts</h3>
<p>You've edited the fork directly. Open your fork on GitHub, resolve the conflict in the PR our sync attempt created, then retry. The installer never edits files in your fork — conflicts only happen if you did.</p>
` },

  { id: 'admin-tour', title: 'Admin tour', level: 1, content: `
<p>Every tab in /admin and what it's for.</p>
<ul>
  <li><strong>Overview</strong> — quick actions (run today's blog now, ping IndexNow), recent posts, recent jobs.</li>
  <li><strong>Daily blog</strong> — manually run the blog chain (text → image → publish) or inspect jobs. Per-step retry available on failed jobs.</li>
  <li><strong>Programmatic</strong> — keyword queue + generated landing pages. Upload CSV of keywords, the cron walks the queue one per day (configurable).</li>
  <li><strong>SEO</strong> — IndexNow keys, sitemap URL, robots.txt preview.</li>
  <li><strong>Brand DNA</strong> — free-form brand description that prompts feed off. Tone, audience, topics-to-avoid.</li>
  <li><strong>Links</strong> — internal-link aliases. Sync from sitemap to teach the AI which URLs exist.</li>
  <li><strong>Calendar</strong> — full content calendar with intent classification + priority sorting.</li>
  <li><strong>Usage</strong> — token spend + budget. Hard-stop the cron at the configured cap.</li>
  <li><strong>Covers</strong> — Canva-style cover designer. See <a href="#covers">cover templates</a>.</li>
  <li><strong>Embeds</strong> — copy-pastable widget HTML for cross-posting your /blog to other sites.</li>
  <li><strong>Updates</strong> — fork-sync + deploy. See <a href="#update">updating</a>.</li>
  <li><strong>Settings</strong> — providers, budgets, brand colours, verification metas, hero-image mode.</li>
</ul>
` },

  { id: 'covers', title: 'Cover templates', level: 1, content: `
<p>Cover templates render a per-post hero image from a layered spec, with text variables substituted at render time. Two reasons to use them:</p>
<ul>
  <li>Brand consistency — every post gets the same visual identity, with the title swapped in.</li>
  <li>Storage efficiency — no per-post PNG. Backgrounds + logos live once in R2; the SVG is rendered on demand at <code>/cover/&lt;slug&gt;.svg</code> and cached at the edge.</li>
</ul>

<h3>Available variables</h3>
<p>Every variable below can be used inside any text layer. They chain with filters using the pipe character: <code>{title|truncate:60|upper}</code>.</p>
<pre><code>{title}             post title
{slug}              URL slug
{excerpt}           first 200 chars, markdown stripped
{primary_keyword}   target search query
{keywords}          comma-separated keywords
{reading_time}      "5 min read"
{word_count}        body word count
{pub_date_long}     "18 May 2026"
{pub_date_short}    "2026-05-18"
{pub_year}, {pub_month}, {pub_day}, {pub_dow}
{update_date}, {today_long}, {year}, {now}
{brand.name}, {brand.url}, {brand.domain}, {brand.tagline}
{brand.cta}, {brand.tone}, {brand.audience}
{brand.business_type}, {brand.service_area}
{brand.key_themes}, {brand.topics_to_avoid}
{brand.logo_url}, {brand.primary_color}, {brand.accent_color}
{site.host}, {site.url}, {site.canonical}
{has_image}, {has_logo}        booleans for {if X}</code></pre>

<h3>Available filters</h3>
<pre><code>{x|upper} {x|lower} {x|title} {x|capitalize}
{x|truncate:N} {x|default:"foo"}
{x|slug} {x|kebab} {x|snake} {x|trim} {x|escape}
{x|first_word} {x|domain}
{x|ordinal}      1 → "1st"
{x|pad:2}        "5" → "05"
{x|number_format}    1234567 → "1,234,567"
{x|pluralize:"post"} 2 → "2 posts"
{x|replace:"old:new"}
{x|prepend:"x"} {x|append:"x"}
{x|read_time}    estimate from word count
{x|date:fmt}     long, short, us, iso, year, month, day, dow, relative, or YYYY-MM-DD-HH-mm-DOW template
{if x}…{/if}    {if !x}…{/if}</code></pre>

<h3>Sharing templates</h3>
<p>Click <em>Export</em> on any template to download a <code>.template</code> file containing the spec + every embedded background/logo (base64). On another install, click <em>Import .template…</em> in the Templates rail. Assets get re-uploaded to the receiver's R2; the spec URLs are rewritten automatically.</p>
` },

  { id: 'self-host', title: 'Self-hosting reference', level: 1, content: `
<h3>Environment variables (Pages project)</h3>
<p>Set in the Cloudflare dashboard → your Pages project → Settings → Environment variables. All optional unless noted.</p>
<dl class="ref-dl">
  <dt><code>SITE_NAME</code></dt><dd>Display name. Falls back to settings table's <code>site_name</code>.</dd>
  <dt><code>SITE_URL</code></dt><dd>Canonical base URL. Falls back to settings.</dd>
  <dt><code>SITE_DESCRIPTION</code></dt><dd>For meta description on home + blog index.</dd>
  <dt><code>SITE_LOGO_URL</code></dt><dd>Logo for JSON-LD Organization.logo.</dd>
  <dt><code>ADMIN_TOKEN</code></dt><dd>64-char hex. Recovery credential — if you lose the password, bearer this in <code>Authorization: Bearer &lt;token&gt;</code> headers to admin APIs.</dd>
  <dt><code>SETUP_TOKEN</code></dt><dd>Magic-link token for /api/setup. Used once on first run; not needed afterwards.</dd>
  <dt><code>CF_API_TOKEN</code> / <code>CF_ACCOUNT_ID</code> / <code>CF_PROJECT</code> / <code>CF_D1_ID</code> / <code>CF_R2_NAME</code></dt><dd>Set by the installer. Used by <code>/api/repair-bindings</code> to self-heal if Cloudflare drops bindings.</dd>
</dl>

<h3>Bindings</h3>
<ul>
  <li><code>DB</code> — D1 database. Schema in <code>functions/_lib/schema.js</code>.</li>
  <li><code>IMAGES</code> — R2 bucket. Stores cover assets + hero images.</li>
  <li><code>AI</code> — Workers AI (Flux for image gen + Llama for fallback text gen). Free tier.</li>
</ul>

<h3>Settings (D1 table)</h3>
<p>Editable in /admin → Settings. Key list: see <code>functions/_lib/settings.js</code>. The most useful ones:</p>
<dl class="ref-dl">
  <dt><code>hero_image_mode</code></dt><dd><code>ai</code> (default) generates a fresh image per post via the configured AI provider. <code>cover</code> renders /cover/&lt;slug&gt;.svg from the default template instead.</dd>
  <dt><code>monthly_budget_usd</code></dt><dd>Hard cap. The cron stops when this month's spend reaches it.</dd>
  <dt><code>budget_warn_pct</code></dt><dd>Show a banner when spend crosses this % of budget.</dd>
  <dt><code>google_site_verification</code> / <code>bing_site_verification</code></dt><dd>Meta-tag values from the respective webmaster consoles.</dd>
  <dt><code>brand_primary_color</code> / <code>brand_accent_color</code> / <code>site_tagline</code> / <code>brand_logo_url</code></dt><dd>Brand identity for cover templates and JSON-LD.</dd>
</dl>
` },
];

function renderToc() {
  return `<nav class="docs-toc" aria-label="Table of contents">
  <strong>On this page</strong>
  <ol>${SECTIONS.map((s) => `<li><a href="#${esc(s.id)}">${esc(s.title)}</a></li>`).join('')}</ol>
</nav>`;
}

function renderSections() {
  return SECTIONS.map((s) =>
    `<section id="${esc(s.id)}" class="docs-section">
  <h2>${esc(s.title)} <a class="anchor" href="#${esc(s.id)}" aria-label="link">#</a></h2>
  ${s.content}
</section>`
  ).join('\n');
}

export const onRequestGet = async ({ request }) => {
  const url = new URL(request.url);
  const host = url.hostname;

  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Docs · pages-seo</title>
<meta name="description" content="Setup, update, troubleshooting, and error reference for pages-seo. Self-hosted programmatic SEO on Cloudflare." />
<link rel="canonical" href="https://${host}/docs" />
<meta name="robots" content="index,follow" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&display=swap" />
<link rel="stylesheet" href="/marketing.css" />
<style>
  .docs-wrap { max-width: 920px; margin: 0 auto; padding: 48px 24px 96px; }
  .docs-head { text-align: left; margin-bottom: 32px; }
  .docs-head h1 { font-size: 44px; line-height: 1.1; margin: 0 0 8px; }
  .docs-head p { color: var(--ink-dim, #6a7484); font-size: 18px; margin: 0; }
  .docs-grid { display: grid; grid-template-columns: 220px 1fr; gap: 48px; margin-top: 24px; }
  .docs-toc { position: sticky; top: 24px; align-self: start; font-size: 13px; }
  .docs-toc strong { font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-dim, #6a7484); display: block; margin-bottom: 12px; }
  .docs-toc ol { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
  .docs-toc a { color: var(--ink); text-decoration: none; border-left: 2px solid var(--line, rgba(0,0,0,0.1)); padding: 2px 10px; display: block; }
  .docs-toc a:hover { color: var(--accent); border-left-color: var(--accent); }
  .docs-section { margin-bottom: 56px; scroll-margin-top: 24px; }
  .docs-section h2 { font-size: 28px; margin: 0 0 16px; display: flex; align-items: baseline; gap: 10px; }
  .docs-section h2 .anchor { color: var(--ink-dim, #6a7484); text-decoration: none; font-size: 0.6em; opacity: 0; transition: opacity .12s; }
  .docs-section h2:hover .anchor { opacity: 1; }
  .docs-section h3 { font-size: 18px; margin: 28px 0 10px; }
  .docs-section p, .docs-section li, .docs-section dd { line-height: 1.6; }
  .docs-section pre { background: var(--bg-2, #f3f1ec); padding: 14px 16px; border-radius: 8px; overflow-x: auto; font-size: 13px; line-height: 1.5; }
  .docs-section code { font-size: 0.9em; }
  .docs-section pre code { background: none; padding: 0; }
  .docs-section ol, .docs-section ul { padding-left: 22px; }
  .docs-section dl { margin: 12px 0; }
  .docs-section dt { font-weight: 600; margin-top: 14px; }
  .docs-section dd { margin: 4px 0 0; color: var(--ink-dim, #4a5060); }
  .err-dl dt { font-family: var(--font-mono, monospace); font-size: 13px; }
  .err-dl dt code { font-size: 1em; }
  .ref-dl dt { font-family: var(--font-mono, monospace); font-size: 13px; }
  .lede { font-size: 17px; color: var(--ink-dim, #4a5060); }
  @media (max-width: 760px) {
    .docs-grid { grid-template-columns: 1fr; }
    .docs-toc { position: static; }
    .docs-head h1 { font-size: 32px; }
  }
</style>
</head>
<body>
<header class="nav">
  <a class="brand" href="/">pages-seo</a>
  <nav>
    <a href="/install">Install</a>
    <a href="/update">Update</a>
    <a href="/docs" aria-current="page">Docs</a>
  </nav>
</header>
<main class="docs-wrap">
  <header class="docs-head">
    <h1>pages-seo docs</h1>
    <p>Setup, update, troubleshooting, error reference, and self-hosting notes.</p>
  </header>
  <div class="docs-grid">
    ${renderToc()}
    <div class="docs-body">${renderSections()}</div>
  </div>
</main>
<footer class="foot">
  <span>pages-seo</span> · <a href="/">Home</a> · <a href="/install">Install</a> · <a href="/docs">Docs</a>
</footer>
</body>
</html>`;

  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Edge-cached for an hour; users get fresh docs within an hour
      // of any deploy. Browser cache short (5 min) so refreshes hit
      // the CDN copy.
      'cache-control': 'public, max-age=300, s-maxage=3600',
    },
  });
};
