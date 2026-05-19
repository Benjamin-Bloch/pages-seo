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

## 🚀 5-minute setup

```bash
git clone https://github.com/Benjamin-Bloch/pages-seo
cd pages-seo
npm install -g wrangler && wrangler login

# pick one — they all do the same thing
npm run setup        # delegates to bash setup.sh
# or:  bash setup.sh
# or:  python3 setup.py
# or:  node setup.js
```

The setup script:

1. Asks for a project name, site URL, admin email + password, and which AI providers you want to enable.
2. Generates an `ADMIN_TOKEN` (recovery) + `INDEXNOW_KEY`.
3. Creates the D1 database and R2 bucket.
4. Patches `wrangler.toml` with your resource IDs.
5. Applies the schema and seeds the admin user (PBKDF2-SHA256, 100k iterations).
6. Pushes every secret to Cloudflare.
7. Deploys the Pages site.
8. Optionally deploys the cron Worker.

When it finishes, open `https://<your-domain>/admin`, log in, and you're done.

> [!TIP]
> The script is **resumable** — if a step fails (network, auth, quota), fix the underlying issue and re-run. Already-done steps are skipped. Delete `.setup-state` to start over.

### One-click deploy (Cloudflare)

Prefer to skip the CLI? Three clicks gets you live:

1. **Fork the repo** → click [Use this template](https://github.com/Benjamin-Bloch/pages-seo/generate) or fork normally.
2. **Connect to Cloudflare Pages** — in the Cloudflare dashboard go to **Workers & Pages → Create → Pages → Connect to Git**, pick your fork, and accept the defaults (`pages_build_output_dir` is read from `wrangler.toml`).
3. **Create the bindings** when prompted: a **D1 database** named `pages-seo`, an **R2 bucket** named `pages-seo-images`, and the **Workers AI** binding. Save and deploy.

Open `https://<your-pages-domain>/admin` and the first-run setup card walks you through:
- picking an admin email + password,
- entering your site name + URL,
- which auto-applies the schema, generates `ADMIN_TOKEN` and `INDEXNOW_KEY`, and seeds the first user — no SQL, no `wrangler pages secret put`.

After that, the onboarding wizard takes over and walks you through Brand DNA → AI providers → 28-day content plan.

**Daily automation** (optional): the cron Worker that drives the daily blog still lives in `cron-worker/` and needs `wrangler deploy` once. You can also just hit **"Run now"** from the admin dashboard until you're ready to automate.

## 🗓️ Content calendar

After you save brand DNA, the admin **Content Calendar** auto-plans the next four weeks of articles — one slot per day, each pre-titled and tagged to a target keyword. Slots are colour-coded:

- 🟢 **Published** — already live.
- 🟣 **Generating** — the cron is mid-chain on this slot.
- 🟡 **Draft** — manually edited and held back from publish.
- 🔵 **Scheduled** — queued for its date.

You can drag-add, remove, swap, or rename any slot. The cron picks up "scheduled" slots in date order; manual "Run now" promotes a slot regardless of date.

## 🖼️ Screenshots

<div align="center">

| Landing | Blog post | Admin · Content Calendar |
|---|---|---|
| [![landing](https://seo.benjaminb.xyz/og.png)](https://seo.benjaminb.xyz) | [![post](https://seo.benjaminb.xyz/og.png)](https://seo.benjaminb.xyz/blog) | [![admin](https://seo.benjaminb.xyz/og.png)](https://seo.benjaminb.xyz/admin) |

</div>

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

## 🤝 Contributing

PRs welcome. See [CONTRIBUTING.md](./.github/CONTRIBUTING.md) for the short version. The codebase is small and entirely framework-free JavaScript — no React, no build step, no transpiler.

## 📜 Licence

MIT — see [LICENCE](./LICENCE).

---

<div align="center">

Built by **[Benjamin Bloch](https://benjaminb.xyz)** · [seo.benjaminb.xyz](https://seo.benjaminb.xyz) is this exact codebase running on its own daily cron.

If `pages-seo` saved you a few hours, [⭐ star the repo](https://github.com/Benjamin-Bloch/pages-seo) — it's the only metric I'm allowed to track.

</div>
