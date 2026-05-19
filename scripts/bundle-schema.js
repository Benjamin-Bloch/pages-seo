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
const escaped = sql.replace(/`/g, '\\`').replace(/\${/g, '\\${');

const out = `// Auto-generated from schema/init.sql. Do not edit by hand —
// re-run \`node scripts/bundle-schema.js\` after editing the SQL.
// Kept in JS so /api/setup can apply it on first run without
// the operator running wrangler d1 execute.

export const SCHEMA_SQL = \`
${escaped}\`;
`;

writeFileSync(join(root, 'functions/_lib/schema.js'), out);
console.log(`✓ wrote functions/_lib/schema.js (${sql.split('\n').length} SQL lines)`);
