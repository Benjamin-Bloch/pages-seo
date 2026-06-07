// GET /api/admin/notices
//
// Returns the active (undismissed) admin notices. The admin SPA
// polls this on load and renders any returned notices as banners.
//
// Response (200):
//   {
//     ok: true,
//     count: <n>,
//     notices: [
//       {
//         id, kind, severity, title, detail,
//         action_url, action_label, created_at
//       },
//       ...
//     ]
//   }
//
// 503 if DB binding is missing (rare).

import { json } from '../../_lib/util.js';
import { adminGate } from '../../_lib/auth.js';

export const onRequestGet = async ({ env, request }) => {
  const gate = await adminGate(env, request);
  if (gate) return gate;
  if (!env?.DB) return json(503, { ok: false, error: 'no_db_binding' });

  try {
    const rows = await env.DB.prepare(
      `SELECT id, kind, severity, title, detail, action_url, action_label, created_at
         FROM admin_notices
        WHERE dismissed_at IS NULL
        ORDER BY created_at DESC
        LIMIT 50`
    ).all();
    const notices = rows?.results || [];
    return json(200, { ok: true, count: notices.length, notices }, {
      'cache-control': 'no-store',
    });
  } catch (e) {
    // Most likely cause: the admin_notices table hasn't been created
    // yet (schema migration didn't run). Return empty rather than
    // 500 so the dashboard works on partially-migrated installs.
    return json(200, { ok: true, count: 0, notices: [], note: 'table_missing' });
  }
};
