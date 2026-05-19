#!/usr/bin/env python3
# pages-seo terminal installer (Python flavour).
#
# Downloaded and piped from https://seo.benjaminb.xyz/install/run.py.
# Functionally equivalent to run.sh — same provisioning logic
# (D1 + R2 + Pages deploy) wrapped in Python so people who prefer
# Python have a familiar runtime.

import getpass
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from base64 import urlsafe_b64encode

C = {
    'reset': '\033[0m', 'dim': '\033[2m', 'bold': '\033[1m',
    'cyan': '\033[36m', 'green': '\033[32m', 'red': '\033[31m', 'yellow': '\033[33m',
}

def say(s):  print(f"{C['cyan']}▸{C['reset']} {C['bold']}{s}{C['reset']}")
def ok(s):   print(f"  {C['green']}✓{C['reset']} {s}")
def warn(s): print(f"  {C['yellow']}!{C['reset']} {s}")
def die(s):  print(f"{C['red']}✗ {s}{C['reset']}"); sys.exit(1)

def banner():
    print()
    print(f"{C['cyan']}╭──────────────────────────────────────────────╮{C['reset']}")
    print(f"{C['cyan']}│{C['reset']}  {C['bold']}pages-seo · install{C['reset']}                       {C['cyan']}│{C['reset']}")
    print(f"{C['cyan']}│{C['reset']}  {C['dim']}one command, no GitHub App, no SQL{C['reset']}         {C['cyan']}│{C['reset']}")
    print(f"{C['cyan']}╰──────────────────────────────────────────────╯{C['reset']}")
    print()

# ── shell glue ─────────────────────────────────────────────────────
# Always pass args as a list, never a shell string, so user values
# can't escape into a shell.
def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)

def run_inherit(cmd, **kw):
    return subprocess.run(cmd, **kw)

# ── wrangler ───────────────────────────────────────────────────────
def have(bin_):
    return shutil.which(bin_) is not None

def ensure_wrangler():
    if have('wrangler'):
        ok('wrangler installed')
        return
    warn('wrangler not found on PATH.')
    if not have('npm'):
        die('wrangler not found and npm isn\'t installed either. Install Node (https://nodejs.org), then `npm install -g wrangler` and re-run.')
    answer = input('  Install it now with `npm install -g wrangler`? (Y/n) ').strip().lower()
    if answer and answer not in ('y', 'yes'):
        die('Install wrangler and re-run: npm install -g wrangler')
    r = run_inherit(['npm', 'install', '-g', 'wrangler'])
    if r.returncode != 0:
        die('npm install -g wrangler failed.')

def ensure_login():
    r = run(['wrangler', 'whoami'])
    if r.returncode == 0 and re.search(r'[a-f0-9]{32}', (r.stdout or '') + (r.stderr or '')):
        ok('logged in to Cloudflare')
        return
    warn('Not logged in to Cloudflare.')
    print('  Running `wrangler login` — your browser will open.')
    r = run_inherit(['wrangler', 'login'])
    if r.returncode != 0:
        die('wrangler login failed.')
    ok('logged in to Cloudflare')

# ── resources ──────────────────────────────────────────────────────
def ensure_d1(name):
    r = run(['wrangler', 'd1', 'list', '--json'])
    if r.returncode == 0:
        try:
            m = re.search(r'\[[\s\S]*\]', r.stdout or '')
            if m:
                rows = json.loads(m.group(0))
                for row in rows:
                    if row.get('name') == name:
                        d1_id = row.get('uuid') or row.get('database_id')
                        ok(f'reusing existing D1 "{name}" ({d1_id})')
                        return d1_id
        except Exception:
            pass
    print(f'  creating D1 database "{name}"…')
    r = run(['wrangler', 'd1', 'create', name])
    all_out = (r.stdout or '') + (r.stderr or '')
    if r.returncode != 0:
        die('D1 create failed:\n' + all_out)
    m = re.search(r'database_id\s*=\s*"([0-9a-f-]{36})"', all_out)
    if not m:
        die('Could not parse database_id from wrangler output:\n' + all_out)
    ok(f'created D1 "{name}" ({m.group(1)})')
    return m.group(1)

def ensure_r2(name):
    print(f'  creating R2 bucket "{name}"…')
    r = run(['wrangler', 'r2', 'bucket', 'create', name])
    all_out = (r.stdout or '') + (r.stderr or '')
    if r.returncode == 0:
        ok(f'created R2 bucket "{name}"')
        return
    if 'already exists' in all_out.lower():
        ok(f'reusing existing R2 bucket "{name}"')
        return
    die('R2 create failed:\n' + all_out)

# ── source + patch + deploy ────────────────────────────────────────
TARBALL = 'https://github.com/Benjamin-Bloch/pages-seo/archive/refs/heads/main.tar.gz'

def fetch_source(workdir):
    tar = os.path.join(workdir, 'src.tar.gz')
    print('  downloading pages-seo source…')
    try:
        urllib.request.urlretrieve(TARBALL, tar)
    except Exception as e:
        die(f'Failed to download source: {e}')
    r = run_inherit(['tar', '-xzf', tar, '-C', workdir, '--strip-components=1'])
    if r.returncode != 0:
        die('Failed to extract source archive.')
    ok('source extracted')

def patch_toml(workdir, project, d1_id, r2_name):
    path = os.path.join(workdir, 'wrangler.toml')
    with open(path, 'r', encoding='utf-8') as f:
        toml = f.read()
    toml = re.sub(r'^name\s*=\s*".*"',          f'name = "{project}"',          toml, flags=re.M)
    toml = re.sub(r'database_name\s*=\s*".*"',  f'database_name = "{project}"', toml, flags=re.M)
    toml = re.sub(r'database_id\s*=\s*".*"',    f'database_id = "{d1_id}"',     toml, flags=re.M)
    toml = re.sub(r'bucket_name\s*=\s*".*"',    f'bucket_name = "{r2_name}"',   toml, flags=re.M)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(toml)
    ok('wrangler.toml patched')

def deploy(workdir, project):
    print(f'  creating Pages project "{project}"…')
    r = run(['wrangler', 'pages', 'project', 'create', project, '--production-branch=main'], cwd=workdir)
    all_out = (r.stdout or '') + (r.stderr or '')
    if r.returncode != 0 and 'already exists' not in all_out.lower():
        die('Pages project create failed:\n' + all_out)
    ok('reusing existing project' if 'already exists' in all_out.lower() else f'created project "{project}"')

    print('  deploying assets + functions (30–60s)…')
    r = run_inherit([
        'wrangler', 'pages', 'deploy', 'public',
        f'--project-name={project}', '--commit-dirty=true', '--branch=main',
    ], cwd=workdir)
    if r.returncode != 0:
        die('wrangler pages deploy failed.')

    r = run(['wrangler', 'pages', 'project', 'list'], cwd=workdir)
    subdomain = f'{project}.pages.dev'
    for line in (r.stdout or '').splitlines():
        if project in line:
            m = re.search(r'([\w-]+\.pages\.dev)', line)
            if m:
                subdomain = m.group(1)
                break
    ok(f'deployed to https://{subdomain}')
    return f'https://{subdomain}'

def set_env(project, key, value):
    p = subprocess.Popen(
        ['wrangler', 'pages', 'secret', 'put', key, f'--project-name={project}'],
        stdin=subprocess.PIPE,
    )
    p.communicate(input=(value + '\n').encode('utf-8'))

def main():
    banner()
    ensure_wrangler()
    ensure_login()

    print()
    say('Tell us about your install')
    project = input('  Project slug (letters/digits/dashes, e.g. my-blog): ').strip().lower()
    if not re.match(r'^[a-z][a-z0-9-]{1,32}$', project):
        die('Invalid project slug. Letters/digits/dashes, 2-33 chars, must start with a letter.')

    site_name = input(f'  Site name [{project}]: ').strip() or project
    email = input('  Admin email: ').strip()
    if not re.match(r'^[^@\s]+@[^@\s]+\.[^@\s]+$', email):
        die('Invalid email.')
    password = getpass.getpass('  Admin password (8+ chars): ')
    if len(password) < 8:
        die('Password must be 8+ characters.')
    confirm = getpass.getpass('  Confirm password: ')
    if confirm != password:
        die('Passwords did not match.')

    print()
    say('Provisioning resources')
    d1_id = ensure_d1(project)
    r2_name = project + '-images'
    ensure_r2(r2_name)

    print()
    say('Preparing source')
    workdir = tempfile.mkdtemp(prefix='pages-seo-install-')
    try:
        fetch_source(workdir)
        patch_toml(workdir, project, d1_id, r2_name)

        print()
        say('Deploying to Cloudflare Pages')
        pages_url = deploy(workdir, project)

        print()
        say('Setting environment variables')
        set_env(project, 'SITE_NAME', site_name)
        set_env(project, 'SITE_URL',  pages_url)
        ok('SITE_NAME + SITE_URL set')

        print()
        say('All set')
        seed_json = json.dumps({'email': email, 'password': password, 'site_name': site_name})
        seed_b64 = urlsafe_b64encode(seed_json.encode('utf-8')).rstrip(b'=').decode('ascii')
        admin_url = pages_url + '/admin#install=' + seed_b64

        print()
        print(f"  {C['bold']}{C['green']}Your install is live.{C['reset']}")
        print()
        print(f"  Site:   {C['cyan']}{pages_url}{C['reset']}")
        print(f"  Admin:  {C['cyan']}{pages_url}/admin{C['reset']}")
        print()
        print('  Open this link to auto-create your admin account and land in the onboarding wizard:')
        print()
        print(f"  {C['dim']}{admin_url}{C['reset']}")
        print()
        print(f"  {C['yellow']}Note:{C['reset']} the link above carries your email + password in a URL fragment")
        print('  so the first-run setup card on /admin can submit it for you automatically.')
        print('  After it\'s used once (which marks setup complete), it stops working.')
        print()

        opener = 'open' if sys.platform == 'darwin' else ('start' if sys.platform == 'win32' else 'xdg-open')
        try:
            subprocess.Popen([opener, admin_url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass
    finally:
        if not os.environ.get('PAGES_SEO_KEEP_TMP'):
            shutil.rmtree(workdir, ignore_errors=True)

if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print()
        die('Cancelled.')
