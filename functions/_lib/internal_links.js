// Internal-link injector. After the AI writes a post, scan the body
// for phrases that match the titles or keywords of OTHER published
// posts, and turn the first matching occurrence of each into a
// markdown link to that post.
//
// We're conservative on purpose:
//   - Max 3 links injected per post (search engines disregard spammy
//     internal linking; UX suffers above ~5)
//   - One link per target post (never two links to the same place)
//   - Skip phrases inside fenced code blocks or existing markdown links
//   - Only match whole-word phrases of 3-6 words, lowercased
//
// Real impact: every post becomes a link upgrade for older posts AND
// gives readers a path to keep reading on the site.

const MAX_LINKS_PER_POST = 3;
const MIN_PHRASE_WORDS   = 3;
const MAX_PHRASE_WORDS   = 6;
const TARGET_POOL_SIZE   = 100;

// Strip code-fences before scanning so we don't link inside code.
function stripFenced(md) {
  return md.replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length));
}

// Build candidate phrases from a target post: title + first few keywords.
// Returned phrases are lowercased + normalised to plain words.
function buildPhrases(post) {
  const out = new Set();
  const title = String(post.title || '');
  // The title itself, if 3-6 words.
  const tWords = title.split(/\s+/).filter(Boolean);
  if (tWords.length >= MIN_PHRASE_WORDS && tWords.length <= MAX_PHRASE_WORDS) {
    out.add(title.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim());
  }
  // Each keyword, if it's a multi-word phrase. The keywords field is
  // comma-separated.
  const kws = String(post.keywords || '').split(',');
  for (const kRaw of kws) {
    const k = kRaw.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    const w = k.split(/\s+/).filter(Boolean);
    if (w.length >= MIN_PHRASE_WORDS && w.length <= MAX_PHRASE_WORDS) {
      out.add(k);
    }
  }
  return [...out];
}

// Escape a phrase for use inside a RegExp.
function escapeRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// For a candidate phrase in a body, find the FIRST occurrence that
// isn't already inside a markdown link (i.e. not after a `[` without a
// closing `](...)`). Returns { start, end } or null.
function findUnlinkedMatch(body, phrase) {
  const rx = new RegExp(`\\b${escapeRx(phrase)}\\b`, 'gi');
  let m;
  while ((m = rx.exec(body)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    // Already inside a markdown link's [text]? Look backward for an
    // unclosed `[` before any `]` between it and start.
    const before = body.slice(0, start);
    const lastOpen  = before.lastIndexOf('[');
    const lastClose = before.lastIndexOf(']');
    if (lastOpen > lastClose) continue; // we're inside a link text
    // Already part of a link's URL? Look for `](` preceding without a
    // closing `)` between.
    const lastUrlOpen  = before.lastIndexOf('](');
    const lastUrlClose = before.lastIndexOf(')');
    if (lastUrlOpen > lastUrlClose) continue;
    return { start, end };
  }
  return null;
}

// Inject up to MAX_LINKS_PER_POST internal links into `body`.
// `selfSlug` excludes the current post from its own link pool.
// `targets` is an array of { slug, title, keywords }.
export function injectInternalLinks(body, selfSlug, targets) {
  if (!body || !Array.isArray(targets) || !targets.length) return { body, injected: [] };
  // Strip code blocks for the scan but apply replacements to the real body.
  const scan = stripFenced(body).toLowerCase();
  const injected = [];
  const seenTargets = new Set();
  let result = body;
  let cursorOffset = 0; // adjusts as we splice in <a> tags

  // Build (phrase, target) pairs, then sort by phrase length so longer
  // matches win first (avoids "page titles" hijacking "page titles
  // that rank" etc).
  const pairs = [];
  for (const t of targets) {
    if (t.slug === selfSlug) continue;
    for (const p of buildPhrases(t)) {
      if (p.length < 8) continue; // tiny matches are too risky
      pairs.push({ phrase: p, target: t });
    }
  }
  pairs.sort((a, b) => b.phrase.length - a.phrase.length);

  for (const { phrase, target } of pairs) {
    if (injected.length >= MAX_LINKS_PER_POST) break;
    if (seenTargets.has(target.slug)) continue;

    const hit = findUnlinkedMatch(result, phrase);
    if (!hit) continue;

    // Use the ORIGINAL casing from the body, not the lowercased phrase.
    const orig = result.slice(hit.start, hit.end);
    const replacement = `[${orig}](/blog/${target.slug})`;
    result = result.slice(0, hit.start) + replacement + result.slice(hit.end);
    seenTargets.add(target.slug);
    injected.push({ slug: target.slug, phrase, original: orig });
  }
  return { body: result, injected };
}

// Pull recent published posts for use as the link target pool.
export async function loadLinkTargets(env, selfSlug, { limit = TARGET_POOL_SIZE } = {}) {
  const rows = await env.DB.prepare(
    `SELECT slug, title, keywords FROM blog_posts
      WHERE status='published' AND slug != ?
      ORDER BY published_at DESC LIMIT ?`
  ).bind(selfSlug || '', limit).all().catch(() => ({ results: [] }));
  return rows.results || [];
}
