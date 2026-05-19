// Direct provider call for one-off structured-JSON prompts (brand DNA,
// content-calendar planner). Unlike generateContent(), this does NOT
// run shapeArticle — the caller parses the JSON themselves.
//
// Walks the provider registry just like generateContent: preferred
// provider first if usable, then the available list in default order.
// Each successful call is logged to ai_usage with a caller-supplied
// `kind` + `source` so the dashboard reports cost per feature.

import { listProviders, vaultedEnv } from './ai.js';
import { loadSettings } from './settings.js';
import { recordUsage, estimateTokens } from './usage.js';

const DEFAULT_SYS = 'You return strict JSON only — no markdown fences, no prose outside the braces.';

export async function callRawLLM(env, prompt, {
  sys = DEFAULT_SYS,
  preferredProvider = '',
  kind = 'raw-json',
  source = 'admin',
} = {}) {
  const overlayed = await vaultedEnv(env);
  const available = (await listProviders(overlayed)).text;
  if (!available.length) throw new Error('no_text_providers_configured');

  const order = preferredProvider && available.includes(preferredProvider)
    ? [preferredProvider, ...available.filter((p) => p !== preferredProvider)]
    : available;

  const settings = await loadSettings(env);
  const errs = [];
  for (const name of order) {
    try {
      const { text, model } = await runProvider(overlayed, name, prompt, sys);
      await recordUsage(env, settings, {
        provider: name, model,
        prompt_tokens: estimateTokens(prompt),
        completion_tokens: estimateTokens(text),
        estimated: true,
        kind, source,
      });
      return { provider: name, parsed: looseJsonParse(text), raw: text };
    } catch (e) {
      errs.push(`${name}: ${String(e?.message || e).slice(0, 120)}`);
    }
  }
  await recordUsage(env, settings, {
    provider: order[0] || 'unknown', kind, source,
    ok: false, error: errs.join(' | '),
  });
  throw new Error('all_providers_failed — ' + errs.join(' | '));
}

async function runProvider(env, name, prompt, sys) {
  switch (name) {
    case 'workers-ai': {
      const model = env.WORKERS_AI_TEXT_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
      const r = await env.AI.run(model, {
        messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt }],
        max_tokens: 4096,
      });
      const raw = r?.response ?? r?.result?.response ?? r;
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
      return { text, model };
    }
    case 'openai': {
      const model = env.OPENAI_TEXT_MODEL || 'gpt-5';
      const r = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, instructions: sys, input: prompt, text: { format: { type: 'json_object' } } }),
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
        body: JSON.stringify({ model, max_tokens: 4096, system: sys, messages: [{ role: 'user', content: prompt }] }),
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
          systemInstruction: { parts: [{ text: sys }] },
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
          messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt }],
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

export function looseJsonParse(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  try { return JSON.parse(s); } catch { /* try cleanup */ }
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
