// Brand DNA — generate, get, and save.
//
// POST /api/admin/brand-dna  { url, provider? }   → scrape + generate 4 fields,
//   return JSON. Does NOT persist; admin reviews + edits, then PUTs.
//
// PUT  /api/admin/brand-dna  { business_type, voice_tone, target_audience,
//                              key_themes, topics_to_avoid, service_area,
//                              source_url? }     → save to settings.
//
// GET  /api/admin/brand-dna                      → load current saved DNA.
//
// Generation flow:
//   1. Scrape the URL (homepage only) via scrape.js.
//   2. Build a brief that tells the LLM to behave like a brand strategist.
//   3. Call the existing AI provider chain — same providers as blog gen.
//   4. Parse + sanitise + return without writing.
//
// Why two-step (generate, then save): the LLM output should always be
// reviewed by a human before going into the prompt pipeline.

import { json, nowSec, audit } from '../../_lib/util.js';
import { adminGate } from '../../_lib/auth.js';
import { scrapeUrl, scrapeToPromptInput } from '../../_lib/scrape.js';
import { loadSettings, setSetting } from '../../_lib/settings.js';
// recordUsage + estimateTokens imported below.

const BRAND_DNA_KEYS = [
  'brand_business_type',
  'brand_voice_tone',
  'brand_target_audience',
  'brand_key_themes',
  'brand_topics_to_avoid',
  'brand_service_area',
];

function buildBrandPrompt(scrapeBlock, hints) {
  const serviceAreaHint = hints?.service_area
    ? `The operator has specified service area: "${hints.service_area}" — keep that exactly.`
    : 'Suggest a service_area only if it is unambiguous from the content. Otherwise return an empty string.';
  const topicsHint = hints?.topics_to_avoid
    ? `The operator has specified topics to avoid: "${hints.topics_to_avoid}" — keep that exactly.`
    : 'topics_to_avoid is optional. Leave it empty unless the source clearly signals subjects the brand should never touch (e.g. competitor names, off-strategy product lines).';

  return [
    'You are an experienced brand strategist analysing a business based on its website.',
    'Read the scraped homepage content below and produce a structured Brand DNA.',
    'Be specific, concrete, and grounded in what the page actually says — do NOT invent claims.',
    'If a section can\'t be confidently inferred, return an empty string for that field.',
    '',
    '## Scraped content',
    scrapeBlock,
    '',
    '## What to produce',
    '- business_type: 4–8 sentences describing what the business does, its model, its differentiators, and what kind of customer it pursues. Read like a brief written by someone who understands the industry, not a marketing blurb.',
    '- voice_tone: 2–4 sentences describing the brand voice as a writer should use it. Note tone, register, what to emphasise, what to avoid. Make it actionable for a content writer.',
    '- target_audience: 3–6 sentences. Demographics, psychographics, intent. Include both the primary segment and any secondary segments. Note what jobs the customer is hiring this brand to do.',
    '- key_themes: 4–10 short topic phrases the content engine should cover. One per line, short noun phrases (e.g. "preventive dentistry", "emergency dental appointments").',
    '- service_area: ' + serviceAreaHint,
    '- topics_to_avoid: ' + topicsHint,
    '',
    '## Output format',
    'Return STRICT JSON only — no markdown fences, no prose outside the braces:',
    '{',
    '  "business_type": "...",',
    '  "voice_tone": "...",',
    '  "target_audience": "...",',
    '  "key_themes": "theme one\\ntheme two\\ntheme three",',
    '  "service_area": "...",',
    '  "topics_to_avoid": "..."',
    '}',
    'Use real newlines inside body strings, but escape them as \\n in JSON.',
    'Do not wrap output in code fences.',
  ].join('\n');
}

// We re-use the existing provider registry — same fallback chain, same
// looseJsonParse, same control-character tolerance.
import { listProviders, vaultedEnv } from '../../_lib/ai.js';
import { recordUsage, estimateTokens } from '../../_lib/usage.js';

// Direct provider call. We don't want to go through generateContent
// because that runs shapeArticle which assumes blog-post shape. We
// build a tiny shim: hit the same env.AI / fetch path with our prompt
// and parse the JSON directly.
//
// Workers AI is the default if it's bound; otherwise fall back to the
// first configured cloud provider.
async function callForBrandDNA(env, prompt, preferredProvider) {
  // Overlay any vault-stored API keys on top of env so cloud providers
  // configured from the admin dashboard work without restart.
  const overlayed = await vaultedEnv(env);
  const available = (await listProviders(overlayed)).text;
  if (!available.length) throw new Error('no_text_providers_configured');

  // Honour the explicit preference if it's currently usable.
  const order = preferredProvider && available.includes(preferredProvider)
    ? [preferredProvider, ...available.filter((p) => p !== preferredProvider)]
    : available;

  const settings = await loadSettings(env);
  const errs = [];
  for (const name of order) {
    try {
      const { text, model } = await runProvider(overlayed, name, prompt);
      // Brand-DNA generations don't always have usage in the raw return,
      // so we estimate. The Workers AI path returns no usage at all,
      // OpenAI's Responses API can; we treat both conservatively.
      await recordUsage(env, settings, {
        provider: name, model,
        prompt_tokens: estimateTokens(prompt),
        completion_tokens: estimateTokens(text),
        estimated: true,
        kind: 'brand-dna', source: 'admin-brand-dna',
      });
      return { provider: name, parsed: looseJsonParse(text) };
    } catch (e) {
      errs.push(`${name}: ${String(e?.message || e).slice(0, 120)}`);
    }
  }
  await recordUsage(env, settings, {
    provider: order[0] || 'unknown', kind: 'brand-dna', source: 'admin-brand-dna',
    ok: false, error: errs.join(' | '),
  });
  throw new Error('all_providers_failed — ' + errs.join(' | '));
}

// Per-provider raw text generation (no JSON shape assumption — caller parses).
async function runProvider(env, name, prompt) {
  const SYS = 'You are a brand strategist. You return strict JSON only.';
  switch (name) {
    case 'workers-ai': {
      const model = env.WORKERS_AI_TEXT_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
      const r = await env.AI.run(model, {
        messages: [{ role: 'system', content: SYS }, { role: 'user', content: prompt }],
        max_tokens: 4096,
      });
      const raw = r?.response ?? r?.result?.response ?? r;
      let text = '';
      if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.business_type) {
        text = JSON.stringify(raw);
      } else {
        text = typeof raw === 'string' ? raw : JSON.stringify(raw);
      }
      return { text, model };
    }
    case 'openai': {
      const model = env.OPENAI_TEXT_MODEL || 'gpt-5';
      const r = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, instructions: SYS, input: prompt, text: { format: { type: 'json_object' } } }),
      });
      if (!r.ok) throw new Error('openai_http_' + r.status);
      const d = await r.json();
      if (d.output_text) return { text: d.output_text, model };
      for (const item of (d.output || [])) {
        if (item.type !== 'message') continue;
        for (const c of (item.content || [])) if (c.type === 'output_text' && c.text) return { text: c.text, model };
      }
      throw new Error('openai_empty');
    }
    case 'anthropic': {
      const model = env.ANTHROPIC_TEXT_MODEL || 'claude-opus-4-7';
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 4096, system: SYS, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!r.ok) throw new Error('anthropic_http_' + r.status);
      const d = await r.json();
      return { text: (d.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''), model };
    }
    case 'gemini': {
      const model = env.GEMINI_TEXT_MODEL || 'gemini-2.5-pro';
      const u = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
      const r = await fetch(u, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYS }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.6 },
        }),
      });
      if (!r.ok) throw new Error('gemini_http_' + r.status);
      const d = await r.json();
      return { text: (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join(''), model };
    }
    case 'groq':
    case 'deepseek':
    case 'mistral':
    case 'together':
    case 'cerebras': {
      const map = {
        groq:     { url: 'https://api.groq.com/openai/v1/chat/completions', key: env.GROQ_API_KEY,     model: env.GROQ_TEXT_MODEL     || 'llama-3.3-70b-versatile' },
        deepseek: { url: 'https://api.deepseek.com/v1/chat/completions',    key: env.DEEPSEEK_API_KEY, model: env.DEEPSEEK_TEXT_MODEL || 'deepseek-chat' },
        mistral:  { url: 'https://api.mistral.ai/v1/chat/completions',      key: env.MISTRAL_API_KEY,  model: env.MISTRAL_TEXT_MODEL  || 'mistral-large-latest' },
        together: { url: 'https://api.together.xyz/v1/chat/completions',    key: env.TOGETHER_API_KEY, model: env.TOGETHER_TEXT_MODEL || 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
        cerebras: { url: 'https://api.cerebras.ai/v1/chat/completions',     key: env.CEREBRAS_API_KEY, model: env.CEREBRAS_TEXT_MODEL || 'llama-3.3-70b' },
      }[name];
      const r = await fetch(map.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${map.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: map.model,
          messages: [{ role: 'system', content: SYS }, { role: 'user', content: prompt }],
          temperature: 0.6,
          response_format: { type: 'json_object' },
        }),
      });
      if (!r.ok) throw new Error(`${name}_http_` + r.status);
      const d = await r.json();
      return { text: d?.choices?.[0]?.message?.content || '', model: map.model };
    }
    default:
      throw new Error('unknown_provider: ' + name);
  }
}

// Lift the helper used elsewhere. Inlined to avoid a circular import.
function looseJsonParse(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  try { return JSON.parse(s); } catch { /* try cleanup */ }
  // Tolerate raw control characters inside string literals.
  let out = '', inStr = false, escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]; const code = ch.charCodeAt(0);
    if (!inStr) { out += ch; if (ch === '"') inStr = true; continue; }
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === '\\') { out += ch; escaped = true; continue; }
    if (ch === '"') { out += ch; inStr = false; continue; }
    if (code < 0x20) {
      out += code === 0x0a ? '\\n' : code === 0x0d ? '\\r' : code === 0x09 ? '\\t' : ('\\u' + code.toString(16).padStart(4, '0'));
      continue;
    }
    out += ch;
  }
  return JSON.parse(out);
}

function sanitiseField(s, max) {
  return String(s || '').trim().slice(0, max);
}

// ─── handlers ─────────────────────────────────────────────────────

export const onRequestGet = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  const s = await loadSettings(env);
  return json(200, {
    ok: true,
    brand: {
      business_type:    s.brand_business_type,
      voice_tone:       s.brand_voice_tone,
      target_audience:  s.brand_target_audience,
      key_themes:       s.brand_key_themes,
      topics_to_avoid:  s.brand_topics_to_avoid,
      service_area:     s.brand_service_area,
      source_url:       s.brand_source_url,
      generated_at:     s.brand_generated_at,
    },
  });
};

export const onRequestPost = async ({ env, request, waitUntil }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }
  const url = String(body?.url || '').trim();
  if (!url) return json(400, { error: 'missing_url' });

  let scrape;
  try {
    scrape = await scrapeUrl(url);
  } catch (e) {
    return json(502, { error: 'scrape_failed', detail: String(e?.message || e) });
  }

  if (!scrape.body_text || scrape.body_text.length < 200) {
    return json(422, {
      error: 'scrape_too_thin',
      detail: 'The page returned < 200 chars of usable body content. Most likely a JS-only site. Try a different URL (e.g. /about) or paste content manually.',
      scrape_summary: { title: scrape.title, headings: scrape.headings, body_chars: scrape.body_text.length },
    });
  }

  const prompt = buildBrandPrompt(scrapeToPromptInput(scrape), {
    service_area: body.service_area || '',
    topics_to_avoid: body.topics_to_avoid || '',
  });

  let result;
  try {
    result = await callForBrandDNA(env, prompt, body.provider);
  } catch (e) {
    return json(502, { error: 'generation_failed', detail: String(e?.message || e) });
  }
  const p = result.parsed || {};

  // Trim every field to sane limits. The brand DNA flows into every
  // subsequent prompt so we can't let it eat the context window.
  const brand = {
    business_type:    sanitiseField(p.business_type, 2_400),
    voice_tone:       sanitiseField(p.voice_tone, 1_200),
    target_audience:  sanitiseField(p.target_audience, 2_000),
    key_themes:       sanitiseField(p.key_themes, 1_200),
    topics_to_avoid:  sanitiseField(body.topics_to_avoid || p.topics_to_avoid, 600),
    service_area:     sanitiseField(body.service_area    || p.service_area, 400),
    source_url:       scrape.url,
    provider:         result.provider,
  };
  waitUntil(audit(env, 'admin', 'brand_dna_generate', null, { url: scrape.url, provider: result.provider }));
  return json(200, { ok: true, brand, scrape_summary: {
    title: scrape.title,
    body_chars: scrape.body_text.length,
    h2_count: scrape.headings.h2.length,
  } });
};

export const onRequestPut = async ({ env, request, waitUntil }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'bad_json' }); }

  const fields = {
    brand_business_type:    sanitiseField(body.business_type, 2_400),
    brand_voice_tone:       sanitiseField(body.voice_tone, 1_200),
    brand_target_audience:  sanitiseField(body.target_audience, 2_000),
    brand_key_themes:       sanitiseField(body.key_themes, 1_200),
    brand_topics_to_avoid:  sanitiseField(body.topics_to_avoid, 600),
    brand_service_area:     sanitiseField(body.service_area, 400),
    brand_source_url:       sanitiseField(body.source_url, 400),
    brand_generated_at:     new Date().toISOString(),
  };
  for (const [k, v] of Object.entries(fields)) await setSetting(env, k, v);
  audit(env, 'admin', 'brand_dna_save', null, { source_url: fields.brand_source_url });

  // Auto-plan the content calendar on first save (or any save when the
  // calendar is empty). Runs in the background so the PUT returns fast.
  // Skipped if the operator already has future slots — the calendar tab
  // has its own "Regenerate plan" button for explicit re-plans.
  // Skip the background plan if the caller is the onboarding wizard —
  // it fires its own /calendar/plan at step 4, and racing two of them
  // makes the wizard's preview start from whatever date the background
  // run already filled up to.
  let planned = false;
  const skipAutoPlan = !!body?.skip_auto_plan;
  try {
    if (!skipAutoPlan) {
      const today = new Date().toISOString().slice(0, 10);
      const future = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM content_calendar
          WHERE scheduled_for >= ? AND status IN ('scheduled','generating','draft')`
      ).bind(today).first().catch(() => ({ n: 0 }));
      if (!future || !future.n) {
        planned = true;
        const url = new URL(request.url);
        waitUntil(
          fetch(`${url.origin}/api/admin/calendar/plan`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              cookie: request.headers.get('cookie') || '',
            },
            body: JSON.stringify({ days: 28, replace: false }),
          }).catch(() => {})
        );
      }
    }
  } catch { /* best-effort; the calendar tab can always plan manually */ }

  return json(200, { ok: true, saved: BRAND_DNA_KEYS.length, planning: planned });
};
