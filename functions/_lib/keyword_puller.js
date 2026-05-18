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

export async function pullKeywords(seed, { limit = 50, expand = true } = {}) {
  const cleanSeed = String(seed || '').trim().toLowerCase();
  if (!cleanSeed) throw new Error('seed_required');

  const queries = [cleanSeed];
  if (expand) {
    for (const p of PREFIXES) queries.push(`${p} ${cleanSeed}`);
    for (const s of SUFFIXES) queries.push(`${cleanSeed} ${s}`);
    for (const l of LETTERS) queries.push(`${cleanSeed} ${l}`);
  }

  const all = await withLimit(queries, fetchSuggestions, 4);
  const seen = new Set();
  const out = [];
  for (const k of all) {
    const norm = String(k || '').trim().toLowerCase();
    if (!norm) continue;
    if (seen.has(norm)) continue;
    // Drop suggestions that don't include the seed at all — they're
    // tangentially related at best and rarely worth a landing page.
    if (!norm.includes(cleanSeed.split(' ')[0])) continue;
    seen.add(norm);
    out.push(norm);
    if (out.length >= limit) break;
  }
  return { seed: cleanSeed, total: out.length, keywords: out };
}
