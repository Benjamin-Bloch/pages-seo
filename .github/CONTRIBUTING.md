# Contributing to pages-seo

PRs and issues welcome. The codebase is small and entirely framework-free JavaScript — no React, no build step, no transpiler — so the barrier to a useful patch is low.

## Quick rules

1. **No build step.** Everything in `functions/` and `public/` is read by Cloudflare Pages as-is. No bundlers, no preprocessors, no transpilers.
2. **No frameworks in the admin SPA.** Vanilla JS only. The dashboard is ~2k lines and that's deliberate — it stays readable for ops people.
3. **D1 changes go in `schema/init.sql`.** If you add a table or index, append it to that file and mention it in the PR description so existing operators know to run the migration.
4. **Don't add new dependencies casually.** `package.json` has zero runtime deps — let's keep it that way unless there's a really good reason.

## Local dev

```bash
git clone https://github.com/Benjamin-Bloch/pages-seo
cd pages-seo
npm install -g wrangler && wrangler login
bash setup.sh                # one-time provisioning
npm run dev                  # local Pages Functions runtime
```

`wrangler dev` proxies your real D1/R2/AI bindings into the local runtime, so you can iterate without redeploying.

## Filing a good issue

- **Bug?** Use the bug template. Include the commit SHA (footer of `/admin`) and any relevant log output.
- **Feature?** Use the feature template. Lead with the problem, not the solution.

## Style

- Comments are for the **why**, not the what. The code already tells you what.
- One change per PR. Easier to review, easier to revert.
- Tabs vs spaces: spaces, two of them.

## Things I'd love help with

- Wider AI-provider coverage (Vertex, Bedrock, Inflection, Perplexity).
- Better i18n hooks (the prompts are English-only right now).
- A Webflow / Wix install guide for non-technical operators.

Thanks for being here.
