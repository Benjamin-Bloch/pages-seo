// Small markdown → HTML renderer for blog + programmatic page bodies.
// Input is always model output (never customer-typed), so the subset is
// intentionally narrow and the inline-rule precedence is fixed.
//
// Supports: H2/H3, paragraphs, unordered + ordered lists, bold, italic,
// inline code, links. HTML in the source is escaped before rules apply
// so model output can't inject script tags.

function escape(s) {
  return String(s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function inline(s) {
  let out = escape(s);
  // Inline code first so its contents are not transformed by bold/italic.
  out = out.replace(/`([^`]+)`/g, (_, t) => `<code>${t}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Links — only http(s) URLs allowed.
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, (_, text, url) => {
    const isExternal = /^https?:/i.test(url);
    const rel = isExternal ? ' rel="nofollow noopener"' : '';
    return `<a href="${url}"${rel}>${text}</a>`;
  });
  return out;
}

// Pre-pass: Llama-class models sometimes emit a heading and the next
// paragraph on a single line, e.g. "# Title Body text starts here". We
// can't safely re-segment arbitrary prose, but we *can* enforce a line
// break before any `#`/`##`/`###` that appears mid-line — markdown
// headings must start a line anyway.
function splitInlineHeadings(md) {
  // Insert a newline before any `#`-style heading that follows a non-newline.
  return md.replace(/([^\n])(\n?)(#{1,6}\s+)/g, (_, prev, nl, h) => {
    if (nl) return prev + nl + h;
    return prev + '\n' + h;
  });
}

export function renderMarkdown(md) {
  const normalised = splitInlineHeadings(String(md || '').replace(/\r\n/g, '\n'));
  const lines = normalised.split('\n');
  const out = [];
  let i = 0;
  // We map H1 → H2 in the rendered output because the page template
  // already owns the H1 (the post title). Two H1s on one page is bad SEO.
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    // Cap heading length — Llama sometimes runs the heading and body
    // into one line. If the captured text is longer than 140 chars it's
    // almost certainly heading + paragraph mashed together; split at
    // sentence/period and emit a heading + paragraph pair.
    if (h && h[2].length <= 140) {
      const rawLevel = h[1].length;
      const level = Math.min(Math.max(rawLevel === 1 ? 2 : rawLevel, 2), 6);
      out.push(`<h${level}>${inline(h[2].trim())}</h${level}>`);
      i++; continue;
    }
    if (h && h[2].length > 140) {
      const rawLevel = h[1].length;
      const level = Math.min(Math.max(rawLevel === 1 ? 2 : rawLevel, 2), 6);
      // Split on first sentence boundary: ". " followed by capital
      // letter, or a question / exclamation mark. Falls back to the
      // first ~80 chars cut at a word boundary if there's no boundary.
      const text = h[2];
      let splitAt = -1;
      const sentence = text.search(/[.!?]\s+[A-Z]/);
      if (sentence > 0 && sentence < 120) splitAt = sentence + 1;
      else {
        const ws = text.lastIndexOf(' ', 80);
        if (ws > 20) splitAt = ws;
      }
      if (splitAt > 0) {
        out.push(`<h${level}>${inline(text.slice(0, splitAt).trim())}</h${level}>`);
        out.push(`<p>${inline(text.slice(splitAt).trim())}</p>`);
      } else {
        out.push(`<h${level}>${inline(text.trim())}</h${level}>`);
      }
      i++; continue;
    }
    if (/^[-*]\s+/.test(line)) {
      out.push('<ul>');
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        out.push(`<li>${inline(lines[i].replace(/^[-*]\s+/, ''))}</li>`);
        i++;
      }
      out.push('</ul>'); continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      out.push('<ol>');
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        out.push(`<li>${inline(lines[i].replace(/^\d+\.\s+/, ''))}</li>`);
        i++;
      }
      out.push('</ol>'); continue;
    }
    // Paragraph — join until next blank/heading/list.
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^#{1,6}\s+/.test(lines[i]) && !/^[-*]\s+/.test(lines[i]) && !/^\d+\.\s+/.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}
