// Default topic pool for the daily blog cron.
//
// THIS FILE IS MEANT TO BE EDITED PER SITE. Each entry is:
//   - `key`      : stable identifier, used to dedupe in blog_topic_usage.
//   - `category` : groups related topics so the picker can rotate
//                  across categories (avoids "3 Cloudflare posts in
//                  5 days" style clustering).
//   - `angle`    : free-text seed passed to the AI's prompt.
//
// Cooldowns: 60 days per topic key, 7 days per category (configurable
// in pickNextTopic). If no topic in a fresh category is available, the
// picker relaxes the category constraint.
//
// Categories used: on-page, technical, content, links, off-page,
// analytics, platform, ai. Aim for 6+ topics per category for healthy
// rotation.

export const TOPICS = [
  // ── on-page (writing for readers + Google) ─────────────────────
  { key: 'on-page-seo-2026',  category: 'on-page',  angle: 'On-page SEO basics in 2026 — what still matters, what doesn\'t, and a checklist a small site can actually use.' },
  { key: 'meta-descriptions', category: 'on-page',  angle: 'Meta descriptions that increase CTR — what works in 2026 with Google rewriting half of them anyway.' },
  { key: 'titles-that-rank',  category: 'on-page',  angle: 'Page titles that rank and get clicked — formula breakdown plus 5 ready-to-adapt templates.' },
  { key: 'thin-content',      category: 'on-page',  angle: 'Thin content — exact thresholds Google flags in 2026 and how to thicken without padding.' },
  { key: 'helpful-content',   category: 'on-page',  angle: 'Surviving Google\'s helpful-content updates — patterns the algorithm flags and how to write outside them.' },
  { key: 'eeat',              category: 'on-page',  angle: 'Google\'s E-E-A-T in 2026 — what it actually means for solo creators and how to demonstrate experience.' },

  // ── technical (crawl, index, render) ────────────────────────────
  { key: 'core-web-vitals',   category: 'technical', angle: 'Core Web Vitals in 2026 — practical thresholds and how to hit them on a Cloudflare-hosted site.' },
  { key: 'sitemap-best-practice', category: 'technical', angle: 'Sitemap best practices for small sites — what to include, what to leave out, and how often to ping IndexNow.' },
  { key: 'schema-org',        category: 'technical', angle: 'Schema.org structured data — which types are worth adding for a content site and which are overkill.' },
  { key: 'canonical-tags',    category: 'technical', angle: 'Canonical tag mistakes that quietly kill rankings — how to audit yours in 10 minutes.' },
  { key: 'redirects-301',     category: 'technical', angle: '301 vs 302 redirects in 2026 — when each preserves link equity and the audit checklist for site moves.' },
  { key: 'robots-txt',        category: 'technical', angle: 'robots.txt for content sites — the directives that matter and the legacy ones that don\'t.' },
  { key: 'page-speed',        category: 'technical', angle: 'Page speed for content sites — the small tweaks that move the needle vs the busy-work that doesn\'t.' },
  { key: 'image-seo',         category: 'technical', angle: 'Image SEO — formats, dimensions, alt text, and lazy-loading rules that actually affect rankings.' },
  { key: 'crawl-budget',      category: 'technical', angle: 'Crawl budget for small sites — when it matters and the 2 fixes that cover 90% of cases.' },
  { key: 'noindex-strategy',  category: 'technical', angle: 'When to noindex — categories of pages most small sites should keep out of Google\'s index.' },
  { key: 'sitemap-priority',  category: 'technical', angle: 'Sitemap priority and changefreq — what Google actually does with these values in 2026.' },
  { key: 'pagination-seo',    category: 'technical', angle: 'Pagination, infinite scroll and rel=next — what Google still respects and what it ignores.' },
  { key: 'mobile-first',      category: 'technical', angle: 'Mobile-first indexing now that desktop is a legacy crawl — the testing routine for small sites.' },
  { key: 'duplicate-content', category: 'technical', angle: 'Duplicate content myths — what actually causes ranking issues vs what doesn\'t in 2026.' },
  { key: 'hreflang',          category: 'technical', angle: 'Hreflang done right for multi-region sites — the 3 mistakes that quietly break it.' },

  // ── content (strategy + planning) ──────────────────────────────
  { key: 'content-clusters',  category: 'content',  angle: 'Topic clusters and pillar pages — how to structure a content site so Google understands you cover a theme.' },
  { key: 'topic-authority',   category: 'content',  angle: 'Building topic authority — why focused sites outrank generalists in 2026.' },
  { key: 'content-refresh',   category: 'content',  angle: 'Refreshing old content — the simple update process that often beats publishing new posts.' },
  { key: 'long-tail-strategy', category: 'content', angle: 'Long-tail keyword strategy for new sites — why long-tails are the only realistic target in year one.' },
  { key: 'keyword-research-cheap', category: 'content', angle: 'Free keyword research workflow — building a 100-keyword list without paying for Ahrefs or Semrush.' },
  { key: 'first-100-visits',  category: 'content',  angle: 'Getting your first 100 search visits — the realistic 90-day plan for a brand-new domain.' },
  { key: 'json-ld-faq',       category: 'content',  angle: 'FAQ schema in 2026 — when Google still shows it in SERPs and whether to bother adding it.' },

  // ── links (internal + outbound) ────────────────────────────────
  { key: 'internal-linking',  category: 'links',    angle: 'Internal linking patterns that compound — turning every new post into a link upgrade for old ones.' },
  { key: 'backlink-basics',   category: 'links',    angle: 'Backlinks in 2026 — what kinds Google still values, what it discounts, and how to earn the good ones.' },

  // ── off-page (search engines + SERP features) ──────────────────
  { key: 'serp-features',     category: 'off-page', angle: 'SERP features in 2026 — featured snippets, People Also Ask, AI Overviews, and what each is worth.' },
  { key: 'ai-overviews',      category: 'off-page', angle: 'Ranking inside Google AI Overviews — what kinds of content get pulled and how to format for it.' },
  { key: 'voice-search',      category: 'off-page', angle: 'Voice search SEO in 2026 — quietly important again as smart-home assistants improve.' },
  { key: 'local-seo',         category: 'off-page', angle: 'Local SEO for service businesses — Google Business Profile, citations, and reviews that move rankings.' },
  { key: 'youtube-seo',       category: 'off-page', angle: 'YouTube SEO basics — titles, descriptions, chapters, and the role of comment engagement.' },
  { key: 'social-signals',    category: 'off-page', angle: 'Social signals and SEO — what Google says vs what correlational data actually shows.' },

  // ── analytics (measurement) ────────────────────────────────────
  { key: 'analytics-without-cookies', category: 'analytics', angle: 'Privacy-friendly analytics in 2026 — options that don\'t need a cookie banner.' },
  { key: 'indexing-issues',   category: 'analytics', angle: 'When Google won\'t index your pages — diagnosing crawl, index, and quality issues in Search Console.' },
  { key: 'gsc-essentials',    category: 'analytics', angle: 'Google Search Console essentials — the 5 reports a small site owner should check every week.' },
  { key: 'ranking-decay',     category: 'analytics', angle: 'Why rankings decay — common causes and the simple monthly hygiene that prevents most of them.' },

  // ── platform (CMS / infra choices) ─────────────────────────────
  { key: 'cms-choice-seo',    category: 'platform', angle: 'Choosing a CMS for SEO — WordPress vs Webflow vs static-site generators in 2026.' },
  { key: 'cloudflare-pages-seo', category: 'platform', angle: 'SEO on Cloudflare Pages — edge caching, headers, and what Google\'s renderer actually sees.' },
  { key: 'indexnow-explained', category: 'platform', angle: 'IndexNow explained — what it does, what it doesn\'t, and the realistic time-to-index gain.' },
  { key: 'amp-is-dead',       category: 'platform', angle: 'AMP in 2026 — is it really dead, and what replaced the speed wins it gave smaller sites.' },
  { key: 'image-cdns',        category: 'platform', angle: 'Image CDNs and Core Web Vitals — when Cloudflare Images / R2 + transforms actually beat hand-tuning.' },

  // ── ai (the elephant in the room) ──────────────────────────────
  { key: 'programmatic-seo',  category: 'ai', angle: 'Programmatic SEO done well in 2026 — when it works, when it gets penalised, and the line between scale and spam.' },
  { key: 'ai-content-strategy', category: 'ai', angle: 'AI-generated content strategy that doesn\'t get penalised — the editing layer that separates ranking sites from spam.' },
];

// Pick a topic that hasn't been used in the last `cooldownDays` days,
// preferring categories that haven't been used in `categoryCooldownDays`.
// If every eligible-by-key topic is in a recently-used category, we
// relax the category constraint rather than skip the day.
export async function pickNextTopic(env, { cooldownDays = 60, categoryCooldownDays = 7 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - cooldownDays * 86400;

  // 1. Per-topic cooldown via blog_topic_usage.
  const usedRows = await env.DB.prepare(
    'SELECT topic_key, last_used_at FROM blog_topic_usage'
  ).all().catch(() => ({ results: [] }));
  const usedMap = new Map((usedRows.results || []).map((r) => [r.topic_key, r.last_used_at]));

  // 2. Category cooldown — derive from the LATEST published post per
  //    category. We look up blog_posts.topic_seed (== topic_key) against
  //    TOPICS' categories. SQL would need a CASE table; cheaper to
  //    compute in JS.
  const catCutoff = now - categoryCooldownDays * 86400;
  const recentRows = await env.DB.prepare(
    `SELECT topic_seed, published_at FROM blog_posts
      WHERE status='published' AND published_at >= ?
      ORDER BY published_at DESC LIMIT 50`
  ).bind(catCutoff).all().catch(() => ({ results: [] }));
  const topicToCategory = new Map(TOPICS.map((t) => [t.key, t.category]));
  const recentCategories = new Set();
  for (const r of (recentRows.results || [])) {
    const cat = topicToCategory.get(r.topic_seed);
    if (cat) recentCategories.add(cat);
  }

  // 3. Eligible by topic cooldown.
  const eligible = TOPICS.filter((t) => {
    const last = usedMap.get(t.key);
    return !last || last < cutoff;
  });
  if (!eligible.length) return TOPICS[Math.floor(Math.random() * TOPICS.length)];

  // 4. Prefer topics in fresh categories.
  const fresh = eligible.filter((t) => !recentCategories.has(t.category));
  const pool = fresh.length ? fresh : eligible;
  return pool[Math.floor(Math.random() * pool.length)];
}

export async function markTopicUsed(env, topicKey) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO blog_topic_usage (topic_key, last_used_at, times_used)
     VALUES (?, ?, 1)
     ON CONFLICT(topic_key) DO UPDATE SET
       last_used_at = excluded.last_used_at,
       times_used = blog_topic_usage.times_used + 1`
  ).bind(topicKey, now).run();
}
