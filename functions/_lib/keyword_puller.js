// Free keyword research via Google Autocomplete.
//
// Uses the public suggestion endpoint Google itself uses to populate the
// dropdown when you type into the search box. No API key, no quota, but
// rate-limited by IP — keep concurrency low and you'll be fine for blog
// research workloads.
//
// Strategy:
//   1. For the seed query, request raw autocomplete.
//   2. Expand by prepending common modifiers (best, cheap, how to, etc.)
//      and appending letters a-z for "long-tail bombing" — this is the
//      same trick most paid tools use behind the scenes.
//   3. De-duplicate, lower-case, return up to `limit` suggestions.
//
// Returns: { seed, total, keywords: [...] }. Throws on network error.

const ENDPOINT = 'https://suggestqueries.google.com/complete/search';

// One-letter expansions reliably surface long-tails. Three-letter
// combinations would surface more but at quadratic cost — not worth it.
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');

// Common high-intent prefixes / suffixes. Tweak to taste per niche.
const PREFIXES = ['best', 'cheap', 'free', 'top', 'how to', 'what is', 'why', 'when to', 'where to'];
const SUFFIXES = ['for beginners', 'in 2026', 'uk', 'usa', 'reviews', 'reddit', 'vs', 'alternative', 'examples', 'guide', 'tutorial', 'price', 'cost'];

async function fetchSuggestions(query) {
  const url = `${ENDPOINT}?client=firefox&hl=en&q=${encodeURIComponent(query)}`;
  const r = await fetch(url, {
    // Pretending to be a normal browser keeps Google from 429-ing instantly.
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; pages-seo/1.0; +https://github.com/Benjamin-Bloch/pages-seo)' },
  });
  if (!r.ok) throw new Error('autocomplete_http_' + r.status);
  const data = await r.json();
  // Response shape: [original_query, [suggestion, suggestion, ...]]
  return Array.isArray(data?.[1]) ? data[1] : [];
}

// Run a batch of fetches with bounded concurrency so we don't fan out 30+
// requests in parallel and trip rate limits.
async function withLimit(items, fn, concurrency = 4) {
  const out = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx]); }
      catch { out[idx] = []; } // swallow per-item errors; collect what we can
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return out.flat();
}

import { scoreKeyword, canonicaliseKeyword } from './keyword_score.js';

// Decide whether a suggestion is meaningfully related to the seed.
// Old code dropped anything not containing the seed's first word, which
// killed perfectly relevant long-tails. Now: keep if the canonicalised
// suggestion contains AT LEAST half the seed's non-stopword tokens.
function relatedToSeed(suggestion, seed) {
  const stopwords = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'is', 'are', 'in', 'on', 'for']);
  const seedTokens = canonicaliseKeyword(seed).split(' ').filter((t) => t && !stopwords.has(t));
  if (!seedTokens.length) return true;
  const cand = canonicaliseKeyword(suggestion);
  let hits = 0;
  for (const t of seedTokens) if (cand.includes(t)) hits++;
  return hits / seedTokens.length >= 0.5;
}

export async function pullKeywords(seed, { limit = 50, expand = true, minScore = 0 } = {}) {
  const cleanSeed = String(seed || '').trim().toLowerCase();
  if (!cleanSeed) throw new Error('seed_required');

  const queries = [cleanSeed];
  if (expand) {
    for (const p of PREFIXES) queries.push(`${p} ${cleanSeed}`);
    for (const s of SUFFIXES) queries.push(`${cleanSeed} ${s}`);
    for (const l of LETTERS) queries.push(`${cleanSeed} ${l}`);
  }

  const all = await withLimit(queries, fetchSuggestions, 4);

  // Pass 1: collect every unique normalised + seed-related suggestion,
  // scored. Dedupe by canonical key (handles plurals/article variants).
  const byCanonical = new Map();
  for (const raw of all) {
    const norm = String(raw || '').trim().toLowerCase();
    if (!norm) continue;
    if (!relatedToSeed(norm, cleanSeed)) continue;
    const canon = canonicaliseKeyword(norm);
    if (!canon) continue;
    const scored = scoreKeyword(norm);
    if (scored.intent === 'junk') continue;
    if (scored.score < minScore) continue;
    const existing = byCanonical.get(canon);
    // Keep the variant with the higher score; if tied, the shorter one
    // (it's the more "canonical" surface form).
    if (!existing ||
        scored.score > existing.score ||
        (scored.score === existing.score && norm.length < existing.keyword.length)) {
      byCanonical.set(canon, {
        keyword: norm,
        canonical: canon,
        score: scored.score,
        intent: scored.intent,
        signals: scored.signals,
      });
    }
  }

  // Pass 2: sort by score DESC and trim to limit.
  const sorted = [...byCanonical.values()]
    .sort((a, b) => b.score - a.score || a.keyword.length - b.keyword.length)
    .slice(0, limit);

  return { seed: cleanSeed, total: sorted.length, keywords: sorted };
}
