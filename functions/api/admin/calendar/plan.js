// POST /api/admin/calendar/plan
//   { days?: number = 28, provider?, replace?: boolean = false }
//
// Auto-plans N days of upcoming articles from the saved Brand DNA.
// Behaviour:
//   - Reads brand DNA from settings. 422 if missing.
//   - Asks the LLM for `days` distinct article ideas in JSON.
//   - Writes one slot per day starting tomorrow, skipping any date that
//     already has an active (scheduled|generating|draft) slot.
//   - `replace: true` wipes future scheduled-status slots first.

import { json, nowSec, newId, audit } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';
import { loadSettings } from '../../../_lib/settings.js';
import { callRawLLM } from '../../../_lib/raw_llm.js';

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
function addDays(d, n) {
  const x = new Date(d.getTime());
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

function buildPlannerPrompt(brand, days, recentTitles) {
  const themes = String(brand.brand_key_themes || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  const avoid  = String(brand.brand_topics_to_avoid || '').trim();
  const recentBlock = recentTitles.length
    ? `\nRecently planned or published titles (DO NOT repeat these or near-duplicates):\n${recentTitles.map((t) => '  - ' + t).join('\n')}`
    : '';

  return [
    `You are an editorial planner for a content marketing programme.`,
    `Plan ${days} distinct blog post ideas for the brand described below.`,
    `Each idea must be:`,
    `  - directly relevant to the brand's audience and themes,`,
    `  - SEO-friendly (target one clear primary keyword phrase),`,
    `  - non-overlapping with the other ideas in this batch,`,
    `  - specific enough that a writer could draft a 900–1300 word article from just the title + angle.`,
    `Mix evergreen pillars with more focused, long-tail topics.`,
    '',
    `## Brand`,
    `Business: ${brand.brand_business_type || '(unspecified)'}`,
    `Voice: ${brand.brand_voice_tone || '(unspecified)'}`,
    `Audience: ${brand.brand_target_audience || '(unspecified)'}`,
    themes.length ? `Themes to cover: ${themes.join(', ')}` : '',
    brand.brand_service_area ? `Service area: ${brand.brand_service_area}` : '',
    avoid ? `Topics to avoid: ${avoid}` : '',
    recentBlock,
    '',
    `## Output format`,
    `Return STRICT JSON only — no markdown fences, no prose outside the braces:`,
    `{`,
    `  "ideas": [`,
    `    { "title": "...", "primary_keyword": "...", "angle": "1-2 sentences of editorial direction" },`,
    `    ...`,
    `  ]`,
    `}`,
    `Return exactly ${days} items. Titles must be unique. Keep titles under 80 chars.`,
  ].filter(Boolean).join('\n');
}

export const onRequestPost = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  let body = {};
  try { body = await request.json(); } catch { /* allow empty */ }
  const days = Math.max(1, Math.min(60, parseInt(body.days, 10) || 28));
  const replace = !!body.replace;
  const provider = String(body.provider || '').trim() || '';

  const settings = await loadSettings(env);
  if (!settings.brand_business_type && !settings.brand_target_audience) {
    return json(422, { error: 'no_brand_dna', detail: 'Save your Brand DNA before planning.' });
  }

  // Recent titles to discourage repetition: last 60 days of posts + any
  // currently-scheduled slots.
  const recent = [];
  const recentPosts = await env.DB.prepare(
    `SELECT title FROM blog_posts WHERE status='published' ORDER BY published_at DESC LIMIT 40`
  ).all().catch(() => ({ results: [] }));
  const futureSlots = await env.DB.prepare(
    `SELECT title FROM content_calendar
      WHERE status IN ('scheduled','generating','draft') ORDER BY scheduled_for ASC LIMIT 40`
  ).all().catch(() => ({ results: [] }));
  for (const r of (recentPosts.results || [])) recent.push(r.title);
  for (const r of (futureSlots.results || [])) recent.push(r.title);

  // Wipe future scheduled-status slots first if asked.
  if (replace) {
    const today = isoDate(new Date());
    await env.DB.prepare(
      `DELETE FROM content_calendar
        WHERE status = 'scheduled' AND scheduled_for >= ?`
    ).bind(today).run();
  }

  // Find which future dates are already taken by an active slot so we
  // skip them when distributing the new ideas.
  const today = new Date(isoDate(new Date()) + 'T00:00:00Z');
  const horizon = addDays(today, days * 2);
  const takenRows = await env.DB.prepare(
    `SELECT scheduled_for FROM content_calendar
      WHERE status IN ('scheduled','generating','draft','published')
        AND scheduled_for >= ? AND scheduled_for <= ?`
  ).bind(isoDate(today), isoDate(horizon)).all().catch(() => ({ results: [] }));
  const taken = new Set((takenRows.results || []).map((r) => r.scheduled_for));

  const prompt = buildPlannerPrompt(settings, days, recent);
  let parsed;
  try {
    const out = await callRawLLM(env, prompt, {
      sys: 'You are an editorial planner. Return strict JSON only.',
      preferredProvider: provider,
      kind: 'calendar-plan',
      source: 'admin-calendar',
    });
    parsed = out.parsed;
  } catch (e) {
    return json(502, { error: 'planner_failed', detail: String(e?.message || e) });
  }

  const ideas = Array.isArray(parsed?.ideas) ? parsed.ideas : [];
  if (!ideas.length) return json(502, { error: 'planner_empty' });

  // Distribute ideas across the next `days` days, starting tomorrow,
  // skipping already-taken dates.
  const slots = [];
  let cursor = addDays(today, 1);
  let safety = 0;
  for (const raw of ideas) {
    while (taken.has(isoDate(cursor))) {
      cursor = addDays(cursor, 1);
      if (++safety > days * 3) break;
    }
    const title = String(raw?.title || '').trim().slice(0, 200);
    if (!title) { cursor = addDays(cursor, 1); continue; }
    slots.push({
      id: newId(),
      scheduled_for: isoDate(cursor),
      title,
      primary_keyword: String(raw?.primary_keyword || '').trim().slice(0, 120) || null,
      angle:           String(raw?.angle || '').trim().slice(0, 500) || null,
    });
    taken.add(isoDate(cursor));
    cursor = addDays(cursor, 1);
  }

  const now = nowSec();
  // Bulk insert. D1 doesn't support multi-row VALUES tuples reliably in
  // bind mode, so loop one statement at a time inside a batch.
  const batch = slots.map((s) =>
    env.DB.prepare(
      `INSERT INTO content_calendar
         (id, scheduled_for, title, primary_keyword, angle, status, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'scheduled', 'planner', ?, ?)`
    ).bind(s.id, s.scheduled_for, s.title, s.primary_keyword, s.angle, now, now)
  );
  if (batch.length) await env.DB.batch(batch);

  await audit(env, 'admin', 'calendar.plan', '', JSON.stringify({ days, inserted: slots.length, replace }));
  return json(200, { ok: true, inserted: slots.length, slots });
};
