#!/usr/bin/env python3
"""pages-seo · one-shot setup (Python flavour).

Identical flow to setup.sh / setup.js — pick whichever you prefer.

Prereqs:
  - wrangler CLI (`npm install -g wrangler`)
  - logged in (`wrangler login`)
  - python3 (any modern version)

Usage:
  python3 setup.py
"""
from __future__ import annotations

import getpass
import json
import os
import re
import secrets
import subprocess
import sys
from pathlib import Path

# ── helpers ──────────────────────────────────────────────────────────


def say(msg: str) -> None:
    print(f"\033[1;36m▸ {msg}\033[0m")


def warn(msg: str) -> None:
    print(f"\033[1;33m! {msg}\033[0m")


def die(msg: str) -> None:
    print(f"\033[1;31m✗ {msg}\033[0m", file=sys.stderr)
    sys.exit(1)


def ask(prompt: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    value = input(f"  {prompt}{suffix}: ").strip()
    return value or default


def ask_yes(prompt: str, default_yes: bool = True) -> bool:
    suffix = "Y/n" if default_yes else "y/N"
    raw = input(f"  {prompt} ({suffix}): ").strip().lower()
    if not raw:
        return default_yes
    return raw.startswith("y")


def run(cmd: list[str], *, check: bool = True, capture: bool = False, stdin_input: str | None = None) -> subprocess.CompletedProcess:
    """Run a wrangler/etc command. `stdin_input` pipes a string to stdin (for `secret put`)."""
    print(f"    $ {' '.join(cmd)}")
    return subprocess.run(
        cmd,
        check=check,
        text=True,
        capture_output=capture,
        input=stdin_input,
    )


def wrangler_logged_in() -> bool:
    r = subprocess.run(["wrangler", "whoami"], capture_output=True, text=True)
    return r.returncode == 0


def patch_wrangler_toml(*, project: str, db_name: str, db_id: str, bucket: str) -> None:
    """Replace name / database_name / database_id / bucket_name in wrangler.toml."""
    path = Path("wrangler.toml")
    text = path.read_text()
    text = re.sub(r'(name\s*=\s*")[^"]+(")', rf"\g<1>{project}\g<2>", text, count=1)
    text = re.sub(r'(database_name\s*=\s*")[^"]+(")', rf"\g<1>{db_name}\g<2>", text)
    text = re.sub(r'(database_id\s*=\s*")[^"]+(")', rf"\g<1>{db_id}\g<2>", text)
    text = re.sub(r'(bucket_name\s*=\s*")[^"]+(")', rf"\g<1>{bucket}\g<2>", text)
    path.write_text(text)


def resolve_db_id(db_name: str) -> str:
    """Find the D1 UUID for a given database name."""
    r = subprocess.run(["wrangler", "d1", "list", "--json"], capture_output=True, text=True, check=True)
    for row in json.loads(r.stdout):
        if row.get("name") == db_name:
            return row.get("uuid") or row.get("id") or ""
    return ""


def write_env(values: dict[str, str]) -> None:
    """Write a local .env mirror so the operator has the secrets too."""
    lines = [
        "# Local-only mirror of the secrets pushed to Cloudflare. Never commit.",
        *[f"{k}={v}" for k, v in values.items() if v],
    ]
    Path(".env").write_text("\n".join(lines) + "\n")


# ── main ─────────────────────────────────────────────────────────────


def has_cmd(name: str) -> bool:
    return bool(subprocess.run(["which", name], capture_output=True).stdout.strip())


def ensure_wrangler() -> None:
    if has_cmd("wrangler"):
        return
    warn("wrangler CLI not found.")
    if not has_cmd("npm"):
        die("Install Node.js + wrangler (npm install -g wrangler) and re-run.")
    if not ask_yes("Install it now with 'npm install -g wrangler'?", default_yes=True):
        die("Install wrangler (npm install -g wrangler) and re-run.")
    r = subprocess.run(["npm", "install", "-g", "wrangler"])
    if r.returncode != 0:
        die("npm install failed. Install wrangler manually and re-run.")


def ensure_wrangler_logged_in() -> None:
    if wrangler_logged_in():
        return
    warn("wrangler is not logged in to Cloudflare.")
    if not ask_yes("Run 'wrangler login' now?", default_yes=True):
        die("Run 'wrangler login' then re-run setup.")
    # `wrangler login` is interactive and opens a browser — inherit stdio.
    r = subprocess.run(["wrangler", "login"])
    if r.returncode != 0 or not wrangler_logged_in():
        die("wrangler still not logged in. Re-run setup once login completes.")


def main() -> None:
    ensure_wrangler()
    ensure_wrangler_logged_in()

    repo_root = Path(__file__).parent.resolve()
    os.chdir(repo_root)
    if not Path("wrangler.toml").exists():
        die("wrangler.toml not found. Run setup from the repo root.")

    say("pages-seo setup")
    print("  This walks through creating the Cloudflare resources you need.")
    print()

    project = ask("Cloudflare Pages project name", "pages-seo")
    db_name = ask("D1 database name", project)
    bucket = ask("R2 bucket name (for hero images)", f"{project}-images")
    site_name = ask("Site display name (shown in titles)", "pages-seo")
    site_url = ask("Site URL (used in OG tags)", "https://example.com")

    print()
    say("Generating admin + indexnow tokens")
    admin_token = secrets.token_hex(32)
    indexnow_key = secrets.token_hex(32)
    print(f"  ADMIN_TOKEN  (paste this into the admin UI):\n    {admin_token}")
    print(f"  INDEXNOW_KEY (auto-served at /<key>.txt):\n    {indexnow_key}")

    print()
    print("  Workers AI is on by default (free tier covers most usage).")
    print("  Add keys for any other providers you want — leave blank to skip.")
    print()
    optional_providers = [
        ("OPENAI_API_KEY",    "OpenAI API key (gpt-5, gpt-image-1)"),
        ("ANTHROPIC_API_KEY", "Anthropic API key (Claude)"),
        ("GEMINI_API_KEY",    "Google Gemini API key (Gemini + Imagen)"),
        ("GROQ_API_KEY",      "Groq API key (fast Llama)"),
        ("DEEPSEEK_API_KEY",  "DeepSeek API key"),
        ("MISTRAL_API_KEY",   "Mistral API key"),
        ("TOGETHER_API_KEY",  "Together AI API key"),
        ("CEREBRAS_API_KEY",  "Cerebras API key"),
    ]
    provider_keys: dict[str, str] = {}
    for env_name, label in optional_providers:
        val = getpass.getpass(f"  {label} (blank to skip): ").strip()
        if val:
            provider_keys[env_name] = val

    say("Writing .env")
    write_env({
        "SITE_NAME": site_name,
        "SITE_URL": site_url,
        "ADMIN_TOKEN": admin_token,
        "INDEXNOW_KEY": indexnow_key,
        **provider_keys,
    })
    print("  wrote .env (gitignored)")

    say(f'Creating D1 database "{db_name}"')
    existing = subprocess.run(["wrangler", "d1", "list", "--json"], capture_output=True, text=True)
    if existing.returncode == 0 and any(r.get("name") == db_name for r in json.loads(existing.stdout or "[]")):
        warn(f"D1 database {db_name} already exists — skipping create")
    else:
        run(["wrangler", "d1", "create", db_name])
    db_id = resolve_db_id(db_name)
    if not db_id:
        die(f"Could not resolve D1 ID for {db_name}")
    print(f"  database_id: {db_id}")

    say(f'Creating R2 bucket "{bucket}"')
    r = subprocess.run(["wrangler", "r2", "bucket", "create", bucket], capture_output=True, text=True)
    if r.returncode and "already exists" not in (r.stderr + r.stdout):
        warn(r.stderr.strip() or r.stdout.strip())

    say("Patching wrangler.toml with your resource names")
    patch_wrangler_toml(project=project, db_name=db_name, db_id=db_id, bucket=bucket)
    print("  wrangler.toml updated")

    say("Applying schema/init.sql")
    run(["wrangler", "d1", "execute", db_name, "--remote", "--file=schema/init.sql"])

    say(f'Pushing secrets to Pages project "{project}"')
    secrets_to_push = [
        ("ADMIN_TOKEN", admin_token),
        ("INDEXNOW_KEY", indexnow_key),
        ("SITE_NAME", site_name),
        ("SITE_URL", site_url),
        *provider_keys.items(),
    ]
    for key, val in secrets_to_push:
        if not val:
            continue
        run(["wrangler", "pages", "secret", "put", key, f"--project-name={project}"], stdin_input=val)

    say("Deploying Pages site")
    run(["wrangler", "pages", "deploy", "public", f"--project-name={project}", "--commit-dirty=true"])

    print()
    if ask_yes("Deploy the cron Worker now?", default_yes=True):
        say("Deploying cron Worker")
        host = re.sub(r"^https?://", "", site_url).split("/")[0]
        cron_dir = repo_root / "cron-worker"
        os.chdir(cron_dir)
        run(["wrangler", "secret", "put", "ADMIN_TOKEN"], stdin_input=admin_token)
        run(["wrangler", "secret", "put", "BLOG_URL"], stdin_input=f"https://{host}/api/admin/blog")
        run(["wrangler", "secret", "put", "PROG_URL"], stdin_input=f"https://{host}/api/admin/prog/generate-next")
        run(["wrangler", "deploy"])
        os.chdir(repo_root)

    print()
    say("Done.")
    print(f"  Admin: {site_url}/admin")
    print(f"  Token: {admin_token}")
    print("  (Token also saved in .env)")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print()
        die("Cancelled.")
