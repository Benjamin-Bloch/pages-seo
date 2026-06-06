<div align="center">

# pages-seo

**A self-hosted programmatic-SEO + daily-AI-blog toolkit that runs entirely on Cloudflare.**

[![Cloudflare Pages](https://img.shields.io/badge/Cloudflare-Pages-F38020?logo=cloudflare&logoColor=white)](https://pages.cloudflare.com)
[![Workers AI](https://img.shields.io/badge/Workers%20AI-included-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers-ai/)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-1a1a1a)](./LICENCE)
[![Demo](https://img.shields.io/badge/live%20demo-seo.benjaminb.xyz-0a0a0a)](https://seo.benjaminb.xyz)
[![Made by Benjamin Bloch](https://img.shields.io/badge/made%20by-Benjamin%20Bloch-f5cf3e)](https://benjaminb.xyz)

Plug in a URL (or a keyword list), point a cron at it, and `pages-seo` quietly publishes programmatic landing pages and a daily blog post — each with a hero image — and pings IndexNow so Bing/Yandex/Seznam crawl them within minutes.

**Free tier covers most cases.** No servers, no Docker, no Vercel bill at scale.

[**Live demo →**](https://seo.benjaminb.xyz)  ·  [**5-minute setup**](#-5-minute-setup)  ·  [**Architecture**](#%EF%B8%8F-architecture)  ·  [**AI providers**](#-ai-providers)

</div>

---

## ✨ What you get

- **Brand DNA generator** — paste a URL, get a structured brand profile baked into every prompt.
- **Content calendar** — auto-plans 4–8 weeks of upcoming articles from the brand DNA; add, remove, swap, or reorder them in a Monday-first grid.
- **Daily AI blog** — multi-step chain (start → text → image → publish) that survives Pages Functions' aggressive isolate kills.
- **Programmatic landing pages** — one URL per keyword, AI-written, served from D1 with edge caching.
- **Hero images** — Workers AI (Flux) by default; OpenAI / Gemini Imagen as fallback.
- **Keyword puller** — free Google-Autocomplete-based seed expansion, queues straight into D1.
- **Sitemap + IndexNow** — automatic XML sitemap, on-publish IndexNow pings, robots.txt.
- **Embeddable widget** — drop a `<script>` on any site to render your latest posts.
- **Admin dashboard** — single-page SPA with email/password login, runs jobs and inspects the queue.
- **Cover image editor** — canvas-based crop, captions, badges, gradient overlay.
- **Multi-AI registry** — Workers AI → OpenAI → Anthropic → Gemini → Groq → DeepSeek → Mistral → Together → Cerebras. Each is optional.

## 🚀 Install in one command

### Option A — 1-click deploy (zero terminal)

<a href="https://deploy.workers.cloudflare.com/?url=https://github.com/Benjamin-Bloch/pages-seo">
  <img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare" />
</a>

Cloudflare forks the repo to your GitHub, creates a Pages project, provisions the D1 database and R2 bucket, and deploys — about 90 seconds, all in the browser. After the deploy lands, open `https://<your-project>.pages.dev/admin` and complete the first-run setup card.

> [!IMPORTANT]
> **If the first build fails with `Authentication error [code: 10000]`**, the auto-generated API token Cloudflare creates for Workers Builds is missing the `Pages:Edit` scope. Fix in 60 seconds:
>
> 1. Create a token at <https://dash.cloudflare.com/profile/api-tokens> with **Account** permissions: Cloudflare Pages:Edit, D1:Edit, Workers R2:Edit, Workers AI:Edit, Workers Scripts:Edit, Account Settings:Read.
> 2. Cloudflare dashboard → Workers & Pages → your project → Settings → Build & deployments → **API token** → paste it.
> 3. Re-trigger the deploy from the Deployments tab.
>
> This is a Cloudflare-side quirk of the Deploy to Cloudflare button, not something the repo can fix — they're aware of it. The CLI installer (Option B below) avoids it entirely because it uses `wrangler login` instead of an API token.

### Option B — One-liner installer

If you'd rather drive `wrangler` yourself, pick whichever runtime you already have:

```bash
# Bash / Zsh
curl -fsSL https://seo.benjaminb.xyz/install/run.sh | bash

# Python
curl -fsSL https://seo.benjaminb.xyz/install/run.py | python3

# Node
curl -fsSL https://seo.benjaminb.xyz/install/run.js | node
```

Prefer a browser flow with no terminal? Open **[seo.benjaminb.xyz/install](https://seo.benjaminb.xyz/install)** and sign in with GitHub.

Either way, the installer will:

1. Check that `wrangler` is installed (offers to install it for you).
2. Run `wrangler login` if needed — opens your browser, no API token to copy.
3. Prompt for your project slug, site name, admin email, and password.
4. Provision a D1 database and an R2 bucket on your Cloudflare account.
5. Download the latest source, patch `wrangler.toml`, run `wrangler pages deploy` (which uploads both the static assets and the Functions bundle — no GitHub linkage needed).
6. Set `SITE_NAME` and `SITE_URL` as Pages environment variables.
7. Open your new site's `/admin` with the credentials baked into the URL hash, so the first-run setup card auto-creates your account.

Total wall-clock time: about 2 minutes. The installer is idempotent — re-run with the same slug if anything fails and it'll pick up from where it stopped. See [`cli/README.md`](./cli/README.md) for details.

> [!TIP]
> The legacy `bash setup.sh` flow also works from a clone (provisions via Wrangler the same way) — see the section below.

### Alternatives

<details>
<summary><b>Browser installer at <a href="https://seo.benjaminb.xyz/install">seo.benjaminb.xyz/install</a></b></summary>

The browser flow uses a Cloudflare API token instead of `wrangler login`. It's another option if you can't run Node locally, but it requires you to authorise the **Cloudflare Workers & Pages GitHub App** on your account once (because the browser flow can't deploy Functions via Direct Upload — Cloudflare's public REST API doesn't expose that yet). The CLI above avoids that step entirely.
</details>

<details>
<summary><b>From a clone with <code>bash setup.sh</code></b></summary>

```bash
git clone https://github.com/Benjamin-Bloch/pages-seo
cd pages-seo
npm install -g wrangler && wrangler login

npm run setup        # or: bash setup.sh / python3 setup.py / node setup.js
```

Resumable — if a step fails, fix the issue and re-run. Delete `.setup-state` to start over.
</details>

After install, the onboarding wizard walks you through Brand DNA → AI providers → 28-day content plan. **Daily automation** is optional — the cron Worker in `cron-worker/` needs `wrangler deploy` once for that, or just hit **Run now** from the admin dashboard whenever you want a fresh post.

## 🗓️ Content calendar

After you save brand DNA, the admin **Content Calendar** auto-plans the next four weeks of articles — one slot per day, each pre-titled and tagged to a target keyword. Slots are colour-coded:

- 🟢 **Published** — already live.
- 🟣 **Generating** — the cron is mid-chain on this slot.
- 🟡 **Draft** — manually edited and held back from publish.
- 🔵 **Scheduled** — queued for its date.

You can drag-add, remove, swap, or rename any slot. The cron picks up "scheduled" slots in date order; manual "Run now" promotes a slot regardless of date.

## 🗓️ Day-to-day

| Action | Where |
|---|---|
| Save / regenerate brand DNA | Admin → Brand DNA |
| Re-plan the content calendar | Admin → Content Calendar → "Regenerate" |
| Run today's blog post manually | Admin → Daily blog → "Run now" |
| Pull keywords from a seed | Admin → Programmatic → "Pull keywords" |
| Queue keywords from CSV | Admin → Programmatic → "Upload CSV" |
| Force the next programmatic page | Admin → Programmatic → "Run next" |
| Ping IndexNow for one URL | Admin → SEO → "Ping IndexNow" |
| Get the embed snippet | Admin → Embeds → pick or create |
| Preview a sample post for your brand | Admin → Daily blog → "Preview sample" (dry-run; no D1 / R2 writes) |

The cron Worker drives the blog chain at **08:00 UTC** and generates a programmatic page at **09:00 UTC**. Edit `cron-worker/wrangler.jsonc` to change the schedule.

## 🔌 Embed your blog anywhere

Two routes, same contract:

```html
<!-- Generic (zero config) -->
<div id="ps-blog"></div>
<script src="https://<your-domain>/widget.js" defer></script>

<!-- Named embed (title, accent, post limit configurable in admin) -->
<div id="ps-blog"></div>
<script src="https://<your-domain>/api/embed/<id>" defer></script>
```

The widget paints cards instantly (article list baked into the response), loads body HTML on demand, supports deep-linking (`?post=<slug>`), and degrades gracefully inside srcdoc iframes (Wix, Webflow, GoDaddy previews).

## 🤖 AI providers

Workers AI is bound automatically and is the default. Every other provider is optional — set its API key as a Pages secret and it joins the fallback chain.

| Provider | Secret | Text | Image |
|---|---|---|---|
| Cloudflare Workers AI | _(binding)_ | ✅ Llama 3.3 70B | ✅ Flux 1 schnell |
| OpenAI | `OPENAI_API_KEY` | ✅ gpt-5 | ✅ gpt-image-1 |
| Anthropic | `ANTHROPIC_API_KEY` | ✅ Claude | — |
| Google Gemini | `GEMINI_API_KEY` | ✅ Gemini 2.5 Pro | ✅ Imagen 4 |
| Groq | `GROQ_API_KEY` | ✅ Llama 3.3 70B | — |
| DeepSeek | `DEEPSEEK_API_KEY` | ✅ deepseek-chat | — |
| Mistral | `MISTRAL_API_KEY` | ✅ mistral-large | — |
| Together AI | `TOGETHER_API_KEY` | ✅ Llama 3.3 70B | — |
| Cerebras | `CEREBRAS_API_KEY` | ✅ Llama 3.3 70B | — |

Override the per-provider model with env vars like `OPENAI_TEXT_MODEL` or `GEMINI_IMAGE_MODEL` — see [`.env.example`](./.env.example).

Adding another OpenAI-compatible provider takes one entry in [`functions/_lib/ai.js`](functions/_lib/ai.js) — copy the `groqText` block and swap the URL / env var.

## 🏗️ Architecture

```
public/                  static landing + admin SPA
functions/               Pages Functions (file-based routing)
├── _lib/                shared helpers (ai, auth, util, topics, links, widget_render)
├── api/admin/...        admin API (session cookie or bearer token)
│   ├── blog/            multi-step blog chain (start/text/image/publish)
│   ├── prog/            programmatic pages (generate-next, pull-keywords, etc.)
│   ├── calendar/        content-calendar planner + slot CRUD
│   ├── embed/           CRUD for named blog embeds
│   └── ...              IndexNow ping, providers list, queue, posts
├── api/embed/[id].js    embed widget bundle (per-embed)
├── widget.js.js         embed widget bundle (generic, zero-config)
├── blog/                public blog index + /blog/<slug>
├── p/[slug].js          public programmatic page
├── sitemap.xml.js       full sitemap
└── feed.xml.js          RSS
cron-worker/             scheduled Worker that calls the admin API
schema/init.sql          D1 schema
setup.{sh,py,js}         identical three-flavour resumable installer
```

### Why a chain instead of one Function?

Pages Functions run in V8 isolates that get killed pretty aggressively when the request returns. Cloudflare's `waitUntil` extends that — but not by enough for an end-to-end "generate text → generate image → upload → publish" run when the model is slow. The chain (`/start` → `/text` → `/image` → `/publish`) persists state in `blog_jobs`, each step is idempotent, and the cron Worker drives the steps one at a time over short HTTP calls.

### Authentication

The admin SPA uses **email + password** with PBKDF2-SHA256 (100k iterations — Cloudflare Workers caps PBKDF2 there) and HMAC-SHA256-signed session cookies (HttpOnly, Secure, SameSite=Lax, 14-day expiry). Login is rate-limited (5 failed attempts per email+IP triggers a 1-hour lockout). The `ADMIN_TOKEN` is kept as a bearer-token recovery path and for the cron Worker.

## 🛠️ Local development

```bash
npm run dev          # local Pages Functions runtime
npm run db:console   # quick D1 query
```

`wrangler dev` proxies the live D1/R2/AI bindings into your local Function runtime so you can test without redeploying.

## 🔄 Re-deploy after code changes

```bash
npm run deploy       # delegates to deploy.sh
```

No resource changes, no secret prompts — just `wrangler pages deploy` + `wrangler deploy` for the cron Worker.

## ❓ FAQ

<details>
<summary><b>How much does this cost to run?</b></summary>

On Cloudflare's free tier: $0 for most hobby use. The free tier covers 100k Pages Function invocations/day, 5GB R2 storage, 5M D1 reads/day, and 10k Workers AI neurons/day (≈ a dozen posts with hero images). LLM API keys are pay-per-use if you opt into them — you can run forever on Workers AI alone.
</details>

<details>
<summary><b>How do I bring my own domain?</b></summary>

In the Cloudflare dashboard: Pages → your project → Custom domains → "Set up a custom domain". The setup script asks for the domain you'll use so the SPA, IndexNow key file, and sitemap reflect the right origin.
</details>

<details>
<summary><b>Can I edit posts after they're generated?</b></summary>

Yes — the admin dashboard has an inline post editor with markdown preview. Edits invalidate the edge cache; the change is live within seconds.
</details>

<details>
<summary><b>Does this work without the cron Worker?</b></summary>

Yes. The cron Worker is just a scheduled HTTP client that hits the admin API. You can trigger every job manually from the dashboard, or call the API from any cron source (GitHub Actions, your own server, etc.).
</details>

<details>
<summary><b>Is the AI-generated content "safe" for SEO?</b></summary>

Google's stance (as of late 2025) is that AI content is fine if it's useful. This toolkit injects your brand DNA, CTA, and keyword targets into every prompt, so output is on-brand and topical rather than generic filler. That said: **read what you publish.** The admin's "Preview sample" lets you dry-run a post for any brand without writing to D1/R2.
</details>

<details>
<summary><b>Where do I report issues?</b></summary>

[GitHub Issues](https://github.com/Benjamin-Bloch/pages-seo/issues) — bug template and feature template included.
</details>

## ⭐ Star history

<a href="https://star-history.com/#Benjamin-Bloch/pages-seo&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Benjamin-Bloch/pages-seo&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Benjamin-Bloch/pages-seo&type=Date" />
    <img alt="Star history for Benjamin-Bloch/pages-seo" src="https://api.star-history.com/svg?repos=Benjamin-Bloch/pages-seo&type=Date" />
  </picture>
</a>

If you find `pages-seo` useful, a star helps it surface to others who'd benefit. There's no analytics on this repo — the only signal I have that this matters to anyone is the count above this line.

## 🤝 Contributing

PRs welcome. See [CONTRIBUTING.md](./.github/CONTRIBUTING.md) for the short version. The codebase is small and entirely framework-free JavaScript — no React, no build step, no transpiler.

## 📜 Licence

MIT — see [LICENCE](./LICENCE).

---

<div align="center">

Built by **[Benjamin Bloch](https://benjaminb.xyz)** · [seo.benjaminb.xyz](https://seo.benjaminb.xyz) is this exact codebase running on its own daily cron.

If `pages-seo` saved you a few hours, [⭐ star the repo](https://github.com/Benjamin-Bloch/pages-seo) — it's the only metric I'm allowed to track.

</div>
