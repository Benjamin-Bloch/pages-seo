// Small markdown -> HTML renderer for blog + programmatic page bodies.
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

// Apply emphasis / link / image / autolink rules to a run of text that
// is guaranteed NOT to contain an inline-code span.
function inlineNonCode(out) {
  // Images BEFORE links (same [...](...) shape but start with "!").
  out = out.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, (_, alt, url) =>
    `<img src="${url}" alt="${alt}" loading="lazy" decoding="async" />`);

  // Links -- http(s) or root-relative only.
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, (_, text, url) => {
    const isExternal = /^https?:/i.test(url);
    const rel = isExternal ? ' rel="nofollow noopener"' : '';
    return `<a href="${url}"${rel}>${text}</a>`;
  });

  // Bare-URL autolink. Capture greedily, then peel trailing sentence
  // punctuation and any unbalanced ")" back off so "see https://x.com."
  // keeps the period as prose. The leading guard (start, space, or "(")
  // means a URL already inside a generated href="..." is never re-matched.
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, (m, pre, rawUrl) => {
    let url = rawUrl;
    let trail = '';
    const punct = url.match(/[.,;:!?]+$/);
    if (punct) { trail = punct[0]; url = url.slice(0, -trail.length); }
    if (url.endsWith(')') && !url.includes('(')) { trail = ')' + trail; url = url.slice(0, -1); }
    if (!url) return m;
    return `${pre}<a href="${url}" rel="nofollow noopener">${url}</a>${trail}`;
  });

  // Emphasis: bold before italic before strikethrough. Underscore italic
  // uses boundary guards so snake_case identifiers aren't italicised.
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  out = out.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;!?]|$)/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return out;
}

function inline(s) {
  // Escape first, then split on inline-code spans. split() with a capture
  // group yields alternating segments: even = plain text, odd = code-span
  // contents. Plain text gets the full inline rules; code contents are
  // emitted verbatim inside <code>. No placeholder/sentinel is used, so
  // there is nothing for post content to collide with.
  const parts = escape(s).split(/`([^`]+)`/);
  let out = '';
  for (let k = 0; k < parts.length; k++) {
    out += (k % 2 === 1) ? `<code>${parts[k]}</code>` : inlineNonCode(parts[k]);
  }
  return out;
}

// Exposed so the agent-markup renderer can reuse the same inline rules
// inside custom blocks. Keep this in sync if `inline` changes.
export const inlineRender = inline;

// Pre-pass: Llama-class models sometimes emit a heading and the next
// paragraph on a single line, e.g. "# Title Body text starts here". We
// can't safely re-segment arbitrary prose, but we *can* enforce a line
// break before any `#`/`##`/`###` that appears mid-line -- markdown
// headings must start a line anyway.
function splitInlineHeadings(md) {
  // Insert a newline before any `#`-style heading that follows a real
  // non-newline character. Exclude `#` from the "previous char" class
  // so we don't shred multi-`#` openers -- e.g. `##` would otherwise
  // match as (#)(?)(# ) and turn into "#\n# " (a stray empty h1
  // followed by a real h1 instead of the intended h2).
  return md.replace(/([^\n#])(\n?)(#{1,6}\s+)/g, (_, prev, nl, h) => {
    if (nl) return prev + nl + h;
    return prev + '\n' + h;
  });
}

// agent_markup imports inlineRender from this file. ES modules handle
// this circular reference correctly because inlineRender is assigned
// during top-level execution before agent_markup's parse functions
// are called.
import * as agentMarkup from './agent_markup.js';

export function renderMarkdown(md) {
  const src = String(md || '').replace(/\r\n/g, '\n');
  // Fast path: no custom tags -> straight to Markdown.
  if (!agentMarkup.hasAgentMarkup(src)) return renderMarkdownInner(src);
  const { md: stripped, blocks } = agentMarkup.extractBlocks(src);
  const html = renderMarkdownInner(stripped);
  return agentMarkup.restoreBlocks(html, blocks);
}

function renderMarkdownInner(md) {
  const normalised = splitInlineHeadings(String(md || '').replace(/\r\n/g, '\n'));
  const lines = normalised.split('\n');
  const out = [];
  let i = 0;
  // We map H1 -> H2 in the rendered output because the page template
  // already owns the H1 (the post title). Two H1s on one page is bad SEO.
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    // Fenced code block (```lang ... ```). Captured verbatim and escaped --
    // no inline/heading/table processing inside, so JSON-LD snippets,
    // code samples, etc. render literally instead of leaking as text.
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([a-zA-Z0-9_-]*)\s*$/);
    if (fence) {
      const marker = fence[1][0]; // ` or ~
      const lang = fence[2] || '';
      i++;
      const code = [];
      while (i < lines.length && !new RegExp('^\\s*' + (marker === '`' ? '`{3,}' : '~{3,}') + '\\s*$').test(lines[i])) {
        code.push(lines[i]); i++;
      }
      if (i < lines.length) i++; // consume the closing fence
      const cls = lang ? ` class="language-${escape(lang)}"` : '';
      out.push(`<pre><code${cls}>${escape(code.join('\n'))}</code></pre>`);
      continue;
    }

    // Horizontal rule: a line of 3+ -, *, or _ (optionally spaced).
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('<hr />'); i++; continue;
    }

    // Blockquote: one or more consecutive lines beginning with ">".
    // Nested quotes (">>") collapse to a single level (good enough for
    // model output, which rarely nests). Inner lines are inline-rendered.
    if (/^\s*>\s?/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>+\s?/, '')); i++;
      }
      // Join quote lines into paragraphs (blank line splits paragraphs).
      const paras = quoted.join('\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
      const inner = paras.map((p) => `<p>${inline(p.replace(/\n/g, ' '))}</p>`).join('');
      out.push(`<blockquote>${inner}</blockquote>`);
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    // Cap heading length -- Llama sometimes runs the heading and body
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
    // GFM tables: a header row of pipe-separated cells, a separator row
    // (|---|:--:|), then body rows. The AI sometimes emits these and
    // without this they leaked as raw "| a | b |" text into the post.
    if (isTableRow(line) && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      const headers = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(alignOf);
      i += 2;
      const body = [];
      while (i < lines.length && isTableRow(lines[i])) {
        body.push(splitRow(lines[i])); i++;
      }
      out.push(renderTable(headers, aligns, body));
      continue;
    }
    // Lists (bullet or ordered), with nesting by leading indentation.
    // Collect every consecutive list line, then build a nested tree from
    // the indent levels. Handles mixed indent widths (2 or 4 spaces, or
    // tabs) by ranking the distinct indents encountered.
    if (LIST_RE.test(line)) {
      const listLines = [];
      while (i < lines.length && LIST_RE.test(lines[i])) { listLines.push(lines[i]); i++; }
      out.push(renderList(listLines));
      continue;
    }
    // Paragraph -- join until next blank/heading/list.
    // A line only ends the paragraph for a table if it actually *starts*
    // a table (header row immediately followed by a divider). A lone
    // sentence containing a "|" is just prose.
    const startsTable = (idx) => isTableRow(lines[idx]) && idx + 1 < lines.length && isTableDivider(lines[idx + 1]);
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^#{1,6}\s+/.test(lines[i]) && !LIST_RE.test(lines[i]) && !startsTable(i) && !/^\s*>\s?/.test(lines[i]) && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i]) && !/^\s*(`{3,}|~{3,})/.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    if (buf.length) out.push(`<p>${inline(buf.join(' '))}</p>`);
    else i++; // safety: avoid infinite loop on an unhandled line
  }
  return out.join('\n');
}

// ----------------------------------------------------------------- GFM table helpers -----------------------------------------------------------------
// A table row has at least one pipe and isn't a heading/list line.
function isTableRow(line) {
  const t = (line || '').trim();
  return t.includes('|') && !/^#{1,6}\s/.test(t) && !/^[-*]\s/.test(t);
}
// The divider row: cells of only dashes, optional leading/trailing colons.
function isTableDivider(line) {
  const t = (line || '').trim();
  if (!t.includes('|') && !t.includes('-')) return false;
  const cells = splitRow(t);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c.trim()));
}
// Split "| a | b |" -> ['a','b'] (tolerates missing outer pipes).
function splitRow(line) {
  let t = (line || '').trim();
  t = t.replace(/^\|/, '').replace(/\|$/, '');
  return t.split('|').map((c) => c.trim());
}
function alignOf(cell) {
  const c = (cell || '').trim();
  const l = c.startsWith(':'), r = c.endsWith(':');
  if (l && r) return 'center';
  if (r) return 'right';
  if (l) return 'left';
  return '';
}
function renderTable(headers, aligns, body) {
  const al = (i) => (aligns[i] ? ` style="text-align:${aligns[i]}"` : '');
  const head = headers.map((h, idx) => `<th${al(idx)}>${inline(h)}</th>`).join('');
  const rows = body.map((cells) => {
    // Pad/truncate to the header column count for safety.
    const tds = headers.map((_, idx) => `<td${al(idx)}>${inline(cells[idx] || '')}</td>`).join('');
    return `<tr>${tds}</tr>`;
  }).join('');
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ----------------------------------------------------------------- List helpers (nested) -----------------------------------------------------------------
// A list line: optional indent, then a bullet (-, *, +) or "N." marker.
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+/;

// Build nested <ul>/<ol> from a run of list lines. We rank the distinct
// indentation widths we see (so 2-space, 4-space, or tab nesting all
// work) and open/close lists as depth changes.
function renderList(listLines) {
  const items = listLines.map((ln) => {
    const m = ln.match(LIST_RE);
    const indent = m[1].replace(/\t/g, '    ').length;
    const ordered = /\d/.test(m[2]);
    const text = ln.slice(m[0].length);
    return { indent, ordered, text };
  });
  // Map raw indent widths -> depth levels 0,1,2...
  const widths = [...new Set(items.map((it) => it.indent))].sort((a, b) => a - b);
  const depthOf = (indent) => widths.indexOf(indent);

  let html = '';
  const stack = []; // each entry: the list tag ('ul'|'ol') open at that depth
  let openLi = -1;  // depth at which an <li> is currently open

  for (const it of items) {
    const depth = depthOf(it.indent);
    const tag = it.ordered ? 'ol' : 'ul';
    // Close deeper levels.
    while (stack.length - 1 > depth) {
      html += `</li></${stack.pop()}>`;
      openLi = stack.length - 1;
    }
    if (stack.length - 1 === depth) {
      // Same level: close the previous <li> before opening a new one.
      if (openLi === depth) html += '</li>';
    } else {
      // Going deeper: open a new nested list inside the current <li>.
      html += `<${tag}>`;
      stack.push(tag);
    }
    html += `<li>${inline(it.text.trim())}`;
    openLi = depth;
  }
  // Close everything still open.
  while (stack.length) { html += `</li></${stack.pop()}>`; }
  return html;
}
