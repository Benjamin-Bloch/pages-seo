# pages-seo-install

One-command CLI installer for [pages-seo](https://github.com/Benjamin-Bloch/pages-seo).

## Usage

Run the installer straight from the live site (no npm publish needed) — pick the runtime you have:

```bash
curl -fsSL https://seo.benjaminb.xyz/install/run.sh | bash    # Bash / Zsh
curl -fsSL https://seo.benjaminb.xyz/install/run.py | python3 # Python
curl -fsSL https://seo.benjaminb.xyz/install/run.js | node    # Node
```

That's it. The script will:

1. Check that `wrangler` is installed (offers to install it for you).
2. Run `wrangler login` if you're not already logged in to Cloudflare (opens your browser; no token to copy).
3. Prompt for your project slug, site name, admin email, and password.
4. Provision a D1 database and R2 bucket on your Cloudflare account.
5. Download the latest `pages-seo` source, patch `wrangler.toml`, and run `wrangler pages deploy` — uploading both the static assets and the Functions bundle.
6. Set `SITE_NAME` and `SITE_URL` as Pages environment variables.
7. Open your new site's `/admin` with the credentials baked into the URL hash, so the first-run setup card auto-creates your account.

Total time: ~2 minutes including the wrangler login.

## Why a CLI?

Cloudflare's public REST API doesn't currently support uploading a Pages Functions bundle — that's the bit that powers the admin dashboard and the API in this project. The only documented path that supports Functions is `wrangler pages deploy`, which is a local tool. So this CLI is the honest, working version of "one-click install."

If Cloudflare ever ships a public Functions Direct-Upload API, we can move the whole flow to a browser installer and delete this package.

## Requirements

- Node 20 or newer
- A Cloudflare account (free tier is fine)
- macOS, Linux, or WSL on Windows (PowerShell hasn't been tested)

## Re-running

The installer is idempotent. If something fails partway through, run it again with the same project slug — it'll skip the resources that already exist and pick up from the failed step.

## Licence

MIT — see [LICENCE](../LICENCE).
