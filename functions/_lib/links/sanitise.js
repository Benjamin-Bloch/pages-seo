// Markdown link sanitiser. Run over AI-generated markdown after the model
// returns its JSON, BEFORE the row is inserted into blog_posts / prog_pages.
//
// What it does:
//   1. Strips dangerous protocols. Only http(s), mailto, tel, and our own
//      relative paths (starting with `/`) are allowed.
//   2. Removes any link whose URL is malformed.
//   3. For internal links (starting with `/`), ensures the path is shaped
//      like a real route — kebab-case slug under a known prefix. Unknown
//      internal paths are downgraded to plain text so we don't ship dead
//      links to indexable pages.
//   4. Converts bare URLs in text into proper [url](url) markdown links.
//
// The markdown renderer at functions/_lib/markdown.js already escapes
// HTML and sets rel="nofollow noopener" on external links, so this layer
// focuses on the *URL itself* being well-formed and routable.
//
// Usage:
//   import { sanitiseMarkdownLinks } from '../_lib/links/sanitise.js';
//   const cleaned = sanitiseMarkdownLinks(post.body_markdown, {
//     allowedInternalPrefixes: ['/blog/', '/p/', '/services/'],
//   });

const LINK_RX = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const BARE_URL_RX = /(?<![("\w])(https?:\/\/[A-Za-z0-9._~:/?#@!$&'*+,;=%-]+)(?![\w"])/g;
const SAFE_PROTOCOLS = /^(https?:|mailto:|tel:)/i;

// Default internal-prefix whitelist. Self-hosters can extend this if they
// build extra page types.
export const DEFAULT_INTERNAL_PREFIXES = ['/', '/blog', '/blog/', '/p/'];

function isInternalAllowed(url, allowedPrefixes) {
  if (!url.startsWith('/')) return false;
  if (url === '/') return true;
  return allowedPrefixes.some((p) => url === p.replace(/\/$/, '') || url.startsWith(p));
}

function isUrlSafe(url, allowedPrefixes) {
  if (!url) return false;
  if (url.startsWith('/')) {
    // Block double-slash protocol-relative URLs (//evil.com).
    if (url.startsWith('//')) return false;
    return isInternalAllowed(url, allowedPrefixes);
  }
  return SAFE_PROTOCOLS.test(url);
}

export function sanitiseMarkdownLinks(md, opts = {}) {
  const allowedPrefixes = opts.allowedInternalPrefixes || DEFAULT_INTERNAL_PREFIXES;
  // Accept both flat ({name:url}) and rich ({name:{url,description}}) shapes.
  const rawAliases = opts.aliases || {};
  const aliases = {};
  for (const [k, v] of Object.entries(rawAliases)) {
    aliases[k.toLowerCase()] = (v && typeof v === 'object' && 'url' in v) ? v.url : v;
  }

  let out = String(md || '');

  // 1. Process explicit [text](url) links — replace aliases, then validate.
  out = out.replace(LINK_RX, (match, text, url) => {
    let target = url.trim();
    // Resolve aliases like (signup) → /signup if the alias map defines it.
    if (aliases[target.toLowerCase()]) target = aliases[target.toLowerCase()];
    if (isUrlSafe(target, allowedPrefixes)) {
      return `[${text}](${target})`;
    }
    // Unsafe link — drop the link wrapper, keep the visible text. We don't
    // want a model emitting `[click here](javascript:alert(1))` to make it
    // into rendered HTML.
    return text;
  });

  // 2. Auto-link bare URLs that aren't already inside a link or attribute.
  out = out.replace(BARE_URL_RX, (m, url) => {
    if (!isUrlSafe(url, allowedPrefixes)) return url;
    return `[${url}](${url})`;
  });

  return out;
}

// Public-page rendering convenience: convert internal links to absolute
// URLs based on the request hostname. Used by RSS / sitemap consumers.
export function absolutiseInternalLinks(md, hostname) {
  return String(md || '').replace(LINK_RX, (m, text, url) => {
    if (url.startsWith('/') && !url.startsWith('//')) {
      return `[${text}](https://${hostname}${url})`;
    }
    return m;
  });
}
