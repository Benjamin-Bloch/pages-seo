# pages-seo

> A self-hosted programmatic-SEO + daily-blog toolkit that runs entirely on Cloudflare Pages, D1, R2 and Workers AI. Free tier covers a lot.

Plug in a keyword list (or pull keywords automatically), schedule the cron Worker, and `pages-seo` quietly generates programmatic landing pages and a daily blog post — each with a hero image — and pings IndexNow so Bing/Yandex/Seznam crawl them within minutes.

Optional: drop in keys for any combination of **OpenAI · Anthropic · Gemini · Groq · DeepSeek · Mistral · Together · Cerebras** and they're tried as fallbacks behind Workers AI.

## Features

- **Programmatic SEO pages** — one URL per keyword, AI-written, served from D1 with edge caching.
- **Daily blog** — multi-step generation chain (start → text → image → publish) that survives Pages Functions' aggressive isolate kills.
- **Hero images** — Workers AI (Flux) by default; OpenAI / Gemini Imagen as fallback.
- **Keyword puller** — free Google Autocomplete-based seed expansion, queues straight into `prog_keywords`.
- **Sitemap + IndexNow** — automatic XML sitemap, on-publish IndexNow pings, robots.txt.
- **Embeddable widget** — drop a `<script>` on any site to render your latest posts.
- **Admin dashboard** — single-page, Bearer-token gated, runs jobs and inspects the queue.
- **Link aliases + sanitiser** — generated markdown gets cleaned and `(signup)` style aliases expand to real URLs.
- **Multi-AI registry** — Workers AI → OpenAI → Anthropic → Gemini → Groq → DeepSeek → Mistral → Together → Cerebras. Each provider is optional.

## 5-minute setup

```bash
git clone https://github.com/Benjamin-Bloch/pages-seo
cd pages-seo
npm install -g wrangler && wrangler login

# pick one — they do the same thing
bash setup.sh
# or:  python3 setup.py
# or:  node setup.js
```

The setup script:

1. Asks for a project name, site URL, and which AI providers you want to enable.
2. Generates an `ADMIN_TOKEN` + `INDEXNOW_KEY`.
3. Creates the D1 database and R2 bucket.
4. Patches `wrangler.toml` with your resource IDs.
5. Applies the schema.
6. Pushes every secret to Cloudflare.
7. Deploys the Pages site.
8. Optionally deploys the cron Worker.

When it's done, open `https://<your-domain>/admin`, paste the `ADMIN_TOKEN`, and you're in.

## Day-to-day

| Action | Where |
|---|---|
| Run today's blog post manually | Admin → Daily blog → "Run now" |
| Pull keywords from a seed | Admin → Programmatic → "Pull keywords" |
| Queue keywords from CSV | Admin → Programmatic → "Upload CSV" |
| Force the next programmatic page | Admin → Programmatic → "Run next" |
| Ping IndexNow for one URL | Admin → SEO → "Ping IndexNow" |
| Get the embed snippet | Admin → SEO → "Widget snippet" |
| Preview a sample post for your brand | `POST /api/admin/preview-sample` (dry-run; no D1 / R2 writes) |

The cron Worker runs the blog chain at 08:00 UTC, retries at 10/14/18:00 (resume-only), and generates programmatic pages at 09:00 UTC. Edit `cron-worker/wrangler.jsonc` to change the schedule.

## AI providers

Workers AI is bound automatically and is the default. Every other provider is optional — set its API key as a Pages secret and it joins the fallback chain.

| Provider | Secret | Text | Image |
|---|---|---|---|
| Cloudflare Workers AI | (binding) | ✅ | ✅ |
| OpenAI | `OPENAI_API_KEY` | ✅ (gpt-5) | ✅ (gpt-image-1) |
| Anthropic | `ANTHROPIC_API_KEY` | ✅ (Claude) | — |
| Google Gemini | `GEMINI_API_KEY` | ✅ | ✅ (Imagen) |
| Groq | `GROQ_API_KEY` | ✅ | — |
| DeepSeek | `DEEPSEEK_API_KEY` | ✅ | — |
| Mistral | `MISTRAL_API_KEY` | ✅ | — |
| Together AI | `TOGETHER_API_KEY` | ✅ | — |
| Cerebras | `CEREBRAS_API_KEY` | ✅ | — |

You can override the per-provider model with env vars like `OPENAI_TEXT_MODEL` or `GEMINI_IMAGE_MODEL` — see `.env.example`.

Adding another OpenAI-compatible provider takes one entry in `functions/_lib/ai.js` — copy the `groqText` block and swap the URL / env var.

## Architecture

```
public/                  static landing + admin SPA
functions/               Pages Functions (file-based routing)
├── _lib/                shared helpers (ai, auth, util, topics, links)
├── api/admin/...        admin API (token-gated)
│   ├── blog/            multi-step blog chain (start/text/image/publish)
│   ├── prog/            programmatic pages (generate-next, pull-keywords, etc.)
│   └── ...              IndexNow ping, providers list, queue, posts
├── blog/[slug].js       public blog post
├── p/[slug].js          public programmatic page
├── sitemap.xml.js       full sitemap
└── feed.xml.js          RSS
cron-worker/             scheduled Worker that calls the admin API
schema/init.sql          D1 schema (6 tables)
setup.{sh,py,js}         identical three-flavour installer
```

### Why a chain instead of one Function?

Pages Functions run in V8 isolates that get killed pretty aggressively when the request returns. Cloudflare's `waitUntil` extends that — but not by enough for an end-to-end "generate text → generate image → upload → publish" run when the model is slow. The chain (`/start` → `/text` → `/image` → `/publish`) persists state in `blog_jobs`, each step is idempotent, and the cron Worker drives the steps one at a time over short HTTP calls.

## Local development

```bash
npm run dev        # local Pages Functions runtime
npm run db:console # interactive D1 shell
```

`wrangler dev` proxies the live D1/R2/AI bindings into your local Function runtime so you can test without redeploying.

## Re-deploy after code changes

```bash
bash deploy.sh
```

No resource changes, no secret prompts — just `wrangler pages deploy` + `wrangler deploy` for the cron Worker.

## Licence

MIT — see [LICENCE](./LICENCE).
