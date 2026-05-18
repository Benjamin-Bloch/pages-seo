#!/usr/bin/env node
// pages-seo · one-shot setup (Node flavour, resumable).
//
// Writes progress to .setup-state after each step. Re-running this
// script picks up where it left off — fix the underlying failure, then
// `node setup.js` again. To start over, delete .setup-state.
//
// Prereqs:
//   - Node 18+
//   - wrangler CLI + Cloudflare login (script offers to install/login)

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

const STATE_FILE = '.setup-state';

const say  = (m) => console.log(`\x1b[1;36m▸\x1b[0m \x1b[1m${m}\x1b[0m`);
const ok   = (m) => console.log(`  \x1b[1;32m✓\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[1;33m!\x1b[0m ${m}`);
const die  = (m) => { console.error(`\x1b[1;31m✗ ${m}\x1b[0m`); process.exit(1); };
function banner() {
  console.log();
  console.log('\x1b[1;36m╭──────────────────────────────────────────────╮\x1b[0m');
  console.log('\x1b[1;36m│\x1b[0m  \x1b[1mpages-seo · install\x1b[0m                       \x1b[1;36m│\x1b[0m');
  console.log('\x1b[1;36m│\x1b[0m  \x1b[2mone-shot resumable setup for Cloudflare\x1b[0m    \x1b[1;36m│\x1b[0m');
  console.log('\x1b[1;36m╰──────────────────────────────────────────────╯\x1b[0m');
  console.log();
}

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

function run(cmd, args, { stdinInput } = {}) {
  console.log(`    $ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    stdio: stdinInput !== undefined ? ['pipe', 'inherit', 'inherit'] : 'inherit',
    input: stdinInput,
    encoding: 'utf8',
  });
  if (r.status !== 0) die(`${cmd} ${args[0]} failed (exit ${r.status})`);
}

function capture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ── state file ─────────────────────────────────────────────────────

function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  const out = {};
  for (const line of readFileSync(STATE_FILE, 'utf8').split('\n')) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    out[line.slice(0, idx).trim()] = line.slice(idx + 1);
  }
  return out;
}

function saveKV(state, key, val) {
  state[key] = val;
  writeFileSync(STATE_FILE, Object.entries(state).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
}
const markDone = (state, step) => saveKV(state, `STEP_${step}`, 'done');
const isDone   = (state, step) => state[`STEP_${step}`] === 'done';

// ── wrangler helpers ───────────────────────────────────────────────

function hasCmd(name) { return capture('which', [name]).code === 0; }
function wranglerLoggedIn() { return capture('wrangler', ['whoami']).code === 0; }

async function ensureWrangler() {
  if (hasCmd('wrangler')) return;
  warn('wrangler CLI not found.');
  if (!hasCmd('npm')) die('Install Node.js + wrangler (npm install -g wrangler) and re-run.');
  if (!(await askYes("Install it now with 'npm install -g wrangler'?", true))) {
    die('Install wrangler (npm install -g wrangler) and re-run.');
  }
  const r = spawnSync('npm', ['install', '-g', 'wrangler'], { stdio: 'inherit' });
  if (r.status !== 0) die('npm install failed.');
}

async function ensureWranglerLoggedIn() {
  if (wranglerLoggedIn()) return;
  warn('wrangler is not logged in to Cloudflare.');
  if (!(await askYes("Run 'wrangler login' now?", true))) {
    die("Run 'wrangler login' then re-run setup.");
  }
  spawnSync('wrangler', ['login'], { stdio: 'inherit' });
  if (!wranglerLoggedIn()) die('wrangler still not logged in.');
}

function resolveDbId(dbName) {
  const r = capture('wrangler', ['d1', 'list', '--json']);
  if (r.code !== 0) return '';
  try {
    const list = JSON.parse(r.stdout || '[]');
    const hit = (list || []).find((x) => x?.name === dbName);
    return hit?.uuid || hit?.database_id || hit?.id || '';
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

function pushSecret(name, val, project) {
  if (!val) return;
  run('wrangler', ['pages', 'secret', 'put', name, `--project-name=${project}`], { stdinInput: val });
}

const PROVIDER_PROMPTS = [
  ['OPENAI_API_KEY',    'OpenAI API key (gpt-5, gpt-image-1)'],
  ['ANTHROPIC_API_KEY', 'Anthropic API key (Claude)'],
  ['GEMINI_API_KEY',    'Google Gemini API key (Gemini + Imagen)'],
  ['GROQ_API_KEY',      'Groq API key'],
  ['DEEPSEEK_API_KEY',  'DeepSeek API key'],
  ['MISTRAL_API_KEY',   'Mistral API key'],
  ['TOGETHER_API_KEY',  'Together AI API key'],
  ['CEREBRAS_API_KEY',  'Cerebras API key'],
];

// ── main ──────────────────────────────────────────────────────────

async function main() {
  await ensureWrangler();
  await ensureWranglerLoggedIn();
  if (!existsSync('wrangler.toml')) die('wrangler.toml not found. Run setup from the repo root.');

  banner();
  const state = loadState();
  if (Object.keys(state).length) {
    console.log('  \x1b[2mResuming from .setup-state. Delete it to start over.\x1b[0m\n');
  } else {
    console.log('  \x1b[2mWalking through the full setup. Each step is resumable\x1b[0m');
    console.log('  \x1b[2mif it fails — just re-run `node setup.js`.\x1b[0m\n');
  }

  // 1. inputs
  if (!isDone(state, 'INPUTS')) {
    const project = await ask('Cloudflare Pages project name', state.PROJECT_NAME || 'pages-seo');
    const dbName  = await ask('D1 database name', state.DB_NAME || project);
    const bucket  = await ask('R2 bucket name (for hero images)', state.BUCKET_NAME || `${project}-images`);
    const siteName = await ask('Site display name (shown in titles)', state.SITE_NAME || 'pages-seo');
    const siteUrl  = await ask('Site URL (used in OG tags)', state.SITE_URL || `https://${project}.pages.dev`);
    saveKV(state, 'PROJECT_NAME', project);
    saveKV(state, 'DB_NAME',      dbName);
    saveKV(state, 'BUCKET_NAME',  bucket);
    saveKV(state, 'SITE_NAME',    siteName);
    saveKV(state, 'SITE_URL',     siteUrl);
    markDone(state, 'INPUTS');
  } else {
    ok(`inputs (project=${state.PROJECT_NAME}, db=${state.DB_NAME}, site=${state.SITE_URL})`);
  }

  const project = state.PROJECT_NAME;
  const dbName  = state.DB_NAME;
  const bucket  = state.BUCKET_NAME;
  const siteName = state.SITE_NAME;
  const siteUrl  = state.SITE_URL;

  // 2. tokens
  if (!isDone(state, 'TOKENS')) {
    say('Generating admin + indexnow tokens');
    saveKV(state, 'ADMIN_TOKEN',  randomBytes(32).toString('hex'));
    saveKV(state, 'INDEXNOW_KEY', randomBytes(32).toString('hex'));
    console.log(`  ADMIN_TOKEN  (paste into admin UI):  ${state.ADMIN_TOKEN}`);
    console.log(`  INDEXNOW_KEY (served at /<key>.txt): ${state.INDEXNOW_KEY}`);
    markDone(state, 'TOKENS');
  } else {
    ok('tokens');
  }
  const adminToken  = state.ADMIN_TOKEN;
  const indexnowKey = state.INDEXNOW_KEY;

  // 3. provider keys
  if (!isDone(state, 'PROVIDERS')) {
    console.log();
    console.log('  Workers AI is on by default. Add keys for other providers if you want');
    console.log('  them in the fallback chain. Leave blank to skip.');
    console.log();
    for (const [envName, label] of PROVIDER_PROMPTS) {
      const v = await askSecret(label);
      if (v) saveKV(state, envName, v);
    }
    markDone(state, 'PROVIDERS');
  } else {
    ok('provider keys');
  }
  const providerKeys = Object.fromEntries(
    PROVIDER_PROMPTS.map(([k]) => [k, state[k]]).filter(([, v]) => v),
  );

  // 4. .env
  if (!isDone(state, 'ENV')) {
    say('Writing .env');
    writeEnv({
      SITE_NAME: siteName, SITE_URL: siteUrl,
      ADMIN_TOKEN: adminToken, INDEXNOW_KEY: indexnowKey,
      ...providerKeys,
    });
    markDone(state, 'ENV');
  } else {
    ok('.env');
  }

  // 5. D1
  if (!isDone(state, 'D1')) {
    say(`Creating D1 database "${dbName}"`);
    const existing = resolveDbId(dbName);
    let dbId;
    if (existing) {
      warn(`D1 database ${dbName} already exists — using it`);
      dbId = existing;
    } else {
      run('wrangler', ['d1', 'create', dbName]);
      dbId = resolveDbId(dbName);
    }
    if (!dbId) die(`Could not resolve D1 ID for ${dbName}`);
    saveKV(state, 'DB_ID', dbId);
    console.log(`  database_id: ${dbId}`);
    markDone(state, 'D1');
  } else {
    ok(`D1 (${state.DB_ID})`);
  }
  const dbId = state.DB_ID;

  // 6. R2
  if (!isDone(state, 'R2')) {
    say(`Creating R2 bucket "${bucket}"`);
    const r2 = capture('wrangler', ['r2', 'bucket', 'create', bucket]);
    const combined = r2.stdout + r2.stderr;
    if (r2.code !== 0 && !combined.includes('already exists')) {
      die(combined.trim() || 'r2 bucket create failed');
    }
    if (combined.includes('already exists')) warn('R2 bucket already exists — using it');
    markDone(state, 'R2');
  } else {
    ok('R2 bucket');
  }

  // 7. patch wrangler.toml
  if (!isDone(state, 'TOML')) {
    say('Patching wrangler.toml');
    patchWranglerToml({ project, dbName, dbId, bucket });
    console.log('  wrangler.toml updated');
    markDone(state, 'TOML');
  } else {
    ok('wrangler.toml');
  }

  // 8. Pages project
  if (!isDone(state, 'PROJECT')) {
    say(`Ensuring Pages project "${project}" exists`);
    const list = capture('wrangler', ['pages', 'project', 'list']);
    const names = (list.stdout || '').split('\n').map((l) => l.trim().split(/\s+/)[1]).filter(Boolean);
    if (names.includes(project)) {
      warn('project already exists');
    } else {
      run('wrangler', ['pages', 'project', 'create', project, '--production-branch=main']);
    }
    markDone(state, 'PROJECT');
  } else {
    ok('Pages project');
  }

  // 9. schema
  if (!isDone(state, 'SCHEMA')) {
    say('Applying schema/init.sql');
    run('wrangler', ['d1', 'execute', dbName, '--remote', '--file=schema/init.sql']);
    markDone(state, 'SCHEMA');
  } else {
    ok('schema applied');
  }

  // 10. secrets
  if (!isDone(state, 'SECRETS')) {
    say(`Pushing secrets to Pages project "${project}"`);
    pushSecret('ADMIN_TOKEN',  adminToken,  project);
    pushSecret('INDEXNOW_KEY', indexnowKey, project);
    pushSecret('SITE_NAME',    siteName,    project);
    pushSecret('SITE_URL',     siteUrl,     project);
    for (const [k, v] of Object.entries(providerKeys)) pushSecret(k, v, project);
    markDone(state, 'SECRETS');
  } else {
    ok('secrets pushed');
  }

  // 11. deploy
  if (!isDone(state, 'DEPLOY')) {
    say('Deploying Pages site');
    run('wrangler', ['pages', 'deploy', 'public', `--project-name=${project}`, '--commit-dirty=true']);
    markDone(state, 'DEPLOY');
  } else {
    ok('Pages deployed');
  }

  // 12. cron Worker
  if (!isDone(state, 'CRON')) {
    console.log();
    if (await askYes('Deploy the cron Worker now?', true)) {
      say('Deploying cron Worker');
      const host = siteUrl.replace(/^https?:\/\//, '').split('/')[0];
      const cronDir = resolve(here, 'cron-worker');
      chdir(cronDir);
      run('wrangler', ['secret', 'put', 'ADMIN_TOKEN'], { stdinInput: adminToken });
      run('wrangler', ['secret', 'put', 'BLOG_URL'],    { stdinInput: `https://${host}/api/admin/blog` });
      run('wrangler', ['secret', 'put', 'PROG_URL'],    { stdinInput: `https://${host}/api/admin/prog/generate-next` });
      run('wrangler', ['deploy']);
      chdir(here);
    }
    markDone(state, 'CRON');
  } else {
    ok('cron Worker');
  }

  console.log();
  console.log('\x1b[1;32m╭──────────────────────────────────────────────╮\x1b[0m');
  console.log('\x1b[1;32m│\x1b[0m  \x1b[1m✓ All done\x1b[0m                                  \x1b[1;32m│\x1b[0m');
  console.log('\x1b[1;32m╰──────────────────────────────────────────────╯\x1b[0m\n');
  console.log(`  Admin URL  \x1b[1m${siteUrl}/admin\x1b[0m`);
  console.log(`  Token      \x1b[2m${adminToken}\x1b[0m`);
  console.log(`  State      \x1b[2m${STATE_FILE} (delete to re-run from scratch)\x1b[0m\n`);
  console.log('  \x1b[2mNext: open the admin URL, paste the token, then go to\x1b[0m');
  console.log('  \x1b[2mthe \x1b[0m\x1b[1mSettings\x1b[0m\x1b[2m tab and configure your brand voice.\x1b[0m\n');
  rl.close();
}

main().catch((e) => {
  rl.close();
  die(e?.message || String(e));
});
