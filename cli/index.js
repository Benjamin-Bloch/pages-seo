#!/usr/bin/env node
// pages-seo-install — one-command CLI installer.
//
// Replaces the web installer's clumsy GitHub-App-required path with
// a local flow that talks to Cloudflare directly. Works because the
// user's machine already has `wrangler` authenticated (or can run
// `wrangler login` in two clicks), and `wrangler pages deploy` uses
// Direct Upload internally — no GitHub linkage required.
//
// Single file, zero npm dependencies beyond `wrangler` (which we
// exec). Node 20+ required.
//
// Security note: every shell call uses spawnSync with array args so
// user-supplied values (project slug, names, etc.) can never be
// re-parsed by a shell. No string interpolation into shell commands.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const REPO_TARBALL = 'https://github.com/Benjamin-Bloch/pages-seo/archive/refs/heads/main.tar.gz';

// ── tty helpers ────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
};
const log = (...a) => console.log(...a);
const say = (s) => log(`${C.cyan}▸${C.reset} ${C.bold}${s}${C.reset}`);
const ok  = (s) => log(`  ${C.green}✓${C.reset} ${s}`);
const warn = (s) => log(`  ${C.yellow}!${C.reset} ${s}`);
const die = (s) => { log(`${C.red}✗ ${s}${C.reset}`); process.exit(1); };

function banner() {
  log('');
  log(`${C.cyan}╭──────────────────────────────────────────────╮${C.reset}`);
  log(`${C.cyan}│${C.reset}  ${C.bold}pages-seo · install${C.reset}                       ${C.cyan}│${C.reset}`);
  log(`${C.cyan}│${C.reset}  ${C.dim}one command, no GitHub App, no SQL${C.reset}         ${C.cyan}│${C.reset}`);
  log(`${C.cyan}╰──────────────────────────────────────────────╯${C.reset}`);
  log('');
}

// ── shell glue (no string interpolation; args always arrays) ──────
function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}
function runOk(cmd, args) {
  const r = run(cmd, args);
  return r.status === 0;
}

// ── prompts ────────────────────────────────────────────────────────
const rl = createInterface({ input, output });
async function ask(q, def = '') {
  const suffix = def ? ` (${def})` : '';
  const a = (await rl.question(`  ${q}${suffix}: `)).trim();
  return a || def;
}
async function askPassword(q) {
  output.write(`  ${q}: `);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY) stdin.setRawMode(true);
    let buf = '';
    const onData = (b) => {
      const s = b.toString('utf8');
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') {
          stdin.removeListener('data', onData);
          if (stdin.isTTY) stdin.setRawMode(false);
          output.write('\n');
          return resolve(buf);
        }
        if (ch === '\x7f' || ch === '\b') {
          if (buf.length) { buf = buf.slice(0, -1); output.write('\b \b'); }
          continue;
        }
        if (ch === '\x03') { output.write('\n'); process.exit(130); }
        buf += ch;
        output.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

// ── wrangler bootstrap ────────────────────────────────────────────
function wranglerInstalled() { return runOk('wrangler', ['--version']); }

async function ensureWrangler() {
  if (wranglerInstalled()) { ok('wrangler installed'); return; }
  warn('wrangler not found on PATH.');
  const yes = (await ask('Install it now with `npm install -g wrangler`? (Y/n)', 'Y')).toLowerCase();
  if (yes !== 'y' && yes !== 'yes') die('Install wrangler and re-run: npm install -g wrangler');
  const r = run('npm', ['install', '-g', 'wrangler'], { stdio: 'inherit' });
  if (r.status !== 0) die('npm install -g wrangler failed.');
}

function whoami() {
  const r = run('wrangler', ['whoami']);
  if (r.status !== 0) return { ok: false };
  const acct = (r.stdout + r.stderr).match(/[a-f0-9]{32}/);
  return { ok: true, accountId: acct ? acct[0] : null };
}

async function ensureLogin() {
  let w = whoami();
  if (w.ok && w.accountId) { ok(`logged in (account ${C.dim}${w.accountId}${C.reset})`); return w.accountId; }
  warn('Not logged in to Cloudflare.');
  log('  Running `wrangler login` — your browser will open.');
  run('wrangler', ['login'], { stdio: 'inherit' });
  w = whoami();
  if (!w.ok || !w.accountId) die('wrangler login did not complete. Run it manually and re-run this installer.');
  ok(`logged in (account ${C.dim}${w.accountId}${C.reset})`);
  return w.accountId;
}

// ── Cloudflare resource provisioning via wrangler ─────────────────
async function ensureD1(name) {
  // List first; reuse if exists.
  const list = run('wrangler', ['d1', 'list', '--json']);
  if (list.status === 0) {
    try {
      const m = list.stdout.match(/\[[\s\S]*\]/);
      if (m) {
        const arr = JSON.parse(m[0]);
        const hit = arr.find((r) => r.name === name);
        if (hit) {
          const id = hit.uuid || hit.database_id;
          ok(`reusing existing D1 "${name}" (${id})`);
          return id;
        }
      }
    } catch { /* fall through to create */ }
  }
  log(`  creating D1 database "${name}"…`);
  const r = run('wrangler', ['d1', 'create', name]);
  const all = r.stdout + r.stderr;
  if (r.status !== 0) die('D1 create failed:\n' + all);
  const m = all.match(/database_id\s*=\s*"([0-9a-f-]{36})"/);
  if (!m) die('Could not parse database_id from wrangler output:\n' + all);
  ok(`created D1 "${name}" (${m[1]})`);
  return m[1];
}

async function ensureR2(name) {
  log(`  creating R2 bucket "${name}"…`);
  const r = run('wrangler', ['r2', 'bucket', 'create', name]);
  const all = r.stdout + r.stderr;
  if (r.status === 0) { ok(`created R2 bucket "${name}"`); return; }
  if (/already exists/i.test(all)) { ok(`reusing existing R2 bucket "${name}"`); return; }
  die('R2 create failed:\n' + all);
}

// ── source download ──────────────────────────────────────────────
function fetchSource(workDir) {
  const tar = join(workDir, 'src.tar.gz');
  log(`  downloading pages-seo source…`);
  const dl = run('curl', ['-fsSL', '-o', tar, REPO_TARBALL], { stdio: 'inherit' });
  if (dl.status !== 0) die('Failed to download source from ' + REPO_TARBALL);
  const ex = run('tar', ['-xzf', tar, '-C', workDir, '--strip-components=1'], { stdio: 'inherit' });
  if (ex.status !== 0) die('Failed to extract source archive.');
  ok('source extracted');
}

function patchWranglerToml(dir, project, d1Id, r2Name) {
  const path = join(dir, 'wrangler.toml');
  let toml = readFileSync(path, 'utf8');
  toml = toml.replace(/^name\s*=\s*".*"/m,          `name = "${project}"`);
  toml = toml.replace(/database_name\s*=\s*".*"/m,  `database_name = "${project}"`);
  toml = toml.replace(/database_id\s*=\s*".*"/m,    `database_id = "${d1Id}"`);
  toml = toml.replace(/bucket_name\s*=\s*".*"/m,    `bucket_name = "${r2Name}"`);
  writeFileSync(path, toml);
  ok('wrangler.toml patched with new resources');
}

async function deployPages(dir, project) {
  log(`  creating Pages project "${project}"…`);
  const create = run('wrangler',
    ['pages', 'project', 'create', project, '--production-branch=main'],
    { cwd: dir },
  );
  const co = create.stdout + create.stderr;
  if (create.status !== 0 && !/already exists/i.test(co)) {
    die('Pages project create failed:\n' + co);
  }
  ok(/already exists/i.test(co) ? `reusing existing project "${project}"` : `created project "${project}"`);

  log(`  deploying assets + functions (30–60s)…`);
  const dep = run('wrangler', [
    'pages', 'deploy', 'public',
    `--project-name=${project}`, '--commit-dirty=true', '--branch=main',
  ], { cwd: dir, stdio: 'inherit' });
  if (dep.status !== 0) die('wrangler pages deploy failed.');

  // Resolve the production subdomain via project list. The output
  // is a CLI table; we grep for a row that mentions this project.
  const list = run('wrangler', ['pages', 'project', 'list'], { cwd: dir });
  let subdomain = `${project}.pages.dev`;
  const row = list.stdout.split('\n').find((l) => l.includes(project));
  if (row) {
    const m = row.match(/([\w-]+\.pages\.dev)/);
    if (m) subdomain = m[1];
  }
  ok(`deployed to https://${subdomain}`);
  return `https://${subdomain}`;
}

async function setPagesEnv(project, key, value) {
  const p = spawn('wrangler',
    ['pages', 'secret', 'put', key, `--project-name=${project}`],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  p.stdin.write(value + '\n');
  p.stdin.end();
  await new Promise((res) => p.on('exit', res));
}

// ── main ────────────────────────────────────────────────────────
async function main() {
  banner();

  await ensureWrangler();
  await ensureLogin();

  log('');
  say('Tell us about your install');
  const project = (await ask('Project slug (letters/digits/dashes, e.g. my-blog)')).toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,32}$/.test(project)) die('Invalid project slug. Use letters/digits/dashes, 2-33 chars, start with a letter.');
  const siteName = await ask('Site name', project);
  const email = await ask('Admin email');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) die('Invalid email.');
  const password = await askPassword('Admin password (12+ chars)');
  if (password.length < 12) die('Password must be 12+ characters.');
  const confirm = await askPassword('Confirm password');
  if (confirm !== password) die('Passwords did not match.');

  log('');
  say('Provisioning resources');
  const d1Id = await ensureD1(project);
  await ensureR2(project + '-images');

  log('');
  say('Preparing source');
  const workDir = mkdtempSync(join(tmpdir(), 'pages-seo-install-'));
  try {
    fetchSource(workDir);
    patchWranglerToml(workDir, project, d1Id, project + '-images');

    log('');
    say('Deploying to Cloudflare Pages');
    const pagesUrl = await deployPages(workDir, project);

    log('');
    say('Setting environment variables');
    await setPagesEnv(project, 'SITE_NAME', siteName);
    await setPagesEnv(project, 'SITE_URL',  pagesUrl);
    ok('SITE_NAME + SITE_URL set');

    log('');
    say('All set');
    const seed = JSON.stringify({ email, password, site_name: siteName });
    const b64 = Buffer.from(seed, 'utf8').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const adminUrl = pagesUrl + '/admin#install=' + b64;

    log('');
    log(`  ${C.bold}${C.green}Your install is live.${C.reset}`);
    log('');
    log(`  Site:   ${C.cyan}${pagesUrl}${C.reset}`);
    log(`  Admin:  ${C.cyan}${pagesUrl}/admin${C.reset}`);
    log('');
    log(`  Open this link to auto-create your admin account and land in the onboarding wizard:`);
    log('');
    log(`  ${C.dim}${adminUrl}${C.reset}`);
    log('');
    log(`  ${C.yellow}Note:${C.reset} the link above carries your email + password in a URL fragment`);
    log(`  so the first-run setup card on /admin can submit it for you automatically.`);
    log(`  After it's used once (which marks setup complete), it stops working.`);
    log('');

    const opener = process.platform === 'darwin' ? 'open' :
                   process.platform === 'win32' ? 'start' : 'xdg-open';
    try { run(opener, [adminUrl], { stdio: 'ignore' }); } catch { /* user can copy from the log */ }

  } finally {
    if (process.env.PAGES_SEO_KEEP_TMP) {
      log(`  ${C.dim}temp dir kept at ${workDir}${C.reset}`);
    } else {
      try { rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
    }
    rl.close();
  }
}

main().catch((e) => die(e.stack || e.message || String(e)));
