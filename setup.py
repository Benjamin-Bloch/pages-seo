#!/usr/bin/env python3
"""pages-seo · one-shot setup (Python flavour, resumable).

Writes progress to .setup-state after each step. Re-running this script
picks up where it left off — fix the underlying failure (network, auth,
quota), then `python3 setup.py` again. To start over, delete
.setup-state.

Prereqs:
  - wrangler CLI (`npm install -g wrangler` — script offers to install)
  - logged in (`wrangler login` — script offers to run it)
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

STATE_FILE = Path(".setup-state")

# ── output helpers ──────────────────────────────────────────────────


def say(msg: str)  -> None: print(f"\033[1;36m▸\033[0m \033[1m{msg}\033[0m")
def ok(msg: str)   -> None: print(f"  \033[1;32m✓\033[0m {msg}")
def warn(msg: str) -> None: print(f"  \033[1;33m!\033[0m {msg}")
def die(msg: str)  -> None:
    print(f"\033[1;31m✗ {msg}\033[0m", file=sys.stderr)
    sys.exit(1)


def banner() -> None:
    print()
    print("\033[1;36m╭──────────────────────────────────────────────╮\033[0m")
    print("\033[1;36m│\033[0m  \033[1mpages-seo · install\033[0m                       \033[1;36m│\033[0m")
    print("\033[1;36m│\033[0m  \033[2mone-shot resumable setup for Cloudflare\033[0m    \033[1;36m│\033[0m")
    print("\033[1;36m╰──────────────────────────────────────────────╯\033[0m")
    print()


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


def run(cmd: list[str], *, stdin_input: str | None = None) -> None:
    print(f"    $ {' '.join(cmd)}")
    r = subprocess.run(cmd, text=True, input=stdin_input)
    if r.returncode != 0:
        die(f"command failed (exit {r.returncode}): {' '.join(cmd)}")


def capture(cmd: list[str]) -> tuple[int, str, str]:
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.returncode, r.stdout or "", r.stderr or ""


# ── state management ────────────────────────────────────────────────


def load_state() -> dict[str, str]:
    if not STATE_FILE.exists():
        return {}
    out: dict[str, str] = {}
    for line in STATE_FILE.read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, _, v = line.partition("=")
            out[k.strip()] = v
    return out


def save_kv(state: dict[str, str], key: str, val: str) -> None:
    state[key] = val
    STATE_FILE.write_text("\n".join(f"{k}={v}" for k, v in state.items()) + "\n")


def mark_done(state: dict[str, str], step: str) -> None:
    save_kv(state, f"STEP_{step}", "done")


def is_done(state: dict[str, str], step: str) -> bool:
    return state.get(f"STEP_{step}") == "done"


# ── wrangler helpers ────────────────────────────────────────────────


def has_cmd(name: str) -> bool:
    return capture(["which", name])[0] == 0


def wrangler_logged_in() -> bool:
    return capture(["wrangler", "whoami"])[0] == 0


def ensure_wrangler() -> None:
    if has_cmd("wrangler"):
        return
    warn("wrangler CLI not found.")
    if not has_cmd("npm"):
        die("Install Node.js + wrangler (npm install -g wrangler) and re-run.")
    if not ask_yes("Install it now with 'npm install -g wrangler'?", True):
        die("Install wrangler (npm install -g wrangler) and re-run.")
    if subprocess.run(["npm", "install", "-g", "wrangler"]).returncode != 0:
        die("npm install failed.")


def ensure_wrangler_logged_in() -> None:
    if wrangler_logged_in():
        return
    warn("wrangler is not logged in to Cloudflare.")
    if not ask_yes("Run 'wrangler login' now?", True):
        die("Run 'wrangler login' then re-run setup.")
    subprocess.run(["wrangler", "login"])
    if not wrangler_logged_in():
        die("wrangler still not logged in.")


def resolve_db_id(db_name: str) -> str:
    code, out, _ = capture(["wrangler", "d1", "list", "--json"])
    if code != 0:
        return ""
    try:
        rows = json.loads(out)
    except json.JSONDecodeError:
        return ""
    for row in rows or []:
        if row.get("name") == db_name:
            return row.get("uuid") or row.get("database_id") or row.get("id") or ""
    return ""


def patch_wrangler_toml(*, project: str, db_name: str, db_id: str, bucket: str) -> None:
    path = Path("wrangler.toml")
    text = path.read_text()
    text = re.sub(r'(name\s*=\s*")[^"]+(")', rf"\g<1>{project}\g<2>", text, count=1)
    text = re.sub(r'(database_name\s*=\s*")[^"]+(")', rf"\g<1>{db_name}\g<2>", text)
    text = re.sub(r'(database_id\s*=\s*")[^"]+(")', rf"\g<1>{db_id}\g<2>", text)
    text = re.sub(r'(bucket_name\s*=\s*")[^"]+(")', rf"\g<1>{bucket}\g<2>", text)
    path.write_text(text)


def write_env(values: dict[str, str]) -> None:
    lines = [
        "# Local-only mirror of the secrets pushed to Cloudflare. Never commit.",
        *[f"{k}={v}" for k, v in values.items() if v],
    ]
    Path(".env").write_text("\n".join(lines) + "\n")


def push_secret(name: str, val: str, project: str) -> None:
    if not val:
        return
    run(["wrangler", "pages", "secret", "put", name, f"--project-name={project}"], stdin_input=val)


# ── main ────────────────────────────────────────────────────────────


PROVIDER_PROMPTS = [
    ("OPENAI_API_KEY",    "OpenAI API key (gpt-5, gpt-image-1)"),
    ("ANTHROPIC_API_KEY", "Anthropic API key (Claude)"),
    ("GEMINI_API_KEY",    "Google Gemini API key (Gemini + Imagen)"),
    ("GROQ_API_KEY",      "Groq API key"),
    ("DEEPSEEK_API_KEY",  "DeepSeek API key"),
    ("MISTRAL_API_KEY",   "Mistral API key"),
    ("TOGETHER_API_KEY",  "Together AI API key"),
    ("CEREBRAS_API_KEY",  "Cerebras API key"),
]


def main() -> None:
    ensure_wrangler()
    ensure_wrangler_logged_in()

    repo_root = Path(__file__).parent.resolve()
    os.chdir(repo_root)
    if not Path("wrangler.toml").exists():
        die("wrangler.toml not found. Run setup from the repo root.")

    banner()
    state = load_state()
    if state:
        print("  \033[2mResuming from .setup-state. Delete it to start over.\033[0m\n")
    else:
        print("  \033[2mWalking through the full setup. Each step is resumable\033[0m")
        print("  \033[2mif it fails — just re-run `python3 setup.py`.\033[0m\n")

    # 1. inputs ----------------------------------------------------------
    if not is_done(state, "INPUTS"):
        project = ask("Cloudflare Pages project name", state.get("PROJECT_NAME", "pages-seo"))
        db_name = ask("D1 database name", state.get("DB_NAME", project))
        bucket  = ask("R2 bucket name (for hero images)", state.get("BUCKET_NAME", f"{project}-images"))
        site_name = ask("Site display name (shown in titles)", state.get("SITE_NAME", "pages-seo"))
        site_url  = ask("Site URL (used in OG tags)", state.get("SITE_URL", f"https://{project}.pages.dev"))
        for k, v in [("PROJECT_NAME", project), ("DB_NAME", db_name), ("BUCKET_NAME", bucket),
                     ("SITE_NAME", site_name), ("SITE_URL", site_url)]:
            save_kv(state, k, v)
        mark_done(state, "INPUTS")
    else:
        ok(f"inputs (project={state['PROJECT_NAME']}, db={state['DB_NAME']}, site={state['SITE_URL']})")

    project = state["PROJECT_NAME"]
    db_name = state["DB_NAME"]
    bucket  = state["BUCKET_NAME"]
    site_name = state["SITE_NAME"]
    site_url  = state["SITE_URL"]

    # 2. tokens ----------------------------------------------------------
    if not is_done(state, "TOKENS"):
        say("Generating admin + indexnow tokens")
        admin_token  = secrets.token_hex(32)
        indexnow_key = secrets.token_hex(32)
        save_kv(state, "ADMIN_TOKEN",  admin_token)
        save_kv(state, "INDEXNOW_KEY", indexnow_key)
        print(f"  ADMIN_TOKEN  (paste into admin UI):  {admin_token}")
        print(f"  INDEXNOW_KEY (served at /<key>.txt): {indexnow_key}")
        mark_done(state, "TOKENS")
    else:
        ok("tokens")
    admin_token  = state["ADMIN_TOKEN"]
    indexnow_key = state["INDEXNOW_KEY"]

    # 3. optional provider keys -----------------------------------------
    if not is_done(state, "PROVIDERS"):
        print()
        print("  Workers AI is on by default. Add keys for other providers if you want")
        print("  them in the fallback chain. Leave blank to skip.")
        print()
        for env_name, label in PROVIDER_PROMPTS:
            val = getpass.getpass(f"  {label} (blank to skip): ").strip()
            if val:
                save_kv(state, env_name, val)
        mark_done(state, "PROVIDERS")
    else:
        ok("provider keys")

    provider_keys = {k: state[k] for k, _ in PROVIDER_PROMPTS if k in state}

    # 4. .env mirror -----------------------------------------------------
    if not is_done(state, "ENV"):
        say("Writing .env")
        write_env({
            "SITE_NAME": site_name,
            "SITE_URL": site_url,
            "ADMIN_TOKEN": admin_token,
            "INDEXNOW_KEY": indexnow_key,
            **provider_keys,
        })
        mark_done(state, "ENV")
    else:
        ok(".env")

    # 5. D1 --------------------------------------------------------------
    if not is_done(state, "D1"):
        say(f'Creating D1 database "{db_name}"')
        existing = resolve_db_id(db_name)
        if existing:
            warn(f"D1 database {db_name} already exists — using it")
            db_id = existing
        else:
            run(["wrangler", "d1", "create", db_name])
            db_id = resolve_db_id(db_name)
        if not db_id:
            die(f"Could not resolve D1 ID for {db_name}")
        save_kv(state, "DB_ID", db_id)
        print(f"  database_id: {db_id}")
        mark_done(state, "D1")
    else:
        ok(f"D1 ({state['DB_ID']})")
    db_id = state["DB_ID"]

    # 6. R2 --------------------------------------------------------------
    if not is_done(state, "R2"):
        say(f'Creating R2 bucket "{bucket}"')
        code, out, err = capture(["wrangler", "r2", "bucket", "create", bucket])
        combined = (out + err)
        if code != 0 and "already exists" not in combined:
            die(combined.strip() or "r2 bucket create failed")
        if "already exists" in combined:
            warn("R2 bucket already exists — using it")
        mark_done(state, "R2")
    else:
        ok("R2 bucket")

    # 7. patch wrangler.toml --------------------------------------------
    if not is_done(state, "TOML"):
        say("Patching wrangler.toml")
        patch_wrangler_toml(project=project, db_name=db_name, db_id=db_id, bucket=bucket)
        print("  wrangler.toml updated")
        mark_done(state, "TOML")
    else:
        ok("wrangler.toml")

    # 8. Pages project ---------------------------------------------------
    if not is_done(state, "PROJECT"):
        say(f'Ensuring Pages project "{project}" exists')
        code, out, _ = capture(["wrangler", "pages", "project", "list"])
        names = {line.split()[1] for line in (out or "").splitlines() if len(line.split()) >= 2}
        if project in names:
            warn("project already exists")
        else:
            run(["wrangler", "pages", "project", "create", project, "--production-branch=main"])
        mark_done(state, "PROJECT")
    else:
        ok("Pages project")

    # 9. schema ---------------------------------------------------------
    if not is_done(state, "SCHEMA"):
        say("Applying schema/init.sql")
        run(["wrangler", "d1", "execute", db_name, "--remote", "--file=schema/init.sql"])
        mark_done(state, "SCHEMA")
    else:
        ok("schema applied")

    # 10. secrets -------------------------------------------------------
    if not is_done(state, "SECRETS"):
        say(f'Pushing secrets to Pages project "{project}"')
        push_secret("ADMIN_TOKEN", admin_token, project)
        push_secret("INDEXNOW_KEY", indexnow_key, project)
        push_secret("SITE_NAME", site_name, project)
        push_secret("SITE_URL", site_url, project)
        for k, v in provider_keys.items():
            push_secret(k, v, project)
        mark_done(state, "SECRETS")
    else:
        ok("secrets pushed")

    # 11. deploy Pages --------------------------------------------------
    if not is_done(state, "DEPLOY"):
        say("Deploying Pages site")
        run(["wrangler", "pages", "deploy", "public", f"--project-name={project}", "--commit-dirty=true"])
        mark_done(state, "DEPLOY")
    else:
        ok("Pages deployed")

    # 12. deploy cron Worker --------------------------------------------
    if not is_done(state, "CRON"):
        print()
        if ask_yes("Deploy the cron Worker now?", True):
            say("Deploying cron Worker")
            host = re.sub(r"^https?://", "", site_url).split("/")[0]
            cron_dir = repo_root / "cron-worker"
            os.chdir(cron_dir)
            run(["wrangler", "secret", "put", "ADMIN_TOKEN"], stdin_input=admin_token)
            run(["wrangler", "secret", "put", "BLOG_URL"],    stdin_input=f"https://{host}/api/admin/blog")
            run(["wrangler", "secret", "put", "PROG_URL"],    stdin_input=f"https://{host}/api/admin/prog/generate-next")
            run(["wrangler", "deploy"])
            os.chdir(repo_root)
        mark_done(state, "CRON")
    else:
        ok("cron Worker")

    print()
    print("\033[1;32m╭──────────────────────────────────────────────╮\033[0m")
    print("\033[1;32m│\033[0m  \033[1m✓ All done\033[0m                                  \033[1;32m│\033[0m")
    print("\033[1;32m╰──────────────────────────────────────────────╯\033[0m\n")
    print(f"  Admin URL  \033[1m{site_url}/admin\033[0m")
    print(f"  Token      \033[2m{admin_token}\033[0m")
    print(f"  State      \033[2m{STATE_FILE} (delete to re-run from scratch)\033[0m\n")
    print("  \033[2mNext: open the admin URL, paste the token, then go to\033[0m")
    print("  \033[2mthe \033[0m\033[1mSettings\033[0m\033[2m tab and configure your brand voice.\033[0m\n")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print()
        die("Cancelled.")
