// AI provider router.
//
// Supports a pluggable registry of providers. Workers AI is the default —
// it runs at the edge, free tier covers ~10k tokens/day, and is bound via
// the [ai] block in wrangler.toml (env.AI). Cloud providers (OpenAI,
// Anthropic, Gemini, Mistral, Groq, DeepSeek, Together, Cerebras) are
// opted-in by setting their API key as a Pages secret.
//
// Two public operations:
//   generateContent(env, { kind, seed, provider, brand })
//     → shapeArticle output (title/slug/body_markdown/...)
//   generateImage(env, { prompt, provider })
//     → { bytes (Uint8Array), ai_provider }
//
// `provider` is optional. When set, that provider is tried first; the
// rest of the configured providers are tried in order as a fallback.
// When omitted we use the default order (Workers AI first, then the
// cloud providers in alphabetical order).
//
// Adding a new text provider: append an entry to TEXT_PROVIDERS with
// { name, envKey, call }. `envKey` is the env-var holding the API key
// (omit for env.AI bindings). `call(env, prompt) → parsed JSON object`.

// ── prompt builders ────────────────────────────────────────────────────

function aliasBlock(aliases) {
  if (!aliases || !Object.keys(aliases).length) return '';
  const lines = Object.entries(aliases).map(([k, v]) => `  - "${k}" → ${v}`);
  return [
    'Internal link aliases — use these by their NAME inside markdown links,',
    'e.g. write [Sign up here](signup) and the system expands the URL:',
    lines.join('\n'),
    '',
  ].join('\n');
}

// Shared chunks used across both prompt builders.

const BANNED_PHRASES_BLOCK = [
  'BANNED PHRASES — never use these or any close variant:',
  '  - "in today\'s fast-paced", "in today\'s digital landscape", "in today\'s world"',
  '  - "elevate", "unlock", "leverage", "delve into", "navigate the complexities"',
  '  - "in conclusion", "to wrap up", "all in all"',
  '  - "game-changer", "cutting-edge", "state-of-the-art", "next-level"',
  '  - "robust", "seamless", "innovative", "revolutionary"',
  '  - "it\'s important to note", "it\'s worth mentioning", "it goes without saying"',
  '  - "whether you\'re a beginner or", "no matter your skill level"',
  '  - "ultimate guide", "comprehensive overview", "definitive resource"',
  '  - opening with "Are you...", "Have you ever...", "Imagine if..."',
  '  - any sentence that could appear in any article about any topic',
].join('\n');

const CONCRETENESS_BLOCK = [
  'CONCRETENESS RULES (this is the #1 thing — most AI writing fails here):',
  '  - Every paragraph must contain at least one specific number, brand name, year, price,',
  '    measurement, or named example. No "many people" — say "37% of buyers". No "a long time"',
  '    — say "since 2019". No "high-quality materials" — say "Carrara marble" or "Italian leather".',
  '  - When you make a claim, ground it: name the source ("according to Statista"),',
  '    cite the year, or give a real example.',
  '  - Use real product/brand/place names where relevant. Be specific. If you don\'t know a real one,',
  '    use a plausibly-real-sounding one rather than a generic placeholder.',
  '  - Comparisons must be quantified. Not "more expensive" but "around 2.3× the price".',
].join('\n');

function voiceBlock(brand) {
  const tone = brand?.tone || 'plain-spoken expert: direct, knowledgeable, no marketing fluff';
  const audience = brand?.audience || 'someone actively researching this topic, ready to buy or build, not a beginner';
  return [
    `VOICE: ${tone}`,
    `READER: ${audience}`,
    'Write like you\'re explaining to a smart friend who asked a real question. Short paragraphs.',
    'Vary sentence length (mix 4-word and 25-word sentences). Use contractions. No hedging.',
  ].join('\n');
}

// Renders the long-form brand DNA (business type, key themes, topics
// to avoid, service area) into a prompt block. Only emits sections
// that are actually populated — empty fields don't burn tokens.
function brandDNABlock(brand) {
  const out = [];
  if (brand?.business_type) {
    out.push('# Business context');
    out.push(String(brand.business_type).trim());
    out.push('');
  }
  if (brand?.key_themes) {
    out.push('# Key themes this brand covers');
    const themes = String(brand.key_themes)
      .split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    for (const t of themes) out.push(`- ${t}`);
    out.push('');
  }
  if (brand?.service_area) {
    out.push(`# Service area`);
    out.push(`This brand operates in: ${String(brand.service_area).trim()}.`);
    out.push('If location-relevant, mention this naturally. Do NOT invent service areas outside it.');
    out.push('');
  }
  if (brand?.topics_to_avoid) {
    out.push('# DO NOT mention');
    out.push(String(brand.topics_to_avoid).trim());
    out.push('Treat the above as off-strategy. Skip these topics entirely.');
    out.push('');
  }
  return out.join('\n');
}

function jsonSchemaBlock(primaryQueryHint = '...') {
  return [
    'Return STRICT JSON only — no markdown fences, no prose outside the braces. Shape:',
    '{',
    `  "primary_query": "${primaryQueryHint}",`,
    '  "secondary_keywords": "kw1, kw2, kw3, kw4, kw5",',
    '  "title": "...",',
    '  "slug": "...",',
    '  "meta_description": "...",',
    '  "body_markdown": "...",',
    '  "hero_image_prompt": "...",',
    '  "hero_image_alt": "..."',
    '}',
  ].join('\n');
}

function buildArticlePrompt(angle, brand) {
  const brandName = brand?.name || 'this site';
  const brandUrl = brand?.url || '/';
  const cta = brand?.cta || 'Sign up to get started.';
  const aliases = aliasBlock(brand?.aliases);
  return [
    `# Brief`,
    `You are a senior content writer for ${brandName} (${brandUrl}).`,
    `Today's topic angle: "${angle}"`,
    ``,
    brandDNABlock(brand),
    `# Reader context`,
    voiceBlock(brand),
    ``,
    aliases,
    `# SEO`,
    '- Pick ONE primary search query — a real query a user would type in 2026, with commercial intent if possible.',
    '- Pick 5 secondary long-tail keywords, comma-separated, lower-case, no hashtags.',
    '- The primary query MUST appear in: the title (verbatim or very close), the first 100 words, at least one H2, the meta description, and the slug.',
    '- Secondary keywords each appear at least once, woven in naturally.',
    '- Title: 50-70 chars, contains the primary query, written like a real headline not a keyword stuffing.',
    '- Meta description: 140-160 chars, contains the primary query, gives the reader a concrete reason to click.',
    '',
    `# Structure`,
    '- 900-1300 words total.',
    '- Open with a hook paragraph that names the primary query and gives the reader ONE specific takeaway (not a setup like "let\'s explore...").',
    '- 4-6 H2 sub-headings. Each H2 introduces a single concrete idea, not a generic theme.',
    '- Short paragraphs (2-4 sentences). Mix in 1-2 bullet lists where it makes sense — never just for filler.',
    '- One FAQ-style H2 near the end with 3-4 specific reader questions and direct answers.',
    '- Close with one short paragraph (3-4 sentences) that links to "' + brandUrl + '" and naturally includes the call-to-action: "' + cta + '"',
    '- Markdown body. No code fences around the whole document.',
    '',
    BANNED_PHRASES_BLOCK,
    '',
    CONCRETENESS_BLOCK,
    '',
    `# Hero image`,
    'hero_image_prompt: a wide cinematic photorealistic concept image suitable as a blog header for this topic. Specific scene, specific lighting, specific composition. No faces, no text overlays.',
    'hero_image_alt: 80-120 chars, descriptive enough that a screen-reader user gets the gist.',
    '',
    `# Output`,
    jsonSchemaBlock(),
    'No prose outside the JSON. Be specific. Be useful. Be the article a real expert would write.',
  ].join('\n');
}

function buildProgrammaticPrompt(keyword, brand) {
  const brandName = brand?.name || 'this site';
  const brandUrl = brand?.url || '/';
  const cta = brand?.cta || 'Sign up to get started.';
  const aliases = aliasBlock(brand?.aliases);
  return [
    `# Brief`,
    `You are building a programmatic SEO landing page for ${brandName} (${brandUrl}).`,
    `Target keyword (verbatim, this is the search query): "${keyword}"`,
    'This page needs to rank for that exact query and serve the reader who typed it.',
    '',
    brandDNABlock(brand),
    `# Reader context`,
    voiceBlock(brand),
    'The reader typed this exact keyword into Google. They have a specific question or intent. Address it head-on in the first paragraph — do NOT bury the answer.',
    '',
    aliases,
    `# Structure`,
    '- 700-1000 words. Markdown body. No code fences.',
    '- Hook paragraph (2-3 sentences) that names the keyword verbatim and gives the reader one concrete answer or commitment.',
    '- 3-5 H2 sub-headings, each introducing one concrete idea relevant to the keyword.',
    '- Short paragraphs (2-4 sentences). 1-2 bullet lists where it helps.',
    '- One H2 with 2-3 reader questions answered directly (FAQ style).',
    '- Close with one paragraph that links to "' + brandUrl + '" and naturally includes the CTA: "' + cta + '"',
    '',
    `# Constraints`,
    '- Title: 50-70 chars, contains the keyword.',
    '- Meta description: 140-160 chars, contains the keyword, summarises the page concretely.',
    '- Slug: kebab-case, derived from the keyword.',
    '',
    BANNED_PHRASES_BLOCK,
    '',
    CONCRETENESS_BLOCK,
    '',
    `# Hero image`,
    'hero_image_prompt: photorealistic concept image directly related to "' + keyword + '". Specific scene, no faces, no text in the image.',
    'hero_image_alt: 80-120 chars.',
    '',
    `# Output`,
    jsonSchemaBlock(keyword),
  ].join('\n');
}

// ── shared post-processing ─────────────────────────────────────────────

function slugify(input) {
  return String(input)
    .toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-')
    .replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function shapeArticle(parsed, providerLabel) {
  if (!parsed?.title || !parsed?.body_markdown) {
    throw new Error('ai_article_missing_fields');
  }
  const slug = slugify(parsed.slug || parsed.title || ('post-' + Date.now()));
  const primary = String(parsed.primary_query || '').trim().toLowerCase();
  const secondary = String(parsed.secondary_keywords || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const keywords = Array.from(new Set([primary, ...secondary].filter(Boolean)))
    .slice(0, 10).join(', ');
  return {
    title: String(parsed.title).trim().slice(0, 140),
    slug,
    meta_description: String(parsed.meta_description || '').trim().slice(0, 200),
    body_markdown: String(parsed.body_markdown).trim(),
    hero_image_prompt: String(parsed.hero_image_prompt || '').trim().slice(0, 600),
    hero_image_alt: String(parsed.hero_image_alt || parsed.title).trim().slice(0, 200),
    primary_query: primary,
    keywords,
    ai_provider: providerLabel,
  };
}

// Escape raw control characters (newlines, tabs, etc.) that appear
// *inside* JSON string literals. Llama-class models routinely return
// JSON-looking output with raw \n bytes inside the body_markdown field,
// which violates strict JSON. We walk the string with a tiny state
// machine and replace unescaped control chars with their \uXXXX form
// only while we're inside a string literal.
function escapeControlsInStrings(s) {
  let out = '';
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const code = ch.charCodeAt(0);
    if (!inStr) {
      out += ch;
      if (ch === '"') inStr = true;
      continue;
    }
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') { out += ch; escaped = true; continue; }
    if (ch === '"') { out += ch; inStr = false; continue; }
    if (code < 0x20) {
      // \n → \\n, \r → \\r, \t → \\t, others → \\uXXXX.
      if (code === 0x0a) out += '\\n';
      else if (code === 0x0d) out += '\\r';
      else if (code === 0x09) out += '\\t';
      else out += '\\u' + code.toString(16).padStart(4, '0');
      continue;
    }
    out += ch;
  }
  return out;
}

// Strip code fences / leading prose if the model wraps its JSON. Also
// tolerates raw control chars inside string values (Llama habit).
function looseJsonParse(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  try { return JSON.parse(s); } catch {}
  // Retry with control chars inside string literals escaped.
  return JSON.parse(escapeControlsInStrings(s));
}

const SYSTEM_JSON_ONLY = 'You return strict JSON only. No prose outside the JSON.';

// ── Workers AI ────────────────────────────────────────────────────────

const WORKERS_AI_TEXT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const WORKERS_AI_IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';

async function workersAIText(env, prompt) {
  if (!env?.AI) throw new Error('workers_ai_binding_missing');
  const model = env.WORKERS_AI_TEXT_MODEL || WORKERS_AI_TEXT_MODEL;
  const r = await env.AI.run(model, {
    messages: [
      { role: 'system', content: SYSTEM_JSON_ONLY },
      { role: 'user', content: prompt },
    ],
    max_tokens: 4096,
  });
  // Workers AI may return either a string in `response` or, when the
  // model emits structured output, an already-parsed object. Cover both.
  const raw = r?.response ?? r?.result?.response ?? r?.result ?? r;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    // Already parsed JSON — just hand it back.
    if (raw.title || raw.body_markdown || raw.primary_query) return raw;
  }
  if (typeof raw === 'string' && raw.length) return looseJsonParse(raw);
  if (!raw) throw new Error('workers_ai_empty_response');
  throw new Error('workers_ai_unexpected_shape: ' + JSON.stringify(raw).slice(0, 200));
}

async function workersAIImage(env, prompt) {
  if (!env?.AI) throw new Error('workers_ai_binding_missing');
  const model = env.WORKERS_AI_IMAGE_MODEL || WORKERS_AI_IMAGE_MODEL;
  const r = await env.AI.run(model, { prompt, num_steps: 4 });
  if (r instanceof ReadableStream) {
    const chunks = [];
    const reader = r.getReader();
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value); total += value.length;
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.length; }
    return buf;
  }
  if (r instanceof Uint8Array) return r;
  if (r?.image) return b64ToBytes(r.image);
  throw new Error('workers_ai_image_unexpected_shape');
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ── OpenAI-compatible chat completion helper ──────────────────────────
//
// OpenAI, Groq, DeepSeek, Mistral, Together and Cerebras all expose a
// chat-completions endpoint with the same request/response shape. Wrap
// the differences (base URL, model id, optional `response_format`) in
// one helper so adding a new compatible provider is one config entry.
async function chatCompletion({ url, apiKey, model, prompt, useJsonFormat = true, extraHeaders = {} }) {
  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_JSON_ONLY },
      { role: 'user', content: prompt },
    ],
    temperature: 0.7,
  };
  if (useJsonFormat) body.response_format = { type: 'json_object' };
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('chat_http_' + r.status + ': ' + t.slice(0, 200));
  }
  const data = await r.json();
  const text = data?.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('chat_empty');
  return looseJsonParse(text);
}

// ── OpenAI (Responses API for gpt-5; chat API for image) ──────────────

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const OPENAI_IMAGES_URL = 'https://api.openai.com/v1/images/generations';
const OPENAI_TEXT_MODEL = 'gpt-5';
const OPENAI_IMAGE_MODEL = 'gpt-image-1';

function extractOpenAIText(data) {
  if (data?.output_text) return data.output_text;
  for (const item of (data?.output || [])) {
    if (item?.type !== 'message') continue;
    for (const c of (item.content || [])) {
      if (c?.type === 'output_text' && c.text) return c.text;
    }
  }
  return '';
}

async function openAIText(env, prompt) {
  if (!env?.OPENAI_API_KEY) throw new Error('openai_not_configured');
  const model = env.OPENAI_TEXT_MODEL || OPENAI_TEXT_MODEL;
  const r = await fetch(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      instructions: SYSTEM_JSON_ONLY,
      input: prompt,
      text: { format: { type: 'json_object' } },
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('openai_text_http_' + r.status + ': ' + t.slice(0, 200));
  }
  const data = await r.json();
  const text = extractOpenAIText(data);
  if (!text) throw new Error('openai_text_empty');
  return looseJsonParse(text);
}

async function openAIImage(env, prompt) {
  if (!env?.OPENAI_API_KEY) throw new Error('openai_not_configured');
  const model = env.OPENAI_IMAGE_MODEL || OPENAI_IMAGE_MODEL;
  const directed = [
    'Photorealistic editorial hero image for a blog header.',
    'Subject: ' + prompt,
    'Shot on a 35mm DSLR, natural daylight, shallow depth of field,',
    'soft realistic colour grade, sharp focus on subject.',
    'NOT illustrated, NOT 3D-rendered, NOT cartoon. No text overlays, no logos.',
  ].join(' ');
  const r = await fetch(OPENAI_IMAGES_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt: directed,
      size: '1536x1024',
      quality: 'high',
      n: 1,
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('openai_image_http_' + r.status + ': ' + t.slice(0, 200));
  }
  const data = await r.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error('openai_image_empty');
  return b64ToBytes(b64);
}

// ── Anthropic (Claude) ─────────────────────────────────────────────────

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_TEXT_MODEL = 'claude-opus-4-7';

async function anthropicText(env, prompt) {
  if (!env?.ANTHROPIC_API_KEY) throw new Error('anthropic_not_configured');
  const model = env.ANTHROPIC_TEXT_MODEL || ANTHROPIC_TEXT_MODEL;
  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: SYSTEM_JSON_ONLY,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('anthropic_http_' + r.status + ': ' + t.slice(0, 200));
  }
  const data = await r.json();
  const text = (data?.content || [])
    .filter((c) => c?.type === 'text').map((c) => c.text).join('') || '';
  if (!text) throw new Error('anthropic_empty');
  return looseJsonParse(text);
}

// ── Google Gemini ──────────────────────────────────────────────────────

const GEMINI_TEXT_MODEL = 'gemini-2.5-pro';
const GEMINI_IMAGE_MODEL = 'imagen-4.0-generate-001';

async function geminiText(env, prompt) {
  if (!env?.GEMINI_API_KEY) throw new Error('gemini_not_configured');
  const model = env.GEMINI_TEXT_MODEL || GEMINI_TEXT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_JSON_ONLY }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.7 },
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('gemini_http_' + r.status + ': ' + t.slice(0, 200));
  }
  const data = await r.json();
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((p) => p?.text || '').join('');
  if (!text) throw new Error('gemini_empty');
  return looseJsonParse(text);
}

async function geminiImage(env, prompt) {
  if (!env?.GEMINI_API_KEY) throw new Error('gemini_not_configured');
  const model = env.GEMINI_IMAGE_MODEL || GEMINI_IMAGE_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${env.GEMINI_API_KEY}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: { sampleCount: 1, aspectRatio: '16:9' },
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('gemini_image_http_' + r.status + ': ' + t.slice(0, 200));
  }
  const data = await r.json();
  const b64 = data?.predictions?.[0]?.bytesBase64Encoded;
  if (!b64) throw new Error('gemini_image_empty');
  return b64ToBytes(b64);
}

// ── OpenAI-compatible cloud providers ─────────────────────────────────

async function groqText(env, prompt) {
  if (!env?.GROQ_API_KEY) throw new Error('groq_not_configured');
  return chatCompletion({
    url: 'https://api.groq.com/openai/v1/chat/completions',
    apiKey: env.GROQ_API_KEY,
    model: env.GROQ_TEXT_MODEL || 'llama-3.3-70b-versatile',
    prompt,
  });
}

async function deepseekText(env, prompt) {
  if (!env?.DEEPSEEK_API_KEY) throw new Error('deepseek_not_configured');
  return chatCompletion({
    url: 'https://api.deepseek.com/v1/chat/completions',
    apiKey: env.DEEPSEEK_API_KEY,
    model: env.DEEPSEEK_TEXT_MODEL || 'deepseek-chat',
    prompt,
  });
}

async function mistralText(env, prompt) {
  if (!env?.MISTRAL_API_KEY) throw new Error('mistral_not_configured');
  return chatCompletion({
    url: 'https://api.mistral.ai/v1/chat/completions',
    apiKey: env.MISTRAL_API_KEY,
    model: env.MISTRAL_TEXT_MODEL || 'mistral-large-latest',
    prompt,
  });
}

async function togetherText(env, prompt) {
  if (!env?.TOGETHER_API_KEY) throw new Error('together_not_configured');
  return chatCompletion({
    url: 'https://api.together.xyz/v1/chat/completions',
    apiKey: env.TOGETHER_API_KEY,
    model: env.TOGETHER_TEXT_MODEL || 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    prompt,
  });
}

async function cerebrasText(env, prompt) {
  if (!env?.CEREBRAS_API_KEY) throw new Error('cerebras_not_configured');
  return chatCompletion({
    url: 'https://api.cerebras.ai/v1/chat/completions',
    apiKey: env.CEREBRAS_API_KEY,
    model: env.CEREBRAS_TEXT_MODEL || 'llama-3.3-70b',
    prompt,
  });
}

// ── provider registry ─────────────────────────────────────────────────

// Order matters: when no `provider` is specified, we walk the list in
// order and use the first one whose `available(env)` returns true.
// Workers AI is first because it's always present in this deployment.
const TEXT_PROVIDERS = [
  { name: 'workers-ai', available: (e) => !!e?.AI,                call: workersAIText  },
  { name: 'openai',     available: (e) => !!e?.OPENAI_API_KEY,    call: openAIText     },
  { name: 'anthropic',  available: (e) => !!e?.ANTHROPIC_API_KEY, call: anthropicText  },
  { name: 'gemini',     available: (e) => !!e?.GEMINI_API_KEY,    call: geminiText     },
  { name: 'groq',       available: (e) => !!e?.GROQ_API_KEY,      call: groqText       },
  { name: 'deepseek',   available: (e) => !!e?.DEEPSEEK_API_KEY,  call: deepseekText   },
  { name: 'mistral',    available: (e) => !!e?.MISTRAL_API_KEY,   call: mistralText    },
  { name: 'together',   available: (e) => !!e?.TOGETHER_API_KEY,  call: togetherText   },
  { name: 'cerebras',   available: (e) => !!e?.CEREBRAS_API_KEY,  call: cerebrasText   },
];

// Image providers — Anthropic, Groq, DeepSeek etc. don't do image gen,
// so they don't appear here.
const IMAGE_PROVIDERS = [
  { name: 'workers-ai', available: (e) => !!e?.AI,                call: workersAIImage },
  { name: 'openai',     available: (e) => !!e?.OPENAI_API_KEY,    call: openAIImage    },
  { name: 'gemini',     available: (e) => !!e?.GEMINI_API_KEY,    call: geminiImage    },
];

function orderProviders(registry, env, preferred) {
  const available = registry.filter((p) => p.available(env));
  if (!preferred) return available;
  const head = available.filter((p) => p.name === preferred);
  const tail = available.filter((p) => p.name !== preferred);
  return [...head, ...tail];
}

// Every provider-secret name we care about, for vault overlay.
import { envWithVault } from './secret_vault.js';
const PROVIDER_SECRET_NAMES = [
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY',
  'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY',
  'TOGETHER_API_KEY', 'CEREBRAS_API_KEY',
];

// Overlay any vault-stored keys on top of env so the rest of this file
// can keep reading `env.X` synchronously. Pages secrets always win over
// vault values.
async function withVault(env) {
  return envWithVault(env, PROVIDER_SECRET_NAMES);
}

// List provider names currently usable. Async because we may consult
// the vault. Exposed for the admin UI's preferred-provider dropdown.
export async function listProviders(env) {
  const overlayed = await withVault(env);
  return {
    text:  TEXT_PROVIDERS.filter((p) => p.available(overlayed)).map((p) => p.name),
    image: IMAGE_PROVIDERS.filter((p) => p.available(overlayed)).map((p) => p.name),
  };
}

// ── public API ─────────────────────────────────────────────────────────

// `kind` is 'article' (long blog post) or 'programmatic' (landing page).
// `seed` is the topic-angle string for articles or the keyword for
// programmatic pages. `provider` is optional — when omitted we walk the
// registry in default order (Workers AI first).
export async function generateContent(env, { kind, seed, provider, brand }) {
  const overlayed = await withVault(env);
  const prompt = kind === 'programmatic'
    ? buildProgrammaticPrompt(seed, brand)
    : buildArticlePrompt(seed, brand);

  const order = orderProviders(TEXT_PROVIDERS, overlayed, provider);
  if (!order.length) throw new Error('no_text_providers_configured');

  const errs = [];
  for (const p of order) {
    try {
      const parsed = await p.call(overlayed, prompt);
      return shapeArticle(parsed, p.name);
    } catch (e) {
      errs.push(`${p.name}: ${String(e?.message || e).slice(0, 120)}`);
    }
  }
  throw new Error('all_text_providers_failed — ' + errs.join(' | '));
}

export async function generateImage(env, { prompt, provider }) {
  if (!prompt) throw new Error('image_prompt_empty');
  const overlayed = await withVault(env);
  const order = orderProviders(IMAGE_PROVIDERS, overlayed, provider);
  if (!order.length) throw new Error('no_image_providers_configured');

  const errs = [];
  for (const p of order) {
    try {
      const bytes = await p.call(overlayed, prompt);
      return { bytes, ai_provider: p.name };
    } catch (e) {
      errs.push(`${p.name}: ${String(e?.message || e).slice(0, 120)}`);
    }
  }
  throw new Error('all_image_providers_failed — ' + errs.join(' | '));
}

// Convenience for callers that need to consult the vault outside the
// content-gen paths (e.g. the brand-DNA generator's bespoke provider
// dispatcher).
export async function vaultedEnv(env) { return withVault(env); }
