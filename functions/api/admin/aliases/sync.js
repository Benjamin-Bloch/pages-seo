// POST /api/admin/aliases/sync
// Refreshes the sitemap-kind aliases by scanning published blog posts
// and programmatic pages. Manual aliases are untouched.

import { json, audit } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';
import { syncSitemapAliases } from '../../../_lib/links/aliases.js';

export const onRequestPost = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  const result = await syncSitemapAliases(env);
  await audit(env, 'admin', 'aliases.sync', '', JSON.stringify(result));
  return json(200, { ok: true, ...result });
};
