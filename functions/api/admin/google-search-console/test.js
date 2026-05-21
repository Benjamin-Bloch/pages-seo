// POST /api/admin/google-search-console/test
//
// Live probe: triggers a sitemap re-submit against GSC and (when
// the user has the Indexing API toggle on) a per-URL ping for the
// site's homepage. Returns the raw result objects so the operator
// can see exactly what Google said.
//
// Always non-destructive — sitemap submissions are idempotent, and
// notifying the homepage URL is the equivalent of a "hello" ping.
//
// Auth: admin gate.

import { json } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';
import { onPublish, describeConfig } from '../../../_lib/google_indexing.js';
import { getSiteIdentity } from '../../../_lib/site_identity.js';

export const onRequestPost = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  const desc = await describeConfig(env);
  if (!desc.configured) {
    return json(400, { error: 'not_configured', detail: 'Paste the service-account JSON in /admin → Settings → Google Search Console first.' });
  }
  const id = await getSiteIdentity(env);
  const homeUrl = (id.url || '').replace(/\/$/, '') + '/';
  const result = await onPublish(env, [homeUrl]);
  return json(200, { ok: true, config: desc, result });
};
