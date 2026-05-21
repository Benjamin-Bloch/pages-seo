// Lightweight single-page scraper for brand-DNA generation.
//
// Fetches one URL, strips HTML, returns the title, meta description,
// h1/h2/h3 headings, og tags, and ~6KB of body text. Skips images,
// scripts, styles, JSON-LD, nav/footer/aside chrome.
//
// Returns { url, status, title, meta_description, og, headings: [...],
//   body_text, errors: [...] }. Throws only on hard network failure.

const MAX_HTML_BYTES = 800_000;  // ~800KB of HTML is enough; bigger pages are bloated SPAs
const MAX_BODY_TEXT  = 6_000;    // chars passed to the LLM; more is wasted tokens

const SKIP_TAG_RE = /<(script|style|template|noscript|svg|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi;
const COMMENT_RE  = /<!--[\s\S]*?-->/g;
const TAG_RE      = /<[^>]+>/g;
const WS_RE       = /\s+/g;

// Decode the small set of HTML entities the scraper actually cares
// about. Single-pass replace: every match is a complete entity and
// we never produce a new entity that the next pattern could decode
// again. The old version decoded &amp; → & first, which meant input
// like "&amp;lt;" would round-trip to "<" — letting an attacker
// smuggle an entity past a downstream entity-aware sanitiser.
// CodeQL flagged that as "Double escaping or unescaping" (CWE-176).
//
// One unified regex matches any entity, and the replacer dispatches.
// Numeric entities (decimal and hex) are decoded; named ones from
// the small list are decoded; anything else passes through as-is.
const ENTITY_MAP = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>',
  '&quot;': '"', '&apos;': "'", '&#39;': "'",
  '&nbsp;': ' ', '&hellip;': '…',
  '&mdash;': '—', '&ndash;': '–',
  '&lsquo;': '‘', '&rsquo;': '’',
  '&ldquo;': '“', '&rdquo;': '”',
};
const ENTITY_RE = /&(?:amp|lt|gt|quot|apos|nbsp|hellip|mdash|ndash|lsquo|rsquo|ldquo|rdquo|#39|#x?[0-9a-fA-F]+);/g;
function decode(s) {
  return String(s || '').replace(ENTITY_RE, (m) => {
    if (m in ENTITY_MAP) return ENTITY_MAP[m];
    // Numeric entity: &#dec; or &#xhex;
    if (m.startsWith('&#x') || m.startsWith('&#X')) {
      const cp = parseInt(m.slice(3, -1), 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    if (m.startsWith('&#')) {
      const cp = parseInt(m.slice(2, -1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return m;
  });
}

function extractMeta(html, name) {
  // <meta name|property="X" content="Y">  or reverse order
  const re1 = new RegExp(`<meta[^>]+(?:name|property)\\s*=\\s*["']${name}["'][^>]*content\\s*=\\s*["']([^"']+)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']+)["'][^>]*(?:name|property)\\s*=\\s*["']${name}["']`, 'i');
  const m = re1.exec(html) || re2.exec(html);
  return decode(m ? m[1] : '').trim();
}

function extractAll(html, selector) {
  // selector: 'h1' | 'h2' | 'h3'
  const re = new RegExp(`<${selector}\\b[^>]*>([\\s\\S]*?)<\\/${selector}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = decode(m[1].replace(TAG_RE, ' ')).replace(WS_RE, ' ').trim();
    if (text && text.length < 240) out.push(text);
    if (out.length >= 30) break;
  }
  return out;
}

function extractBodyText(html) {
  // Strip script/style etc, then pull text out of the <body>. Also
  // drop common chrome blocks (nav, footer, aside, header) so the LLM
  // sees content, not navigation.
  let s = html.replace(SKIP_TAG_RE, ' ').replace(COMMENT_RE, ' ');
  // Try to scope to <main> or <article>; fall back to <body>.
  const main = s.match(/<(main|article)\b[\s\S]*?<\/\1>/i);
  if (main) s = main[0];
  else {
    const body = s.match(/<body\b[\s\S]*?<\/body>/i);
    if (body) s = body[0];
  }
  // Remove obvious chrome.
  s = s.replace(/<(nav|footer|aside|header)\b[\s\S]*?<\/\1>/gi, ' ');
  // Strip remaining tags, decode entities, collapse whitespace.
  s = decode(s.replace(TAG_RE, ' ')).replace(WS_RE, ' ').trim();
  return s.slice(0, MAX_BODY_TEXT);
}

export async function scrapeUrl(rawUrl, { timeoutMs = 12_000 } = {}) {
  const errors = [];
  let target;
  try {
    target = new URL(rawUrl.trim());
  } catch {
    throw new Error('invalid_url');
  }
  if (!/^https?:$/.test(target.protocol)) throw new Error('only_http_https');

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(target.toString(), {
      headers: {
        // Many marketing sites serve different (or no) content to bot UAs.
        // Mimic a normal browser so we get the same HTML a human would.
        'User-Agent': 'Mozilla/5.0 (compatible; pages-seo/1.0; +https://github.com/Benjamin-Bloch/pages-seo)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(t);
    if (err?.name === 'AbortError') throw new Error('timeout');
    throw new Error('fetch_failed: ' + String(err?.message || err).slice(0, 120));
  }
  clearTimeout(t);

  if (!res.ok) throw new Error('http_' + res.status);
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('html') && !ct.includes('xml')) {
    throw new Error('not_html_content_type: ' + ct);
  }

  // Cap HTML size — don't suck a 50MB SPA bundle into the function.
  let buf = '';
  const reader = res.body?.getReader();
  if (reader) {
    let total = 0;
    while (total < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      buf += new TextDecoder().decode(value, { stream: true });
      if (total >= MAX_HTML_BYTES) errors.push('html_truncated');
    }
  } else {
    buf = await res.text();
    if (buf.length > MAX_HTML_BYTES) {
      buf = buf.slice(0, MAX_HTML_BYTES);
      errors.push('html_truncated');
    }
  }

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(buf);
  const title = titleMatch ? decode(titleMatch[1].replace(WS_RE, ' ').trim()) : '';

  const meta = {
    description: extractMeta(buf, 'description'),
    og_title: extractMeta(buf, 'og:title'),
    og_description: extractMeta(buf, 'og:description'),
    og_site_name: extractMeta(buf, 'og:site_name'),
    keywords: extractMeta(buf, 'keywords'),
  };

  const headings = {
    h1: extractAll(buf, 'h1'),
    h2: extractAll(buf, 'h2'),
    h3: extractAll(buf, 'h3'),
  };

  const body_text = extractBodyText(buf);

  return {
    url: target.toString(),
    status: res.status,
    title,
    meta,
    headings,
    body_text,
    errors,
  };
}

// Render a scrape result into a compact text block we can feed to the LLM.
// Keeps total size <= ~7KB so it fits comfortably under any provider's
// context window even with the brand-DNA system prompt on top.
export function scrapeToPromptInput(scrape) {
  const lines = [];
  lines.push(`URL: ${scrape.url}`);
  if (scrape.title) lines.push(`Page title: ${scrape.title}`);
  if (scrape.meta?.description) lines.push(`Meta description: ${scrape.meta.description}`);
  if (scrape.meta?.og_title && scrape.meta.og_title !== scrape.title) lines.push(`OG title: ${scrape.meta.og_title}`);
  if (scrape.meta?.og_description) lines.push(`OG description: ${scrape.meta.og_description}`);
  if (scrape.meta?.og_site_name) lines.push(`OG site name: ${scrape.meta.og_site_name}`);
  if (scrape.headings?.h1?.length) lines.push(`H1: ${scrape.headings.h1.slice(0, 5).join(' | ')}`);
  if (scrape.headings?.h2?.length) lines.push(`H2: ${scrape.headings.h2.slice(0, 12).join(' | ')}`);
  if (scrape.headings?.h3?.length) lines.push(`H3: ${scrape.headings.h3.slice(0, 12).join(' | ')}`);
  if (scrape.body_text) {
    lines.push('', 'Body content (extracted, lightly cleaned):');
    lines.push(scrape.body_text);
  }
  return lines.join('\n');
}
