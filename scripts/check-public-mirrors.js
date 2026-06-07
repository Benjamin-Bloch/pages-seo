#!/usr/bin/env node
// Build-time guard for the Pages public/ directory.
//
// Cloudflare's Workers Builds CI refuses any directory that contains
// symlinks (the "build output directory contains links to files that
// can't be accessed" error). Local `wrangler pages deploy` follows
// symlinks silently, so a setup that works on a maintainer's machine
// can break in CI. This script blocks both failure modes:
//
//   1. Any symlink under public/ → exit 1 with the offending path.
//   2. Any file under public/ that's a stale mirror of a canonical
//      source (AGENTS.md, .claude/skills, .github/prompts) → exit 1
//      with a one-line `cp` command the operator can paste to resync.
//
// Wire this into the build chain (package.json `predeploy` or
// `bundle-schema`) so CI fails fast with an actionable message
// instead of the cryptic Cloudflare error.

import { readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(REPO_ROOT, 'public');

// Canonical source → public mirror. When a project ships one file
// in two places (because canonical tools look for it at the root,
// but Pages serves it from public/), the mirror has to be kept in
// sync by hand. This script catches drift.
const MIRRORED = [
  { src: 'AGENTS.md',
    pub: 'public/AGENTS.md' },
  { src: '.claude/skills/pages-seo/SKILL.md',
    pub: 'public/skills/pages-seo/SKILL.md' },
  { src: '.github/prompts/pages-seo-install.prompt.md',
    pub: 'public/prompts/pages-seo-install.prompt.md' },
  { src: '.github/prompts/pages-seo-update.prompt.md',
    pub: 'public/prompts/pages-seo-update.prompt.md' },
  { src: '.github/prompts/pages-seo-repair.prompt.md',
    pub: 'public/prompts/pages-seo-repair.prompt.md' },
];

const errors = [];

// ── Check 1: no symlinks anywhere under public/ ─────────────────
// Pure-Node walk — no shell, no child_process. Uses lstatSync so a
// symlink reports as a symlink rather than being resolved to its
// target (which is what Cloudflare's CI complains about).
function walkForLinks(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isSymbolicLink()) {
        out.push(p);
        continue;
      }
      if (e.isDirectory()) stack.push(p);
    }
  }
  return out;
}
const links = walkForLinks(PUBLIC_DIR);
for (const link of links) {
  errors.push(
    `  symlink in public/ — Cloudflare Workers Builds rejects this:\n` +
    `    ${relative(REPO_ROOT, link)}\n` +
    `  fix: rm "${relative(REPO_ROOT, link)}" && cp <target> "${relative(REPO_ROOT, link)}"`
  );
}

// ── Check 2: canonical sources match their public mirrors ──────
for (const { src, pub } of MIRRORED) {
  const srcPath = join(REPO_ROOT, src);
  const pubPath = join(REPO_ROOT, pub);
  if (!existsSync(srcPath)) continue;        // not all repos have every file
  if (!existsSync(pubPath)) {
    errors.push(
      `  missing public mirror of "${src}"\n` +
      `  fix: cp "${src}" "${pub}"`
    );
    continue;
  }
  // lstat catches a symlink survived; statSync follows it. We've
  // already failed for symlinks above, so here just compare bytes.
  const srcBuf = readFileSync(srcPath);
  const pubBuf = readFileSync(pubPath);
  if (Buffer.compare(srcBuf, pubBuf) !== 0) {
    errors.push(
      `  drift: "${pub}" no longer matches "${src}"\n` +
      `  fix: cp "${src}" "${pub}"`
    );
  }
}

if (errors.length) {
  console.error('check-public-mirrors: ' + errors.length + ' issue(s):\n');
  console.error(errors.join('\n\n'));
  process.exit(1);
}
console.log('check-public-mirrors: ok');
