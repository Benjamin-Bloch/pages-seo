// Pre-publish quality scorer for blog posts.
//
// Returns a structured verdict so the caller can decide what to do:
//   { score: 0..100, band: 'good'|'warn'|'bad', issues: [...], stats: {...} }
//
// "bad" is meant to keep the post out of the published index until a
// human reviews it; "warn" still publishes but logs a warning. The
// caller in publish.js sets status='review' for 'bad' results.
//
// We score on real signals only — measurable structural quality, not
// AI-graded "is it good writing?" That keeps the check deterministic
// and free.

// Word count, counting actual words (not whitespace). Stripped of fenced
// code blocks first because a code block isn't prose for length purposes.
function wordCount(md) {
  const noCode = String(md || '').replace(/```[\s\S]*?```/g, '');
  const words = noCode.split(/\s+/).filter(Boolean);
  return words.length;
}

function countMatches(md, re) {
  const m = String(md || '').match(re);
  return m ? m.length : 0;
}

// Internal-link count: markdown links whose URL starts with "/" or the
// site's own host. Excludes external links and anchors.
function internalLinkCount(md) {
  return countMatches(String(md || ''), /\[[^\]]+\]\(\/(?:blog|p)\/[a-z0-9-]+/gi);
}

function hasFaqOrCallout(md) {
  return /(\bFAQ\b|<details|<summary|:::|> \*\*[A-Z])/i.test(String(md || ''));
}

// Deterministic 0..100 score with rule contributions. Each issue can
// add to `issues` for the audit trail; the score itself is derived from
// the same checks.
export function scorePost({ title, body_markdown, meta_description, slug }) {
  const body = String(body_markdown || '');
  const stats = {
    word_count: wordCount(body),
    h2_count:   countMatches(body, /^\#\#\s+/gm),
    h3_count:   countMatches(body, /^\#\#\#\s+/gm),
    ul_count:   countMatches(body, /^[-*]\s+/gm),
    ol_count:   countMatches(body, /^\d+\.\s+/gm),
    code_blocks:countMatches(body, /```/g) / 2,  // pairs
    internal_links: internalLinkCount(body),
    external_links: countMatches(body, /\[[^\]]+\]\(https?:\/\/[^)]+\)/g),
    title_len:  String(title || '').length,
    meta_len:   String(meta_description || '').length,
    slug:       String(slug || ''),
  };

  const issues = [];
  let score = 100;

  // Word count — calibrated so genuinely thin posts go to review:
  //   <300 words: clear "thin content" by Google's own guidance.
  //                Heavy penalty -> review.
  //   <600 words: short for a how-to / explainer. Penalty pushes the
  //                aggregate score below the 'bad' threshold UNLESS
  //                structure compensates.
  //   <1200 words: warning only (still publishes).
  // The prompt asks for 2500 words; we don't penalise hitting fewer
  // as long as it's substantive.
  if (stats.word_count < 300) {
    issues.push({ rule: 'too_short_thin',
      detail: `Body is ${stats.word_count} words; under 300 reads as thin content to Google.`,
      severity: 'bad' });
    score -= 60;
  } else if (stats.word_count < 600) {
    issues.push({ rule: 'too_short',
      detail: `Body is ${stats.word_count} words; target is 800+ for any useful guide.`,
      severity: 'bad' });
    score -= 40;
  } else if (stats.word_count < 1200) {
    issues.push({ rule: 'short',
      detail: `Body is ${stats.word_count} words; aiming for 1500+ for definitive guides.`,
      severity: 'warn' });
    score -= 12;
  }

  // Structure — H2s organise scannable content. 3+ H2s is the prompt's
  // target. None at all is a clear failure.
  if (stats.h2_count === 0) {
    issues.push({ rule: 'no_subheadings',
      detail: 'No H2 subheadings — body is a wall of text.',
      severity: 'bad' });
    score -= 25;
  } else if (stats.h2_count < 3) {
    issues.push({ rule: 'few_subheadings',
      detail: `Only ${stats.h2_count} H2 subheading(s); 3+ recommended.`,
      severity: 'warn' });
    score -= 8;
  }

  // Lists/tables — at least one is expected by the prompt.
  if (stats.ul_count + stats.ol_count === 0) {
    issues.push({ rule: 'no_lists',
      detail: 'No bullet or numbered lists; prose-only posts read as flat.',
      severity: 'warn' });
    score -= 6;
  }

  // Internal links — none is forgivable for the first few posts, then
  // becomes a real miss as the archive grows.
  if (stats.internal_links === 0) {
    issues.push({ rule: 'no_internal_links',
      detail: 'No internal links to other posts; misses SEO + retention win.',
      severity: 'warn' });
    score -= 6;
  }

  // Meta description — Google rewrites half of these but the explicit
  // ones still beat the auto-generated.
  if (stats.meta_len < 50) {
    issues.push({ rule: 'meta_too_short',
      detail: `Meta description is ${stats.meta_len} chars; 120-160 is the sweet spot.`,
      severity: 'warn' });
    score -= 5;
  } else if (stats.meta_len > 180) {
    issues.push({ rule: 'meta_too_long',
      detail: `Meta description is ${stats.meta_len} chars; will be truncated in SERP.`,
      severity: 'warn' });
    score -= 3;
  }

  // Title — 60 chars is roughly the SERP cutoff.
  if (stats.title_len === 0) {
    issues.push({ rule: 'no_title', detail: 'Title is empty.', severity: 'bad' });
    score -= 40;
  } else if (stats.title_len > 70) {
    issues.push({ rule: 'title_too_long',
      detail: `Title is ${stats.title_len} chars; will be truncated in Google's SERP.`,
      severity: 'warn' });
    score -= 3;
  }

  // Slug — common AI mistakes: leading "blog-", overly long, has
  // stop-words.
  if (/^blog[-_]/i.test(stats.slug)) {
    issues.push({ rule: 'slug_blog_prefix',
      detail: `Slug starts with "blog" — the AI prepended the category. Should be ${stats.slug.replace(/^blog[-_]/i, '')}.`,
      severity: 'warn' });
    score -= 4;
  }

  // Cap and band.
  score = Math.max(0, Math.min(100, score));
  const band = score >= 70 ? 'good' : score >= 45 ? 'warn' : 'bad';
  return { score, band, issues, stats };
}

// Convenience helper for publish.js. Decides what `status` to set based
// on the score. Operator can override via body.force_publish.
export function statusForScore(verdict, { forcePublish = false } = {}) {
  if (forcePublish) return 'published';
  if (verdict.band === 'bad') return 'review';
  return 'published';
}
