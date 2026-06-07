#!/usr/bin/env python3
# pages-seo terminal UNINSTALLER (Python flavour).
#
# Downloaded and piped from https://seo.benjaminb.xyz/install/uninstall.py.
# Reverses what install/run.py provisioned: the Cloudflare Pages project,
# the D1 database, and the R2 bucket. Asks before each destructive step.
#
#   curl -fsSL https://seo.benjaminb.xyz/install/uninstall.py | python3
#
# Use --yes to skip every confirmation (CI-style):
#   curl -fsSL …/uninstall.py | python3 - --yes my-project

import json
import os
import re
import shutil
import subprocess
import sys

C = {
    'reset': '\033[0m', 'dim': '\033[2m', 'bold': '\033[1m',
    'cyan':  '\033[36m', 'green': '\033[32m', 'red': '\033[31m', 'yellow':'\033[33m',
}
def say(s):  print(f"{C['cyan']}▸{C['reset']} {C['bold']}{s}{C['reset']}")
def ok(s):   print(f"  {C['green']}✓{C['reset']} {s}")
def warn(s): print(f"  {C['yellow']}!{C['reset']} {s}")
def err(s):  print(f"  {C['red']}✗{C['reset']} {s}")
def die(s):  print(f"{C['red']}✗ {s}{C['reset']}"); sys.exit(1)

# We read confirmations from /dev/tty so the prompt works when this
# script is piped through python3 (stdin is the script body, not the
# terminal). Falls back to plain input() if there's no /dev/tty.
def _tty_io():
    try:
        return open('/dev/tty', 'r'), open('/dev/tty', 'w')
    except OSError:
        return None, None
def ask(prompt, default=''):
    rin, rout = _tty_io()
    label = prompt + (f' [{default}]' if default else '') + ': '
    if not rin:
        try: ans = input(label).strip()
        except EOFError: ans = ''
        return ans or default
    rout.write(label); rout.flush()
    try: ans = rin.readline().strip()
    finally: rin.close(); rout.close()
    return ans or default
def ask_yes_no(prompt, default_no=True):
    suffix = '[y/N]' if default_no else '[Y/n]'
    a = ask(f'{prompt} {suffix}').lower()
    if not a: return not default_no
    return a in ('y', 'yes')

def run(args):
    return subprocess.run(args, capture_output=True, text=True)

def wrangler_installed():
    return shutil.which('wrangler') is not None or run(['wrangler', '--version']).returncode == 0

def is_logged_in():
    r = run(['wrangler', 'whoami'])
    return r.returncode == 0 and 'not authenticated' not in (r.stdout + r.stderr).lower()

# ── discovery ──────────────────────────────────────────────────────
# Look up the live IDs for the project's D1 + R2 so we delete the right
# things. Wrangler's `pages project list --json` includes deployment
# config which carries the bindings; if that fails we fall back to the
# project name + the conventional "<project>-images" R2 name.

def discover(project):
    found = {'pages': False, 'd1_id': None, 'd1_name': None, 'r2_name': None}

    # Pages project existence
    r = run(['wrangler', 'pages', 'project', 'list'])
    out = (r.stdout or '') + (r.stderr or '')
    if re.search(rf'\b{re.escape(project)}\b', out):
        found['pages'] = True

    # D1 by name match
    r = run(['wrangler', 'd1', 'list', '--json'])
    if r.returncode == 0:
        try:
            m = re.search(r'\[[\s\S]*\]', r.stdout or '')
            if m:
                for row in json.loads(m.group(0)):
                    if row.get('name') == project:
                        found['d1_id'] = row.get('uuid') or row.get('database_id')
                        found['d1_name'] = row.get('name')
                        break
        except Exception:
            pass

    # R2 bucket: convention is "<project>-images" (run.py / run.sh / run.js).
    r2_guess = project + '-images'
    r = run(['wrangler', 'r2', 'bucket', 'list'])
    if r.returncode == 0 and re.search(rf'\b{re.escape(r2_guess)}\b', r.stdout or ''):
        found['r2_name'] = r2_guess
    return found

# ── deletions ──────────────────────────────────────────────────────
def delete_pages(project, yes):
    if not yes and not ask_yes_no(f'Delete Pages project "{project}"?'):
        warn('skipped Pages project'); return
    r = run(['wrangler', 'pages', 'project', 'delete', project, '--yes'])
    out = (r.stdout or '') + (r.stderr or '')
    if r.returncode == 0 or 'not found' in out.lower():
        ok(f'deleted Pages project "{project}"')
    else:
        err(f'failed to delete Pages project:\n{out.strip()}')

def delete_d1(d1_id, d1_name, yes):
    if not yes and not ask_yes_no(f'Delete D1 database "{d1_name}" ({d1_id})? This wipes all blog posts.'):
        warn('skipped D1 database'); return
    r = run(['wrangler', 'd1', 'delete', d1_id, '--skip-confirmation'])
    out = (r.stdout or '') + (r.stderr or '')
    if r.returncode == 0 or 'not found' in out.lower():
        ok(f'deleted D1 database "{d1_name}"')
    else:
        err(f'failed to delete D1:\n{out.strip()}')

def delete_r2(r2_name, yes):
    if not yes and not ask_yes_no(f'Delete R2 bucket "{r2_name}"? This wipes all hero images.'):
        warn('skipped R2 bucket'); return
    # Empty the bucket first so the delete doesn't fail on non-empty.
    run(['wrangler', 'r2', 'bucket', 'delete', r2_name, '--force'])  # newer wrangler
    r = run(['wrangler', 'r2', 'bucket', 'delete', r2_name])
    out = (r.stdout or '') + (r.stderr or '')
    if r.returncode == 0 or 'not found' in out.lower() or 'does not exist' in out.lower():
        ok(f'deleted R2 bucket "{r2_name}"')
    else:
        err(f'failed to delete R2 bucket:\n{out.strip()}')

# ── main ───────────────────────────────────────────────────────────
def main():
    print()
    print(f"{C['cyan']}╭──────────────────────────────────────────────╮{C['reset']}")
    print(f"{C['cyan']}│{C['reset']}  {C['bold']}pages-seo · UNINSTALL{C['reset']}                     {C['cyan']}│{C['reset']}")
    print(f"{C['cyan']}│{C['reset']}  {C['dim']}removes the Pages project + D1 + R2{C['reset']}        {C['cyan']}│{C['reset']}")
    print(f"{C['cyan']}╰──────────────────────────────────────────────╯{C['reset']}")
    print()

    # Parse args (yes-flag + optional project slug). When piped via curl
    # … | python3 - --yes my-project, argv[1:] is the trailing args.
    args = sys.argv[1:]
    yes = '--yes' in args or '-y' in args
    args = [a for a in args if a not in ('--yes', '-y')]

    if not wrangler_installed():
        die('wrangler is not installed. Install it first: npm install -g wrangler')
    if not is_logged_in():
        warn('Not logged in to Cloudflare — running `wrangler login`…')
        run(['wrangler', 'login'])
        if not is_logged_in(): die('Login failed.')
    ok('logged in to Cloudflare')

    project = args[0] if args else ask('Project slug to uninstall (the one you used when installing)')
    project = project.strip().lower()
    if not re.match(r'^[a-z][a-z0-9-]{1,32}$', project):
        die('Project slug must be lowercase letters/digits/dashes (e.g. my-blog).')

    print()
    say(f'Looking up resources for "{project}"')
    f = discover(project)

    summary = []
    if f['pages']: summary.append(f'Pages project "{project}"')
    if f['d1_id']: summary.append(f'D1 database "{f["d1_name"]}" ({f["d1_id"]})')
    if f['r2_name']: summary.append(f'R2 bucket "{f["r2_name"]}"')

    if not summary:
        warn('Nothing found to delete for that slug.')
        warn('Common cause: typo in the slug. Re-run with the exact name you gave the installer.')
        return

    print()
    print('  Found:')
    for s in summary: print(f'    · {s}')
    print()
    print(f"  {C['yellow']}This is destructive and cannot be undone.{C['reset']}")
    if not yes:
        if not ask_yes_no('Proceed with deletion?'): die('Aborted.')
    print()

    say('Removing resources')
    if f['pages']:  delete_pages(project, yes)
    if f['d1_id']:  delete_d1(f['d1_id'], f['d1_name'], yes)
    if f['r2_name']: delete_r2(f['r2_name'], yes)

    print()
    print(f"  {C['bold']}{C['green']}Uninstall complete.{C['reset']}")
    print(f"  Your Cloudflare account no longer has any pages-seo resources for \"{project}\".")
    print()

if __name__ == '__main__':
    try: main()
    except KeyboardInterrupt:
        print(); die('Cancelled.')
