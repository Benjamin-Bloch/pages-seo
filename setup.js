#!/usr/bin/env node
// pages-seo · one-shot setup (Node flavour).
//
// Identical flow to setup.sh / setup.py — pick whichever you prefer.
//
// Prereqs:
//   - wrangler CLI (`npm install -g wrangler`)
//   - logged in (`wrangler login`)
//   - Node 18+
//
// Usage:  node setup.js

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { chdir } from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
chdir(here);

const say  = (m) => console.log(`\x1b[1;36m▸ ${m}\x1b[0m`);
const warn = (m) => console.log(`\x1b[1;33m! ${m}\x1b[0m`);
const die  = (m) => { console.error(`\x1b[1;31m✗ ${m}\x1b[0m`); process.exit(1); };

const rl = createInterface({ input, output });
const ask = async (q, def = '') => {
  const suffix = def ? ` [${def}]` : '';
  const v = (await rl.question(`  ${q}${suffix}: `)).trim();
  return v || def;
};
const askSecret = async (q) => (await rl.question(`  ${q} (blank to skip): `)).trim();
const askYes = async (q, defYes = true) => {
  const v = (await rl.question(`  ${q} (${defYes ? 'Y/n' : 'y/N'}): `)).trim().toLowerCase();
  if (!v) return defYes;
  return v.startsWith('y');
};

// Run a command, optionally piping a string to stdin (for `secret put`).
function run(cmd, args, { stdinInput } = {}) {
  console.log(`    $ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    stdio: stdinInput !== undefined ? ['pipe', 'inherit', 'inherit'] : 'inherit',
    input: stdinInput,
    encoding: 'utf8',
  });
  if (r.status !== 0) die(`${cmd} ${args[0]} failed (exit ${r.status})`);
  return r;
}

function capture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function wranglerLoggedIn() {
  return capture('wrangler', ['whoami']).code === 0;
}

function resolveDbId(dbName) {
  const r = capture('wrangler', ['d1', 'list', '--json']);
  if (r.code !== 0) return '';
  try {
    const list = JSON.parse(r.stdout || '[]');
    const hit = list.find((x) => x?.name === dbName);
    return hit?.uuid || hit?.id || '';
  } catch { return ''; }
}

function patchWranglerToml({ project, dbName, dbId, bucket }) {
  let text = readFileSync('wrangler.toml', 'utf8');
  text = text.replace(/(name\s*=\s*")[^"]+(")/, `$1${project}$2`);
  text = text.replace(/(database_name\s*=\s*")[^"]+(")/g, `$1${dbName}$2`);
  text = text.replace(/(database_id\s*=\s*")[^"]+(")/g,   `$1${dbId}$2`);
  text = text.replace(/(bucket_name\s*=\s*")[^"]+(")/g,   `$1${bucket}$2`);
  writeFileSync('wrangler.toml', text);
}

function writeEnv(values) {
  const lines = [
    '# Local-only mirror of the secrets pushed to Cloudflare. Never commit.',
    ...Object.entries(values).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`),
  ];
  writeFileSync('.env', lines.join('\n') + '\n');
}

async function main() {
  if (capture('which', ['wrangler']).code !== 0) {
    die('wrangler CLI not found. Run: npm install -g wrangler');
  }
  if (!wranglerLoggedIn()) die('wrangler is not logged in. Run: wrangler login');
  if (!existsSync('wrangler.toml')) die('wrangler.toml not found. Run setup from the repo root.');

  say('pages-seo setup');
  console.log('  This walks through creating the Cloudflare resources you need.');
  console.log();

  const project  = await ask('Cloudflare Pages project name', 'pages-seo');
  const dbName   = await ask('D1 database name', project);
  const bucket   = await ask('R2 bucket name (for hero images)', `${project}-images`);
  const siteName = await ask('Site display name (shown in titles)', 'pages-seo');
  const siteUrl  = await ask('Site URL (used in OG tags)', 'https://example.com');

  console.log();
  say('Generating admin + indexnow tokens');
  const adminToken  = randomBytes(32).toString('hex');
  const indexnowKey = randomBytes(32).toString('hex');
  console.log(`  ADMIN_TOKEN  (paste this into the admin UI):\n    ${adminToken}`);
  console.log(`  INDEXNOW_KEY (auto-served at /<key>.txt):\n    ${indexnowKey}`);

  console.log();
  console.log('  Workers AI is on by default (free tier covers most usage).');
  console.log('  Add keys for any other providers you want — leave blank to skip.');
  console.log();
  const providerPrompts = [
    ['OPENAI_API_KEY',    'OpenAI API key (gpt-5, gpt-image-1)'],
    ['ANTHROPIC_API_KEY', 'Anthropic API key (Claude)'],
    ['GEMINI_API_KEY',    'Google Gemini API key (Gemini + Imagen)'],
    ['GROQ_API_KEY',      'Groq API key (fast Llama)'],
    ['DEEPSEEK_API_KEY',  'DeepSeek API key'],
    ['MISTRAL_API_KEY',   'Mistral API key'],
    ['TOGETHER_API_KEY',  'Together AI API key'],
    ['CEREBRAS_API_KEY',  'Cerebras API key'],
  ];
  const providerKeys = {};
  for (const [envName, label] of providerPrompts) {
    const v = await askSecret(label);
    if (v) providerKeys[envName] = v;
  }

  say('Writing .env');
  writeEnv({
    SITE_NAME: siteName,
    SITE_URL: siteUrl,
    ADMIN_TOKEN: adminToken,
    INDEXNOW_KEY: indexnowKey,
    ...providerKeys,
  });
  console.log('  wrote .env (gitignored)');

  say(`Creating D1 database "${dbName}"`);
  const existing = capture('wrangler', ['d1', 'list', '--json']);
  let alreadyExists = false;
  try {
    alreadyExists = JSON.parse(existing.stdout || '[]').some((x) => x?.name === dbName);
  } catch { /* ignore */ }
  if (alreadyExists) warn(`D1 database ${dbName} already exists — skipping create`);
  else run('wrangler', ['d1', 'create', dbName]);
  const dbId = resolveDbId(dbName);
  if (!dbId) die(`Could not resolve D1 ID for ${dbName}`);
  console.log(`  database_id: ${dbId}`);

  say(`Creating R2 bucket "${bucket}"`);
  const r2 = capture('wrangler', ['r2', 'bucket', 'create', bucket]);
  if (r2.code !== 0 && !(r2.stderr + r2.stdout).includes('already exists')) {
    warn((r2.stderr || r2.stdout).trim());
  }

  say('Patching wrangler.toml with your resource names');
  patchWranglerToml({ project, dbName, dbId, bucket });
  console.log('  wrangler.toml updated');

  say('Applying schema/init.sql');
  run('wrangler', ['d1', 'execute', dbName, '--remote', '--file=schema/init.sql']);

  say(`Pushing secrets to Pages project "${project}"`);
  const baseSecrets = [
    ['ADMIN_TOKEN',  adminToken],
    ['INDEXNOW_KEY', indexnowKey],
    ['SITE_NAME',    siteName],
    ['SITE_URL',     siteUrl],
    ...Object.entries(providerKeys),
  ];
  for (const [k, v] of baseSecrets) {
    if (!v) continue;
    run('wrangler', ['pages', 'secret', 'put', k, `--project-name=${project}`], { stdinInput: v });
  }

  say('Deploying Pages site');
  run('wrangler', ['pages', 'deploy', 'public', `--project-name=${project}`, '--commit-dirty=true']);

  console.log();
  if (await askYes('Deploy the cron Worker now?', true)) {
    say('Deploying cron Worker');
    const host = siteUrl.replace(/^https?:\/\//, '').split('/')[0];
    const cronDir = resolve(here, 'cron-worker');
    chdir(cronDir);
    run('wrangler', ['secret', 'put', 'ADMIN_TOKEN'], { stdinInput: adminToken });
    run('wrangler', ['secret', 'put', 'BLOG_URL'],    { stdinInput: `https://${host}/api/admin/blog` });
    run('wrangler', ['secret', 'put', 'PROG_URL'],    { stdinInput: `https://${host}/api/admin/prog/generate-next` });
    run('wrangler', ['deploy'], {});
    chdir(here);
  }

  console.log();
  say('Done.');
  console.log(`  Admin: ${siteUrl}/admin`);
  console.log(`  Token: ${adminToken}`);
  console.log('  (Token also saved in .env)');
  rl.close();
}

main().catch((e) => {
  rl.close();
  die(e?.message || String(e));
});
