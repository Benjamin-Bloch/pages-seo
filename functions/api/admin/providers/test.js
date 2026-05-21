// POST /api/admin/providers/test
//
// Probe one or all configured AI providers with a tiny prompt so the
// operator can verify their keys work without waiting for the next
// blog cron run to either succeed or fail.
//
// Body (optional): { name: 'openai' }
//   When omitted, every text provider with a configured key/binding
//   gets pinged. Workers AI is always present, so the list will
//   include at least one entry. Each ping is sequential to avoid
//   a thundering-herd against a single rate limit; total wall time
//   is bounded by the slowest provider (~3s per provider in the
//   worst case).
//
// Response:
//   { ok: true,
//     results: [
//       { name, ok, ms, sample?, error?, detail? }, ...
//     ]
//   }
import { json, audit } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';
import { listProviders, pingTextProvider } from '../../../_lib/ai.js';

export const onRequestPost = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  let body = {};
  try { body = await request.json(); } catch { /* allow empty body */ }
  const wanted = String(body?.name || '').trim();

  let names;
  if (wanted) {
    names = [wanted];
  } else {
    const list = await listProviders(env);
    names = list?.text || [];
  }

  const results = [];
  for (const n of names) {
    const r = await pingTextProvider(env, n);
    results.push({ name: n, ...r });
  }

  audit(env, 'admin', 'provider_test', null, {
    tested: names.length,
    failed: results.filter((r) => !r.ok).map((r) => r.name),
  });

  return json(200, { ok: true, results });
};
