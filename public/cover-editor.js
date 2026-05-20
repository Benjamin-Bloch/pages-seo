/* eslint-disable no-multi-assign */
//
// Cover designer — Canva-style rewrite.
//
// Lives separately from admin.js because it's substantial (~1400 LOC)
// and tightly self-contained. admin.js loads it on the Covers tab,
// then calls window.CoverEditor.init({ root, api, ...glue }).
//
// What's new vs. the old inline Cover module:
//
//   - Pointer events (touch + pen + mouse) instead of mouse-only.
//   - 8 resize handles (corners + edges) plus a rotation handle.
//   - Smart snap guides: when dragging/resizing, layers magnetically
//     align to canvas edges, canvas center, and every other layer's
//     edges + centers. Magenta guidelines render in real time.
//   - Marquee multi-select. Group-move; group-resize from any
//     bounding handle preserves relative layout. Align + distribute
//     in the floating toolbar when 2+ layers are selected.
//   - Floating toolbar over the selection (context-aware). Stays in
//     view above the selection unless that would clip the viewport,
//     in which case it flips below.
//   - Drag-from-sidebar onto the canvas (HTML5 DnD). Background
//     drops replace the bg; logos add a placed layer at the drop
//     point.
//   - Double-click a text layer to edit inline (positioned
//     contenteditable overlay; blur commits, Esc cancels).
//   - Right-click context menu: Bring forward / Send back / Duplicate
//     / Delete / Lock.
//   - Undo/redo with Cmd/Ctrl-Z + Cmd-Shift-Z. Every mutation goes
//     through cmd() so the history is consistent.
//   - Responsive canvas. Fits to the viewport with a scale factor;
//     zoom controls (25–400%) + reset (Cmd-0). Canvas pixels stay
//     at the spec resolution so exports remain 1200×630 or whatever
//     preset is chosen.
//   - Optional fields on layer schema: rotation (deg), opacity
//     (0–1), locked (bool). Old saved templates without these render
//     identically (defaults applied at render time).
//
// Backwards-compat: the template schema persisted to D1 is unchanged
// for old features. We only ADD optional fields. Server-side
// rendering (functions/_lib/cover_template.js or similar) does not
// need updates to keep loading old templates; if/when we want
// rotation/opacity to survive the apply step, those handlers will
// need a parallel update.

(function () {
  'use strict';

  // ── DOM helpers ──────────────────────────────────────────────────
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') e.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
        else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else if (k === 'dataset' && typeof v === 'object') Object.assign(e.dataset, v);
        else if (v === false || v == null) { /* skip */ }
        else if (v === true) e.setAttribute(k, '');
        else e.setAttribute(k, String(v));
      }
    }
    for (const c of children) {
      if (c == null || c === false) continue;
      e.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return e;
  }
  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // ── constants ────────────────────────────────────────────────────
  const FONT_FAMILIES = [
    { label: 'System', value: 'system-ui, -apple-system, Segoe UI, sans-serif' },
    { label: 'Inter',  value: 'Inter, sans-serif' },
    { label: 'Georgia', value: 'Georgia, serif' },
    { label: 'Times', value: '"Times New Roman", serif' },
    { label: 'Helvetica', value: '"Helvetica Neue", Arial, sans-serif' },
    { label: 'Courier', value: '"Courier New", monospace' },
    { label: 'Trebuchet', value: '"Trebuchet MS", sans-serif' },
    { label: 'Impact', value: 'Impact, sans-serif' },
  ];
  const FONT_WEIGHTS = ['300', '400', '500', '600', '700', '800'];
  const PRESETS = [
    { label: 'OG default 1200 × 630', w: 1200, h: 630 },
    { label: 'HD 1920 × 1080',        w: 1920, h: 1080 },
    { label: 'Square 1080 × 1080',    w: 1080, h: 1080 },
    { label: 'Portrait 1080 × 1350',  w: 1080, h: 1350 },
    { label: 'Pinterest 1000 × 1500', w: 1000, h: 1500 },
  ];
  // Pixels-in-canvas-space within which snapping engages. Felt
  // tuning value — small enough to ignore by moving fast, large
  // enough to grab on a deliberate slow drag.
  const SNAP_THRESHOLD = 6;

  // Image cache — keyed by URL. Returned as HTMLImageElement once
  // decoded.
  const imageCache = new Map();
  function loadImage(url) {
    if (!url) return Promise.resolve(null);
    if (imageCache.has(url)) return imageCache.get(url);
    const p = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
    imageCache.set(url, p);
    return p;
  }

  // Tiny UID — collision risk is low enough for a single editor session.
  function uid() { return 'l' + Math.random().toString(36).slice(2, 9); }

  // ── template/expression mirror ───────────────────────────────────
  // Same shape as the server's _lib/template.js so {title} etc.
  // preview consistently. Kept in lockstep with admin.js's earlier
  // copy — if you change one, change both.
  const TPL_FILTERS = {
    upper: (v) => String(v ?? '').toUpperCase(),
    lower: (v) => String(v ?? '').toLowerCase(),
    title: (v) => String(v ?? '').replace(/\w\S*/g, (t) => t[0].toUpperCase() + t.slice(1).toLowerCase()),
    truncate: (v, n) => {
      const s = String(v ?? '');
      const max = parseInt(n, 10) || 60;
      return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
    },
    default: (v, fb) => {
      const s = String(v ?? '').trim();
      return s ? v : (fb ?? '');
    },
    slug: (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    escape: (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    date: (v, fmt) => {
      const d = v ? new Date(v) : new Date();
      if (isNaN(d.getTime())) return '';
      const f = String(fmt || 'short');
      if (f === 'long') return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      if (f === 'short') return d.toISOString().slice(0, 10);
      return f
        .replace(/YYYY/g, d.getUTCFullYear())
        .replace(/MM/g, String(d.getUTCMonth() + 1).padStart(2, '0'))
        .replace(/DD/g, String(d.getUTCDate()).padStart(2, '0'))
        .replace(/HH/g, String(d.getUTCHours()).padStart(2, '0'))
        .replace(/mm/g, String(d.getUTCMinutes()).padStart(2, '0'));
    },
  };
  function tplLookup(ctx, path) {
    if (!path) return undefined;
    const parts = path.split('.');
    let cur = ctx;
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[p];
    }
    return cur;
  }
  function tplTruthy(v) {
    if (v == null || v === false || v === 0) return false;
    if (typeof v === 'string') {
      const s = v.trim();
      return !!s && s !== '0' && s.toLowerCase() !== 'false';
    }
    if (Array.isArray(v)) return v.length > 0;
    return true;
  }
  function tplExpand(template, ctx) {
    if (template == null) return '';
    let s = String(template);
    const re = /\{\s*if\s+(!)?\s*([a-zA-Z_][\w.]*)\s*\}([\s\S]*?)\{\s*\/if\s*\}/;
    for (let i = 0; i < 100; i++) {
      const m = s.match(re);
      if (!m) break;
      const v = tplLookup(ctx, m[2]);
      const keep = tplTruthy(v) !== (m[1] === '!') ? m[3] : '';
      s = s.slice(0, m.index) + keep + s.slice(m.index + m[0].length);
    }
    return s.replace(/\{\s*([^{}|][^{}]*?)\s*\}/g, (full, raw) => {
      if (/^\s*(if\s+|\/if)/i.test(raw)) return full;
      const parts = raw.split('|').map((p) => p.trim());
      const path = parts.shift();
      let v = tplLookup(ctx, path);
      for (const p of parts) {
        const colon = p.indexOf(':');
        const name = colon < 0 ? p.trim() : p.slice(0, colon).trim();
        let arg = colon < 0 ? undefined : p.slice(colon + 1).trim();
        if (arg) { const qm = arg.match(/^['"](.*)['"]$/); if (qm) arg = qm[1]; }
        const fn = TPL_FILTERS[name];
        if (typeof fn === 'function') { try { v = fn(v, arg); } catch { /* */ } }
      }
      return v == null ? '' : String(v);
    });
  }

  // ── editor state ─────────────────────────────────────────────────
  function defaultTemplate() {
    return { width: 1200, height: 630, background: null, layers: [] };
  }
  function makeState() {
    return {
      template: defaultTemplate(),
      selectedIds: new Set(),
      assets: { background: [], logo: [] },
      templates: [],
      posts: [],
      previewCtx: null,
      zoom: 1,            // 0.25–4
      autoFit: true,      // when true, zoom recalculates to fit container
      drag: null,         // active pointer interaction
      marquee: null,      // active marquee box (canvas-space)
      snapGuides: [],     // [{kind:'v'|'h', at:number}]
      editingTextId: null,
      contextMenu: null,
    };
  }

  // ── history (command stack) ──────────────────────────────────────
  function makeHistory() {
    return {
      past: [], future: [],
      capacity: 200,
      coalesceWith: null,    // when set, next push merges into the last entry if descriptor matches
    };
  }

  // ── core editor ──────────────────────────────────────────────────
  function CoverEditor() {
    const state = makeState();
    const history = makeHistory();
    let root;        // mount point
    let api;         // fetch helper from admin.js
    let glue;        // { onDirty, loadSettings, getWhoami }
    let canvas;      // <canvas>
    let ctx2d;       // 2D context
    let canvasWrap;  // container holding canvas + overlay
    let overlay;     // absolutely-positioned div over canvas for handles, guides, marquee
    let textEditor;  // contenteditable div for inline text editing
    let toolbar;     // floating toolbar
    let inspector;   // right panel
    let layersPanel; // left panel section
    let assetsPanel; // left panel section
    let zoomLabel;   // toolbar zoom indicator
    let presetSelect;
    let sizeLabel;
    let dirty = false;

    // ─── public init ─────────────────────────────────────────────
    function init(opts) {
      root = opts.root;
      api = opts.api;
      glue = opts.glue || {};
      build();
      bindGlobalKeys();
      // Initial render once mounted.
      requestAnimationFrame(() => {
        fitToContainer();
        redraw();
      });
    }

    // ─── layout build ────────────────────────────────────────────
    function build() {
      clearChildren(root);
      root.classList.add('ce-root');

      // ── header / toolbar ─────────────────────────────────────
      const header = el('header', { class: 'ce-header' },
        el('div', { class: 'ce-header-left' },
          el('label', { class: 'ce-size' },
            (sizeLabel = el('span', null, '1200 × 630')),
            (presetSelect = el('select', { class: 'ce-preset' },
              ...PRESETS.map((p, i) =>
                el('option', { value: i }, p.label),
              ),
              el('option', { value: 'custom' }, 'Custom…'),
            )),
          ),
          el('span', { class: 'ce-divider' }),
          (() => {
            const grp = el('div', { class: 'ce-zoom' });
            const out = el('button', { class: 'ce-icon-btn', title: 'Zoom out (Cmd −)', onclick: () => setZoom(state.zoom / 1.25) }, '−');
            zoomLabel = el('button', { class: 'ce-zoom-label', title: 'Reset zoom (Cmd 0)', onclick: () => { state.autoFit = true; fitToContainer(); redraw(); } }, '100%');
            const inn = el('button', { class: 'ce-icon-btn', title: 'Zoom in (Cmd +)', onclick: () => setZoom(state.zoom * 1.25) }, '+');
            grp.append(out, zoomLabel, inn);
            return grp;
          })(),
        ),
        el('div', { class: 'ce-header-center' },
          el('button', { class: 'ce-icon-btn', title: 'Undo (Cmd Z)', onclick: undo }, '↺'),
          el('button', { class: 'ce-icon-btn', title: 'Redo (Cmd Shift Z)', onclick: redo }, '↻'),
        ),
        el('div', { class: 'ce-header-right' },
          el('button', { class: 'ce-btn ce-btn-ghost', onclick: openSaveTemplateDialog }, 'Save as template'),
          el('button', { class: 'ce-btn', onclick: openApplyDialog }, 'Apply to post'),
        ),
      );

      presetSelect.addEventListener('change', () => {
        const v = presetSelect.value;
        if (v === 'custom') {
          const w = parseInt(prompt('Width in pixels', String(state.template.width)) || '0', 10);
          const h = parseInt(prompt('Height in pixels', String(state.template.height)) || '0', 10);
          if (!w || !h) { syncPresetSelect(); return; }
          cmd('resize-canvas', () => {
            state.template.width = clamp(w, 200, 4000);
            state.template.height = clamp(h, 200, 4000);
            updateSizeLabel();
            fitToContainer();
          });
        } else {
          const p = PRESETS[parseInt(v, 10)];
          if (!p) return;
          cmd('resize-canvas', () => {
            state.template.width = p.w; state.template.height = p.h;
            updateSizeLabel();
            fitToContainer();
          });
        }
      });

      // ── body: three-column workspace ──────────────────────────
      const body = el('div', { class: 'ce-body' });

      // Left sidebar — assets + layers
      const leftSidebar = el('aside', { class: 'ce-sidebar ce-sidebar-left' });
      const tabBar = el('div', { class: 'ce-sb-tabs' },
        el('button', { class: 'ce-sb-tab is-active', dataset: { tab: 'assets' }, onclick: (e) => switchSidebarTab(e.target) }, 'Assets'),
        el('button', { class: 'ce-sb-tab', dataset: { tab: 'layers' }, onclick: (e) => switchSidebarTab(e.target) }, 'Layers'),
        el('button', { class: 'ce-sb-tab', dataset: { tab: 'templates' }, onclick: (e) => switchSidebarTab(e.target) }, 'Templates'),
      );
      assetsPanel = el('div', { class: 'ce-sb-pane', dataset: { tab: 'assets' } });
      layersPanel = el('div', { class: 'ce-sb-pane is-hidden', dataset: { tab: 'layers' } });
      const templatesPanel = el('div', { class: 'ce-sb-pane is-hidden', dataset: { tab: 'templates' } });
      leftSidebar.append(tabBar, assetsPanel, layersPanel, templatesPanel);

      // Center — canvas viewport
      const center = el('main', { class: 'ce-center' });
      const viewport = el('div', { class: 'ce-viewport' });
      canvasWrap = el('div', { class: 'ce-canvas-wrap' });
      canvas = el('canvas', { class: 'ce-canvas', width: 1200, height: 630 });
      overlay = el('div', { class: 'ce-overlay' });
      canvasWrap.append(canvas, overlay);
      viewport.appendChild(canvasWrap);
      center.appendChild(viewport);

      // Right sidebar — inspector + preview
      const rightSidebar = el('aside', { class: 'ce-sidebar ce-sidebar-right' },
        el('div', { class: 'ce-sb-pane' },
          el('h3', { class: 'ce-sb-h' }, 'Preview with title'),
          el('div', { class: 'ce-row' },
            el('select', { id: 'ce-preview-post', class: 'ce-input', onchange: refreshPreview }, el('option', { value: '' }, '(pick post)')),
          ),
          el('div', { class: 'ce-row' },
            el('input', { id: 'ce-preview-title', class: 'ce-input', placeholder: 'or type a title…', oninput: refreshPreview }),
          ),
        ),
        (inspector = el('div', { class: 'ce-sb-pane ce-inspector' },
          el('h3', { class: 'ce-sb-h' }, 'Inspector'),
          el('p', { class: 'ce-dim' }, 'Select a layer to edit.'),
        )),
      );

      body.append(leftSidebar, center, rightSidebar);

      // Status bar at bottom
      const status = el('footer', { class: 'ce-status' },
        el('span', { class: 'ce-status-hint' }, 'Drop images on the canvas · Drag to move · Shift-drag to scale uniformly · Double-click text to edit'),
      );

      // Floating toolbar above selection (initially hidden)
      toolbar = el('div', { class: 'ce-float-toolbar', hidden: true });

      root.append(header, body, status, toolbar);

      // ── viewport handlers ─────────────────────────────────────
      ctx2d = canvas.getContext('2d');
      bindCanvas();
      bindDnD();
      window.addEventListener('resize', () => { fitToContainer(); redraw(); });

      // Initial sidebar render.
      renderAssetsPanel();
      renderLayersPanel();
      renderTemplatesPanel(templatesPanel);
    }

    function switchSidebarTab(button) {
      const sb = button.closest('.ce-sidebar');
      $$('.ce-sb-tab', sb).forEach((t) => t.classList.toggle('is-active', t === button));
      const tab = button.dataset.tab;
      $$('.ce-sb-pane', sb).forEach((p) => {
        p.classList.toggle('is-hidden', p.dataset.tab !== tab);
      });
    }

    function updateSizeLabel() {
      sizeLabel.textContent = `${state.template.width} × ${state.template.height}`;
    }
    function syncPresetSelect() {
      const idx = PRESETS.findIndex((p) => p.w === state.template.width && p.h === state.template.height);
      presetSelect.value = idx >= 0 ? String(idx) : 'custom';
    }

    // ── responsive scaling ────────────────────────────────────────
    function fitToContainer() {
      const vp = $('.ce-viewport', root);
      if (!vp) return;
      const padding = 48;
      const availW = vp.clientWidth  - padding;
      const availH = vp.clientHeight - padding;
      const sw = availW / state.template.width;
      const sh = availH / state.template.height;
      const fit = Math.min(sw, sh, 1.0); // never upscale past 100% on auto
      if (state.autoFit) {
        state.zoom = Math.max(0.25, fit);
      }
      applyZoom();
    }
    function setZoom(z) {
      state.autoFit = false;
      state.zoom = clamp(z, 0.25, 4);
      applyZoom();
      redraw();
    }
    function applyZoom() {
      const { width, height } = state.template;
      canvasWrap.style.width  = `${width * state.zoom}px`;
      canvasWrap.style.height = `${height * state.zoom}px`;
      // Match the canvas's CSS size to the wrap; canvas pixel size
      // stays at native so exports are full-res.
      canvas.style.width  = '100%';
      canvas.style.height = '100%';
      if (zoomLabel) zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
      // Reposition floating toolbar + handles.
      renderOverlay();
    }

    // ── command pattern (history) ─────────────────────────────────
    // We snapshot the template before mutating, run the mutator, then
    // push the (before, after) pair onto the past stack. Undo restores
    // the before snapshot; redo reapplies the after.
    //
    // descriptor is a string key. Successive commands with the same
    // descriptor within 500ms coalesce — typing in the inspector
    // doesn't produce one history entry per keystroke.
    let lastCmdAt = 0;
    function cmd(descriptor, mutator) {
      const before = snapshot();
      try { mutator(); }
      catch (e) { console.error('[cover] cmd failed', e); restoreSnapshot(before); return; }
      const after = snapshot();
      // No actual change? Skip.
      if (JSON.stringify(before) === JSON.stringify(after)) return;
      const now = Date.now();
      const last = history.past[history.past.length - 1];
      if (last && last.descriptor === descriptor && (now - lastCmdAt) < 500) {
        last.after = after;          // coalesce: extend the last command
      } else {
        history.past.push({ descriptor, before, after });
        if (history.past.length > history.capacity) history.past.shift();
      }
      lastCmdAt = now;
      history.future.length = 0;
      markDirty();
      redraw();
    }
    function snapshot() {
      return {
        template: JSON.parse(JSON.stringify(state.template)),
        selectedIds: Array.from(state.selectedIds),
      };
    }
    function restoreSnapshot(s) {
      state.template = JSON.parse(JSON.stringify(s.template));
      state.selectedIds = new Set(s.selectedIds);
      updateSizeLabel(); syncPresetSelect();
      redraw();
    }
    function undo() {
      const c = history.past.pop();
      if (!c) return;
      history.future.push(c);
      restoreSnapshot(c.before);
      markDirty();
    }
    function redo() {
      const c = history.future.pop();
      if (!c) return;
      history.past.push(c);
      restoreSnapshot(c.after);
      markDirty();
    }
    function markDirty() {
      dirty = true;
      if (glue.onDirty) glue.onDirty();
    }

    // ── render dispatcher ─────────────────────────────────────────
    let scheduled = false;
    function redraw() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(async () => {
        scheduled = false;
        try { await drawCanvas(); }
        catch (e) { console.error('[cover] draw', e); }
        renderOverlay();
        renderInspector();
        renderLayersPanel();
        renderFloatingToolbar();
      });
    }

    // ── canvas rendering ──────────────────────────────────────────
    async function drawCanvas() {
      const { width, height } = state.template;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width; canvas.height = height;
      }
      const c = ctx2d;
      c.clearRect(0, 0, width, height);

      if (state.template.background?.url) {
        const img = await loadImage(state.template.background.url);
        if (img) {
          const r = Math.max(width / img.width, height / img.height);
          const w = img.width * r, h = img.height * r;
          c.drawImage(img, (width - w) / 2, (height - h) / 2, w, h);
        }
      } else {
        c.fillStyle = '#111';
        c.fillRect(0, 0, width, height);
      }

      for (const layer of state.template.layers) {
        await drawLayer(c, layer, state.previewCtx);
      }
    }
    async function drawLayer(c, layer, previewCtx) {
      c.save();
      // Apply opacity + rotation.
      c.globalAlpha = layer.opacity != null ? layer.opacity : 1;
      const rot = layer.rotation || 0;
      if (rot) {
        c.translate(layer.x + layer.w / 2, layer.y + layer.h / 2);
        c.rotate(rot * Math.PI / 180);
        c.translate(-(layer.x + layer.w / 2), -(layer.y + layer.h / 2));
      }

      if (layer.kind === 'box') {
        c.fillStyle = layer.fill || 'rgba(0,0,0,0.55)';
        if (layer.radius) {
          roundRect(c, layer.x, layer.y, layer.w, layer.h, layer.radius);
          c.fill();
        } else {
          c.fillRect(layer.x, layer.y, layer.w, layer.h);
        }
      } else if (layer.kind === 'text') {
        const fontSize = layer.size || 60;
        const family = layer.family || FONT_FAMILIES[0].value;
        const weight = layer.weight || '600';
        const italic = layer.italic ? 'italic ' : '';
        c.font = `${italic}${weight} ${fontSize}px ${family}`;
        c.fillStyle = layer.color || '#ffffff';
        c.textBaseline = 'top';
        c.textAlign = layer.align || 'left';
        const display = tplExpand(layer.text, previewCtx || { title: layer.text || '' });
        const lines = wrapLines(c, display, layer.w);
        const lineHeight = fontSize * (layer.lineHeight || 1.15);
        let drawX = layer.x;
        if (layer.align === 'center') drawX = layer.x + layer.w / 2;
        if (layer.align === 'right')  drawX = layer.x + layer.w;
        for (let i = 0; i < lines.length; i++) {
          if (layer.shadow) {
            c.shadowColor = layer.shadowColor || 'rgba(0,0,0,0.6)';
            c.shadowBlur = layer.shadowBlur != null ? layer.shadowBlur : 8;
            c.shadowOffsetY = layer.shadowY != null ? layer.shadowY : 2;
          }
          c.fillText(lines[i], drawX, layer.y + i * lineHeight);
          c.shadowColor = 'transparent'; c.shadowBlur = 0; c.shadowOffsetY = 0;
        }
      } else if (layer.kind === 'logo' && layer.url) {
        const img = await loadImage(layer.url);
        if (img) {
          const r = Math.min(layer.w / img.width, layer.h / img.height);
          const w = img.width * r, h = img.height * r;
          c.drawImage(img, layer.x + (layer.w - w) / 2, layer.y + (layer.h - h) / 2, w, h);
        }
      }
      c.restore();
    }
    function roundRect(c, x, y, w, h, r) {
      r = Math.min(r, w / 2, h / 2);
      c.beginPath();
      c.moveTo(x + r, y);
      c.arcTo(x + w, y,     x + w, y + h, r);
      c.arcTo(x + w, y + h, x,     y + h, r);
      c.arcTo(x,     y + h, x,     y,     r);
      c.arcTo(x,     y,     x + w, y,     r);
      c.closePath();
    }
    function wrapLines(c, text, maxWidth) {
      const lines = [];
      for (const para of String(text).split('\n')) {
        const words = para.split(/\s+/).filter(Boolean);
        let line = '';
        for (const w of words) {
          const trial = line ? line + ' ' + w : w;
          if (c.measureText(trial).width <= maxWidth) line = trial;
          else {
            if (line) lines.push(line);
            line = w;
          }
        }
        if (line) lines.push(line);
        if (!words.length) lines.push('');
      }
      return lines;
    }

    // ── overlay rendering (selection handles + guides) ───────────
    function renderOverlay() {
      clearChildren(overlay);
      const sel = selectedLayers();
      // Snap guides.
      for (const g of state.snapGuides) {
        const line = el('div', { class: 'ce-guide ' + (g.kind === 'v' ? 'ce-guide-v' : 'ce-guide-h') });
        if (g.kind === 'v') {
          line.style.left = `${g.at * state.zoom}px`;
        } else {
          line.style.top = `${g.at * state.zoom}px`;
        }
        overlay.appendChild(line);
      }
      // Selection bounding box + handles.
      if (sel.length === 0) return;
      const bbox = boundingBox(sel);
      const sb = el('div', { class: 'ce-selection-box' });
      sb.style.left   = `${bbox.x * state.zoom}px`;
      sb.style.top    = `${bbox.y * state.zoom}px`;
      sb.style.width  = `${bbox.w * state.zoom}px`;
      sb.style.height = `${bbox.h * state.zoom}px`;
      overlay.appendChild(sb);
      // 8 resize handles.
      for (const h of HANDLES) {
        const dot = el('div', { class: 'ce-handle ce-handle-' + h.id, dataset: { handle: h.id } });
        const hx = bbox.x + h.fx * bbox.w;
        const hy = bbox.y + h.fy * bbox.h;
        dot.style.left = `${hx * state.zoom}px`;
        dot.style.top  = `${hy * state.zoom}px`;
        overlay.appendChild(dot);
      }
      // Rotation handle (single-layer only — group rotation is more
      // work than the v1 budget).
      if (sel.length === 1) {
        const rot = el('div', { class: 'ce-handle-rotate', dataset: { handle: 'rotate' } });
        const cx = (bbox.x + bbox.w / 2) * state.zoom;
        const cy = (bbox.y - 30 / state.zoom) * state.zoom;
        rot.style.left = `${cx}px`;
        rot.style.top  = `${cy}px`;
        overlay.appendChild(rot);
        // Connecting line.
        const line = el('div', { class: 'ce-rotate-link' });
        line.style.left = `${cx - 1}px`;
        line.style.top  = `${(bbox.y - 30 / state.zoom) * state.zoom}px`;
        line.style.height = `${30}px`;
        overlay.appendChild(line);
      }
      // Marquee.
      if (state.marquee) {
        const m = state.marquee;
        const x = Math.min(m.x0, m.x1), y = Math.min(m.y0, m.y1);
        const w = Math.abs(m.x1 - m.x0), h = Math.abs(m.y1 - m.y0);
        const box = el('div', { class: 'ce-marquee' });
        box.style.left   = `${x * state.zoom}px`;
        box.style.top    = `${y * state.zoom}px`;
        box.style.width  = `${w * state.zoom}px`;
        box.style.height = `${h * state.zoom}px`;
        overlay.appendChild(box);
      }
    }

    const HANDLES = [
      { id: 'nw', fx: 0,   fy: 0,   cursor: 'nwse-resize' },
      { id: 'n',  fx: 0.5, fy: 0,   cursor: 'ns-resize'   },
      { id: 'ne', fx: 1,   fy: 0,   cursor: 'nesw-resize' },
      { id: 'e',  fx: 1,   fy: 0.5, cursor: 'ew-resize'   },
      { id: 'se', fx: 1,   fy: 1,   cursor: 'nwse-resize' },
      { id: 's',  fx: 0.5, fy: 1,   cursor: 'ns-resize'   },
      { id: 'sw', fx: 0,   fy: 1,   cursor: 'nesw-resize' },
      { id: 'w',  fx: 0,   fy: 0.5, cursor: 'ew-resize'   },
    ];

    function selectedLayers() {
      return state.template.layers.filter((l) => state.selectedIds.has(l.id));
    }
    function boundingBox(layers) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const l of layers) {
        x0 = Math.min(x0, l.x);
        y0 = Math.min(y0, l.y);
        x1 = Math.max(x1, l.x + l.w);
        y1 = Math.max(y1, l.y + l.h);
      }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }

    // ── pointer interaction ──────────────────────────────────────
    function bindCanvas() {
      canvasWrap.addEventListener('pointerdown', onPointerDown);
      canvasWrap.addEventListener('pointermove', onPointerMove);
      canvasWrap.addEventListener('pointerup', onPointerUp);
      canvasWrap.addEventListener('pointercancel', onPointerUp);
      canvasWrap.addEventListener('dblclick', onDoubleClick);
      canvasWrap.addEventListener('contextmenu', onContextMenu);
    }
    function toCanvasCoords(ev) {
      const rect = canvas.getBoundingClientRect();
      const sx = state.template.width  / rect.width;
      const sy = state.template.height / rect.height;
      return { x: (ev.clientX - rect.left) * sx, y: (ev.clientY - rect.top) * sy };
    }
    function hitTest(px, py) {
      // Returns the topmost UNLOCKED layer under the point.
      for (let i = state.template.layers.length - 1; i >= 0; i--) {
        const l = state.template.layers[i];
        if (l.locked) continue;
        if (pointInLayer(l, px, py)) return l;
      }
      return null;
    }
    function pointInLayer(l, px, py) {
      // Approximation: ignore rotation in the hit-test for now. With
      // rotation, the bounding-box hit-test is a slight overshoot
      // (the user clicks slightly outside the rotated rect's visible
      // area but still hits). Acceptable until rotation is heavily
      // used; revisit with proper inverse-transform if needed.
      return px >= l.x && px <= l.x + l.w && py >= l.y && py <= l.y + l.h;
    }
    function onPointerDown(ev) {
      // Was a handle clicked? Handles live in the overlay layer.
      const handleEl = ev.target.closest('[data-handle]');
      const { x, y } = toCanvasCoords(ev);
      if (handleEl) {
        canvasWrap.setPointerCapture(ev.pointerId);
        const handle = handleEl.dataset.handle;
        const sel = selectedLayers();
        if (handle === 'rotate' && sel.length === 1) {
          beginRotate(sel[0], x, y);
        } else {
          beginResize(sel, handle, x, y);
        }
        return;
      }
      const hit = hitTest(x, y);
      if (!hit) {
        if (!ev.shiftKey) state.selectedIds.clear();
        canvasWrap.setPointerCapture(ev.pointerId);
        beginMarquee(x, y);
        redraw();
        return;
      }
      if (ev.shiftKey) {
        if (state.selectedIds.has(hit.id)) state.selectedIds.delete(hit.id);
        else state.selectedIds.add(hit.id);
      } else if (!state.selectedIds.has(hit.id)) {
        state.selectedIds = new Set([hit.id]);
      }
      canvasWrap.setPointerCapture(ev.pointerId);
      beginMove(x, y, ev.altKey);
      redraw();
    }
    function onPointerMove(ev) {
      if (!state.drag && !state.marquee) {
        // Update cursor on hover for affordances.
        const handleEl = ev.target.closest('[data-handle]');
        if (handleEl) {
          const h = HANDLES.find((x) => x.id === handleEl.dataset.handle);
          canvasWrap.style.cursor = h ? h.cursor : 'grab';
        } else {
          const { x, y } = toCanvasCoords(ev);
          canvasWrap.style.cursor = hitTest(x, y) ? 'move' : 'default';
        }
        return;
      }
      const { x, y } = toCanvasCoords(ev);
      if (state.marquee) {
        state.marquee.x1 = x; state.marquee.y1 = y;
        renderOverlay();
        return;
      }
      if (state.drag.mode === 'move')    doMove(x, y, ev.shiftKey);
      if (state.drag.mode === 'resize')  doResize(x, y, ev.shiftKey, ev.altKey);
      if (state.drag.mode === 'rotate')  doRotate(x, y, ev.shiftKey);
    }
    function onPointerUp(ev) {
      if (state.marquee) {
        const m = state.marquee;
        const box = {
          x: Math.min(m.x0, m.x1), y: Math.min(m.y0, m.y1),
          w: Math.abs(m.x1 - m.x0), h: Math.abs(m.y1 - m.y0),
        };
        state.marquee = null;
        // Anything with a non-trivial area gets the marquee select.
        // Click-without-drag clears the selection.
        if (box.w > 3 && box.h > 3) {
          const ids = state.template.layers
            .filter((l) => !l.locked && intersects(box, l))
            .map((l) => l.id);
          state.selectedIds = new Set(ids);
        }
        try { canvasWrap.releasePointerCapture(ev.pointerId); } catch { /* */ }
        redraw();
        return;
      }
      if (state.drag) {
        const desc = state.drag.descriptor;
        // The drag mutated state directly to keep it cheap; we now
        // wrap that in a single history entry by snapshotting the
        // pre-drag state we squirreled away in drag.before.
        const before = state.drag.before;
        const after = snapshot();
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          history.past.push({ descriptor: desc, before, after });
          if (history.past.length > history.capacity) history.past.shift();
          history.future.length = 0;
          markDirty();
        }
        state.drag = null;
        state.snapGuides = [];
        try { canvasWrap.releasePointerCapture(ev.pointerId); } catch { /* */ }
        redraw();
      }
    }
    function intersects(a, b) {
      return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
    }

    function beginMarquee(x, y) {
      state.marquee = { x0: x, y0: y, x1: x, y1: y };
    }
    function beginMove(x, y, dup) {
      const sel = selectedLayers();
      if (sel.length === 0) return;
      // Alt-drag = duplicate-on-start. The duplicates immediately
      // become the selection so the drag moves THEM, not the
      // originals.
      if (dup) {
        const clones = sel.map((l) => ({ ...JSON.parse(JSON.stringify(l)), id: uid() }));
        state.template.layers.push(...clones);
        state.selectedIds = new Set(clones.map((c) => c.id));
      }
      const layers = selectedLayers();
      state.drag = {
        mode: 'move',
        descriptor: dup ? 'dup-move' : 'move',
        startX: x, startY: y,
        before: snapshot(),
        origs: layers.map((l) => ({ id: l.id, x: l.x, y: l.y })),
      };
    }
    function beginResize(sel, handle, x, y) {
      if (sel.length === 0) return;
      const bbox = boundingBox(sel);
      state.drag = {
        mode: 'resize',
        handle,
        descriptor: 'resize',
        startX: x, startY: y,
        before: snapshot(),
        bbox: { ...bbox },
        origs: sel.map((l) => ({
          id: l.id,
          // Store relative position within the bounding box so we can
          // proportionally redistribute on group resize.
          rx: (l.x - bbox.x) / (bbox.w || 1),
          ry: (l.y - bbox.y) / (bbox.h || 1),
          rw: l.w / (bbox.w || 1),
          rh: l.h / (bbox.h || 1),
          origSize: l.size || null,
        })),
      };
    }
    function beginRotate(layer, x, y) {
      const cx = layer.x + layer.w / 2, cy = layer.y + layer.h / 2;
      state.drag = {
        mode: 'rotate',
        descriptor: 'rotate',
        before: snapshot(),
        cx, cy,
        startAngle: Math.atan2(y - cy, x - cx) * 180 / Math.PI,
        origRotation: layer.rotation || 0,
        layerId: layer.id,
      };
    }
    function doMove(x, y, axisLock) {
      const dx = x - state.drag.startX;
      const dy = y - state.drag.startY;
      // axisLock (shift) — confine to the dominant axis so the user
      // can drag straight without a steady hand.
      let mx = dx, my = dy;
      if (axisLock) {
        if (Math.abs(dx) > Math.abs(dy)) my = 0; else mx = 0;
      }
      // Apply move.
      for (const o of state.drag.origs) {
        const l = state.template.layers.find((x) => x.id === o.id);
        if (!l) continue;
        l.x = Math.round(o.x + mx);
        l.y = Math.round(o.y + my);
      }
      // Compute snap adjustments based on the post-move bounding box
      // of the selection (compared to siblings + canvas).
      const sel = selectedLayers();
      const snap = computeSnap(sel);
      if (snap.dx || snap.dy) {
        for (const o of state.drag.origs) {
          const l = state.template.layers.find((x) => x.id === o.id);
          if (l) { l.x += snap.dx; l.y += snap.dy; }
        }
      }
      state.snapGuides = snap.guides;
      drawCanvas().then(renderOverlay);
    }
    function doResize(x, y, uniform, fromCenter) {
      const d = state.drag;
      const bbox = d.bbox;
      const handle = d.handle;
      const minSize = 20;
      let nx = bbox.x, ny = bbox.y, nw = bbox.w, nh = bbox.h;
      if (handle.includes('e')) nw = Math.max(minSize, x - bbox.x);
      if (handle.includes('s')) nh = Math.max(minSize, y - bbox.y);
      if (handle.includes('w')) { nw = Math.max(minSize, bbox.x + bbox.w - x); nx = x; }
      if (handle.includes('n')) { nh = Math.max(minSize, bbox.y + bbox.h - y); ny = y; }
      if (uniform) {
        // Lock aspect ratio.
        const aspect = bbox.w / bbox.h;
        if (handle === 'e' || handle === 'w') nh = nw / aspect;
        else if (handle === 'n' || handle === 's') nw = nh * aspect;
        else { // corner
          const ratio = Math.max(nw / bbox.w, nh / bbox.h);
          nw = bbox.w * ratio;
          nh = bbox.h * ratio;
          if (handle.includes('w')) nx = bbox.x + bbox.w - nw;
          if (handle.includes('n')) ny = bbox.y + bbox.h - nh;
        }
      }
      if (fromCenter) {
        const dx = (nw - bbox.w) / 2, dy = (nh - bbox.h) / 2;
        nx = bbox.x - dx; ny = bbox.y - dy;
        nw = bbox.w + 2 * dx; nh = bbox.h + 2 * dy;
      }
      // Apply to each selected layer, keeping their relative position
      // inside the bbox.
      for (const o of d.origs) {
        const l = state.template.layers.find((x) => x.id === o.id);
        if (!l) continue;
        l.x = Math.round(nx + o.rx * nw);
        l.y = Math.round(ny + o.ry * nh);
        l.w = Math.max(minSize, Math.round(o.rw * nw));
        l.h = Math.max(minSize, Math.round(o.rh * nh));
        // Text layers: scale font size proportionally when grabbing a
        // corner. Edge handles change only one dim — leave font alone.
        if (l.kind === 'text' && o.origSize != null && (handle.length === 2)) {
          const f = Math.min(nw / bbox.w, nh / bbox.h);
          l.size = Math.max(8, Math.round(o.origSize * f));
        }
      }
      drawCanvas().then(renderOverlay);
    }
    function doRotate(x, y, snap) {
      const d = state.drag;
      const layer = state.template.layers.find((l) => l.id === d.layerId);
      if (!layer) return;
      const ang = Math.atan2(y - d.cy, x - d.cx) * 180 / Math.PI;
      let next = d.origRotation + (ang - d.startAngle);
      if (snap) next = Math.round(next / 15) * 15;
      layer.rotation = ((next + 360) % 360);
      drawCanvas().then(renderOverlay);
    }

    // ── snapping ──────────────────────────────────────────────────
    function computeSnap(sel) {
      if (sel.length === 0) return { dx: 0, dy: 0, guides: [] };
      const bbox = boundingBox(sel);
      const cw = state.template.width, ch = state.template.height;
      // Candidate vertical lines (x values) and horizontal lines (y).
      const vTargets = [0, cw / 2, cw];
      const hTargets = [0, ch / 2, ch];
      // Add other layers' edges + centers.
      for (const other of state.template.layers) {
        if (state.selectedIds.has(other.id)) continue;
        vTargets.push(other.x, other.x + other.w / 2, other.x + other.w);
        hTargets.push(other.y, other.y + other.h / 2, other.y + other.h);
      }
      // The selection's own snap points.
      const vSources = [bbox.x, bbox.x + bbox.w / 2, bbox.x + bbox.w];
      const hSources = [bbox.y, bbox.y + bbox.h / 2, bbox.y + bbox.h];

      let dx = 0, dy = 0;
      const guides = [];
      let bestDx = Infinity, bestDy = Infinity;
      for (const src of vSources) {
        for (const tgt of vTargets) {
          const d = tgt - src;
          if (Math.abs(d) < SNAP_THRESHOLD && Math.abs(d) < Math.abs(bestDx)) {
            bestDx = d;
          }
        }
      }
      for (const src of hSources) {
        for (const tgt of hTargets) {
          const d = tgt - src;
          if (Math.abs(d) < SNAP_THRESHOLD && Math.abs(d) < Math.abs(bestDy)) {
            bestDy = d;
          }
        }
      }
      if (bestDx !== Infinity) dx = bestDx;
      if (bestDy !== Infinity) dy = bestDy;
      // Build guide lines at the snapped position.
      const finalV = [bbox.x + dx, bbox.x + bbox.w / 2 + dx, bbox.x + bbox.w + dx];
      const finalH = [bbox.y + dy, bbox.y + bbox.h / 2 + dy, bbox.y + bbox.h + dy];
      for (const v of finalV) {
        if (vTargets.some((t) => Math.abs(t - v) < 0.5)) guides.push({ kind: 'v', at: v });
      }
      for (const h of finalH) {
        if (hTargets.some((t) => Math.abs(t - h) < 0.5)) guides.push({ kind: 'h', at: h });
      }
      return { dx, dy, guides };
    }

    // ── double-click / inline edit ───────────────────────────────
    function onDoubleClick(ev) {
      const { x, y } = toCanvasCoords(ev);
      const hit = hitTest(x, y);
      if (!hit || hit.kind !== 'text') return;
      beginInlineTextEdit(hit);
    }
    function beginInlineTextEdit(layer) {
      // Replace the canvas-rendered text with a contenteditable
      // positioned over the layer's bounds. On blur or Esc, commit.
      if (textEditor) endInlineTextEdit(false);
      state.editingTextId = layer.id;
      const ed = el('div', {
        class: 'ce-text-editor',
        contenteditable: 'true',
        style: {
          left:   `${layer.x * state.zoom}px`,
          top:    `${layer.y * state.zoom}px`,
          width:  `${layer.w * state.zoom}px`,
          minHeight: `${layer.h * state.zoom}px`,
          fontSize: `${(layer.size || 60) * state.zoom}px`,
          fontFamily: layer.family || FONT_FAMILIES[0].value,
          fontWeight: layer.weight || '600',
          color: layer.color || '#ffffff',
          textAlign: layer.align || 'left',
          fontStyle: layer.italic ? 'italic' : 'normal',
        },
      });
      ed.textContent = layer.text || '';
      ed.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); endInlineTextEdit(false); }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); endInlineTextEdit(true); }
      });
      ed.addEventListener('blur', () => endInlineTextEdit(true));
      overlay.appendChild(ed);
      textEditor = ed;
      // Microtask so the browser focuses after appending.
      setTimeout(() => {
        ed.focus();
        document.execCommand('selectAll', false, null);
      }, 0);
    }
    function endInlineTextEdit(commit) {
      if (!textEditor || !state.editingTextId) return;
      const id = state.editingTextId;
      const newText = textEditor.textContent;
      textEditor.remove();
      textEditor = null;
      state.editingTextId = null;
      if (!commit) return;
      cmd('edit-text', () => {
        const l = state.template.layers.find((x) => x.id === id);
        if (l) l.text = newText;
      });
    }

    // ── right-click context menu ─────────────────────────────────
    function onContextMenu(ev) {
      ev.preventDefault();
      const { x, y } = toCanvasCoords(ev);
      const hit = hitTest(x, y);
      if (hit && !state.selectedIds.has(hit.id)) {
        state.selectedIds = new Set([hit.id]);
        renderOverlay();
      }
      if (state.selectedIds.size === 0) return;
      showContextMenu(ev.clientX, ev.clientY);
    }
    function showContextMenu(clientX, clientY) {
      hideContextMenu();
      const sel = selectedLayers();
      const anyLocked = sel.some((l) => l.locked);
      const menu = el('div', { class: 'ce-context-menu' },
        menuItem('Bring forward', () => moveZ(+1)),
        menuItem('Bring to front', () => moveZ(+Infinity)),
        menuItem('Send backward', () => moveZ(-1)),
        menuItem('Send to back', () => moveZ(-Infinity)),
        el('div', { class: 'ce-context-sep' }),
        menuItem('Duplicate (⌘D)', duplicateSelection),
        menuItem(anyLocked ? 'Unlock' : 'Lock', toggleLock),
        menuItem('Delete (⌫)', deleteSelection),
      );
      menu.style.left = `${clientX}px`;
      menu.style.top  = `${clientY}px`;
      document.body.appendChild(menu);
      state.contextMenu = menu;
      const close = (e) => {
        if (e.target.closest('.ce-context-menu')) return;
        hideContextMenu();
        document.removeEventListener('mousedown', close, true);
      };
      // setTimeout so the contextmenu event's own propagation doesn't
      // close us immediately.
      setTimeout(() => document.addEventListener('mousedown', close, true), 0);
    }
    function menuItem(label, fn) {
      return el('button', { class: 'ce-context-item', onclick: () => { fn(); hideContextMenu(); } }, label);
    }
    function hideContextMenu() {
      if (state.contextMenu) {
        state.contextMenu.remove();
        state.contextMenu = null;
      }
    }
    function moveZ(delta) {
      cmd('zorder', () => {
        const layers = state.template.layers;
        const sel = sortedSelection();
        if (delta === +Infinity) {
          // Move all to the top, preserving relative order.
          const others = layers.filter((l) => !state.selectedIds.has(l.id));
          state.template.layers = others.concat(sel);
        } else if (delta === -Infinity) {
          const others = layers.filter((l) => !state.selectedIds.has(l.id));
          state.template.layers = sel.concat(others);
        } else if (delta > 0) {
          for (let i = layers.length - 2; i >= 0; i--) {
            if (state.selectedIds.has(layers[i].id) && !state.selectedIds.has(layers[i + 1].id)) {
              [layers[i], layers[i + 1]] = [layers[i + 1], layers[i]];
            }
          }
        } else if (delta < 0) {
          for (let i = 1; i < layers.length; i++) {
            if (state.selectedIds.has(layers[i].id) && !state.selectedIds.has(layers[i - 1].id)) {
              [layers[i], layers[i - 1]] = [layers[i - 1], layers[i]];
            }
          }
        }
      });
    }
    function sortedSelection() {
      // Selection in current z-order, lowest first.
      return state.template.layers.filter((l) => state.selectedIds.has(l.id));
    }
    function duplicateSelection() {
      cmd('duplicate', () => {
        const clones = selectedLayers().map((l) => ({
          ...JSON.parse(JSON.stringify(l)),
          id: uid(),
          x: l.x + 20,
          y: l.y + 20,
        }));
        state.template.layers.push(...clones);
        state.selectedIds = new Set(clones.map((c) => c.id));
      });
    }
    function toggleLock() {
      cmd('lock', () => {
        const sel = selectedLayers();
        const anyUnlocked = sel.some((l) => !l.locked);
        for (const l of sel) l.locked = anyUnlocked;
      });
    }
    function deleteSelection() {
      cmd('delete', () => {
        state.template.layers = state.template.layers.filter((l) => !state.selectedIds.has(l.id));
        state.selectedIds.clear();
      });
    }

    // ── floating toolbar ─────────────────────────────────────────
    function renderFloatingToolbar() {
      clearChildren(toolbar);
      const sel = selectedLayers();
      if (sel.length === 0) { toolbar.hidden = true; return; }

      // Single text layer → text controls inline.
      if (sel.length === 1 && sel[0].kind === 'text') {
        const l = sel[0];
        appendTextControls(toolbar, l);
      } else if (sel.length === 1 && sel[0].kind === 'box') {
        appendBoxControls(toolbar, sel[0]);
      } else if (sel.length === 1 && sel[0].kind === 'logo') {
        appendLogoControls(toolbar, sel[0]);
      } else {
        appendMultiControls(toolbar, sel);
      }
      // Common controls — always.
      toolbar.append(
        el('span', { class: 'ce-tb-sep' }),
        iconBtn('⇧', 'Bring to front', () => moveZ(+Infinity)),
        iconBtn('⇩', 'Send to back',  () => moveZ(-Infinity)),
        iconBtn('⎘', 'Duplicate (⌘D)',  duplicateSelection),
        iconBtn('🔒', 'Lock / unlock', toggleLock),
        iconBtn('🗑', 'Delete (⌫)',    deleteSelection),
      );

      // Position above the selection's bounding box.
      const bbox = boundingBox(sel);
      const wrap = canvasWrap.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      const cx = (bbox.x + bbox.w / 2) * state.zoom + (wrap.left - rootRect.left);
      const cy = bbox.y * state.zoom + (wrap.top - rootRect.top);
      toolbar.hidden = false;
      toolbar.style.left = `${cx}px`;
      // Toolbar is translated -50% horizontally + translated above
      // the bbox top with a small gap. If that would go off the top
      // of the workspace, flip it below.
      toolbar.style.top = `${cy}px`;
      toolbar.style.transform = 'translate(-50%, calc(-100% - 8px))';
      requestAnimationFrame(() => {
        const tbRect = toolbar.getBoundingClientRect();
        if (tbRect.top < rootRect.top + 8) {
          // Flip below.
          toolbar.style.top = `${(bbox.y + bbox.h) * state.zoom + (wrap.top - rootRect.top)}px`;
          toolbar.style.transform = 'translate(-50%, 8px)';
        }
      });
    }
    function appendTextControls(toolbar, l) {
      // Font family.
      const fam = el('select', { class: 'ce-tb-input', onchange: () => cmd('text-style', () => l.family = fam.value) });
      for (const f of FONT_FAMILIES) {
        fam.appendChild(el('option', { value: f.value, selected: l.family === f.value }, f.label));
      }
      // Size.
      const size = el('input', { type: 'number', class: 'ce-tb-input ce-tb-size', min: 8, max: 400, value: l.size || 60,
        oninput: () => cmd('text-style', () => l.size = clamp(parseInt(size.value, 10) || 60, 8, 400)) });
      // Weight (dropdown).
      const weight = el('select', { class: 'ce-tb-input', onchange: () => cmd('text-style', () => l.weight = weight.value) });
      for (const w of FONT_WEIGHTS) weight.appendChild(el('option', { value: w, selected: (l.weight || '600') === w }, w));
      // Color.
      const color = el('input', { type: 'color', class: 'ce-tb-color', value: hexOnly(l.color || '#ffffff'),
        oninput: () => cmd('text-style', () => l.color = color.value) });
      // Bold toggle (jumps weight between 400 and 700).
      const bold = iconBtn('B', 'Bold', () => cmd('text-style', () => {
        l.weight = (parseInt(l.weight, 10) || 400) >= 600 ? '400' : '700';
      }));
      bold.classList.toggle('is-on', (parseInt(l.weight, 10) || 400) >= 600);
      const italic = iconBtn('I', 'Italic', () => cmd('text-style', () => { l.italic = !l.italic; }));
      italic.classList.toggle('is-on', !!l.italic);
      // Align.
      const align = el('div', { class: 'ce-tb-segmented' });
      for (const a of ['left', 'center', 'right']) {
        const b = el('button', { class: 'ce-tb-seg', dataset: { align: a },
          title: 'Align ' + a, onclick: () => cmd('text-style', () => l.align = a) },
          a === 'left' ? '⯇' : a === 'right' ? '⯈' : '═');
        if ((l.align || 'left') === a) b.classList.add('is-on');
        align.appendChild(b);
      }
      const shadow = iconBtn('☼', 'Shadow', () => cmd('text-style', () => { l.shadow = !l.shadow; }));
      shadow.classList.toggle('is-on', !!l.shadow);
      toolbar.append(fam, size, weight, bold, italic, align, color, shadow);
    }
    function appendBoxControls(toolbar, l) {
      const baseHex = hexOnly(l.fill || '#000000');
      const baseAlpha = parseAlpha(l.fill, 0.55);
      const color = el('input', { type: 'color', class: 'ce-tb-color', value: baseHex,
        oninput: () => cmd('box-style', () => { l.fill = hexToRgba(color.value, alpha.value); }) });
      const alpha = el('input', { type: 'range', class: 'ce-tb-input ce-tb-range', min: 0, max: 1, step: 0.05, value: String(baseAlpha),
        oninput: () => cmd('box-style', () => { l.fill = hexToRgba(color.value, alpha.value); }) });
      const radius = el('input', { type: 'number', class: 'ce-tb-input ce-tb-size', min: 0, max: 999, value: l.radius || 0,
        oninput: () => cmd('box-style', () => { l.radius = parseInt(radius.value, 10) || 0; }) });
      toolbar.append(
        el('span', { class: 'ce-tb-lbl' }, 'Fill'), color,
        el('span', { class: 'ce-tb-lbl' }, 'Alpha'), alpha,
        el('span', { class: 'ce-tb-lbl' }, 'Radius'), radius,
      );
    }
    function appendLogoControls(toolbar, l) {
      const sel = el('select', { class: 'ce-tb-input', onchange: () => cmd('logo-source', () => {
        l.url = sel.value || null; l.asset_id = null;
      }) });
      sel.appendChild(el('option', { value: '' }, '(no logo)'));
      for (const a of state.assets.logo) {
        sel.appendChild(el('option', { value: a.url, selected: l.url === a.url }, a.original_name || a.id));
      }
      toolbar.append(el('span', { class: 'ce-tb-lbl' }, 'Source'), sel);
    }
    function appendMultiControls(toolbar, sel) {
      // Align (relative to bounding box).
      const align = (axis, mode) => () => cmd('align', () => {
        const bbox = boundingBox(sel);
        for (const l of sel) {
          if (axis === 'x') {
            if (mode === 'left')   l.x = bbox.x;
            if (mode === 'center') l.x = bbox.x + (bbox.w - l.w) / 2;
            if (mode === 'right')  l.x = bbox.x + bbox.w - l.w;
          } else {
            if (mode === 'top')    l.y = bbox.y;
            if (mode === 'center') l.y = bbox.y + (bbox.h - l.h) / 2;
            if (mode === 'bottom') l.y = bbox.y + bbox.h - l.h;
          }
        }
      });
      toolbar.append(
        iconBtn('⫷', 'Align left',   align('x', 'left')),
        iconBtn('⫸', 'Align right',  align('x', 'right')),
        iconBtn('⊟', 'Center horizontally', align('x', 'center')),
        el('span', { class: 'ce-tb-sep' }),
        iconBtn('⊺', 'Align top',    align('y', 'top')),
        iconBtn('⊥', 'Align bottom', align('y', 'bottom')),
        iconBtn('⊟', 'Center vertically', align('y', 'center')),
      );
      if (sel.length >= 3) {
        toolbar.append(
          el('span', { class: 'ce-tb-sep' }),
          iconBtn('⇔', 'Distribute horizontally', () => cmd('distribute', () => distribute(sel, 'x'))),
          iconBtn('⇕', 'Distribute vertically',   () => cmd('distribute', () => distribute(sel, 'y'))),
        );
      }
    }
    function distribute(layers, axis) {
      // Sort by axis position; redistribute centers evenly between
      // the first and last layer's centers.
      const sorted = [...layers].sort((a, b) => (axis === 'x' ? a.x + a.w / 2 - (b.x + b.w / 2) : a.y + a.h / 2 - (b.y + b.h / 2)));
      if (sorted.length < 3) return;
      const first = sorted[0], last = sorted[sorted.length - 1];
      const start = axis === 'x' ? first.x + first.w / 2 : first.y + first.h / 2;
      const end   = axis === 'x' ? last.x  + last.w  / 2 : last.y  + last.h  / 2;
      const step  = (end - start) / (sorted.length - 1);
      for (let i = 1; i < sorted.length - 1; i++) {
        const c = start + i * step;
        const l = sorted[i];
        if (axis === 'x') l.x = c - l.w / 2;
        else l.y = c - l.h / 2;
      }
    }
    function iconBtn(label, title, fn) {
      return el('button', { class: 'ce-tb-icon', title, onclick: fn }, label);
    }

    // ── inspector (right side) ───────────────────────────────────
    function renderInspector() {
      clearChildren(inspector);
      inspector.appendChild(el('h3', { class: 'ce-sb-h' }, 'Inspector'));
      const sel = selectedLayers();
      if (sel.length === 0) {
        inspector.appendChild(el('p', { class: 'ce-dim' }, 'Select a layer to edit. Or drag an asset onto the canvas.'));
        return;
      }
      const grid = el('div', { class: 'ce-grid' });
      if (sel.length > 1) {
        grid.append(label2('Selected', el('span', null, `${sel.length} layers`)));
      } else {
        const l = sel[0];
        grid.append(
          label2('X', numIn(l.x, (v) => cmd('coords', () => l.x = v))),
          label2('Y', numIn(l.y, (v) => cmd('coords', () => l.y = v))),
          label2('W', numIn(l.w, (v) => cmd('coords', () => l.w = v))),
          label2('H', numIn(l.h, (v) => cmd('coords', () => l.h = v))),
        );
        if (l.kind === 'text') {
          const ta = el('textarea', { class: 'ce-input', rows: 3,
            oninput: () => cmd('text-edit', () => l.text = ta.value),
          });
          ta.value = l.text || '';
          grid.append(label2('Text', ta, true));
        }
        if (l.rotation || l.kind !== 'box') {
          grid.append(label2('Rotation°', numIn(l.rotation || 0, (v) => cmd('rotate-num', () => l.rotation = v))));
        }
        grid.append(label2('Opacity', el('input', {
          type: 'range', min: 0, max: 1, step: 0.05, value: String(l.opacity ?? 1),
          oninput: (e) => cmd('opacity', () => l.opacity = parseFloat(e.target.value)),
        })));
      }
      inspector.appendChild(grid);
    }
    function label2(label, input, full) {
      const wrap = el('label', { class: 'ce-grid-row' + (full ? ' ce-grid-full' : '') },
        el('span', null, label), input);
      return wrap;
    }
    function numIn(value, fn) {
      const inp = el('input', { type: 'number', class: 'ce-input ce-input-num', value: value ?? 0 });
      inp.addEventListener('input', () => fn(parseFloat(inp.value) || 0));
      return inp;
    }

    // ── layers panel ─────────────────────────────────────────────
    function renderLayersPanel() {
      clearChildren(layersPanel);
      layersPanel.appendChild(el('div', { class: 'ce-sb-section' },
        el('h3', { class: 'ce-sb-h' }, 'Layers'),
        el('div', { class: 'ce-add-row' },
          el('button', { class: 'ce-btn ce-btn-ghost ce-btn-sm', onclick: () => addLayer('text') }, '+ Text'),
          el('button', { class: 'ce-btn ce-btn-ghost ce-btn-sm', onclick: () => addLayer('box') }, '+ Box'),
          el('button', { class: 'ce-btn ce-btn-ghost ce-btn-sm', onclick: () => addLayer('logo') }, '+ Logo'),
        ),
      ));
      const ul = el('ul', { class: 'ce-layers' });
      const layers = [...state.template.layers].reverse();
      if (!layers.length) {
        ul.appendChild(el('li', { class: 'ce-dim' }, 'No layers yet.'));
      }
      for (const l of layers) {
        const li = el('li', { class: 'ce-layer' + (state.selectedIds.has(l.id) ? ' is-selected' : '') });
        const icon = l.kind === 'text' ? '𝐓' : l.kind === 'box' ? '▭' : '🖼';
        const label = l.kind === 'text' ? (l.text || '(empty)') :
                      l.kind === 'box'  ? 'Box' :
                      l.kind === 'logo' ? 'Logo' : l.kind;
        li.append(
          el('span', { class: 'ce-layer-icon' }, icon),
          el('span', { class: 'ce-layer-label' }, String(label).slice(0, 28)),
        );
        li.addEventListener('click', (e) => {
          if (e.shiftKey) {
            if (state.selectedIds.has(l.id)) state.selectedIds.delete(l.id);
            else state.selectedIds.add(l.id);
          } else {
            state.selectedIds = new Set([l.id]);
          }
          redraw();
        });
        if (l.locked) li.appendChild(el('span', { class: 'ce-layer-lock', title: 'Locked' }, '🔒'));
        ul.appendChild(li);
      }
      layersPanel.appendChild(ul);
    }

    // ── assets panel ─────────────────────────────────────────────
    function renderAssetsPanel() {
      clearChildren(assetsPanel);
      assetsPanel.append(
        el('div', { class: 'ce-sb-section' },
          el('h3', { class: 'ce-sb-h' }, 'Backgrounds'),
          (() => {
            const lbl = el('label', { class: 'ce-btn ce-btn-ghost ce-btn-sm ce-upload-btn' },
              '+ Upload background',
              el('input', { type: 'file', accept: 'image/*', hidden: true,
                onchange: (e) => { const f = e.target.files[0]; if (f) uploadAsset('background', f); e.target.value = ''; }
              }),
            );
            return lbl;
          })(),
          assetGrid('background'),
        ),
        el('div', { class: 'ce-sb-section' },
          el('h3', { class: 'ce-sb-h' }, 'Logos'),
          (() => {
            const lbl = el('label', { class: 'ce-btn ce-btn-ghost ce-btn-sm ce-upload-btn' },
              '+ Upload logo',
              el('input', { type: 'file', accept: 'image/*', hidden: true,
                onchange: (e) => { const f = e.target.files[0]; if (f) uploadAsset('logo', f); e.target.value = ''; }
              }),
            );
            return lbl;
          })(),
          assetGrid('logo'),
        ),
      );
    }
    function assetGrid(kind) {
      const grid = el('div', { class: 'ce-asset-grid' });
      const items = state.assets[kind] || [];
      if (!items.length) {
        grid.appendChild(el('div', { class: 'ce-dim' }, kind === 'background' ? 'No backgrounds yet.' : 'No logos yet.'));
        return grid;
      }
      for (const a of items) {
        const card = el('div', { class: 'ce-asset', draggable: true });
        card.appendChild(el('img', { src: a.url, loading: 'lazy', alt: a.original_name || '' }));
        const del = el('button', { class: 'ce-asset-del', title: 'Delete',
          onclick: async (e) => {
            e.stopPropagation();
            if (!confirm('Delete this asset?')) return;
            await api('/api/admin/cover/upload?id=' + encodeURIComponent(a.id), { method: 'DELETE' });
            await loadAssets();
          },
        }, '×');
        card.appendChild(del);
        card.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('application/x-cover-asset', JSON.stringify({ kind, id: a.id, url: a.url }));
          e.dataTransfer.effectAllowed = 'copy';
        });
        // Tap-to-add as a fallback for non-DnD touch devices.
        card.addEventListener('click', () => {
          if (kind === 'background') {
            cmd('set-bg', () => { state.template.background = { asset_id: a.id, url: a.url }; });
          } else {
            addLayer('logo', { url: a.url, asset_id: a.id });
          }
        });
        grid.appendChild(card);
      }
      return grid;
    }

    // ── templates panel ──────────────────────────────────────────
    function renderTemplatesPanel(panel) {
      clearChildren(panel);
      panel.append(
        el('div', { class: 'ce-sb-section' },
          el('h3', { class: 'ce-sb-h' }, 'Saved templates'),
          (() => {
            if (!state.templates.length) {
              return el('div', { class: 'ce-dim' }, 'None yet. Click “Save as template” in the header.');
            }
            const ul = el('ul', { class: 'ce-tpl-list' });
            for (const t of state.templates) {
              const li = el('li', { class: 'ce-tpl-item' });
              li.appendChild(el('strong', null, t.name));
              if (t.is_default) li.appendChild(el('span', { class: 'ce-pill' }, 'default'));
              li.appendChild(el('button', { class: 'ce-btn ce-btn-ghost ce-btn-sm',
                onclick: () => loadTemplateSpec(t) }, 'Load'));
              li.appendChild(el('button', { class: 'ce-btn ce-btn-ghost ce-btn-sm ce-tpl-del',
                onclick: async () => {
                  if (!confirm('Delete template "' + t.name + '"?')) return;
                  await api('/api/admin/cover/templates?id=' + encodeURIComponent(t.id), { method: 'DELETE' });
                  await loadTemplates();
                },
              }, '✕'));
              ul.appendChild(li);
            }
            return ul;
          })(),
        ),
      );
    }

    function loadTemplateSpec(t) {
      if (!t.spec) return;
      cmd('load-template', () => {
        state.template = JSON.parse(JSON.stringify(t.spec));
        for (const l of state.template.layers) l.id = l.id || uid();
        state.selectedIds.clear();
        updateSizeLabel(); syncPresetSelect();
        fitToContainer();
      });
    }

    // ── add layer (button or DnD) ────────────────────────────────
    function addLayer(kind, opts = {}) {
      const { width, height } = state.template;
      const base = { id: uid(), kind, x: opts.x ?? 80, y: opts.y ?? 80, locked: false };
      if (kind === 'text') {
        Object.assign(base, {
          w: opts.w ?? Math.min(width - 160, 800), h: opts.h ?? 200,
          text: opts.text ?? '{title}',
          size: 72, family: FONT_FAMILIES[0].value, weight: '700',
          align: 'left', color: '#ffffff', shadow: true, lineHeight: 1.15,
        });
      } else if (kind === 'box') {
        Object.assign(base, {
          w: opts.w ?? Math.min(width - 160, 800), h: opts.h ?? 250,
          fill: 'rgba(0,0,0,0.55)', radius: 12,
        });
      } else if (kind === 'logo') {
        const w = opts.w ?? 200, h = opts.h ?? 80;
        Object.assign(base, {
          w, h,
          x: opts.x ?? width - w - 40,
          y: opts.y ?? height - h - 40,
          url: opts.url ?? state.assets.logo[0]?.url ?? null,
          asset_id: opts.asset_id ?? null,
        });
      }
      cmd('add-layer', () => {
        state.template.layers.push(base);
        state.selectedIds = new Set([base.id]);
      });
    }

    // ── drag-from-sidebar onto canvas ────────────────────────────
    function bindDnD() {
      canvasWrap.addEventListener('dragover', (e) => {
        if (Array.from(e.dataTransfer?.types || []).includes('application/x-cover-asset')
            || Array.from(e.dataTransfer?.types || []).includes('Files')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      });
      canvasWrap.addEventListener('drop', (e) => {
        const { x, y } = toCanvasCoords(e);
        const payload = e.dataTransfer.getData('application/x-cover-asset');
        if (payload) {
          e.preventDefault();
          try {
            const a = JSON.parse(payload);
            if (a.kind === 'background') {
              cmd('set-bg', () => { state.template.background = { asset_id: a.id, url: a.url }; });
            } else {
              addLayer('logo', { url: a.url, asset_id: a.id, x: Math.round(x - 100), y: Math.round(y - 40) });
            }
          } catch { /* */ }
          return;
        }
        if (e.dataTransfer.files && e.dataTransfer.files.length) {
          e.preventDefault();
          const file = e.dataTransfer.files[0];
          if (!file.type.startsWith('image/')) return;
          // Heuristic: file dropped near a corner → background; else logo.
          const cw = state.template.width, ch = state.template.height;
          const margin = 100;
          const isBg = (x < margin || x > cw - margin || y < margin || y > ch - margin);
          uploadAsset(isBg ? 'background' : 'logo', file).then(() => {
            if (!isBg) {
              // Most-recently-uploaded logo, placed at the drop point.
              const a = state.assets.logo[state.assets.logo.length - 1] || state.assets.logo[0];
              if (a) addLayer('logo', { url: a.url, asset_id: a.id, x: Math.round(x - 100), y: Math.round(y - 40) });
            }
          });
        }
      });
    }

    // ── keyboard ─────────────────────────────────────────────────
    function bindGlobalKeys() {
      const handler = (ev) => {
        // Don't capture while the user is typing in an input.
        if (textEditor) return;
        const target = ev.target;
        const inField = target && (target.matches('input, textarea, select') || target.isContentEditable);
        // Cmd/Ctrl-Z / Cmd-Shift-Z work even inside the editor's inputs.
        const cmdKey = ev.metaKey || ev.ctrlKey;
        if (cmdKey && (ev.key === 'z' || ev.key === 'Z')) {
          if (ev.shiftKey) { redo(); ev.preventDefault(); return; }
          undo(); ev.preventDefault(); return;
        }
        if (cmdKey && (ev.key === 'd' || ev.key === 'D')) {
          if (state.selectedIds.size) { duplicateSelection(); ev.preventDefault(); }
          return;
        }
        if (cmdKey && ev.key === '0') { state.autoFit = true; fitToContainer(); redraw(); ev.preventDefault(); return; }
        if (cmdKey && (ev.key === '=' || ev.key === '+')) { setZoom(state.zoom * 1.25); ev.preventDefault(); return; }
        if (cmdKey && ev.key === '-') { setZoom(state.zoom / 1.25); ev.preventDefault(); return; }
        if (inField) return;
        if ((ev.key === 'Delete' || ev.key === 'Backspace') && state.selectedIds.size) {
          deleteSelection(); ev.preventDefault(); return;
        }
        if (ev.key === 'Escape') { state.selectedIds.clear(); redraw(); return; }
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(ev.key) && state.selectedIds.size) {
          const step = ev.shiftKey ? 10 : 1;
          const dx = (ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0);
          const dy = (ev.key === 'ArrowUp'   ? -step : ev.key === 'ArrowDown'  ? step : 0);
          cmd('nudge', () => {
            for (const l of selectedLayers()) { l.x += dx; l.y += dy; }
          });
          ev.preventDefault();
        }
      };
      // Bound at root only so other admin tabs aren't affected.
      root.addEventListener('keydown', handler);
      root.tabIndex = 0;
      // Also catch global Cmd-Z on document while the editor is mounted.
      const docHandler = (ev) => {
        if (!root.contains(document.activeElement) && document.activeElement !== document.body) return;
        if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'z' || ev.key === 'Z')) {
          handler(ev);
        }
      };
      document.addEventListener('keydown', docHandler);
    }

    // ── upload + load helpers (talk to admin.js's API helper) ───
    function fileToBase64(file) {
      return new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result).replace(/^data:[^;]+;base64,/, ''));
        fr.onerror = () => rej(new Error('read_failed'));
        fr.readAsDataURL(file);
      });
    }
    async function uploadAsset(kind, file) {
      const b64 = await fileToBase64(file);
      const r = await api('/api/admin/cover/upload', {
        method: 'POST',
        // Server expects `content_type`, not `mime` — keep the key
        // name in sync with functions/api/admin/cover/upload.js.
        body: JSON.stringify({
          kind,
          filename: file.name || (kind + '.png'),
          content_type: file.type || 'image/png',
          base64: b64,
        }),
      });
      if (r.body?.ok) {
        await loadAssets();
      }
      return r.body?.asset || null;
    }
    async function loadAssets() {
      const [bgs, logos] = await Promise.all([
        api('/api/admin/cover/upload?kind=background'),
        api('/api/admin/cover/upload?kind=logo'),
      ]);
      state.assets.background = bgs.body?.assets || [];
      state.assets.logo = logos.body?.assets || [];
      renderAssetsPanel();
    }
    async function loadTemplates() {
      const { body } = await api('/api/admin/cover/templates');
      state.templates = body?.templates || [];
      const panel = $('.ce-sb-pane[data-tab="templates"]', root);
      if (panel) renderTemplatesPanel(panel);
    }
    async function loadPosts() {
      const r = await api('/api/admin/blog/list');
      state.posts = (r.body?.posts || []).filter((p) => p.status === 'published').slice(0, 50);
      const sel = $('#ce-preview-post', root);
      if (!sel) return;
      while (sel.options.length > 1) sel.remove(1);
      for (const p of state.posts) {
        sel.appendChild(el('option', { value: p.id }, p.title.slice(0, 70)));
      }
    }

    async function refreshPreview() {
      const titleField = ($('#ce-preview-title', root)?.value || '').trim();
      const postId = $('#ce-preview-post', root)?.value || '';
      const post = postId ? state.posts.find((p) => p.id === postId) : null;
      const title = titleField || post?.title || '';
      if (!title) {
        state.previewCtx = null; redraw(); return;
      }
      // Build the same context shape the server uses.
      let settings = {}, whoami = {};
      try {
        const s = await api('/api/admin/settings');
        settings = s.body?.settings || {};
      } catch { /* */ }
      try {
        const w = await api('/api/admin/whoami');
        whoami = w.body || {};
      } catch { /* */ }
      state.previewCtx = {
        title,
        primary_keyword: post?.primary_query || '',
        slug: post?.slug || '',
        provider: post?.ai_provider || '',
        has_image: !!post?.hero_image_key,
        has_logo: state.template.layers.some((l) => l.kind === 'logo' && l.url),
        date: new Date(),
        brand: {
          name: whoami?.site_name || settings.site_name || 'this site',
          url:  whoami?.site_url  || settings.site_url  || '/',
          cta:  settings.site_cta || '',
          tone: settings.brand_voice_tone || settings.site_tone || '',
          audience: settings.brand_target_audience || settings.site_audience || '',
          business_type: settings.brand_business_type || '',
          service_area:  settings.brand_service_area  || '',
          key_themes:    settings.brand_key_themes    || '',
          topics_to_avoid: settings.brand_topics_to_avoid || '',
        },
      };
      redraw();
    }

    // ── save / apply dialogs ────────────────────────────────────
    async function openSaveTemplateDialog() {
      const name = prompt('Template name', '');
      if (!name) return;
      const setDefault = confirm('Make this the default template for new posts?');
      const spec = JSON.parse(JSON.stringify(state.template));
      const r = await api('/api/admin/cover/templates', {
        method: 'POST',
        body: JSON.stringify({ name, spec, is_default: setDefault }),
      });
      if (r.body?.ok) {
        await loadTemplates();
        alert('Saved.');
      } else {
        alert('Save failed: ' + (r.body?.error || r.status));
      }
    }
    async function openApplyDialog() {
      const postId = $('#ce-preview-post', root)?.value || '';
      if (!postId) { alert('Pick a post in the right-hand preview section first.'); return; }
      const post = state.posts.find((p) => p.id === postId);
      if (!post) return;
      // Render at full resolution with the post's title.
      state.previewCtx = { ...(state.previewCtx || {}), title: post.title };
      // Suppress overlay during the final render.
      const savedSel = new Set(state.selectedIds);
      state.selectedIds.clear();
      await drawCanvas();
      state.selectedIds = savedSel;
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      if (!blob) { alert('Render failed.'); redraw(); return; }
      const fr = new FileReader();
      const dataUrl = await new Promise((res) => { fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
      const r = await api('/api/admin/cover/apply', {
        method: 'POST',
        body: JSON.stringify({ target: 'post', id: postId, base64: dataUrl }),
      });
      redraw();
      if (r.body?.ok) {
        alert(`Applied to “${post.title.slice(0, 60)}…”.`);
      } else {
        alert('Apply failed: ' + (r.body?.error || r.status));
      }
    }

    // ── misc helpers ────────────────────────────────────────────
    function hexOnly(s) {
      const m = String(s || '#ffffff').match(/^#?([0-9a-f]{6})/i);
      return m ? '#' + m[1] : '#ffffff';
    }
    function parseAlpha(s, fallback) {
      const m = String(s || '').match(/rgba\([^)]*?,\s*([0-9.]+)\s*\)/);
      return m ? parseFloat(m[1]) : fallback;
    }
    function hexToRgba(hex, a) {
      const m = String(hex).match(/^#?([0-9a-f]{6})$/i);
      const alpha = clamp(parseFloat(a) || 0, 0, 1);
      if (!m) return `rgba(0,0,0,${alpha})`;
      const n = parseInt(m[1], 16);
      const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    function clamp(n, lo, hi) {
      n = parseFloat(n);
      if (isNaN(n)) n = lo;
      return Math.min(hi, Math.max(lo, n));
    }

    // ── public-ish: load + apply default template from server ──
    async function bootstrap() {
      await Promise.all([loadAssets(), loadTemplates(), loadPosts()]);
      // Auto-load default template if one exists.
      const def = state.templates.find((t) => t.is_default);
      if (def && def.spec) loadTemplateSpec(def);
      else redraw();
    }

    // ── public surface ─────────────────────────────────────────
    return {
      init: (opts) => {
        init(opts);
        bootstrap();
      },
      // Allow admin.js to re-run bootstrap on tab activation.
      refresh: bootstrap,
      get state() { return state; },
    };
  }

  // Expose singleton.
  window.CoverEditor = CoverEditor();
})();
