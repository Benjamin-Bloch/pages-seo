// Content-calendar planner core. Pure-ish: takes the env + how many
// ideas to plan, returns the new slots already inserted into D1.
//
// Used by:
//   POST /api/admin/calendar/plan  → operator-driven re-plan.
//   POST /api/admin/blog/start     → JIT fallback when the cron asks
//                                    `from_calendar:true` but the
//                                    calendar is empty. Plans exactly
//                                    one slot for today and returns
//                                    it so the chain can claim it.

import { nowSec, newId } from './util.js';
import { loadSettings } from './settings.js';
import { callRawLLM } from './raw_llm.js';

function isoDate(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));
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

async function recentTitleList(env, limit = 40) {
  const recent = [];
  const recentPosts = await env.DB.prepare(
    `SELECT title FROM blog_posts WHERE status='published' ORDER BY published_at DESC LIMIT ?`
  ).bind(limit).all().catch(() => ({ results: [] }));
  const futureSlots = await env.DB.prepare(
    `SELECT title FROM content_calendar
      WHERE status IN ('scheduled','generating','draft') ORDER BY scheduled_for ASC LIMIT ?`
  ).bind(limit).all().catch(() => ({ results: [] }));
  for (const r of (recentPosts.results || [])) recent.push(r.title);
  for (const r of (futureSlots.results || [])) recent.push(r.title);
  return recent;
}

// Operator-facing batch planner. Distributes `days` ideas starting at
// `startOffset` days from today, skipping dates already taken.
export async function planCalendar(env, { days = 28, replace = false, preferredProvider = '', startOffset = 1, source = 'admin-calendar' } = {}) {
  const settings = await loadSettings(env);
  if (!settings.brand_business_type && !settings.brand_target_audience) {
    const err = new Error('no_brand_dna');
    err.code = 'no_brand_dna';
    throw err;
  }

  const today = new Date(isoDate(new Date()) + 'T00:00:00Z');
  if (replace) {
    await env.DB.prepare(
      `DELETE FROM content_calendar WHERE status = 'scheduled' AND scheduled_for >= ?`
    ).bind(isoDate(today)).run();
  }

  const horizon = addDays(today, days * 2 + startOffset);
  const takenRows = await env.DB.prepare(
    `SELECT scheduled_for FROM content_calendar
      WHERE status IN ('scheduled','generating','draft','published')
        AND scheduled_for >= ? AND scheduled_for <= ?`
  ).bind(isoDate(today), isoDate(horizon)).all().catch(() => ({ results: [] }));
  const taken = new Set((takenRows.results || []).map((r) => r.scheduled_for));

  const prompt = buildPlannerPrompt(settings, days, await recentTitleList(env));
  const out = await callRawLLM(env, prompt, {
    sys: 'You are an editorial planner. Return strict JSON only.',
    preferredProvider, kind: 'calendar-plan', source,
  });
  const ideas = Array.isArray(out.parsed?.ideas) ? out.parsed.ideas : [];
  if (!ideas.length) {
    const err = new Error('planner_empty');
    err.code = 'planner_empty';
    throw err;
  }

  const slots = [];
  let cursor = addDays(today, startOffset);
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

  if (!slots.length) return { slots: [], provider: out.provider };

  const now = nowSec();
  const batch = slots.map((s) =>
    env.DB.prepare(
      `INSERT INTO content_calendar
         (id, scheduled_for, title, primary_keyword, angle, status, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'scheduled', 'planner', ?, ?)`
    ).bind(s.id, s.scheduled_for, s.title, s.primary_keyword, s.angle, now, now)
  );
  await env.DB.batch(batch);
  return { slots, provider: out.provider };
}

// Just-in-time fallback. Plans ONE idea for today (or whatever date we
// pass) and returns the freshly-inserted slot row. Cron uses this when
// it asks `from_calendar:true` and finds the cupboard bare. Cheap: one
// LLM call, no operator interaction.
export async function planSingleForToday(env, { preferredProvider = '', source = 'cron-jit' } = {}) {
  const settings = await loadSettings(env);
  if (!settings.brand_business_type && !settings.brand_target_audience) {
    // No brand DNA = no useful plan. Caller should fall back to legacy
    // pickNextTopic() instead of erroring.
    return null;
  }
  const today = isoDate(new Date());
  // If a slot already exists for today, don't double-up.
  const existing = await env.DB.prepare(
    `SELECT id FROM content_calendar WHERE scheduled_for = ? AND status='scheduled' LIMIT 1`
  ).bind(today).first().catch(() => null);
  if (existing) {
    return env.DB.prepare(`SELECT * FROM content_calendar WHERE id = ?`).bind(existing.id).first();
  }

  const prompt = buildPlannerPrompt(settings, 1, await recentTitleList(env, 30));
  let out;
  try {
    out = await callRawLLM(env, prompt, {
      sys: 'You are an editorial planner. Return strict JSON only.',
      preferredProvider, kind: 'calendar-plan', source,
    });
  } catch {
    return null;
  }
  const idea = Array.isArray(out.parsed?.ideas) ? out.parsed.ideas[0] : null;
  const title = String(idea?.title || '').trim().slice(0, 200);
  if (!title) return null;

  const id  = newId();
  const now = nowSec();
  await env.DB.prepare(
    `INSERT INTO content_calendar
       (id, scheduled_for, title, primary_keyword, angle, status, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'scheduled', 'jit', ?, ?)`
  ).bind(
    id, today, title,
    String(idea?.primary_keyword || '').trim().slice(0, 120) || null,
    String(idea?.angle || '').trim().slice(0, 500) || null,
    now, now,
  ).run();
  return env.DB.prepare(`SELECT * FROM content_calendar WHERE id = ?`).bind(id).first();
}
