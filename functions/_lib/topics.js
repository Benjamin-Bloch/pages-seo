// Default topic pool for the daily blog cron.
//
// THIS FILE IS MEANT TO BE EDITED PER SITE. Replace these entries with
// topics relevant to your audience. Each entry is { key, angle }:
//   - `key`   : stable identifier, used to dedupe in blog_topic_usage.
//   - `angle` : free-text seed passed to the AI's prompt as today's topic.
//
// The cron applies a 60-day cooldown so the same topic isn't re-used too
// quickly. If you have fewer than 60 topics, some will repeat sooner.
//
// Starter set below covers general SEO / content marketing. Swap in your
// own niche before deploying. Aim for 40-60 topics for healthy rotation.

export const TOPICS = [
  { key: 'on-page-seo-2026',  angle: 'On-page SEO basics in 2026 — what still matters, what doesn\'t, and a checklist a small site can actually use.' },
  { key: 'core-web-vitals',   angle: 'Core Web Vitals in 2026 — practical thresholds and how to hit them on a Cloudflare-hosted site.' },
  { key: 'sitemap-best-practice', angle: 'Sitemap best practices for small sites — what to include, what to leave out, and how often to ping IndexNow.' },
  { key: 'schema-org',        angle: 'Schema.org structured data — which types are worth adding for a content site and which are overkill.' },
  { key: 'eeat',              angle: 'Google\'s E-E-A-T in 2026 — what it actually means for solo creators and how to demonstrate experience.' },
  { key: 'helpful-content',   angle: 'Surviving Google\'s helpful-content updates — patterns the algorithm flags and how to write outside them.' },
  { key: 'programmatic-seo',  angle: 'Programmatic SEO done well in 2026 — when it works, when it gets penalised, and the line between scale and spam.' },
  { key: 'keyword-research-cheap', angle: 'Free keyword research workflow — building a 100-keyword list without paying for Ahrefs or Semrush.' },
  { key: 'long-tail-strategy', angle: 'Long-tail keyword strategy for new sites — why long-tails are the only realistic target in year one.' },
  { key: 'content-clusters',  angle: 'Topic clusters and pillar pages — how to structure a content site so Google understands you cover a theme.' },
  { key: 'internal-linking',  angle: 'Internal linking patterns that compound — turning every new post into a link upgrade for old ones.' },
  { key: 'backlink-basics',   angle: 'Backlinks in 2026 — what kinds Google still values, what it discounts, and how to earn the good ones.' },
  { key: 'page-speed',        angle: 'Page speed for content sites — the small tweaks that move the needle vs the busy-work that doesn\'t.' },
  { key: 'image-seo',         angle: 'Image SEO — formats, dimensions, alt text, and lazy-loading rules that actually affect rankings.' },
  { key: 'meta-descriptions', angle: 'Meta descriptions that increase CTR — what works in 2026 with Google rewriting half of them anyway.' },
  { key: 'titles-that-rank',  angle: 'Page titles that rank and get clicked — formula breakdown plus 5 ready-to-adapt templates.' },
  { key: 'ai-content-strategy', angle: 'AI-generated content strategy that doesn\'t get penalised — the editing layer that separates ranking sites from spam.' },
  { key: 'serp-features',     angle: 'SERP features in 2026 — featured snippets, People Also Ask, AI Overviews, and what each is worth.' },
  { key: 'indexing-issues',   angle: 'When Google won\'t index your pages — diagnosing crawl, index, and quality issues in Search Console.' },
  { key: 'gsc-essentials',    angle: 'Google Search Console essentials — the 5 reports a small site owner should check every week.' },
  { key: 'sitemap-priority',  angle: 'Sitemap priority and changefreq — what Google actually does with these values in 2026.' },
  { key: 'robots-txt',        angle: 'robots.txt for content sites — the directives that matter and the legacy ones that don\'t.' },
  { key: 'canonical-tags',    angle: 'Canonical tag mistakes that quietly kill rankings — how to audit yours in 10 minutes.' },
  { key: 'redirects-301',     angle: '301 vs 302 redirects in 2026 — when each preserves link equity and the audit checklist for site moves.' },
  { key: 'duplicate-content', angle: 'Duplicate content myths — what actually causes ranking issues vs what doesn\'t in 2026.' },
  { key: 'voice-search',      angle: 'Voice search SEO in 2026 — quietly important again as smart-home assistants improve.' },
  { key: 'mobile-first',      angle: 'Mobile-first indexing now that desktop is a legacy crawl — the testing routine for small sites.' },
  { key: 'local-seo',         angle: 'Local SEO for service businesses — Google Business Profile, citations, and reviews that move rankings.' },
  { key: 'youtube-seo',       angle: 'YouTube SEO basics — titles, descriptions, chapters, and the role of comment engagement.' },
  { key: 'ai-overviews',      angle: 'Ranking inside Google AI Overviews — what kinds of content get pulled and how to format for it.' },
  { key: 'content-refresh',   angle: 'Refreshing old content — the simple update process that often beats publishing new posts.' },
  { key: 'topic-authority',   angle: 'Building topic authority — why focused sites outrank generalists in 2026.' },
  { key: 'cms-choice-seo',    angle: 'Choosing a CMS for SEO — WordPress vs Webflow vs static-site generators in 2026.' },
  { key: 'cloudflare-pages-seo', angle: 'SEO on Cloudflare Pages — edge caching, headers, and what Google\'s renderer actually sees.' },
  { key: 'indexnow-explained', angle: 'IndexNow explained — what it does, what it doesn\'t, and the realistic time-to-index gain.' },
  { key: 'first-100-visits',  angle: 'Getting your first 100 search visits — the realistic 90-day plan for a brand-new domain.' },
  { key: 'analytics-without-cookies', angle: 'Privacy-friendly analytics in 2026 — options that don\'t need a cookie banner.' },
  { key: 'amp-is-dead',       angle: 'AMP in 2026 — is it really dead, and what replaced the speed wins it gave smaller sites.' },
  { key: 'pagination-seo',    angle: 'Pagination, infinite scroll and rel=next — what Google still respects and what it ignores.' },
  { key: 'json-ld-faq',       angle: 'FAQ schema in 2026 — when Google still shows it in SERPs and whether to bother adding it.' },
  { key: 'hreflang',          angle: 'Hreflang done right for multi-region sites — the 3 mistakes that quietly break it.' },
  { key: 'thin-content',      angle: 'Thin content — exact thresholds Google flags in 2026 and how to thicken without padding.' },
  { key: 'image-cdns',        angle: 'Image CDNs and Core Web Vitals — when Cloudflare Images / R2 + transforms actually beat hand-tuning.' },
  { key: 'social-signals',    angle: 'Social signals and SEO — what Google says vs what correlational data actually shows.' },
  { key: 'crawl-budget',      angle: 'Crawl budget for small sites — when it matters and the 2 fixes that cover 90% of cases.' },
  { key: 'noindex-strategy',  angle: 'When to noindex — categories of pages most small sites should keep out of Google\'s index.' },
  { key: 'ranking-decay',     angle: 'Why rankings decay — common causes and the simple monthly hygiene that prevents most of them.' },
];

// Pick a topic that hasn't been used in the last `cooldownDays` days.
export async function pickNextTopic(env, { cooldownDays = 60 } = {}) {
  const cutoff = Math.floor(Date.now() / 1000) - cooldownDays * 86400;
  const usedRows = await env.DB.prepare(
    'SELECT topic_key, last_used_at FROM blog_topic_usage'
  ).all().catch(() => ({ results: [] }));
  const usedMap = new Map((usedRows.results || []).map((r) => [r.topic_key, r.last_used_at]));

  const eligible = TOPICS.filter((t) => {
    const last = usedMap.get(t.key);
    return !last || last < cutoff;
  });
  const pool = eligible.length ? eligible : TOPICS;
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
