#!/usr/bin/env node
// pages-seo terminal UNINSTALLER (Node flavour).
//
//   curl -fsSL https://seo.benjaminb.xyz/install/uninstall.js | node
//   curl -fsSL https://seo.benjaminb.xyz/install/uninstall.js | node - --yes my-project
//
// Removes the Cloudflare Pages project, D1 database, and R2 bucket
// that install/run.js created. Asks before each destructive step
// (unless --yes is passed).

import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, openSync } from 'node:fs';
import { ReadStream as TTYReadStream } from 'node:tty';

// When run via `curl … | node`, stdin IS the script body. Re-open
// /dev/tty so prompts read the user, not the script.
let input = process.stdin;
try {
  if (!process.stdin.isTTY && existsSync('/dev/tty')) {
    const fd = openSync('/dev/tty', 'r');
    input = new TTYReadStream(fd);
  }
} catch { /* */ }
const output = process.stdout;

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  cyan:  '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
};
const log  = (...a) => console.log(...a);
const say  = (s) => log(`${C.cyan}▸${C.reset} ${C.bold}${s}${C.reset}`);
const ok   = (s) => log(`  ${C.green}✓${C.reset} ${s}`);
const warn = (s) => log(`  ${C.yellow}!${C.reset} ${s}`);
const err  = (s) => log(`  ${C.red}✗${C.reset} ${s}`);
const die  = (s) => { log(`${C.red}✗ ${s}${C.reset}`); process.exit(1); };

function run(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8' });
}
function runOk(cmd, args) { return run(cmd, args).status === 0; }

const rl = createInterface({ input, output });
function ask(q, def = '') {
  return new Promise((res) => {
    rl.question(`  ${q}${def ? ` [${def}]` : ''}: `, (a) => res((a || '').trim() || def));
  });
}
async function askYesNo(q, defaultNo = true) {
  const ans = (await ask(`${q} ${defaultNo ? '[y/N]' : '[Y/n]'}`)).toLowerCase();
  if (!ans) return !defaultNo;
  return ans === 'y' || ans === 'yes';
}

const ARGS = process.argv.slice(2);
const YES = ARGS.includes('--yes') || ARGS.includes('-y');
const POS = ARGS.filter((a) => a !== '--yes' && a !== '-y');

function banner() {
  log('');
  log(`${C.cyan}╭──────────────────────────────────────────────╮${C.reset}`);
  log(`${C.cyan}│${C.reset}  ${C.bold}pages-seo · UNINSTALL${C.reset}                     ${C.cyan}│${C.reset}`);
  log(`${C.cyan}│${C.reset}  ${C.dim}removes the Pages project + D1 + R2${C.reset}        ${C.cyan}│${C.reset}`);
  log(`${C.cyan}╰──────────────────────────────────────────────╯${C.reset}`);
  log('');
}

function discoverPages(project) {
  const r = run('wrangler', ['pages', 'project', 'list']);
  const out = (r.stdout || '') + (r.stderr || '');
  return new RegExp(`\\b${project.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`).test(out);
}
function discoverD1(project) {
  const r = run('wrangler', ['d1', 'list', '--json']);
  if (r.status !== 0) return null;
  try {
    const m = (r.stdout || '').match(/\[[\s\S]*\]/);
    if (!m) return null;
    const rows = JSON.parse(m[0]);
    const hit = rows.find((x) => x && x.name === project);
    if (!hit) return null;
    return { id: hit.uuid || hit.database_id, name: hit.name };
  } catch { return null; }
}
function discoverR2(project) {
  const name = `${project}-images`;
  const r = run('wrangler', ['r2', 'bucket', 'list']);
  if (r.status !== 0) return null;
  const out = (r.stdout || '') + (r.stderr || '');
  return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`).test(out) ? name : null;
}

async function deletePages(project) {
  if (!YES && !(await askYesNo(`Delete Pages project "${project}"?`))) { warn('skipped Pages project'); return; }
  const r = run('wrangler', ['pages', 'project', 'delete', project, '--yes']);
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status === 0 || /not found/i.test(out)) ok(`deleted Pages project "${project}"`);
  else err(`Pages delete failed: ${out.trim()}`);
}
async function deleteD1(d1) {
  if (!YES && !(await askYesNo(`Delete D1 database "${d1.name}" (${d1.id})? This wipes all blog posts.`))) { warn('skipped D1'); return; }
  const r = run('wrangler', ['d1', 'delete', d1.id, '--skip-confirmation']);
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status === 0 || /not found/i.test(out)) ok(`deleted D1 database "${d1.name}"`);
  else err(`D1 delete failed: ${out.trim()}`);
}
async function deleteR2(name) {
  if (!YES && !(await askYesNo(`Delete R2 bucket "${name}"? This wipes all hero images.`))) { warn('skipped R2 bucket'); return; }
  let r = run('wrangler', ['r2', 'bucket', 'delete', name, '--force']);
  if (r.status !== 0) r = run('wrangler', ['r2', 'bucket', 'delete', name]);
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status === 0 || /not found|does not exist/i.test(out)) ok(`deleted R2 bucket "${name}"`);
  else err(`R2 delete failed: ${out.trim()}`);
}

async function main() {
  banner();

  if (!runOk('wrangler', ['--version'])) die('wrangler is not installed. Install it first: npm install -g wrangler');
  if (!runOk('wrangler', ['whoami'])) {
    warn('Not logged in to Cloudflare — running `wrangler login`…');
    run('wrangler', ['login']);
    if (!runOk('wrangler', ['whoami'])) die('Login failed.');
  }
  ok('logged in to Cloudflare');

  let project = (POS[0] || await ask('Project slug to uninstall (the one you used when installing)')).trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,32}$/.test(project)) die('Project slug must be lowercase letters/digits/dashes (e.g. my-blog).');

  log('');
  say(`Looking up resources for "${project}"`);
  const havePages = discoverPages(project);
  const d1 = discoverD1(project);
  const r2 = discoverR2(project);

  const summary = [];
  if (havePages) summary.push(`Pages project "${project}"`);
  if (d1) summary.push(`D1 database "${d1.name}" (${d1.id})`);
  if (r2) summary.push(`R2 bucket "${r2}"`);

  if (!summary.length) {
    warn('Nothing found to delete for that slug.');
    warn('Common cause: typo in the slug. Re-run with the exact name you gave the installer.');
    rl.close(); return;
  }

  log('  Found:');
  for (const s of summary) log(`    · ${s}`);
  log('');
  log(`  ${C.yellow}This is destructive and cannot be undone.${C.reset}`);
  if (!YES && !(await askYesNo('Proceed with deletion?'))) die('Aborted.');
  log('');

  say('Removing resources');
  if (havePages) await deletePages(project);
  if (d1)        await deleteD1(d1);
  if (r2)        await deleteR2(r2);

  log('');
  log(`  ${C.bold}${C.green}Uninstall complete.${C.reset}`);
  log(`  Your Cloudflare account no longer has any pages-seo resources for "${project}".`);
  log('');
  rl.close();
}

main().catch((e) => { err(String(e?.stack || e)); process.exit(1); });
