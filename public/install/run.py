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
import sys
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from base64 import urlsafe_b64encode

# When run as `curl … | python3`, stdin IS the script source, so
# input() returns immediately with EOFError on every prompt. Reattach
# stdin to the controlling terminal (POSIX only; Windows users go via
# the bash or node script). Falls back silently if /dev/tty isn't
# available.
try:
    if not sys.stdin.isatty() and os.path.exists('/dev/tty'):
        sys.stdin = open('/dev/tty', 'r')
except Exception:
    pass

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
    # Wrangler has changed this output format over versions. Match all of:
    #   database_id = "uuid"               (legacy TOML snippet)
    #   "database_id": "uuid"              (current JSON snippet)
    #   database_id: "uuid"                (variant)
    # Falls back to grabbing any bare UUID from the output as a last resort.
    m = re.search(r'"?database_id"?\s*[=:]\s*"([0-9a-f-]{36})"', all_out)
    if not m:
        m = re.search(r'\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b', all_out)
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
# PAGES_SEO_REF lets advanced users target main / a branch / a SHA.
# Default is the latest tagged release.
REF = os.environ.get('PAGES_SEO_REF', 'v1.0.4').strip() or 'v1.0.4'
TARBALL_TAG = f'https://github.com/Benjamin-Bloch/pages-seo/archive/refs/tags/{REF}.tar.gz'
TARBALL_BRANCH = f'https://github.com/Benjamin-Bloch/pages-seo/archive/refs/heads/{REF}.tar.gz'

def fetch_source(workdir):
    tar = os.path.join(workdir, 'src.tar.gz')
    print(f'  downloading pages-seo source ({REF})…')
    try:
        urllib.request.urlretrieve(TARBALL_TAG, tar)
    except Exception:
        try:
            urllib.request.urlretrieve(TARBALL_BRANCH, tar)
        except Exception as e:
            die(f'Failed to download source for ref "{REF}": {e}\nSet PAGES_SEO_REF=main for bleeding edge.')
    r = run_inherit(['tar', '-xzf', tar, '-C', workdir, '--strip-components=1'])
    if r.returncode != 0:
        die('Failed to extract source archive.')
    ok('source extracted')

def ask_password(prompt):
    """Read a password and show the LAST typed character in plain, then
    mask it with '*' when the next char is typed. Familiar phone-keyboard
    feel: you can verify each keystroke without leaving the password on
    screen. Reads from /dev/tty so it works when this script is piped
    through python3 (stdin is the script itself, not the terminal).

    Falls back to plain getpass on Windows or anything without a tty."""
    if os.name == 'nt':
        return getpass.getpass(prompt + ': ')
    try:
        tty_in = open('/dev/tty', 'rb', buffering=0)
        tty_out = open('/dev/tty', 'w')
    except OSError:
        return getpass.getpass(prompt + ': ')
    try:
        import termios, tty
    except ImportError:
        tty_in.close(); tty_out.close()
        return getpass.getpass(prompt + ': ')

    tty_out.write(prompt + ': '); tty_out.flush()
    fd = tty_in.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        buf = []
        last_shown = False  # whether the last char on screen is plain
        while True:
            ch = tty_in.read(1).decode('utf-8', errors='ignore')
            if ch in ('\r', '\n'):
                # Mask the trailing plain char so the final prompt is all *s.
                if last_shown: tty_out.write('\b*')
                tty_out.write('\n'); tty_out.flush(); break
            if ch == '\x03':  # Ctrl-C
                tty_out.write('\n'); tty_out.flush()
                raise KeyboardInterrupt
            if ch in ('\x7f', '\x08'):  # Backspace / DEL
                if buf:
                    buf.pop()
                    tty_out.write('\b \b'); tty_out.flush()
                    last_shown = False
                continue
            if ch < ' ':  # other control chars: ignore
                continue
            # Mask the previous plain char (if any), then show this one
            # in plain. Next keystroke will mask it too.
            if last_shown: tty_out.write('\b*')
            buf.append(ch)
            tty_out.write(ch); tty_out.flush()
            last_shown = True
        return ''.join(buf)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)
        tty_in.close(); tty_out.close()

def patch_toml(workdir, project, d1_id, r2_name):
    path = os.path.join(workdir, 'wrangler.toml')
    # Some releases (incl. v1.0.4) ship only wrangler.template.toml so
    # the repo doesn't carry the maintainer's real D1/R2 IDs. If the
    # active file isn't there, materialise it from the template.
    if not os.path.exists(path):
        template = os.path.join(workdir, 'wrangler.template.toml')
        if os.path.exists(template):
            shutil.copyfile(template, path)
        else:
            die('No wrangler.toml or wrangler.template.toml in source archive.')
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
    password = ask_password('  Admin password (8+ chars)')
    if len(password) < 8:
        die('Password must be 8+ characters.')
    confirm = ask_password('  Confirm password')
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
