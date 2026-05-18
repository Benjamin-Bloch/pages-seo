// Agent body markup — a small, *additive* tag language on top of
// Markdown. The LLM can emit either, or both. We pre-process custom
// blocks out of the input, render the rest with the existing Markdown
// engine, then re-insert the rendered custom HTML.
//
// Tags
//   /.h1./ ... /./       → <h2>...</h2>   (h1 collapsed to h2; the page
//                                          template owns the page-level h1)
//   /.h2./ ... /./       → <h2>...</h2>
//   /.h3./ ... /./       → <h3>...</h3>
//   /.p./ ... /./        → <p>...</p>
//   /.box.amber./ ... /./   → <div class="agent-box amber">...</div>
//   /.box./ ... /./      → <div class="agent-box">...</div>
//   /.callout./ ... /./  → <aside class="agent-callout">...</aside>
//   /.list./
//     /.item./ ... /./
//     /.item./ ... /./
//   /./                  → <ul><li>...</li>...</ul>
//   /.divider./          → <hr />
//
// The closing token /./ matches the most-recent opening tag.
// Tags may nest: an /.item./ inside a /.list./ renders as a <li>;
// outside a list it renders as a paragraph.
//
// Anything outside `/.X./ … /./` regions is left to Markdown. Inline
// markdown (**bold**, links) still works inside custom blocks because
// we render the captured body via `inline()` from markdown.js.

import { inlineRender } from './markdown.js';

// Allowed top-level block tags + their HTML mapping. The `class` field
// names the CSS class applied to the resulting element so site/admin
// stylesheets can pick them up.
const BLOCK_TAGS = {
  'h1':       { tag: 'h2' },                              // demoted
  'h2':       { tag: 'h2' },
  'h3':       { tag: 'h3' },
  'h4':       { tag: 'h4' },
  'p':        { tag: 'p'  },
  'callout':  { tag: 'aside', cls: 'agent-callout' },
  'divider':  { tag: 'hr',   void: true },
};

// `box` and `box.<colour>` get special handling.
const BOX_VARIANTS = new Set(['amber', 'green', 'red', 'blue', 'grey']);

// Top-level container tags whose children are list items.
const LIST_CONTAINERS = new Set(['list', 'ordered']);

// Recursive descent parser. Returns rendered HTML for a custom block.
function renderBlock(tag, body) {
  // Box variants: /.box./ /.box.amber./ /.box.green./ etc.
  if (tag === 'box' || tag.startsWith('box.')) {
    const variant = tag.startsWith('box.') ? tag.slice(4) : '';
    const cls = ['agent-box'];
    if (variant && BOX_VARIANTS.has(variant)) cls.push(variant);
    return `<div class="${cls.join(' ')}">${renderInner(body, /*inList*/ false)}</div>`;
  }

  // Lists.
  if (LIST_CONTAINERS.has(tag)) {
    const tagName = tag === 'ordered' ? 'ol' : 'ul';
    // Children that aren't /.item./ get wrapped as paragraphs.
    const inner = renderInner(body, /*inList*/ true);
    return `<${tagName}>${inner}</${tagName}>`;
  }

  // Items rendered out-of-list → paragraph fallback.
  if (tag === 'item') {
    return `<p>${inlineRender(body)}</p>`;
  }

  const def = BLOCK_TAGS[tag];
  if (!def) {
    // Unknown tag → emit the body as a paragraph and quietly drop the
    // tag. Better than failing silently or showing the source.
    return `<p>${inlineRender(body)}</p>`;
  }
  if (def.void) return `<${def.tag} />`;
  const cls = def.cls ? ` class="${def.cls}"` : '';
  return `<${def.tag}${cls}>${inlineRender(body)}</${def.tag}>`;
}

// Render the inner content of a block. If we're inside a list,
// `/.item./` children become <li>; everything else stays as a custom
// block. Outside a list, item → paragraph.
function renderInner(text, inList) {
  // Run another pass over the body — children may themselves be tags.
  const out = parseBlocks(text, inList);
  // Trim leading/trailing whitespace-only fragments.
  return out.trim();
}

// Scan a text region for `/.tag./ … /./` blocks and render them in
// place. Text outside tags is run through Markdown's inline renderer
// so **bold** etc still works. When `inList` is true, items become
// <li>; otherwise items become <p>.
function parseBlocks(text, inList) {
  if (!text) return '';
  let i = 0, out = '';
  const N = text.length;
  while (i < N) {
    // Look for the next opening tag.
    const open = text.slice(i).match(/\/\.([\w.-]+)\.\//);
    if (!open) {
      // No more tags; flush the rest.
      const rest = text.slice(i).trim();
      if (rest) out += inList ? '' : inlineRender(rest);
      break;
    }
    // Emit the gap before the tag.
    const gap = text.slice(i, i + open.index).trim();
    if (gap) out += inList ? '' : inlineRender(gap);

    const tag = open[1];
    const tagStart = i + open.index;
    const tagEnd = tagStart + open[0].length;

    // Void tags like /.divider./ have no closing /./.
    if (BLOCK_TAGS[tag]?.void) {
      out += renderBlock(tag, '');
      i = tagEnd;
      continue;
    }

    // Find the matching `/./`. We use balanced-scanning so nested
    // `/.X./ … /./` blocks inside the body don't close us early.
    let depth = 1;
    let scan = tagEnd;
    let closeAt = -1;
    while (scan < N) {
      const o = text.slice(scan).match(/\/\.([\w.-]+)\.\//);
      const c = text.slice(scan).indexOf('/./');
      const oIdx = o ? scan + o.index : -1;
      const cIdx = c >= 0 ? scan + c : -1;
      if (cIdx < 0) break; // no close found
      if (oIdx >= 0 && oIdx < cIdx) {
        // Skip past this inner opener (and its void-handling).
        const innerTag = o[1];
        const innerEnd = oIdx + o[0].length;
        if (BLOCK_TAGS[innerTag]?.void) { scan = innerEnd; continue; }
        depth++;
        scan = innerEnd;
        continue;
      }
      // It's a close.
      depth--;
      if (depth === 0) { closeAt = cIdx; break; }
      scan = cIdx + 3;
    }
    if (closeAt < 0) {
      // Unbalanced — render the opener as plaintext and continue.
      out += inList ? '' : inlineRender(open[0]);
      i = tagEnd;
      continue;
    }
    const body = text.slice(tagEnd, closeAt);
    // If we're inside a list, an `item` child becomes <li>.
    if (inList && tag === 'item') {
      out += `<li>${inlineRender(body.trim())}</li>`;
    } else {
      out += renderBlock(tag, body);
    }
    i = closeAt + 3;
  }
  return out;
}

// True if the input contains any agent-markup tags. Skip the
// pre-processing pass when none are present so plain-Markdown posts
// have zero overhead.
export function hasAgentMarkup(s) {
  return /\/\.[\w.-]+\.\//.test(String(s || ''));
}

// Pre-render: extract custom blocks into HTML, leaving the Markdown
// engine to handle anything else. Returns { md, blocks } where `md` is
// the source with placeholders for each rendered block, and `blocks`
// is a map of placeholder → final HTML. The caller renders md as
// Markdown, then runs `restoreBlocks(html, blocks)`.
export function extractBlocks(src) {
  const blocks = new Map();
  let n = 0;
  // Replace every top-level custom block with a placeholder. We pass
  // through parseBlocks to handle the rendering of each block.
  // The trick: identify each top-level block and substitute it with a
  // unique string token that Markdown will preserve verbatim.
  const placeholderFor = () => `\n\nAGENT_BLOCK_${(++n).toString(36).padStart(4, '0')}\n\n`;
  // We walk the same way parseBlocks does, but emit placeholders rather
  // than rendered HTML.
  let i = 0, out = '';
  const text = String(src || '');
  const N = text.length;
  while (i < N) {
    const open = text.slice(i).match(/\/\.([\w.-]+)\.\//);
    if (!open) { out += text.slice(i); break; }
    out += text.slice(i, i + open.index);
    const tag = open[1];
    const tagStart = i + open.index;
    const tagEnd = tagStart + open[0].length;
    if (BLOCK_TAGS[tag]?.void) {
      const ph = placeholderFor();
      blocks.set(ph.trim(), renderBlock(tag, ''));
      out += ph;
      i = tagEnd; continue;
    }
    let depth = 1, scan = tagEnd, closeAt = -1;
    while (scan < N) {
      const o = text.slice(scan).match(/\/\.([\w.-]+)\.\//);
      const c = text.slice(scan).indexOf('/./');
      const oIdx = o ? scan + o.index : -1;
      const cIdx = c >= 0 ? scan + c : -1;
      if (cIdx < 0) break;
      if (oIdx >= 0 && oIdx < cIdx) {
        const innerTag = o[1];
        const innerEnd = oIdx + o[0].length;
        if (BLOCK_TAGS[innerTag]?.void) { scan = innerEnd; continue; }
        depth++; scan = innerEnd; continue;
      }
      depth--;
      if (depth === 0) { closeAt = cIdx; break; }
      scan = cIdx + 3;
    }
    if (closeAt < 0) { out += open[0]; i = tagEnd; continue; }
    const body = text.slice(tagEnd, closeAt);
    const ph = placeholderFor();
    blocks.set(ph.trim(), renderBlock(tag, body));
    out += ph;
    i = closeAt + 3;
  }
  return { md: out, blocks };
}

// Re-substitute placeholders in the rendered HTML. Strip any wrapping
// `<p>…</p>` first: the Markdown renderer (correctly) wrapped the
// placeholder paragraph-style, but our blocks are themselves
// block-level HTML (<div>, <aside>, <hr>) and can't legally live
// inside a <p>.
export function restoreBlocks(html, blocks) {
  if (!blocks.size) return html;
  // Strip <p>…AGENT_BLOCK_xxxx…</p> wrappers first.
  html = html.replace(/<p>\s*(AGENT_BLOCK_[0-9a-z]+)\s*<\/p>/g, '$1');
  return html.replace(/AGENT_BLOCK_[0-9a-z]+/g, (m) => blocks.get(m) ?? m);
}
