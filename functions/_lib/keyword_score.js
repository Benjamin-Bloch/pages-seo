// Heuristic keyword scoring + intent classification.
//
// No external APIs — these are signals derived purely from the keyword
// string. They're rough but correlate well with the keywords that
// actually convert vs. the ones that drain quota.
//
// Score breakdown (0–100):
//   intent       0–35  buyer signals (buy, price, cost, vs, best, near me, etc.)
//   specificity  0–20  word count, presence of numbers/years/locations
//   modifier     0–15  high-CTR modifiers (review, alternative, guide, comparison)
//   length       0–10  reward 3-6 words, penalise 1-word or 8+-word
//   penalty     -0–30  generic/branded/junk patterns
//
// Intent categories: "transactional", "commercial", "informational",
// "navigational", "junk".

const TRANSACTIONAL = [
  'buy', 'purchase', 'order', 'shop', 'price', 'pricing', 'prices',
  'cost', 'costs', 'deal', 'discount', 'coupon', 'cheap', 'sale',
  'subscribe', 'sign up', 'free trial', 'demo', 'quote', 'quotes',
  'for sale', 'near me', 'delivery', 'installation', 'install',
  'hire', 'rent', 'rental', 'lease', 'booking', 'book a',
];
const COMMERCIAL = [
  'best', 'top', 'review', 'reviews', 'rating', 'compare',
  'comparison', 'vs', 'versus', 'alternative', 'alternatives',
  'pros and cons', 'worth it', 'is it good', 'reddit',
];
const INFORMATIONAL = [
  'how to', 'what is', 'why', 'when', 'where', 'guide',
  'tutorial', 'examples', 'meaning', 'definition', 'history',
  'explained', 'difference between',
];
const NAVIGATIONAL = [
  'login', 'sign in', 'app', 'official', 'website', 'download',
  'support', 'help', 'contact',
];

const JUNK_PATTERNS = [
  /\b(porn|nude|xxx|nsfw|onlyfans|escort)\b/i,
  /\b(hack|crack|warez|nulled|cracked)\b/i,
  /\b(free\s+download)\b/i,                 // distinct from "free trial"
  /[a-z0-9]{40,}/i,                         // single unbroken token ≥40 chars
];

// Numeric strings that aren't years, prices, measurements, or quantities.
// Trips on session IDs and tracking codes; lets "£20000", "2026", "50kg" pass.
function looksLikeJunkNumeric(s) {
  const ms = s.match(/\d{4,}/g);
  if (!ms) return false;
  for (const m of ms) {
    const idx = s.indexOf(m);
    const before = s.slice(Math.max(0, idx - 2), idx);
    const after  = s.slice(idx + m.length, idx + m.length + 4);
    // OK if preceded by a currency char or followed by a unit.
    if (/[£€$¥]/.test(before)) continue;
    if (/^\s*(k|kg|lb|cm|in|ft|m|mm|gb|tb|mb|mph|kph|°|%)/i.test(after)) continue;
    // OK if it's a plausible year (1900-2099).
    const n = parseInt(m, 10);
    if (n >= 1900 && n <= 2099 && m.length === 4) continue;
    // Else: treat as junk numeric.
    return true;
  }
  return false;
}

const SPECIFICITY_MODIFIERS = [
  /\b\d{4}\b/,                       // year (2024, 2026)
  /\b(uk|usa|us|canada|australia|ireland|nyc|london|melbourne|toronto)\b/i,
  /\b\d+\s*(kg|lb|cm|inch|in|ft|m|mm)\b/i,  // measurement
  /\b£?\$?\d+k?\+?\b/,               // contains a number
];

const HIGH_CTR_MODIFIERS = [
  /\b(template|checklist|calculator|cheat sheet|case study)\b/i,
  /\b(tutorial|step by step|step-by-step|walkthrough)\b/i,
  /\b(comparison|side by side|head to head)\b/i,
];

function countMatches(text, list) {
  let n = 0;
  for (const w of list) {
    // word-boundary safe substring match (multi-word phrases are common)
    const re = new RegExp(`(^|[\\s-])${w.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}([\\s-]|$)`, 'i');
    if (re.test(text)) n++;
  }
  return n;
}

export function classifyIntent(kw) {
  const s = String(kw || '').toLowerCase();
  if (countMatches(s, TRANSACTIONAL))   return 'transactional';
  if (countMatches(s, COMMERCIAL))      return 'commercial';
  if (countMatches(s, NAVIGATIONAL))    return 'navigational';
  if (countMatches(s, INFORMATIONAL))   return 'informational';
  return 'informational';
}

// Returns { score (int 0-100), intent, signals: [...], penalty: int }.
export function scoreKeyword(kw) {
  const s = String(kw || '').toLowerCase().trim();
  if (!s) return { score: 0, intent: 'junk', signals: [], penalty: 0 };

  // Junk gate — heavy penalty + low score.
  for (const re of JUNK_PATTERNS) {
    if (re.test(s)) return { score: 0, intent: 'junk', signals: ['junk_pattern'], penalty: 100 };
  }
  if (looksLikeJunkNumeric(s)) {
    return { score: 0, intent: 'junk', signals: ['junk_numeric'], penalty: 100 };
  }

  const signals = [];
  let intentScore = 0;
  let intent = 'informational';

  const tx = countMatches(s, TRANSACTIONAL);
  const co = countMatches(s, COMMERCIAL);
  const nv = countMatches(s, NAVIGATIONAL);
  const inf = countMatches(s, INFORMATIONAL);

  if (tx > 0) {
    intent = 'transactional';
    intentScore = Math.min(35, 20 + tx * 8);
    signals.push(`transactional×${tx}`);
  } else if (co > 0) {
    intent = 'commercial';
    intentScore = Math.min(28, 16 + co * 6);
    signals.push(`commercial×${co}`);
  } else if (nv > 0) {
    intent = 'navigational';
    intentScore = 6; // navigational rarely worth landing pages
    signals.push(`navigational×${nv}`);
  } else if (inf > 0) {
    intent = 'informational';
    intentScore = Math.min(14, 8 + inf * 3);
    signals.push(`informational×${inf}`);
  }

  // Specificity
  let specScore = 0;
  for (const re of SPECIFICITY_MODIFIERS) {
    if (re.test(s)) { specScore += 5; signals.push('specific'); break; }
  }
  // Word count: 3-6 words = sweet spot for long-tail.
  const wc = s.split(/\s+/).filter(Boolean).length;
  if (wc >= 3 && wc <= 6) { specScore += 12; signals.push(`words=${wc}`); }
  else if (wc === 2) { specScore += 6; signals.push('short-tail'); }
  else if (wc === 1) { specScore -= 10; signals.push('single-word'); }
  else if (wc >= 7) { specScore -= 8; signals.push('over-long'); }

  // High-CTR modifiers
  let modScore = 0;
  for (const re of HIGH_CTR_MODIFIERS) {
    if (re.test(s)) { modScore = 12; signals.push('high_ctr'); break; }
  }

  // Length sweet spot
  const len = s.length;
  let lenScore = 0;
  if (len >= 15 && len <= 50) lenScore = 8;
  else if (len < 8) lenScore = -5;
  else if (len > 70) lenScore = -3;

  // Generic-word penalty: lots of stopword-only padding ("the best
  // of the best") signals filler queries.
  let penalty = 0;
  const stopwords = ['the', 'a', 'an', 'of', 'and', 'or', 'to', 'is', 'are', 'in', 'on'];
  const tokens = s.split(/\s+/);
  const stopRatio = tokens.filter((t) => stopwords.includes(t)).length / Math.max(tokens.length, 1);
  if (stopRatio > 0.5) { penalty += 10; signals.push('stopword-heavy'); }

  // Final score, clamped 0-100.
  let score = intentScore + specScore + modScore + lenScore - penalty;
  score = Math.max(0, Math.min(100, Math.round(score)));

  return { score, intent, signals, penalty };
}

// Normalise a keyword to canonical form for dedupe across plurals,
// punctuation, and stop-word variants. "best luxury bathtubs uk" and
// "the best luxury bathtub uk" map to the same canonical key.
export function canonicaliseKeyword(kw) {
  let s = String(kw || '').toLowerCase().trim();
  s = s.replace(/[^a-z0-9\s£$€]/g, ' ');     // strip punctuation
  s = s.replace(/\s+/g, ' ');
  // Drop articles/prepositions when they don't change meaning.
  s = s.split(' ')
       .filter((t) => !['the', 'a', 'an'].includes(t))
       .join(' ');
  // Crude depluralisation — words ending in 's' get singular form for
  // matching purposes only. (We keep the original form for display.)
  s = s.split(' ').map((t) => {
    if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
    if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
    return t;
  }).join(' ');
  return s.trim();
}
