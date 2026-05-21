#!/usr/bin/env node
// Bundles schema/init.sql into functions/_lib/schema.js so the
// /api/setup endpoint can apply it on first run without the operator
// running wrangler d1 execute. Re-run this script any time the SQL
// changes:
//
//   node scripts/bundle-schema.js
//
// CI / npm could call this automatically pre-deploy, but for now it's
// a manual step (the diff is obvious in PRs).

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sql  = readFileSync(join(root, 'schema/init.sql'), 'utf8');

// Escape so the SQL can be embedded inside a `${'`'}…${'`'}` template
// literal. ORDER MATTERS: backslashes first, then dollar-brace, then
// backticks. If you do backticks first you escape the backslash that
// was supposed to escape your future backtick, breaking the output
// when the input contains literal backticks or "\${" sequences.
// CodeQL flagged the old two-step replace as an incomplete escape
// for exactly this reason.
const escaped = sql
  .replace(/\\/g, '\\\\')   // 1. literal backslashes
  .replace(/`/g,  '\\`')    // 2. backticks (the template delimiter)
  .replace(/\$\{/g, '\\${'); // 3. ${ (the template interpolation start)

const out = `// Auto-generated from schema/init.sql. Do not edit by hand —
// re-run \`node scripts/bundle-schema.js\` after editing the SQL.
// Kept in JS so /api/setup can apply it on first run without
// the operator running wrangler d1 execute.

export const SCHEMA_SQL = \`
${escaped}\`;
`;

writeFileSync(join(root, 'functions/_lib/schema.js'), out);
console.log(`✓ wrote functions/_lib/schema.js (${sql.split('\n').length} SQL lines)`);
