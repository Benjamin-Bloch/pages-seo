// POST /api/admin/calendar/plan
//   { days?: number = 28, provider?, replace?: boolean = false }
//
// Auto-plans N days of upcoming articles from the saved Brand DNA.
// Thin wrapper around _lib/calendar_planner.js so cron's JIT path and
// the operator's "Regenerate" button share the same code.

import { json, audit } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';
import { planCalendar } from '../../../_lib/calendar_planner.js';

export const onRequestPost = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  let body = {};
  try { body = await request.json(); } catch { /* allow empty */ }
  const days     = Math.max(1, Math.min(60, parseInt(body.days, 10) || 28));
  const replace  = !!body.replace;
  const provider = String(body.provider || '').trim() || '';

  try {
    const result = await planCalendar(env, { days, replace, preferredProvider: provider });
    await audit(env, 'admin', 'calendar.plan', '', JSON.stringify({ days, inserted: result.slots.length, replace }));
    return json(200, { ok: true, inserted: result.slots.length, slots: result.slots });
  } catch (e) {
    if (e.code === 'no_brand_dna') {
      return json(422, { error: 'no_brand_dna', detail: 'Save your Brand DNA before planning.' });
    }
    if (e.code === 'planner_empty') {
      return json(502, { error: 'planner_empty' });
    }
    return json(502, { error: 'planner_failed', detail: String(e?.message || e) });
  }
};
