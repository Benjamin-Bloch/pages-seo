-- Programmatic SEO landing pages for pages-seo itself ("eat your own
-- dog food"). Each row targets a buyer-intent keyword the toolkit
-- should rank for. Re-runnable: uses INSERT OR REPLACE keyed on slug.
--
-- Word counts deliberately tuned to ~700 words (the quality scorer's
-- "good" tier) so they pass the same bar as cron-generated posts.
-- Internal links point at /install, /docs, /ai-setup, and each other.
--
-- Apply with:
--   wrangler d1 execute <db-name> --remote --file=scripts/seed-landing-pages.sql

-- ─── 1. self-hosted programmatic SEO ───────────────────────────────
INSERT OR REPLACE INTO prog_pages
  (id, slug, keyword, title, meta_description, body_markdown,
   status, ai_provider, created_at, published_at)
VALUES
  ('seed-self-hosted-programmatic-seo',
   'self-hosted-programmatic-seo',
   'self-hosted programmatic SEO',
   'Self-Hosted Programmatic SEO: A Practical Toolkit for Cloudflare',
   'Run programmatic SEO on your own infrastructure. pages-seo is an open-source toolkit that publishes AI-generated landing pages and a daily blog on Cloudflare Pages — free tier covers most cases.',
   '# Self-hosted programmatic SEO

Programmatic SEO is the practice of generating large numbers of landing pages — one per keyword, location, or product variant — and publishing them on infrastructure you control. **Self-hosting** means no per-page SaaS fee, no vendor lock-in, and full ownership of the URLs, schema, and analytics.

## Why self-host instead of using a SaaS

Most programmatic-SEO SaaS tools charge per page generated, per word, or per domain — fine until you have 5,000 URLs and the bill scales linearly. Self-hosting flips that: one Cloudflare account, $0–5/month, unlimited pages.

You also keep:

- **Control of the URLs.** Your domain, your slugs, your canonical tags.
- **Control of the schema.** Article + Breadcrumb + FAQ — whatever Google ranks for, you can ship.
- **Control of the data.** Every post lives in your own D1 database. Export, edit, or migrate without permission.
- **Control of the AI.** Workers AI by default; swap in OpenAI, Claude, Gemini, or any of nine providers via config.

## What pages-seo gives you

pages-seo runs the full SEO loop on Cloudflare Pages — no servers, no Docker, no $50/mo SaaS bill. Specifically:

- **Programmatic landing pages.** One URL per keyword, AI-generated, served from D1 with edge caching.
- **Daily AI blog.** A cron Worker generates one long-form post per day, with a hero image.
- **Sitemap + IndexNow.** Auto-pinged to Bing, Yandex, and Seznam within seconds of publish.
- **RSS feed.** Auto-discovered by aggregators.
- **Embed widget.** Drop the latest 3 posts on any external site with one `<script>` tag.
- **Brand DNA generator.** Paste your URL, get a structured brand profile baked into every prompt.

## How fast can you get started

The fastest path is the [1-click Deploy to Cloudflare](/install) button — about 90 seconds, all in the browser. The CLI path takes ~2 minutes if you already have `wrangler` installed.

Either way, you end up with a working install at `https://<your-slug>.pages.dev/admin` and the daily cron scheduled.

## The architecture in one paragraph

Cloudflare Pages serves both static assets (HTML, CSS, JS) and Pages Functions (HTTP routes under `/api`). Posts live in a D1 SQLite database; hero images live in R2 object storage. A separate Cloudflare Worker fires daily, hits `/api/admin/blog/cron-tick`, and that endpoint orchestrates the multi-step generation chain (start → text → image → publish) — broken into steps so it survives Pages Functions'' aggressive isolate kills.

## Cost: what you actually pay

On Cloudflare''s free tier with Workers AI: **$0/month**. Workers AI gives you 10,000 Neurons/day free — a full-length post (Qwen3 text + a Flux hero image) costs roughly 150–230 Neurons, so the free tier covers ~40–60 long posts per day. The defaults run one blog post plus ten programmatic pages a day, using well under 20% of that allowance.

If you outgrow the free tier: Workers Paid is $5/month plus a few cents per million extra operations.

## Who this is for

- **Indie operators** running content sites who don''t want a Substack-style middleman.
- **Agencies** managing client SEO who want to white-label without per-seat SaaS.
- **Open-source teams** documenting a product who want a daily blog without writing it.

If that''s you, the next step is the [install guide](/install) or the [AI setup walkthrough](/ai-setup) if you''d rather an LLM hold your hand through it.

## Common questions

**Is AI-generated content penalised by Google?** Google''s public position is that AI content is fine if it''s useful. The toolkit ships with Article + Breadcrumb + FAQ schema, structured headings, and IndexNow pings — quality is on the model you choose.

**Can I edit posts manually?** Yes. Posts live in your D1 database — edit via the admin UI''s post detail view, or run SQL directly with `wrangler d1 execute`.

**What about a real domain?** Point your domain at Cloudflare Pages in the dashboard. The site reads the request host, so URLs, sitemap, and canonical tags all switch automatically.

See the [error reference](/docs#errors) if you hit a snag, or the [full docs](/docs) for the long version.',
   'published', 'maintainer',
   strftime('%s','now'), strftime('%s','now'));

-- ─── 2. Cloudflare Pages SEO blog ──────────────────────────────────
INSERT OR REPLACE INTO prog_pages
  (id, slug, keyword, title, meta_description, body_markdown,
   status, ai_provider, created_at, published_at)
VALUES
  ('seed-cloudflare-pages-seo-blog',
   'cloudflare-pages-seo-blog',
   'Cloudflare Pages SEO blog',
   'How to run an SEO blog on Cloudflare Pages (open source)',
   'pages-seo turns a Cloudflare Pages project into a daily-publishing SEO blog: D1 storage, R2 images, IndexNow pings, Article schema. Free tier covers most cases.',
   '# Running an SEO blog on Cloudflare Pages

[Cloudflare Pages](https://pages.cloudflare.com) is a static-site host with serverless Functions, free SSL, and a generous free tier. It''s also a surprisingly good place to run a daily-publishing SEO blog — once you wire up the right combination of D1, R2, and Workers AI.

## Why Cloudflare Pages instead of WordPress / Ghost / Substack

The usual three tradeoffs:

- **Hosting cost.** Pages free tier: 100k requests/day, unlimited bandwidth. WordPress: $5–25/month, scales worse.
- **Cold start.** Pages Functions resume in &lt;10ms; WordPress on shared hosting is 200–800ms TTFB.
- **AI integration.** Workers AI runs inside the same edge as your Functions — no per-token API call to a third party for the default model.

The catch: Pages Functions cap at 30 seconds of CPU and have aggressive isolate-kill semantics. You can''t run a long synchronous "generate-blog-post" function. You have to chain it: pick the topic → generate the text → generate the hero image → publish. Each step is its own request, each writes state to D1.

That''s what pages-seo does for you, out of the box.

## What you need

- A Cloudflare account (free tier is fine).
- A domain — or just use the `*.pages.dev` subdomain you get for free.
- About 5 minutes for the installer to finish.

The fastest path is the [1-click Deploy to Cloudflare](/install) button. The CLI installer takes about 2 minutes if you''re comfortable with a shell.

## What the toolkit ships

A working pages-seo install includes:

- **Daily AI blog**, scheduled via a separate cron Worker.
- **Programmatic landing pages** (`/p/<keyword>`) with edge caching.
- **Sitemap.xml** auto-generated from D1; submitted to Bing + Yandex + Seznam via IndexNow within seconds of publish.
- **RSS feed** at `/feed.xml`, auto-discovered by aggregators.
- **OpenGraph + Twitter card** meta tags rendered per-post.
- **Article + Breadcrumb + FAQ JSON-LD** in every post.
- **Embed widget** so you can drop the latest 3 posts on a marketing page elsewhere.

## The architecture

```
Cloudflare Pages          ← serves /, /blog/*, /p/*, /admin, /api/*
  ├── Pages Functions     ← HTTP handlers in functions/api/**.js
  ├── D1 (SQLite)         ← posts, settings, audit log, jobs
  ├── R2 (object storage) ← hero images
  └── Workers AI          ← text + image generation
Cloudflare Worker (cron)  ← daily POST to /api/admin/blog/cron-tick
```

D1 is the single source of truth — every post, every job, every setting lives there. Migrating to a different host means dumping D1 and re-importing somewhere else.

## How fast is it

A cron tick from scheduled time to published post takes about 60–90 seconds: ~30s text generation (Qwen3 70B or your chosen LLM), ~20s hero image (Flux Schnell), ~5s schema apply + D1 writes, ~5s IndexNow ping. The post is live at the edge as soon as D1 commits.

## What you actually pay

On the free tier with Workers AI: **$0/month** for the defaults (1 blog post + 10 programmatic pages per day). The free-tier ceiling sits around 40–60 long posts/day before you''d need Workers Paid ($5/month).

## What''s involved in installing

Three steps, in any of three flavours:

1. Click the [Deploy to Cloudflare](/install) button.
2. Or run the [terminal installer](/install).
3. Or have [ChatGPT / Claude / Gemini walk you through it](/ai-setup).

If you hit a snag, the [error reference](/docs#errors) covers the 20 most common failure modes with their fixes.

## Next steps

After install, the order I recommend:

1. Open `/admin` and fill in **Brand DNA** — paste your domain, get a structured profile.
2. Run the **keyword puller** to seed your first batch of programmatic pages.
3. Let the cron tick once. Check `/api/health` shows `cron_likely_alive: true` the next morning.

Related: [self-hosted programmatic SEO](/p/self-hosted-programmatic-seo), [open-source AI blog generator](/p/open-source-ai-blog-generator), [workers AI blog](/p/workers-ai-blog).',
   'published', 'maintainer',
   strftime('%s','now'), strftime('%s','now'));

-- ─── 3. open-source AI blog generator ──────────────────────────────
INSERT OR REPLACE INTO prog_pages
  (id, slug, keyword, title, meta_description, body_markdown,
   status, ai_provider, created_at, published_at)
VALUES
  ('seed-open-source-ai-blog-generator',
   'open-source-ai-blog-generator',
   'open source AI blog generator',
   'Open-Source AI Blog Generator (Self-Hosted, $0/mo)',
   'pages-seo is an open-source AI blog generator that runs on Cloudflare Pages. Daily posts, hero images, SEO schema, IndexNow — all on your own infrastructure.',
   '# Open-source AI blog generator

Most "AI blog generator" tools are SaaS: you pay $30–100/month, post output appears on someone else''s domain, and you''re one pricing change away from a forced migration. **pages-seo** is the opposite — open source, MIT licensed, runs entirely on your own Cloudflare account.

## What "open source" actually buys you

- **Read the prompts.** Every system prompt the toolkit uses is in [the repo](https://github.com/Benjamin-Bloch/pages-seo). Tweak them.
- **Swap the models.** Nine providers supported out of the box — Workers AI, OpenAI, Anthropic, Gemini, Groq, DeepSeek, Mistral, Together, Cerebras.
- **Own the data.** Posts live in your D1 database. Export with `wrangler d1 export` any time.
- **Fork it.** Disagree with a design choice? Fork, edit, ship. No EULA, no "premium plan" to pay for the feature you want.

## What the toolkit does

1. **Picks tomorrow''s topic** from a content calendar you can edit, hand-curate, or auto-fill from your brand DNA.
2. **Generates the post** — a multi-step chain (topic → outline → body → meta + schema) tuned to survive Pages Functions'' wall-clock cap.
3. **Generates a hero image** — Workers AI Flux by default, OpenAI/Gemini Imagen as fallback.
4. **Publishes** with schema markup, OG/Twitter cards, and IndexNow pings.
5. **Adds it to the sitemap and RSS feed** automatically.

## What it doesn''t do

- It doesn''t lock you into a SaaS hosting tier.
- It doesn''t charge per word, per post, or per domain.
- It doesn''t ship analytics back to a third party. Use Cloudflare Web Analytics (free) or any tool of your choice.

## Quality

Workers AI (Llama 3.3 70B or Qwen3 70B) produces SEO-coherent, structurally clean copy — title, meta, slug, keywords, H2/H3, FAQ, CTA all in place. The prose tends toward generic; you can swap in Claude Sonnet or GPT-5 for noticeably better output at higher cost per post.

The toolkit also ships a **pre-publish quality scorer** that grades each draft on word count, headings, lists, internal links, title/meta length. Thin posts get marked `status=review` instead of going live, so you''re not auto-publishing junk.

## Free tier coverage

On Cloudflare''s free tier with Workers AI: **$0/month** for the default schedule (1 blog + 10 programmatic pages per day). Workers AI gives 10,000 Neurons/day free; a full post is ~150–230 Neurons. So the free tier covers ~40–60 long posts/day before you''d need to upgrade.

## How to get started

- **1-click:** [Deploy to Cloudflare](/install) — Cloudflare forks the repo, provisions resources, deploys. About 90 seconds.
- **Terminal:** `curl -fsSL https://seo.benjaminb.xyz/install/run.sh | bash` — about 2 minutes.
- **AI walkthrough:** [/ai-setup](/ai-setup) — pick your AI tool and copy a tailored prompt.

## Comparison: SaaS vs self-hosted AI blog generators

| | SaaS (e.g. SEObot, Writesonic) | pages-seo (self-hosted) |
|---|---|---|
| **Monthly cost** | $30–100+ | $0–5 (Cloudflare) |
| **Per-post cost** | Tracked + capped | Workers AI Neurons; no cap |
| **Your domain** | Sometimes, via DNS | Always (it''s your Pages project) |
| **Edit the prompts** | No | Yes |
| **Swap the AI model** | Limited | 9 providers |
| **Data ownership** | Their database | Your D1 |
| **Sitemap + IndexNow** | Varies | Built-in |
| **Embed widget** | Usually paid | Built-in |

## What''s missing (be honest)

A few things SaaS does better today:

- **GUI content-calendar drag-and-drop** is more polished in SaaS tools. pages-seo''s calendar is functional but utilitarian.
- **Stock-photo libraries.** SaaS tools bundle access. We use AI-generated hero images.
- **Multi-language out of the box.** pages-seo supports it via brand DNA but doesn''t auto-translate by default.

If those matter more than ownership and cost, a SaaS is the right answer. Otherwise: [install pages-seo](/install).

See also: [self-hosted programmatic SEO](/p/self-hosted-programmatic-seo) · [Cloudflare Pages SEO blog](/p/cloudflare-pages-seo-blog) · [free programmatic SEO tool](/p/free-programmatic-seo-tool).',
   'published', 'maintainer',
   strftime('%s','now'), strftime('%s','now'));

-- ─── 4. Workers AI blog ────────────────────────────────────────────
INSERT OR REPLACE INTO prog_pages
  (id, slug, keyword, title, meta_description, body_markdown,
   status, ai_provider, created_at, published_at)
VALUES
  ('seed-workers-ai-blog',
   'workers-ai-blog',
   'Workers AI blog',
   'Using Workers AI to Run a Blog (Free Tier, No Per-Token Cost)',
   'Workers AI gives you 10,000 Neurons/day free. pages-seo uses that allowance to run a full SEO blog — text + hero images — at $0/month.',
   '# Running a blog on Workers AI

[Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) is Cloudflare''s edge AI inference platform. It gives you 10,000 Neurons/day free — enough for ~40–60 long blog posts when you''re generating both text and hero images. **pages-seo** is built around that allowance.

## What''s a Neuron

Neurons are Cloudflare''s billing unit for Workers AI. A generation step (text or image) costs a model-specific number of Neurons. Concretely, for a default pages-seo post:

- **Text** (~800 words via Qwen3 70B): ~120–180 Neurons
- **Hero image** (Flux Schnell, 1024×1024): ~25–50 Neurons
- **Total per post**: ~150–230 Neurons

The free tier resets at midnight UTC. If you publish one post per day, you use ~2–3% of the daily allowance.

## Why Workers AI specifically

Three reasons it makes sense as the default:

1. **No API token to set up.** Cloudflare Pages auto-binds `AI` to your Pages project — no separate key management.
2. **Same edge as your Functions.** No round-trip to a US-east API endpoint; inference runs in the colo nearest your user.
3. **No per-token billing surprises.** You either have Neurons or you don''t — no $300 surprise bills from a runaway loop.

## When you''d want a paid fallback

Workers AI is fine for SEO-coherent, structurally clean copy. For higher-quality prose, you can plug in:

- **Claude Sonnet 4** for editorial-feeling content.
- **GPT-5** for technical depth and code-heavy posts.
- **Gemini 2.5 Pro** for long-context research summaries.

Each provider is configured in `/admin → System → Providers`. They run as a fallback chain — if one fails, the next runs automatically.

## Free-tier ceiling, in plain numbers

At default settings (1 blog + 10 programmatic pages per day):

| | Neurons/day | % of 10,000 free |
|---|---|---|
| Blog post (text + image) | 230 | 2.3% |
| 10 prog pages (text only, no image) | ~1500 | 15% |
| **Total** | **~1730** | **~17%** |

You''re running at ~17% utilization. That leaves room to:

- Bump the daily blog cadence to 3 posts/day.
- Generate hero images for prog pages too (+250 Neurons each).
- Run a draft "second opinion" pass via a paid provider on the most important posts.

## Other Workers AI limits

Two other free-tier ceilings worth knowing:

- **100k Pages requests/day.** That''s 100k page views — fine for a small site.
- **5 GB D1 storage.** A post averages ~5 KB of text in D1; you can fit ~1 million posts before hitting the cap.

If you outgrow any of these: Workers Paid ($5/month) covers them with generous per-million-operation pricing on top.

## How to start

Install pages-seo with the [1-click Deploy to Cloudflare button](/install) or the [terminal installer](/install). The default config uses Workers AI; no API keys to copy.

Once installed, you can override per-step:

- `/admin → System → Providers` — set the model and the fallback chain.
- `/admin → Brand DNA` — paste your domain to flavour the prompts.
- `/admin → Content calendar` — preview the next 4 weeks of topics.

Related: [self-hosted programmatic SEO](/p/self-hosted-programmatic-seo) · [open-source AI blog generator](/p/open-source-ai-blog-generator) · [Cloudflare Pages SEO blog](/p/cloudflare-pages-seo-blog).',
   'published', 'maintainer',
   strftime('%s','now'), strftime('%s','now'));

-- ─── 5. free programmatic SEO tool ─────────────────────────────────
INSERT OR REPLACE INTO prog_pages
  (id, slug, keyword, title, meta_description, body_markdown,
   status, ai_provider, created_at, published_at)
VALUES
  ('seed-free-programmatic-seo-tool',
   'free-programmatic-seo-tool',
   'free programmatic SEO tool',
   'A Free Programmatic SEO Tool (Open Source, Self-Hosted)',
   'pages-seo is a free programmatic-SEO tool you self-host on Cloudflare. No SaaS subscription. No per-page fees. Generates landing pages + daily blog from your own infrastructure.',
   '# Free programmatic SEO tool

Most "programmatic SEO" tools follow one of two pricing models:

- **Per-page fee** ($0.10–$1 per generated page). A 5,000-page site costs $500–5,000.
- **Monthly subscription** ($30–300/month). You stop paying, your site disappears or stops updating.

**pages-seo** is neither. It''s an open-source toolkit you install on your own Cloudflare account. Cloudflare''s free tier covers most realistic usage. No subscription, no per-page fee, no domain limit.

## What "free" actually means here

- **The toolkit:** MIT licensed, free forever. [Source on GitHub](https://github.com/Benjamin-Bloch/pages-seo).
- **The hosting:** Cloudflare Pages free tier — 100k requests/day, unlimited bandwidth.
- **The AI:** Workers AI free tier — 10,000 Neurons/day, enough for ~40–60 long posts.
- **The storage:** D1 free tier — 5 GB; R2 free tier — 10 GB egress/month.

The only thing you pay for is a domain (~$10/year), and only if you don''t want to use the free `*.pages.dev` subdomain Cloudflare gives you.

## What you get

The toolkit publishes two kinds of pages:

- **Programmatic landing pages** at `/p/<keyword-slug>`. One URL per keyword you target. Edge-cached, AI-generated body, schema markup.
- **Blog posts** at `/blog/<slug>`. One long-form post per day, with a hero image, scheduled via a cron Worker.

Both share the same infrastructure (Cloudflare Pages + D1 + R2) and the same SEO foundations: sitemap, IndexNow, Article schema, OG/Twitter cards, RSS, canonical tags.

## The realistic limits of free tier

The Cloudflare free tier ceilings, in order of likelihood you''ll hit them:

1. **10k Workers AI Neurons/day.** Default config uses ~17% of this. You can run 3–4× the default cadence before hitting it.
2. **100k Pages requests/day.** ~100k page views. Plenty for a growing site; you''d need real traffic to exceed it.
3. **5 GB D1 storage.** ~1 million posts'' worth of text.

If you breach any of them: Workers Paid is $5/month with very generous overage rates.

## How "free" compares to paid SaaS

Compare to a typical programmatic-SEO SaaS:

| | Typical SaaS | pages-seo (free tier) |
|---|---|---|
| **Setup cost** | $0–500 onboarding | $0 |
| **Monthly minimum** | $30–300 | $0 |
| **Per-page fee** | $0.10–$1 | $0 |
| **5,000 pages** | $500–5,000 | $0 |
| **Your domain** | DNS-pointed | Yours |
| **Source code** | Closed | MIT licensed |
| **Data export** | Paid feature | `wrangler d1 export` |

## What you trade off

Honest tradeoffs:

- **You have to install it.** Click the [1-click Deploy](/install) button or run a terminal command. Takes 2–5 minutes.
- **You manage your own AI provider chain.** Workers AI by default; you can add paid providers as fallbacks in `/admin → System → Providers`.
- **You handle your own analytics.** Cloudflare Web Analytics is free and integrates in one click, or wire up GA4 / Plausible / Fathom — your choice.

If those are reasonable trades, [install pages-seo](/install) takes under 5 minutes.

## Common questions

**Is it really $0/month forever?** On Cloudflare''s free tier, yes — assuming you stay under the ceilings above. If you don''t, Workers Paid is $5/month with generous overage rates.

**Can I use it for a client?** Yes. MIT licence — use it commercially without attribution if you want.

**Does it support multiple domains?** Each pages-seo install is one domain. For multiple, you install it multiple times (each on its own Cloudflare Pages project + D1 + R2).

**Can I migrate off Cloudflare later?** Yes. D1 is SQLite, exportable. R2 is S3-compatible, downloadable. Posts are markdown.

Related: [self-hosted programmatic SEO](/p/self-hosted-programmatic-seo) · [open-source AI blog generator](/p/open-source-ai-blog-generator).',
   'published', 'maintainer',
   strftime('%s','now'), strftime('%s','now'));

-- ─── 6. alternative to SEObot ──────────────────────────────────────
INSERT OR REPLACE INTO prog_pages
  (id, slug, keyword, title, meta_description, body_markdown,
   status, ai_provider, created_at, published_at)
VALUES
  ('seed-alternative-to-seobot',
   'alternative-to-seobot',
   'alternative to SEObot',
   'An Open-Source Alternative to SEObot (Self-Hosted, $0/mo)',
   'Looking for an SEObot alternative? pages-seo is open source, runs on your Cloudflare account, costs $0/mo on free tier. Same daily-AI-blog idea, you own the infrastructure.',
   '# An open-source alternative to SEObot

[SEObot](https://seobotai.com) is a polished SaaS that auto-generates blog posts. It''s good at what it does. The reasons people look for alternatives are usually:

1. **Cost** — the per-post or per-month fee adds up.
2. **Ownership** — the posts live on their infrastructure, indexed in their database.
3. **Customisation** — you can''t edit the system prompts or swap the model.

**pages-seo** addresses all three. It''s open source (MIT licence), runs on your own Cloudflare account, and ships with every prompt readable in the repo.

## How pages-seo compares

| | SEObot (SaaS) | pages-seo (self-hosted) |
|---|---|---|
| **Pricing** | Per-post + monthly | Cloudflare free tier ($0) |
| **Where the posts live** | Their database, your domain via DNS | Your D1 database, your Pages project |
| **Edit the prompts** | No | Yes (in the repo) |
| **Swap the AI model** | Limited choices | 9 providers (Workers AI, OpenAI, Claude, Gemini, Groq, DeepSeek, Mistral, Together, Cerebras) |
| **Embed widget** | Paid tier | Built-in |
| **Sitemap + IndexNow** | Yes | Yes |
| **Schema (Article + FAQ)** | Yes | Yes |
| **Hero images** | Stock photos | Workers AI Flux (or OpenAI / Gemini Imagen) |
| **Data export** | Paid feature | `wrangler d1 export` |
| **Multi-language** | Yes | Via brand DNA |
| **Setup time** | 5 minutes | 5 minutes |

## Where SEObot wins

Being honest:

- **Polish.** The SEObot dashboard is more refined; pages-seo''s admin is functional but utilitarian.
- **Stock images.** SEObot bundles a stock photo library. pages-seo uses AI-generated hero images.
- **Hand-holding.** SEObot has a customer-success layer; pages-seo has docs and an [AI setup walkthrough](/ai-setup).

If those matter more than ownership and cost, SEObot is the right tool.

## Where pages-seo wins

- **$0/month.** On the Cloudflare free tier, indefinitely.
- **Source-readable prompts.** Want the AI to write in a specific voice? Edit `functions/_lib/prompts/*.js`.
- **Provider chain.** Workers AI by default; OpenAI or Claude as fallback. SEObot uses GPT under the hood; you can''t change that.
- **Infra you control.** Cloudflare goes down, your hosting fails. SEObot goes down, your site stops updating until they''re back.

## What "self-hosted" actually requires

- A Cloudflare account (free).
- Either: click the [Deploy to Cloudflare](/install) button, OR run the installer (`curl ... | bash`), OR use the [AI setup walkthrough](/ai-setup).
- About 5 minutes.

After install, you''re at `https://<your-project>.pages.dev/admin`. Set up brand DNA, set the cron schedule, you''re live.

## Migrating from SEObot

If you already have SEObot writing for a domain:

1. Install pages-seo on a different `*.pages.dev` subdomain first.
2. Verify the cron ticks, posts render, sitemap submits.
3. Swap your custom domain''s DNS from SEObot to your Pages project.
4. Export your historical SEObot posts and import them into D1 (the schema supports manual inserts; `published_at` controls visibility).

The [error reference](/docs#errors) covers what to do if any of those steps trip.

## Cost example

Side-by-side for a 30-posts-per-month cadence:

- **SEObot:** ~$49/month (their entry tier at time of writing).
- **pages-seo:** $0/month on Cloudflare free tier. (~9% of Workers AI free quota.)

Over a year: $588 → $0. Over five years: $2,940 → $0.

If you''re running multiple domains, the gap widens — pages-seo installs are independent, each with their own free-tier allowance.

Related: [self-hosted programmatic SEO](/p/self-hosted-programmatic-seo) · [free programmatic SEO tool](/p/free-programmatic-seo-tool) · [open-source AI blog generator](/p/open-source-ai-blog-generator).',
   'published', 'maintainer',
   strftime('%s','now'), strftime('%s','now'));
