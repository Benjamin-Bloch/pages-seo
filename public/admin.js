// pages-seo · admin dashboard logic.
//
// Single bundle, no framework. Auth model: email + password POST'd to
// /api/admin/login, which sets an HttpOnly session cookie. The cookie
// rides along on every subsequent fetch automatically (same-origin),
// so the api() helper doesn't need to add Authorization headers.
//
// The original Bearer ADMIN_TOKEN flow is preserved server-side as a
// fallback for the cron worker and as a recovery credential.
(() => {

  // ── helpers ─────────────────────────────────────────────────────
  function $(sel, root = document) { return root.querySelector(sel); }
  function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
  function setText(el, text) { if (el) el.textContent = String(text == null ? '' : text); }
  function showLog(el, text) { if (!el) return; el.hidden = false; el.textContent = String(text); }
  function appendLog(el, text) { if (!el) return; el.hidden = false; el.textContent += '\n' + String(text); el.scrollTop = el.scrollHeight; }
  function clearChildren(el) { if (el) el.replaceChildren(); }

  async function api(path, opts = {}) {
    const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
    // `credentials: 'same-origin'` is the default, but we set it
    // explicitly so the session cookie ALWAYS rides along — including
    // for POST/PUT/DELETE where some browsers default differently.
    const r = await fetch(path, { ...opts, headers, credentials: 'same-origin' });
    let body = null;
    try { body = await r.json(); } catch { /* not JSON */ }
    return { status: r.status, body };
  }

  // ── login gate ──────────────────────────────────────────────────
  // whoamiStatus returns:
  //   { ok: true, info } — authenticated + configured (signed in)
  //   { ok: false, reason: 'config', missing: [...] } — deployment incomplete
  //   { ok: false, reason: 'unauth' } — no session
  async function whoamiStatus() {
    const { status, body } = await api('/api/admin/whoami');
    if (status === 200) return { ok: true, info: body };
    if (status === 503) {
      // needs_setup === true means no admin user exists yet — the SPA
      // should render the first-run setup form instead of the dead-end
      // "missing secrets" message.
      return {
        ok: false,
        reason: body?.needs_setup ? 'setup' : 'config',
        missing: body?.missing || [],
      };
    }
    return { ok: false, reason: 'unauth' };
  }

  function showConfigError(missing) {
    $('#gate').hidden = false;
    $('#dash').hidden = true;
    const err = $('#gate-err');
    const form = $('#login-form');
    if (form) form.style.display = 'none';
    err.textContent =
      'Setup is not complete. Missing: ' + (missing.join(', ') || 'unknown') +
      '. Run setup.sh / setup.py / setup.js, or push the missing secrets with `wrangler pages secret put <NAME>`, then redeploy.';
  }

  async function showGate(initial) {
    $('#gate').hidden = false;
    $('#dash').hidden = true;
    const form = $('#login-form');
    if (form) form.style.display = '';
    const email = $('#gate-email');
    const password = $('#gate-password');
    const err = $('#gate-err');
    const go = $('#gate-go');
    email.disabled = false; password.disabled = false; go.disabled = false;
    password.value = '';
    err.textContent = initial?.note || '';
    setTimeout(() => (email.value ? password.focus() : email.focus()), 0);
  }

  // Login submit. Bound exactly ONCE at script-load time so the
  // handler exists before any user click — earlier we lazily attached
  // inside showGate(), which left a window where a click would do a
  // native form submission (browser navigated to /admin? with empty
  // query string). preventDefault is called synchronously before any
  // await.
  function bindLoginForm() {
    const form = document.getElementById('login-form');
    if (!form) return;
    form.addEventListener('submit', (e) => {
      // Cancel the native submit IMMEDIATELY. Anything async happens
      // after this line; the browser already knows not to navigate.
      e.preventDefault();
      runLogin().catch((err) => {
        const errEl = document.getElementById('gate-err');
        if (errEl) errEl.textContent = 'Network error: ' + (err?.message || err);
      });
      return false;
    });
  }

  async function runLogin() {
    const email = document.getElementById('gate-email');
    const password = document.getElementById('gate-password');
    const err = document.getElementById('gate-err');
    const go = document.getElementById('gate-go');
    const e2 = String(email.value || '').trim().toLowerCase();
    const p2 = String(password.value || '');
    if (!e2 || !p2) { err.textContent = 'Email and password required.'; return; }
    err.textContent = ''; go.disabled = true; go.textContent = 'Signing in…';
    try {
      const { status, body } = await api('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ email: e2, password: p2 }),
      });
      if (status === 200 && body?.ok) {
        mount();
        return;
      }
      if (status === 429) {
        const wait = body?.retry_after_sec ? Math.ceil(body.retry_after_sec / 60) : 60;
        err.textContent = `Too many failed attempts. Try again in ~${wait} min.`;
        return;
      }
      err.textContent = body?.error === 'invalid_credentials'
        ? 'Email or password is incorrect.'
        : (body?.error || `Sign-in failed (HTTP ${status}).`);
    } finally {
      go.disabled = false; go.textContent = 'Sign in';
    }
  }

  async function doLogout() {
    try { await api('/api/admin/logout', { method: 'POST' }); }
    catch { /* swallow */ }
    showGate({ note: 'Signed out.' });
  }

  // ── tabs ────────────────────────────────────────────────────────
  function activateTab(name) {
    $$('.tab').forEach((t) => {
      const active = t.dataset.tab === name;
      t.setAttribute('aria-current', active ? 'page' : 'false');
    });
    $$('[data-page]').forEach((p) => {
      p.hidden = p.dataset.page !== name;
    });
    if (name === 'overview') loadOverview();
    if (name === 'blog') { loadJobs(); loadPosts(); }
    if (name === 'prog') { loadQueue(); }
    if (name === 'seo') { renderWidgetSnippet(); }
    if (name === 'brand') { loadBrand(); }
    if (name === 'links') { Links.init(); }
    if (name === 'calendar') { Calendar.init(); }
    if (name === 'usage') { loadUsage(); }
    if (name === 'covers') { Cover.init(); }
    if (name === 'embeds') { loadEmbeds(); }
    if (name === 'updates') { Updates.init(); }
    if (name === 'settings') { loadSettings(); loadProviderGrid(); }
  }

  // ── usage ──────────────────────────────────────────────────────
  function fmtUSD(n) {
    if (n == null) return '—';
    if (n < 0.01) return '$' + n.toFixed(4);
    if (n < 1)    return '$' + n.toFixed(3);
    return '$' + n.toFixed(2);
  }
  function fmtInt(n) {
    if (n == null) return '—';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  }

  async function loadUsage() {
    const win = $('#usage-window')?.value || 'month';
    const { status, body } = await api('/api/admin/usage?window=' + encodeURIComponent(win));
    if (status !== 200) return;

    // Headline numbers
    setText($('#usage-spent'),  fmtUSD(body.total.cost_usd));
    setText($('#usage-budget'), body.budget.monthly_usd > 0 ? fmtUSD(body.budget.monthly_usd) : 'none');
    setText($('#usage-pct'),    body.budget.monthly_usd > 0 ? body.budget.pct + '%' : '—');
    setText($('#usage-calls'),  fmtInt(body.total.calls));
    setText($('#usage-tokens'), fmtInt(body.total.total_tokens));
    setText($('#usage-errors'), fmtInt(body.total.errors));

    // Progress bar
    const wrap = $('#usage-progress-wrap');
    const fill = $('#usage-progress-fill');
    if (body.budget.monthly_usd > 0) {
      wrap.style.display = 'block';
      const pct = Math.min(100, body.budget.pct);
      fill.style.width = pct + '%';
      fill.classList.toggle('warn', body.budget.over_warn);
      fill.classList.toggle('bad',  body.budget.over_budget);
    } else {
      wrap.style.display = 'none';
    }

    // Banner
    const bCard = $('#usage-banner-card');
    const banner = $('#usage-banner');
    if (body.budget.over_budget) {
      bCard.hidden = false;
      banner.className = 'usage-banner bad';
      banner.innerHTML = '<strong>Budget exceeded.</strong> The cron Worker is now blocked. Admin generations still work (with a confirmation prompt). Increase the budget in Settings or wait for the next month.';
    } else if (body.budget.over_warn) {
      bCard.hidden = false;
      banner.className = 'usage-banner warn';
      banner.innerHTML = `<strong>${body.budget.pct}% of monthly budget used.</strong> Consider tuning provider mix or pausing the cron until the new month.`;
    } else {
      bCard.hidden = true;
    }

    // By provider
    const tbP = $('#usage-by-provider');
    clearChildren(tbP);
    if (!body.by_provider.length) {
      const tr = document.createElement('tr'); const td_ = document.createElement('td');
      td_.colSpan = 4; td_.className = 'dim'; td_.textContent = 'No usage yet for this window.';
      tr.appendChild(td_); tbP.appendChild(tr);
    } else {
      for (const p of body.by_provider) {
        const tr = document.createElement('tr');
        tr.appendChild(td(p.provider, 'cell-strong'));
        tr.appendChild(td(p.calls));
        tr.appendChild(td(fmtInt(p.tokens)));
        tr.appendChild(td(fmtUSD(p.cost)));
        tbP.appendChild(tr);
      }
    }

    // By kind
    const tbK = $('#usage-by-kind');
    clearChildren(tbK);
    if (!body.by_kind.length) {
      const tr = document.createElement('tr'); const td_ = document.createElement('td');
      td_.colSpan = 4; td_.className = 'dim'; td_.textContent = 'No usage yet.';
      tr.appendChild(td_); tbK.appendChild(tr);
    } else {
      for (const k of body.by_kind) {
        const tr = document.createElement('tr');
        tr.appendChild(td(k.kind, 'cell-strong'));
        tr.appendChild(td(k.calls));
        tr.appendChild(td(fmtInt(k.tokens)));
        tr.appendChild(td(fmtUSD(k.cost)));
        tbK.appendChild(tr);
      }
    }

    // Daily bars
    const daily = $('#usage-daily');
    clearChildren(daily);
    if (!body.daily.length) {
      daily.textContent = 'No usage yet.';
      daily.className = 'usage-daily dim';
    } else {
      daily.className = 'usage-daily';
      const max = Math.max(...body.daily.map((d) => d.cost), 0.001);
      for (const d of body.daily) {
        const row = document.createElement('div'); row.className = 'usage-day';
        const lbl = document.createElement('div'); lbl.className = 'usage-day-label'; lbl.textContent = d.date;
        const barWrap = document.createElement('div'); barWrap.className = 'usage-day-bar';
        const bar = document.createElement('div'); bar.className = 'usage-day-fill';
        bar.style.width = Math.max(2, (d.cost / max) * 100) + '%';
        barWrap.appendChild(bar);
        const val = document.createElement('div'); val.className = 'usage-day-val'; val.textContent = `${fmtUSD(d.cost)} · ${d.calls} calls`;
        row.append(lbl, barWrap, val);
        daily.appendChild(row);
      }
    }

    // Recent
    const tbR = $('#usage-recent');
    clearChildren(tbR);
    if (!body.recent.length) {
      const tr = document.createElement('tr'); const td_ = document.createElement('td');
      td_.colSpan = 7; td_.className = 'dim'; td_.textContent = 'No calls yet.';
      tr.appendChild(td_); tbR.appendChild(tr);
    } else {
      for (const r of body.recent) {
        const tr = document.createElement('tr');
        const when = new Date(r.created_at * 1000);
        tr.appendChild(td(when.toISOString().slice(5, 16).replace('T', ' ')));
        tr.appendChild(td(r.provider));
        tr.appendChild(td(r.kind));
        tr.appendChild(td(r.source || '—'));
        tr.appendChild(td(fmtInt(r.total_tokens)));
        tr.appendChild(td(fmtUSD(r.cost_usd)));
        const tdOk = document.createElement('td');
        const pill = document.createElement('span');
        pill.className = 'pill ' + (r.ok ? 'good' : 'bad');
        pill.textContent = r.ok ? 'ok' : 'err';
        if (!r.ok && r.error) tdOk.title = r.error;
        tdOk.appendChild(pill);
        tr.appendChild(tdOk);
        tbR.appendChild(tr);
      }
    }
  }

  // ── brand DNA ────────────────────────────────────────────────────
  // Project name used by the wrangler-secret-put hint. Inferred from
  // SITE_URL when possible (e.g. https://my-royal-bath.pages.dev → my-royal-bath).
  function inferProjectName(siteUrl) {
    try {
      const host = new URL(siteUrl).hostname;
      const m = host.match(/^([^.]+)\.pages\.dev$/);
      if (m) return m[1];
      return host.split('.')[0];
    } catch { return '<project-name>'; }
  }

  function fillBrand(brand) {
    $$('[data-brand]').forEach((el) => {
      const k = el.dataset.brand;
      el.value = brand?.[k] ?? '';
    });
    const ga = $('#brand-generated-at');
    if (ga) ga.value = brand?.generated_at || '';
  }

  async function loadBrand() {
    const { status, body } = await api('/api/admin/brand-dna');
    if (status !== 200) return;
    fillBrand(body?.brand || {});
    // Pre-seed the URL input with the saved source_url if any.
    const urlIn = $('#brand-url');
    if (urlIn && !urlIn.value) urlIn.value = body?.brand?.source_url || '';
  }

  async function generateBrand() {
    const url = $('#brand-url').value.trim();
    const status = $('#brand-gen-status');
    if (!url) { status.className = 'status bad'; status.textContent = 'Enter a URL first.'; return; }
    const btn = $('#brand-generate');
    btn.disabled = true;
    status.className = 'status'; status.textContent = 'Scraping + analysing… ~10-30s';
    const { status: code, body } = await api('/api/admin/brand-dna', {
      method: 'POST',
      body: JSON.stringify({
        url,
        // Carry over any user-typed service-area / topics-to-avoid so the
        // model doesn't overwrite the operator's intent.
        service_area:    $('[data-brand="service_area"]').value.trim() || undefined,
        topics_to_avoid: $('[data-brand="topics_to_avoid"]').value.trim() || undefined,
      }),
    });
    btn.disabled = false;
    if (code !== 200 || !body?.ok) {
      status.className = 'status bad';
      status.textContent = (body?.error || code) + (body?.detail ? ' · ' + body.detail : '');
      return;
    }
    fillBrand(body.brand);
    // Also fill source_url field manually since the GET endpoint returns
    // it under a key the form-fill loop reads.
    const su = $('[data-brand="source_url"]');
    if (su) su.value = body.brand.source_url || '';
    status.className = 'status good';
    status.textContent = `Generated · provider=${body.brand.provider}. Review then click Save.`;
  }

  function clearBrandFields() {
    if (!confirm('Clear all brand DNA fields locally? (Click Save afterwards to persist the empty state.)')) return;
    $$('[data-brand]').forEach((el) => { el.value = ''; });
    const ga = $('#brand-generated-at'); if (ga) ga.value = '';
    const su = $('#brand-url'); if (su) su.value = '';
    const status = $('#brand-save-status');
    status.className = 'status'; status.textContent = 'Fields cleared. Click Save to persist.';
  }

  async function runBrandFilter(dryRun) {
    const status = $('#brand-filter-status');
    const out = $('#brand-filter-results');
    const dryBtn = $('#brand-filter-dry');
    const goBtn = $('#brand-filter-go');
    dryBtn.disabled = true; goBtn.disabled = true;
    status.className = 'status';
    status.textContent = dryRun ? 'Dry-running…' : 'Filtering (this writes failures back to D1)…';
    const { status: code, body } = await api('/api/admin/brand-filter-queue', {
      method: 'POST',
      body: JSON.stringify({ dry_run: !!dryRun }),
    });
    dryBtn.disabled = false; goBtn.disabled = false;
    if (code !== 200 || !body?.ok) {
      status.className = 'status bad';
      status.textContent = (body?.error || code) + (body?.hint ? ' · ' + body.hint : '');
      out.hidden = true;
      return;
    }
    status.className = 'status good';
    status.textContent = `${dryRun ? '[dry]' : '[applied]'} ${body.evaluated} evaluated · ${body.kept} kept · ${body.dropped} dropped · provider=${body.provider}`;
    if (!dryRun) loadQueue();
    // Render the dropped sample
    out.hidden = false;
    clearChildren(out);
    if (body.dropped_sample?.length) {
      const h = document.createElement('h4'); h.textContent = 'Dropped (first ' + body.dropped_sample.length + ')';
      out.appendChild(h);
      const ul = document.createElement('ul');
      for (const d of body.dropped_sample) {
        const li = document.createElement('li');
        const kw = document.createElement('span'); kw.className = 'kw'; kw.textContent = d.keyword;
        const reason = document.createElement('span'); reason.className = 'meta'; reason.textContent = d.reason;
        li.append(kw, reason);
        ul.appendChild(li);
      }
      out.appendChild(ul);
    } else {
      const p = document.createElement('p'); p.className = 'dim';
      p.textContent = 'Nothing was off-brand.';
      out.appendChild(p);
    }
  }

  async function saveBrand() {
    const status = $('#brand-save-status');
    status.className = 'status'; status.textContent = 'Saving…';
    const payload = {};
    $$('[data-brand]').forEach((el) => {
      payload[el.dataset.brand] = (el.value || '').toString();
    });
    const { status: code, body } = await api('/api/admin/brand-dna', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    if (code !== 200 || !body?.ok) {
      status.className = 'status bad'; status.textContent = body?.error || code; return;
    }
    status.className = 'status good';
    if (body.planning) {
      status.innerHTML = `Saved · ${body.saved} field(s). Planning your <a href="#" data-jump-cal>Content Calendar</a> in the background…`;
      const link = status.querySelector('[data-jump-cal]');
      if (link) link.addEventListener('click', (e) => { e.preventDefault(); activateTab('calendar'); });
    } else {
      status.textContent = `Saved · ${body.saved} field(s). Every new post will use this.`;
    }
    setTimeout(() => { status.textContent = ''; status.className = 'status'; }, 6000);
  }

  // ── embeds ────────────────────────────────────────────────────
  // Manages the /api/admin/embeds CRUD endpoints. Each embed gives
  // the operator a `<div id="ps-blog"></div>` + `<script src=…>`
  // snippet they can paste on any external site to display the
  // toolkit's posts.
  async function loadEmbeds() {
    const list = $('#embed-list');
    if (!list) return;
    const { status, body } = await api('/api/admin/embeds');
    if (status !== 200) {
      list.textContent = 'Failed to load: ' + (body?.error || status);
      list.className = 'dim'; return;
    }
    clearChildren(list);
    list.className = '';
    if (!body.embeds?.length) {
      const d = document.createElement('div'); d.className = 'dim';
      d.textContent = 'No embeds yet. Create one above.';
      list.appendChild(d); return;
    }
    for (const e of body.embeds) {
      const row = document.createElement('div'); row.className = 'embed-row';

      const head = document.createElement('div'); head.className = 'embed-head';
      const name = document.createElement('div'); name.className = 'embed-name'; name.textContent = e.name;
      const meta = document.createElement('div'); meta.className = 'embed-meta';
      const settingsBits = [];
      if (e.settings?.title)  settingsBits.push('title: ' + e.settings.title);
      if (e.settings?.accent) settingsBits.push('accent: ' + e.settings.accent);
      if (e.settings?.limit)  settingsBits.push('limit: ' + e.settings.limit);
      meta.textContent = settingsBits.join(' · ') || 'defaults';
      head.append(name, meta);
      row.appendChild(head);

      const snip = document.createElement('div'); snip.className = 'embed-snippet';
      snip.textContent = e.snippet;
      row.appendChild(snip);

      const actions = document.createElement('div'); actions.className = 'embed-actions';
      const copy = document.createElement('button'); copy.className = 'btn btn-sm';
      copy.textContent = 'Copy snippet';
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(e.snippet);
          copy.textContent = 'Copied!';
          setTimeout(() => (copy.textContent = 'Copy snippet'), 1500);
        } catch { copy.textContent = 'Select + copy manually'; }
      };
      const preview = document.createElement('button'); preview.className = 'btn btn-sm';
      preview.textContent = 'Preview';
      const previewBox = document.createElement('div'); previewBox.className = 'embed-preview'; previewBox.hidden = true;
      preview.onclick = () => {
        if (!previewBox.hidden) { previewBox.hidden = true; preview.textContent = 'Preview'; return; }
        clearChildren(previewBox);
        // Build an iframe so the host CSS doesn't leak in.
        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'width:100%;min-height:240px;border:0;background:#fff;border-radius:6px';
        iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><title>preview</title></head><body><div id="ps-blog"></div><script src="${e.embed_url}" defer></script></body></html>`;
        previewBox.appendChild(iframe);
        previewBox.hidden = false;
        preview.textContent = 'Hide preview';
      };
      const open = document.createElement('a'); open.className = 'btn btn-sm';
      open.textContent = 'Open URL';
      open.href = e.embed_url; open.target = '_blank'; open.rel = 'noopener';
      const del = document.createElement('button'); del.className = 'btn btn-sm embed-del';
      del.textContent = 'Delete';
      del.onclick = async () => {
        if (!confirm('Delete the embed "' + e.name + '"? Anyone using the snippet on a live site will see an empty widget.')) return;
        await api('/api/admin/embeds?id=' + encodeURIComponent(e.id), { method: 'DELETE' });
        loadEmbeds();
      };
      actions.append(copy, preview, open, del);
      row.appendChild(actions);
      row.appendChild(previewBox);
      list.appendChild(row);
    }
  }

  async function createEmbed() {
    const status = $('#embed-create-status');
    const name = $('#embed-create-name').value.trim();
    if (!name) { status.className = 'status bad'; status.textContent = 'Name required.'; return; }
    const settings = {};
    const title  = $('#embed-create-title').value.trim();
    const accent = $('#embed-create-accent').value;
    const limit  = parseInt($('#embed-create-limit').value, 10);
    if (title)  settings.title = title;
    if (accent) settings.accent = accent;
    if (Number.isFinite(limit) && limit > 0) settings.limit = limit;
    status.className = 'status'; status.textContent = 'Creating…';
    const { status: code, body } = await api('/api/admin/embeds', {
      method: 'POST',
      body: JSON.stringify({ name, settings }),
    });
    if (code !== 200 || !body?.ok) {
      status.className = 'status bad';
      status.textContent = 'Failed: ' + (body?.error || code);
      return;
    }
    status.className = 'status good';
    status.textContent = 'Created.';
    $('#embed-create-name').value = '';
    $('#embed-create-title').value = '';
    $('#embed-create-limit').value = '';
    setTimeout(() => { status.textContent = ''; status.className = 'status'; }, 2500);
    loadEmbeds();
  }

  // ── provider status grid (Settings tab) ─────────────────────────
  const PROVIDER_META = [
    { name: 'workers-ai', label: 'Cloudflare Workers AI', envKey: '(binding)',          text: true,  image: true,  optional: false },
    { name: 'openai',     label: 'OpenAI',                envKey: 'OPENAI_API_KEY',     text: true,  image: true,  optional: true },
    { name: 'anthropic',  label: 'Anthropic Claude',      envKey: 'ANTHROPIC_API_KEY',  text: true,  image: false, optional: true },
    { name: 'gemini',     label: 'Google Gemini',         envKey: 'GEMINI_API_KEY',     text: true,  image: true,  optional: true },
    { name: 'groq',       label: 'Groq',                  envKey: 'GROQ_API_KEY',       text: true,  image: false, optional: true },
    { name: 'deepseek',   label: 'DeepSeek',              envKey: 'DEEPSEEK_API_KEY',   text: true,  image: false, optional: true },
    { name: 'mistral',    label: 'Mistral',               envKey: 'MISTRAL_API_KEY',    text: true,  image: false, optional: true },
    { name: 'together',   label: 'Together AI',           envKey: 'TOGETHER_API_KEY',   text: true,  image: false, optional: true },
    { name: 'cerebras',   label: 'Cerebras',              envKey: 'CEREBRAS_API_KEY',   text: true,  image: false, optional: true },
  ];

  async function loadProviderGrid() {
    const grid = $('#providers-grid');
    if (!grid) return;
    clearChildren(grid);
    const who = await api('/api/admin/whoami');
    const projectName = inferProjectName(who.body?.site_url || '');
    // /api/admin/secrets gives us per-key source: pages-secret | vault | unset.
    // /api/admin/providers gives us which providers are actually usable.
    const [secretsResp, providersResp] = await Promise.all([
      api('/api/admin/secrets'),
      api('/api/admin/providers'),
    ]);
    const sources = secretsResp.body?.keys || {};
    const usableText = new Set(providersResp.body?.text || []);

    for (const p of PROVIDER_META) {
      // workers-ai has no env-var key; it's bound via the [ai] block.
      const isWorkersAI = p.name === 'workers-ai';
      const source = isWorkersAI
        ? (usableText.has('workers-ai') ? 'binding' : 'unset')
        : (sources[p.envKey] || 'unset');
      const configured = source !== 'unset';

      const card = document.createElement('div');
      card.className = 'provider-card' + (configured ? ' configured' : '');

      const head = document.createElement('div'); head.className = 'provider-head';
      const dot = document.createElement('span'); dot.className = 'provider-dot' + (configured ? ' on' : '');
      const label = document.createElement('strong'); label.textContent = p.label;
      const badge = document.createElement('span'); badge.className = 'provider-status';
      badge.textContent = {
        'binding':       'binding',
        'pages-secret':  'pages secret',
        'vault':         'vault',
        'unset':         p.optional ? 'not set' : 'missing',
      }[source];
      head.append(dot, label, badge);

      const sub = document.createElement('div'); sub.className = 'provider-sub';
      const caps = [];
      if (p.text)  caps.push('text');
      if (p.image) caps.push('image');
      sub.textContent = `${p.envKey} · ${caps.join(' + ')}`;
      card.append(head, sub);

      if (isWorkersAI) {
        // No edit affordance — it's a binding.
        const note = document.createElement('div'); note.className = 'provider-sub';
        note.style.color = 'var(--ink-faint)';
        note.textContent = 'Configured via the [ai] binding in wrangler.toml.';
        card.append(note);
        grid.appendChild(card);
        continue;
      }

      // Edit row: paste key inline, save to the encrypted vault.
      const editRow = document.createElement('div'); editRow.className = 'provider-edit';
      const input = document.createElement('input');
      input.type = 'password';
      input.placeholder = configured
        ? `${source} value set — paste a new key to replace`
        : `Paste ${p.envKey} (stored encrypted)`;
      input.autocomplete = 'off';
      const save = document.createElement('button');
      save.className = 'btn btn-primary btn-sm';
      save.textContent = 'Save';
      save.onclick = async () => {
        const val = input.value.trim();
        if (!val) { input.focus(); return; }
        save.disabled = true; save.textContent = 'Saving…';
        const { status, body } = await api('/api/admin/secrets', {
          method: 'POST',
          body: JSON.stringify({ name: p.envKey, value: val }),
        });
        save.disabled = false; save.textContent = 'Save';
        if (status === 200 && body?.ok) {
          input.value = '';
          loadProviderGrid(); // refresh
        } else {
          save.textContent = body?.error || ('http ' + status);
          setTimeout(() => (save.textContent = 'Save'), 2500);
        }
      };
      editRow.append(input, save);
      card.append(editRow);

      // Source-specific actions row.
      if (source === 'vault') {
        const actions = document.createElement('div'); actions.className = 'provider-actions';
        const del = document.createElement('button'); del.className = 'btn btn-ghost btn-sm provider-del';
        del.textContent = 'Remove from vault';
        del.onclick = async () => {
          if (!confirm(`Remove ${p.envKey} from the encrypted vault?`)) return;
          await api('/api/admin/secrets?name=' + encodeURIComponent(p.envKey), { method: 'DELETE' });
          loadProviderGrid();
        };
        actions.append(del);
        card.append(actions);
      } else if (source === 'unset') {
        const cmdRow = document.createElement('div'); cmdRow.className = 'provider-cmd';
        const cmd = `wrangler pages secret put ${p.envKey} --project-name=${projectName}`;
        const code = document.createElement('code'); code.textContent = cmd;
        const copy = document.createElement('button'); copy.className = 'btn btn-ghost btn-sm';
        copy.textContent = 'Copy CLI cmd';
        copy.onclick = async () => {
          try {
            await navigator.clipboard.writeText(cmd);
            copy.textContent = 'Copied';
            setTimeout(() => (copy.textContent = 'Copy CLI cmd'), 1500);
          } catch {
            copy.textContent = 'Select+copy';
          }
        };
        cmdRow.append(code, copy);
        card.append(cmdRow);
      }

      grid.appendChild(card);
    }
  }

  // ── settings ────────────────────────────────────────────────────
  async function loadSettings() {
    const { status, body } = await api('/api/admin/settings');
    if (status !== 200) return;
    // Populate the provider <select> from /api/admin/providers.
    const providers = await api('/api/admin/providers');
    const sel = $('select[data-setting="default_ai_provider"]');
    if (sel) {
      const cur = body.settings?.default_ai_provider || '';
      // Clear all but the first <option>.
      while (sel.options.length > 1) sel.remove(1);
      for (const name of (providers.body?.text || [])) {
        const o = document.createElement('option');
        o.value = name; o.textContent = name;
        if (name === cur) o.selected = true;
        sel.appendChild(o);
      }
    }
    // Populate every [data-setting] input/textarea with the loaded value.
    // Radio inputs (multiple with the same data-setting) are toggled by
    // matching their `value` against the stored setting; everything else
    // gets its `value` set directly.
    $$('[data-setting]').forEach((el) => {
      if (el.tagName === 'SELECT') return; // handled above
      const key = el.dataset.setting;
      const v = body.settings?.[key] ?? '';
      if (el.type === 'radio') {
        el.checked = (el.value === v);
      } else if (el.type === 'checkbox') {
        el.checked = v === 'true' || v === '1' || v === 'on';
      } else {
        el.value = v;
      }
    });
    // Apply hero-image-mode side effects (freeze the Covers tab if 'ai').
    applyHeroImageMode(body.settings?.hero_image_mode || 'ai');
    // Refresh the pricing snapshot whenever the Settings tab opens.
    loadPricingSnapshot();
  }

  async function saveSettings() {
    const status = $('#settings-status');
    setText(status, 'saving…');
    const payload = {};
    // Collect by key. For radios there are multiple elements with the
    // same data-setting — only the checked one wins.
    const seen = new Set();
    $$('[data-setting]').forEach((el) => {
      const key = el.dataset.setting;
      if (el.type === 'radio') {
        if (el.checked) { payload[key] = el.value; seen.add(key); }
        else if (!seen.has(key)) { /* leave; might be set by a later checked sibling */ }
        return;
      }
      if (el.type === 'checkbox') {
        payload[key] = el.checked ? 'true' : ''; return;
      }
      payload[key] = (el.value || '').toString();
    });
    const r = await api('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    if (r.status === 200) {
      setText(status, `saved ${r.body?.updated?.length || 0} field(s)`);
      setTimeout(() => setText(status, ''), 2500);
      // Re-apply the freeze state after save in case the user just
      // flipped the toggle.
      applyHeroImageMode(payload.hero_image_mode || 'ai');
    } else {
      setText(status, `error: ${r.body?.error || r.status}`);
    }
  }

  // ── hero image mode (freeze Covers tab when 'ai') ──────────────
  function applyHeroImageMode(mode) {
    const banner  = $('#cover-frozen-banner');
    const content = $('#cover-content');
    const frozen  = mode !== 'cover';
    if (banner)  banner.hidden = !frozen;
    if (content) content.classList.toggle('frozen', frozen);
  }

  // ── pricing snapshot UI ────────────────────────────────────────
  async function loadPricingSnapshot() {
    const root = $('#pricing-current');
    if (!root) return;
    const { status, body } = await api('/api/admin/pricing');
    if (status !== 200) { root.textContent = 'Failed to load pricing.'; return; }
    clearChildren(root);
    const tbl = document.createElement('table');
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Provider</th><th>Input / 1M</th><th>Output / 1M</th><th>Image</th></tr>';
    tbl.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const [name, p] of Object.entries(body.prices || {})) {
      const tr = document.createElement('tr');
      const cell = (txt, cls) => { const td = document.createElement('td'); if (cls) td.className = cls; td.textContent = txt; return td; };
      tr.appendChild(cell(name));
      tr.appendChild(cell(p.in === 0 ? '—' : `$${Number(p.in).toFixed(2)}`, 'cost'));
      tr.appendChild(cell(p.out === 0 ? '—' : `$${Number(p.out).toFixed(2)}`, 'cost'));
      tr.appendChild(cell(p.image == null ? '—' : `$${Number(p.image).toFixed(3)}/img`, 'cost'));
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    root.appendChild(tbl);
    const meta = document.createElement('span'); meta.className = 'pricing-meta';
    const when = body.fetched_at ? new Date(body.fetched_at * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'never';
    meta.textContent = `Source: ${body.source}${body.stale ? ' (stale)' : ''} · last refreshed: ${when}`;
    root.appendChild(meta);
  }

  async function refreshPricing() {
    const status = $('#pricing-status');
    setText(status, 'fetching from models.dev…');
    const { status: code, body } = await api('/api/admin/pricing', { method: 'POST', body: '{}' });
    if (code !== 200 || !body?.ok) {
      status.className = 'status bad';
      status.textContent = 'Refresh failed: ' + (body?.error || body?.detail || code);
      return;
    }
    status.className = 'status good';
    status.textContent = `Updated ${body.count_updated} providers from ${body.source}.`;
    setTimeout(() => { status.textContent = ''; status.className = 'status'; }, 4000);
    loadPricingSnapshot();
  }

  // ── overview ────────────────────────────────────────────────────
  async function loadOverview() {
    const posts = await api('/api/admin/blog/list');
    setText($('#stat-blog-count'), (posts.body?.posts || []).filter(p => p.status === 'published').length);
    const prog = await api('/api/admin/prog/queue?status=done&limit=500');
    setText($('#stat-prog-count'), (prog.body?.keywords || []).length);
    const queue = await api('/api/admin/prog/queue?status=pending&limit=500');
    setText($('#stat-queue-count'), (queue.body?.keywords || []).length);
  }

  // ── blog chain ──────────────────────────────────────────────────
  async function runBlogChain() {
    const btn = $('#blog-go');
    const status = $('#blog-status');
    const log = $('#blog-log');
    btn.disabled = true;
    const setStatus = (text, cls) => {
      status.textContent = text;
      status.className = 'status' + (cls ? ' ' + cls : '');
    };
    const append = (line) => appendLog(log, line);
    log.hidden = true; log.textContent = '';

    try {
      setStatus('1/4 picking topic…');
      const start = await api('/api/admin/blog/start', { method: 'POST', body: '{}' });
      const jobId = start.body?.job_id;
      if (!jobId) throw new Error(start.body?.error || 'start failed');
      append(`job_id: ${jobId}`);

      const payload = JSON.stringify({ job_id: jobId });
      setStatus('2/4 writing article…');
      const text = await api('/api/admin/blog/text', { method: 'POST', body: payload });
      if (text.status !== 200) throw new Error(text.body?.detail || text.body?.error || 'text failed');
      append(`title: ${text.body.title}`);
      append(`slug:  ${text.body.slug}`);
      append(`ai:    ${text.body.ai_provider}`);

      setStatus('3/4 generating image…');
      const img = await api('/api/admin/blog/image', { method: 'POST', body: payload });
      if (img.status !== 200) throw new Error(img.body?.detail || img.body?.error || 'image failed');
      append(`image: ${img.body.image_uploaded ? 'ok' : '(skipped)'}`);

      setStatus('4/4 publishing…');
      const pub = await api('/api/admin/blog/publish', { method: 'POST', body: payload });
      if (pub.status !== 200) throw new Error(pub.body?.error || 'publish failed');
      append(`published: /blog/${pub.body.slug}`);

      setStatus('Published.', 'good');
      loadPosts();
      loadJobs();
    } catch (e) {
      setStatus('Failed: ' + e.message, 'bad');
      append('error: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  }

  async function loadJobs() {
    const tbody = $('#jobs-table tbody');
    if (!tbody) return;
    clearChildren(tbody);
    const { status, body } = await api('/api/admin/blog/jobs');
    if (status !== 200 || !body?.jobs?.length) {
      const tr = document.createElement('tr');
      const tdE = document.createElement('td'); tdE.colSpan = 6; tdE.style.color = 'var(--ink-faint)';
      tdE.textContent = status === 200 ? 'No drafts or failed jobs.' : 'Failed to load.';
      tr.appendChild(tdE); tbody.appendChild(tr); return;
    }
    for (const j of body.jobs) {
      const tr = document.createElement('tr');
      tr.appendChild(td(new Date((j.updated_at || 0) * 1000).toLocaleString('en-GB')));
      tr.appendChild(td(j.topic_key || '—'));
      tr.appendChild(td(j.slug || '—'));
      const pill = document.createElement('span');
      pill.className = 'pill ' + (j.status === 'failed' ? 'bad' : j.status === 'image_done' ? 'good' : 'warn');
      pill.textContent = j.status;
      const tdStatus = document.createElement('td'); tdStatus.appendChild(pill); tr.appendChild(tdStatus);
      tr.appendChild(td(j.error ? j.error.slice(0, 80) : '—'));
      const tdAct = document.createElement('td');
      const retry = mkBtn('Resume', 'btn-sm', () => resumeJob(j.id, retry));
      const del = mkBtn('Delete', 'btn-sm btn-danger', async () => {
        if (!confirm('Delete this draft?')) return;
        await api('/api/admin/blog/delete-job', { method: 'POST', body: JSON.stringify({ id: j.id }) });
        loadJobs();
      });
      tdAct.append(retry, del); tr.appendChild(tdAct);
      tbody.appendChild(tr);
    }
  }
  async function resumeJob(id, btn) {
    btn.disabled = true; btn.textContent = 'Resuming…';
    try {
      await api('/api/admin/blog/retry-job', { method: 'POST', body: JSON.stringify({ id }) });
      const payload = JSON.stringify({ job_id: id });
      let r = await api('/api/admin/blog/text', { method: 'POST', body: payload });
      if (r.status !== 200) throw new Error(r.body?.detail || r.body?.error || 'text');
      r = await api('/api/admin/blog/image', { method: 'POST', body: payload });
      if (r.status !== 200) throw new Error(r.body?.detail || r.body?.error || 'image');
      r = await api('/api/admin/blog/publish', { method: 'POST', body: payload });
      if (r.status !== 200) throw new Error(r.body?.error || 'publish');
      loadJobs(); loadPosts();
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Resume';
      alert('Resume failed: ' + e.message);
    }
  }

  async function loadPosts() {
    const tbody = $('#posts-table tbody');
    if (!tbody) return;
    clearChildren(tbody);
    const { body } = await api('/api/admin/blog/list');
    const posts = body?.posts || [];
    if (!posts.length) {
      const tr = document.createElement('tr');
      const tdE = document.createElement('td'); tdE.colSpan = 5; tdE.style.color = 'var(--ink-faint)';
      tdE.textContent = 'No posts yet.';
      tr.appendChild(tdE); tbody.appendChild(tr); return;
    }
    for (const p of posts) {
      const tr = document.createElement('tr');
      tr.appendChild(td(new Date((p.published_at || 0) * 1000).toLocaleDateString('en-GB')));
      const tdT = document.createElement('td'); tdT.className = 'cell-strong';
      const a = document.createElement('a'); a.href = '/blog/' + p.slug; a.target = '_blank'; a.rel = 'noopener'; a.textContent = p.title;
      tdT.appendChild(a); tr.appendChild(tdT);
      tr.appendChild(td(p.slug));
      tr.appendChild(td(p.ai_provider || '—'));
      const tdAct = document.createElement('td');
      const toggle = mkBtn(p.status === 'hidden' ? 'Show' : 'Hide', 'btn-sm', async () => {
        await api('/api/admin/blog/post', { method: 'POST', body: JSON.stringify({ id: p.id, action: p.status === 'hidden' ? 'show' : 'hide' }) });
        loadPosts();
      });
      const del = mkBtn('Delete', 'btn-sm btn-danger', async () => {
        if (!confirm('Delete ' + p.slug + '?')) return;
        await api('/api/admin/blog/post', { method: 'POST', body: JSON.stringify({ id: p.id, action: 'delete' }) });
        loadPosts();
      });
      tdAct.append(toggle, del); tr.appendChild(tdAct);
      tbody.appendChild(tr);
    }
  }

  // ── programmatic ────────────────────────────────────────────────
  async function pullAndQueue(queue) {
    const seed = $('#pull-seed').value.trim();
    const limit = parseInt($('#pull-limit').value, 10) || 50;
    const out = $('#pull-out');
    if (!seed) { showLog(out, 'Enter a seed phrase.'); return; }
    showLog(out, `Pulling autocomplete suggestions for "${seed}"…`);
    const { status, body } = await api('/api/admin/prog/pull-keywords', {
      method: 'POST', body: JSON.stringify({ seed, limit, queue }),
    });
    if (status !== 200) { showLog(out, 'Error: ' + (body?.error || status)); return; }
    const head = `Pulled ${body.pulled} keywords (deduped, junk dropped)` +
      (queue ? ` · inserted ${body.inserted} · duplicate ${body.duplicate}` : ' (preview only)');
    // Hide the log block and render a structured list instead.
    if (out) { out.hidden = true; }
    const host = out?.parentNode;
    if (!host) return;
    // Remove a previous preview list if present.
    const old = host.querySelector('.pull-preview-list');
    if (old) old.remove();
    const headline = document.createElement('p');
    headline.style.cssText = 'margin:10px 0 0;color:var(--ink-dim);font-size:13px';
    headline.textContent = head;
    // Insert headline + list right after the log placeholder so it sits in place.
    const ul = document.createElement('ul');
    ul.className = 'pull-preview-list';
    const items = (body.keywords || []);
    if (!items.length) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="kw">No keywords passed the junk/dedupe filters.</span>';
      ul.appendChild(li);
    } else {
      for (const k of items) {
        const li = document.createElement('li');
        const kw = document.createElement('span'); kw.className = 'kw'; kw.textContent = k.keyword;
        const meta = document.createElement('span'); meta.className = 'meta';
        meta.textContent = `${k.intent.padEnd(13)} · score ${String(k.score).padStart(2)}`;
        li.append(kw, meta);
        ul.appendChild(li);
      }
    }
    // Stick the headline + list right after the textarea / log.
    out.parentNode.insertBefore(headline, out.nextSibling);
    out.parentNode.insertBefore(ul, headline.nextSibling);
    if (queue) loadQueue();
  }

  async function uploadCsv() {
    const csv = $('#upload-csv').value;
    const status = $('#upload-status');
    if (!csv.trim()) { status.textContent = 'Paste at least one keyword.'; status.className = 'status bad'; return; }
    const { status: code, body } = await api('/api/admin/prog/upload', {
      method: 'POST', body: JSON.stringify({ csv }),
    });
    if (code !== 200) { status.textContent = 'Error: ' + (body?.error || code); status.className = 'status bad'; return; }
    status.textContent = `Inserted ${body.inserted}, skipped ${body.duplicate} duplicates.`;
    status.className = 'status good';
    $('#upload-csv').value = '';
    loadQueue();
  }

  const INTENT_PILL = {
    transactional: 'good',
    commercial:    'warn',
    informational: '',
    navigational:  '',
    junk:          'bad',
  };

  async function patchKeyword(id, patch) {
    return api('/api/admin/prog/queue', {
      method: 'PATCH',
      body: JSON.stringify({ id, ...patch }),
    });
  }

  async function loadQueue() {
    const tbody = $('#queue-table tbody');
    if (!tbody) return;
    clearChildren(tbody);
    const statusFilter = $('#queue-status').value || 'pending';
    const { body } = await api('/api/admin/prog/queue?status=' + encodeURIComponent(statusFilter));
    const rows = body?.keywords || [];
    if (!rows.length) {
      const tr = document.createElement('tr');
      const tdE = document.createElement('td'); tdE.colSpan = 6; tdE.style.color = 'var(--ink-faint)';
      tdE.textContent = `No ${statusFilter} keywords.`;
      tr.appendChild(tdE); tbody.appendChild(tr); return;
    }
    for (const k of rows) {
      const tr = document.createElement('tr');
      tr.appendChild(td(k.keyword, 'cell-strong'));

      // Intent pill
      const intentPill = document.createElement('span');
      const intentClass = INTENT_PILL[k.intent] || '';
      intentPill.className = 'pill' + (intentClass ? ' ' + intentClass : '');
      intentPill.textContent = k.intent || '—';
      const tdI = document.createElement('td'); tdI.appendChild(intentPill); tr.appendChild(tdI);

      // Score
      const scoreCell = document.createElement('td');
      scoreCell.className = 'cell-num';
      scoreCell.textContent = (k.score != null ? k.score : '—');
      tr.appendChild(scoreCell);

      // Priority — editable inline for pending rows.
      const tdP = document.createElement('td'); tdP.className = 'cell-priority';
      if (statusFilter === 'pending') {
        const up = document.createElement('button');
        up.className = 'pri-btn'; up.title = 'Bump priority +10'; up.textContent = '↑';
        up.onclick = async () => {
          await patchKeyword(k.id, { priority: (k.priority || 0) + 10 });
          loadQueue();
        };
        const down = document.createElement('button');
        down.className = 'pri-btn'; down.title = 'Lower priority −10'; down.textContent = '↓';
        down.onclick = async () => {
          await patchKeyword(k.id, { priority: (k.priority || 0) - 10 });
          loadQueue();
        };
        const drop = document.createElement('button');
        drop.className = 'pri-btn pri-drop'; drop.title = 'Mark failed (skip)'; drop.textContent = '✕';
        drop.onclick = async () => {
          await patchKeyword(k.id, { status: 'failed' });
          loadQueue();
        };
        const val = document.createElement('span'); val.className = 'pri-val'; val.textContent = (k.priority != null ? k.priority : 0);
        tdP.append(val, up, down, drop);
      } else if (statusFilter === 'failed') {
        const retry = document.createElement('button');
        retry.className = 'pri-btn'; retry.title = 'Retry'; retry.textContent = '↻';
        retry.onclick = async () => {
          await patchKeyword(k.id, { status: 'pending' });
          loadQueue();
        };
        const val = document.createElement('span'); val.className = 'pri-val'; val.textContent = (k.priority != null ? k.priority : 0);
        tdP.append(val, retry);
      } else {
        tdP.textContent = k.priority != null ? k.priority : '—';
      }
      tr.appendChild(tdP);

      // Status pill
      const pill = document.createElement('span');
      pill.className = 'pill ' + (k.status === 'failed' ? 'bad' : k.status === 'done' ? 'good' : 'warn');
      pill.textContent = k.status;
      const tdS = document.createElement('td'); tdS.appendChild(pill); tr.appendChild(tdS);

      tr.appendChild(td(k.page_id ? '/p/…' : '—'));
      tbody.appendChild(tr);
    }
  }

  async function runProgNext() {
    const btn = $('#prog-go');
    const status = $('#prog-status');
    btn.disabled = true; status.className = 'status'; status.textContent = 'Generating… ~60-120s';
    const { status: code, body } = await api('/api/admin/prog/generate-next', { method: 'POST', body: '{}' });
    btn.disabled = false;
    if (code === 200 && body?.drained) { status.className = 'status'; status.textContent = 'Queue is empty.'; return; }
    if (code !== 200 || !body?.ok) { status.className = 'status bad'; status.textContent = (body?.error || code) + ' ' + (body?.detail || ''); return; }
    status.className = 'status good';
    status.textContent = 'Generated /p/' + body.slug;
    loadQueue();
    loadOverview();
  }

  // ── SEO tab ─────────────────────────────────────────────────────
  async function pingIndexNow() {
    const btn = $('#ping-go');
    const status = $('#ping-status');
    btn.disabled = true; status.className = 'status'; status.textContent = 'Pinging…';
    const { status: code, body } = await api('/api/admin/indexnow-ping', { method: 'POST', body: '{}' });
    btn.disabled = false;
    if (code !== 200 || !body?.ok) {
      status.className = 'status bad';
      status.textContent = (body?.error || `failed (${code})`);
      return;
    }
    status.className = 'status good';
    status.textContent = `OK · ${body.urls?.length || 0} URLs (${body.source})`;
  }

  function renderWidgetSnippet() {
    const host = location.host;
    const snippet =
`<div id="my-blog"></div>
<script src="https://${host}/widget.js"
  data-target="#my-blog"
  data-count="5"
  data-title="Latest from our blog"
  defer><\/script>`;
    $('#widget-snippet').textContent = snippet;
    $('#sitemap-link').href = '/sitemap.xml';
  }

  // ── tiny helpers ────────────────────────────────────────────────
  function td(text, cls) {
    const e = document.createElement('td');
    e.textContent = String(text == null ? '' : text);
    if (cls) e.className = cls;
    return e;
  }
  function mkBtn(label, cls, onClick) {
    const b = document.createElement('button');
    b.className = 'btn ' + (cls || '');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  // ── cover editor ────────────────────────────────────────────────
  // Self-contained canvas editor. Drives:
  //   - asset uploads (background + logo) to /api/admin/cover/upload
  //   - template save/load via /api/admin/cover/templates
  //   - client-side rendering of the final PNG, then push to
  //     /api/admin/cover/apply for a specific blog post or job
  // The state lives on `Cover.state`; the canvas is redrawn from state
  // on every interaction. No layout libraries, no DnD libraries.
  const Cover = (() => {
    const CANVAS_ID = 'cover-canvas';
    const FONT_FAMILIES = [
      'system-ui',
      'Georgia, serif',
      'Inter, sans-serif',
      '"Times New Roman", serif',
      '"Helvetica Neue", Arial, sans-serif',
      '"Courier New", monospace',
      '"Trebuchet MS", sans-serif',
      'Impact, sans-serif',
    ];
    const DEFAULT_TEMPLATE = () => ({
      width: 1200, height: 630,
      background: null,
      layers: [],
    });

    const state = {
      template: DEFAULT_TEMPLATE(),
      selectedId: null,
      images: new Map(),
      assets: { background: [], logo: [] },
      templates: [],
      ctx: null,
      drag: null,
      mounted: false,
      posts: [],
    };

    function uid() { return 'l' + Math.random().toString(36).slice(2, 9); }

    async function loadImage(url) {
      if (!url) return null;
      if (state.images.has(url)) return state.images.get(url);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const ready = new Promise((res, rej) => {
        img.onload = () => res(img);
        img.onerror = () => rej(new Error('image_load_failed: ' + url));
      });
      img.src = url;
      try { await ready; state.images.set(url, img); return img; }
      catch { return null; }
    }

    // Tiny mirror of functions/_lib/template.js so the canvas can use
    // the same syntax as the server. Keep them in sync — same filters,
    // same conditional shape. See server file for the full spec.
    const TPL_FILTERS = {
      upper:    (v) => String(v ?? '').toUpperCase(),
      lower:    (v) => String(v ?? '').toLowerCase(),
      title:    (v) => String(v ?? '').replace(/\w\S*/g, (t) => t[0].toUpperCase() + t.slice(1).toLowerCase()),
      truncate: (v, n) => {
        const s = String(v ?? '');
        const max = parseInt(n, 10) || 60;
        return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
      },
      default:  (v, fb) => {
        const s = String(v ?? '').trim();
        return s ? v : (fb ?? '');
      },
      slug:   (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      escape: (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
      date:   (v, fmt) => {
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
      // Conditionals first.
      const re = /\{\s*if\s+(!)?\s*([a-zA-Z_][\w.]*)\s*\}([\s\S]*?)\{\s*\/if\s*\}/;
      for (let i = 0; i < 100; i++) {
        const m = s.match(re);
        if (!m) break;
        const v = tplLookup(ctx, m[2]);
        const keep = tplTruthy(v) !== (m[1] === '!') ? m[3] : '';
        s = s.slice(0, m.index) + keep + s.slice(m.index + m[0].length);
      }
      // Then plain tokens.
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
          if (typeof fn === 'function') { try { v = fn(v, arg); } catch {} }
        }
        return v == null ? '' : String(v);
      });
    }

    // Backwards-compat shim — older code calls substituteTitle(text, title).
    // We translate that into a one-key context so existing layers still work
    // even if the spec ever changes.
    function substituteTitle(text, title) {
      return tplExpand(text, { title: title || '' });
    }

    function wrapLines(ctx, text, maxWidth) {
      const lines = [];
      for (const para of String(text).split('\n')) {
        const words = para.split(/\s+/).filter(Boolean);
        let line = '';
        for (const w of words) {
          const trial = line ? line + ' ' + w : w;
          if (ctx.measureText(trial).width <= maxWidth) line = trial;
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

    // Normalise a draw() argument into a full template context. Accepts
    // either a string (treated as title) or a full ctx object.
    function normaliseCtx(arg) {
      if (arg && typeof arg === 'object') return arg;
      return { title: String(arg || ''), date: new Date(), has_image: !!state.template.background?.url };
    }

    async function draw(arg = '') {
      const previewCtx = normaliseCtx(arg);
      const canvas = $('#' + CANVAS_ID);
      if (!canvas) return;
      const { width, height } = state.template;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width; canvas.height = height;
      }
      const ctx = canvas.getContext('2d');
      state.ctx = ctx;
      ctx.clearRect(0, 0, width, height);

      if (state.template.background?.url) {
        const img = await loadImage(state.template.background.url);
        if (img) {
          const r = Math.max(width / img.width, height / img.height);
          const w = img.width * r, h = img.height * r;
          ctx.drawImage(img, (width - w) / 2, (height - h) / 2, w, h);
        }
      } else {
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, width, height);
      }

      for (const layer of state.template.layers) {
        if (layer.kind === 'box') {
          ctx.fillStyle = layer.fill || 'rgba(0,0,0,0.55)';
          if (layer.radius) {
            roundRect(ctx, layer.x, layer.y, layer.w, layer.h, layer.radius);
            ctx.fill();
          } else {
            ctx.fillRect(layer.x, layer.y, layer.w, layer.h);
          }
        } else if (layer.kind === 'text') {
          const fontSize = layer.size || 60;
          const family = layer.family || FONT_FAMILIES[0];
          const weight = layer.weight || '600';
          ctx.font = `${weight} ${fontSize}px ${family}`;
          ctx.fillStyle = layer.color || '#ffffff';
          ctx.textBaseline = 'top';
          ctx.textAlign = layer.align || 'left';
          const display = tplExpand(layer.text, previewCtx);
          const lines = wrapLines(ctx, display, layer.w || width - layer.x);
          const lineHeight = fontSize * (layer.lineHeight || 1.15);
          let drawX = layer.x;
          if (layer.align === 'center') drawX = layer.x + (layer.w || 0) / 2;
          if (layer.align === 'right')  drawX = layer.x + (layer.w || 0);
          for (let i = 0; i < lines.length; i++) {
            if (layer.shadow) {
              ctx.shadowColor = 'rgba(0,0,0,0.6)';
              ctx.shadowBlur = 8;
              ctx.shadowOffsetY = 2;
            }
            ctx.fillText(lines[i], drawX, layer.y + i * lineHeight);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
          }
        } else if (layer.kind === 'logo' && layer.url) {
          const img = await loadImage(layer.url);
          if (img) {
            const r = Math.min(layer.w / img.width, layer.h / img.height);
            const w = img.width * r, h = img.height * r;
            ctx.drawImage(img, layer.x + (layer.w - w) / 2, layer.y + (layer.h - h) / 2, w, h);
          }
        }
      }

      if (state.selectedId && !state._renderingFinal) {
        const sel = state.template.layers.find((l) => l.id === state.selectedId);
        if (sel) {
          ctx.strokeStyle = '#3aa7ff';
          ctx.lineWidth = 2;
          ctx.setLineDash([6, 4]);
          ctx.strokeRect(sel.x, sel.y, sel.w, sel.h);
          ctx.setLineDash([]);
          ctx.fillStyle = '#3aa7ff';
          ctx.fillRect(sel.x + sel.w - 8, sel.y + sel.h - 8, 14, 14);
        }
      }
    }

    function roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y,     x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x,     y + h, r);
      ctx.arcTo(x,     y + h, x,     y,     r);
      ctx.arcTo(x,     y,     x + w, y,     r);
      ctx.closePath();
    }

    function renderLayersPanel() {
      const ul = $('#cover-layers');
      if (!ul) return;
      clearChildren(ul);
      const layers = state.template.layers;
      if (!layers.length) {
        const li = document.createElement('li'); li.className = 'dim';
        li.textContent = 'No layers. Add one with the buttons below.';
        ul.appendChild(li);
        renderInspector(null);
        return;
      }
      [...layers].reverse().forEach((l) => {
        const li = document.createElement('li');
        li.className = 'cover-layer' + (l.id === state.selectedId ? ' selected' : '');
        const label = document.createElement('span');
        label.className = 'cover-layer-label';
        label.textContent = l.kind === 'text'
          ? '📝 ' + (l.text || '(empty)').slice(0, 30)
          : l.kind === 'box'  ? '⬛ Box'
          : l.kind === 'logo' ? '🖼  Logo'
          : l.kind;
        li.appendChild(label);
        li.onclick = () => { state.selectedId = l.id; redraw(); };
        const actions = document.createElement('span'); actions.className = 'cover-layer-actions';
        const up = document.createElement('button'); up.className = 'pri-btn'; up.textContent = '↑';
        up.title = 'Move forward'; up.onclick = (e) => { e.stopPropagation(); moveLayer(l.id, 1); };
        const dn = document.createElement('button'); dn.className = 'pri-btn'; dn.textContent = '↓';
        dn.title = 'Move backward'; dn.onclick = (e) => { e.stopPropagation(); moveLayer(l.id, -1); };
        const del = document.createElement('button'); del.className = 'pri-btn pri-drop'; del.textContent = '✕';
        del.title = 'Delete'; del.onclick = (e) => { e.stopPropagation(); removeLayer(l.id); };
        actions.append(up, dn, del);
        li.appendChild(actions);
        ul.appendChild(li);
      });
      renderInspector(state.template.layers.find((l) => l.id === state.selectedId) || null);
    }

    function moveLayer(id, dir) {
      const i = state.template.layers.findIndex((l) => l.id === id);
      if (i < 0) return;
      const j = i + dir;
      if (j < 0 || j >= state.template.layers.length) return;
      const arr = state.template.layers;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      redraw();
    }
    function removeLayer(id) {
      state.template.layers = state.template.layers.filter((l) => l.id !== id);
      if (state.selectedId === id) state.selectedId = null;
      redraw();
    }

    function renderInspector(layer) {
      const root = $('#cover-inspector');
      if (!root) return;
      clearChildren(root);
      const h = document.createElement('h3'); h.textContent = 'Inspector';
      root.appendChild(h);
      if (!layer) {
        const p = document.createElement('p'); p.className = 'dim';
        p.textContent = 'Select a layer to edit its style.';
        root.appendChild(p);
        return;
      }
      const wrap = document.createElement('div'); wrap.className = 'cover-inspector-grid';
      const addField = (label, input, fullWidth) => {
        const l = document.createElement('label');
        if (fullWidth) l.classList.add('full');
        const s = document.createElement('span'); s.textContent = label;
        l.append(s, input);
        wrap.appendChild(l);
      };
      const numIn = (val, on) => {
        const i = document.createElement('input'); i.type = 'number'; i.value = val ?? 0;
        i.oninput = () => { on(parseFloat(i.value) || 0); redraw(); };
        return i;
      };
      addField('X', numIn(layer.x, (v) => layer.x = v));
      addField('Y', numIn(layer.y, (v) => layer.y = v));
      addField('Width',  numIn(layer.w, (v) => layer.w = v));
      addField('Height', numIn(layer.h, (v) => layer.h = v));

      if (layer.kind === 'text') {
        const ta = document.createElement('textarea'); ta.rows = 2; ta.value = layer.text || '';
        ta.placeholder = 'Use {title} to substitute the post title';
        ta.oninput = () => { layer.text = ta.value; redraw(); };
        addField('Text', ta, true);
        addField('Size', numIn(layer.size, (v) => layer.size = v));
        const family = document.createElement('select');
        for (const f of FONT_FAMILIES) {
          const o = document.createElement('option'); o.value = f; o.textContent = f.split(',')[0];
          if (layer.family === f) o.selected = true;
          family.appendChild(o);
        }
        family.onchange = () => { layer.family = family.value; redraw(); };
        addField('Family', family);
        const weight = document.createElement('select');
        for (const w of ['300', '400', '500', '600', '700', '800']) {
          const o = document.createElement('option'); o.value = w; o.textContent = w;
          if ((layer.weight || '600') === w) o.selected = true;
          weight.appendChild(o);
        }
        weight.onchange = () => { layer.weight = weight.value; redraw(); };
        addField('Weight', weight);
        const align = document.createElement('select');
        for (const a of ['left', 'center', 'right']) {
          const o = document.createElement('option'); o.value = a; o.textContent = a;
          if ((layer.align || 'left') === a) o.selected = true;
          align.appendChild(o);
        }
        align.onchange = () => { layer.align = align.value; redraw(); };
        addField('Align', align);
        const colour = document.createElement('input'); colour.type = 'color';
        colour.value = layer.color || '#ffffff';
        colour.oninput = () => { layer.color = colour.value; redraw(); };
        addField('Colour', colour);
        const shadow = document.createElement('input'); shadow.type = 'checkbox';
        shadow.checked = !!layer.shadow;
        shadow.onchange = () => { layer.shadow = shadow.checked; redraw(); };
        addField('Shadow', shadow);
      } else if (layer.kind === 'box') {
        const fill = document.createElement('input'); fill.type = 'color';
        const rgbMatch = (layer.fill || '#000000').match(/^#([0-9a-f]{6,8})$/i);
        fill.value = rgbMatch ? '#' + rgbMatch[1].slice(0, 6) : '#000000';
        fill.oninput = () => {
          const a = layer._alpha != null ? layer._alpha : 0.55;
          layer.fill = hexToRgba(fill.value, a); redraw();
        };
        addField('Fill', fill);
        const alpha = document.createElement('input'); alpha.type = 'range';
        alpha.min = '0'; alpha.max = '1'; alpha.step = '0.05';
        alpha.value = String(layer._alpha != null ? layer._alpha : 0.55);
        alpha.oninput = () => {
          layer._alpha = parseFloat(alpha.value);
          layer.fill = hexToRgba(fill.value, layer._alpha); redraw();
        };
        addField('Alpha', alpha);
        addField('Radius', numIn(layer.radius || 0, (v) => layer.radius = v));
      } else if (layer.kind === 'logo') {
        const sel = document.createElement('select');
        const placeholder = document.createElement('option');
        placeholder.value = ''; placeholder.textContent = '(no logo)';
        sel.appendChild(placeholder);
        for (const a of state.assets.logo) {
          const o = document.createElement('option'); o.value = a.url; o.textContent = a.original_name || a.id;
          if (layer.url === a.url) o.selected = true;
          sel.appendChild(o);
        }
        sel.onchange = () => { layer.url = sel.value || null; layer.asset_id = null; redraw(); };
        addField('Source', sel, true);
      }
      root.appendChild(wrap);
    }

    function hexToRgba(hex, a) {
      const m = String(hex).match(/^#?([0-9a-f]{6})$/i);
      if (!m) return 'rgba(0,0,0,' + a + ')';
      const n = parseInt(m[1], 16);
      const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
      return `rgba(${r}, ${g}, ${b}, ${a})`;
    }

    function bindCanvas() {
      const canvas = $('#' + CANVAS_ID);
      if (!canvas) return;
      const hitTest = (px, py) => {
        for (let i = state.template.layers.length - 1; i >= 0; i--) {
          const l = state.template.layers[i];
          if (px >= l.x && px <= l.x + l.w && py >= l.y && py <= l.y + l.h) return l;
        }
        return null;
      };
      const handleHit = (l, px, py) => {
        return px >= l.x + l.w - 16 && py >= l.y + l.h - 16;
      };
      const toCanvas = (e) => {
        const rect = canvas.getBoundingClientRect();
        const sx = canvas.width  / rect.width;
        const sy = canvas.height / rect.height;
        return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
      };
      canvas.addEventListener('mousedown', (e) => {
        const { x, y } = toCanvas(e);
        const hit = hitTest(x, y);
        if (!hit) { state.selectedId = null; redraw(); return; }
        state.selectedId = hit.id;
        const resize = handleHit(hit, x, y);
        state.drag = { id: hit.id, startX: x, startY: y, origX: hit.x, origY: hit.y,
          origW: hit.w, origH: hit.h, mode: resize ? 'resize' : 'move' };
        redraw();
      });
      window.addEventListener('mousemove', (e) => {
        if (!state.drag) return;
        const { x, y } = toCanvas(e);
        const layer = state.template.layers.find((l) => l.id === state.drag.id);
        if (!layer) return;
        const dx = x - state.drag.startX, dy = y - state.drag.startY;
        if (state.drag.mode === 'move') {
          layer.x = Math.round(state.drag.origX + dx);
          layer.y = Math.round(state.drag.origY + dy);
        } else {
          layer.w = Math.max(20, Math.round(state.drag.origW + dx));
          layer.h = Math.max(20, Math.round(state.drag.origH + dy));
        }
        redraw();
      });
      window.addEventListener('mouseup', () => { state.drag = null; });
    }

    function addLayer(kind) {
      const { width, height } = state.template;
      const base = { id: uid(), kind, x: 80, y: 80 };
      if (kind === 'text') {
        Object.assign(base, {
          w: width - 160, h: 200,
          text: '{title}',
          size: 72, family: 'Georgia, serif', weight: '700',
          align: 'left', color: '#ffffff', shadow: true, lineHeight: 1.15,
        });
      } else if (kind === 'box') {
        Object.assign(base, {
          w: width - 160, h: 250,
          fill: 'rgba(0,0,0,0.55)', _alpha: 0.55, radius: 12,
        });
      } else if (kind === 'logo') {
        const w = 200, h = 80;
        Object.assign(base, {
          x: width - w - 40, y: height - h - 40, w, h,
          url: state.assets.logo[0]?.url || null,
        });
      }
      state.template.layers.push(base);
      state.selectedId = base.id;
      redraw();
    }

    let _redrawScheduled = false;
    function redraw(previewTitle) {
      if (_redrawScheduled) return;
      _redrawScheduled = true;
      requestAnimationFrame(async () => {
        _redrawScheduled = false;
        try { await draw(previewTitle); } catch { /* swallow */ }
        renderLayersPanel();
      });
    }

    async function loadAssets() {
      const [bgs, logos] = await Promise.all([
        api('/api/admin/cover/upload?kind=background'),
        api('/api/admin/cover/upload?kind=logo'),
      ]);
      state.assets.background = bgs.body?.assets || [];
      state.assets.logo       = logos.body?.assets || [];
      renderAssetGrid('background', '#cover-bg-grid');
      renderAssetGrid('logo',       '#cover-logo-grid');
    }

    function renderAssetGrid(kind, sel) {
      const grid = $(sel);
      if (!grid) return;
      clearChildren(grid);
      const list = state.assets[kind];
      if (!list.length) {
        const d = document.createElement('div'); d.className = 'dim';
        d.textContent = `No ${kind}s yet.`;
        grid.appendChild(d);
        return;
      }
      for (const a of list) {
        const card = document.createElement('div'); card.className = 'cover-asset';
        const img = document.createElement('img'); img.src = a.url; img.loading = 'lazy';
        const use = document.createElement('button'); use.className = 'btn btn-sm';
        use.textContent = kind === 'background' ? 'Use as bg' : 'Add as logo';
        use.onclick = () => {
          if (kind === 'background') {
            state.template.background = { asset_id: a.id, url: a.url };
          } else {
            addLayer('logo');
            const l = state.template.layers[state.template.layers.length - 1];
            l.url = a.url; l.asset_id = a.id;
          }
          redraw();
        };
        const del = document.createElement('button'); del.className = 'btn btn-sm btn-ghost';
        del.textContent = '✕';
        del.onclick = async () => {
          if (!confirm('Delete this asset?')) return;
          await api('/api/admin/cover/upload?id=' + encodeURIComponent(a.id), { method: 'DELETE' });
          loadAssets();
        };
        card.append(img, use, del);
        grid.appendChild(card);
      }
    }

    async function uploadAsset(kind, file) {
      const status = $('#cover-upload-status');
      const sizeMB = (file.size / 1024 / 1024).toFixed(2);
      // Visible busy state — the buttons get disabled, status stays
      // pinned until completion. Large images can take a few seconds
      // to base64-encode + upload, so silence is the worst UX.
      console.log('[cover] uploadAsset start', { kind, name: file.name, type: file.type, size: file.size });
      const buttons = $$('.cover-upload-row label');
      buttons.forEach((b) => b.classList.add('busy'));
      status.className = 'status'; status.textContent = `Encoding ${kind} (${sizeMB} MB)…`;
      let b64;
      try { b64 = await fileToBase64(file); }
      catch (e) {
        buttons.forEach((b) => b.classList.remove('busy'));
        status.className = 'status bad';
        status.textContent = 'Could not read file: ' + (e?.message || e);
        console.error('[cover] fileToBase64 failed', e);
        return;
      }
      status.textContent = `Uploading ${kind}…`;
      let resp;
      try {
        resp = await api('/api/admin/cover/upload', {
          method: 'POST',
          body: JSON.stringify({
            kind, filename: file.name, content_type: file.type, base64: b64,
          }),
        });
      } catch (e) {
        buttons.forEach((b) => b.classList.remove('busy'));
        status.className = 'status bad';
        status.textContent = 'Network error: ' + (e?.message || e);
        console.error('[cover] upload network error', e);
        return;
      }
      buttons.forEach((b) => b.classList.remove('busy'));
      const { status: code, body } = resp;
      console.log('[cover] upload response', code, body);
      if (code !== 200 || !body?.ok) {
        status.className = 'status bad';
        status.textContent = `Upload failed: ${body?.error || code}${body?.detail ? ' · ' + body.detail : ''}`;
        return;
      }
      status.className = 'status good';
      status.textContent = `✓ Uploaded ${kind}: ${file.name}`;
      // Auto-apply on first upload of each kind so the user sees an
      // immediate visual change in the canvas.
      if (kind === 'background' && !state.template.background) {
        state.template.background = { asset_id: body.asset.id, url: body.asset.url };
        redraw();
      } else if (kind === 'logo' && !state.template.layers.find((l) => l.kind === 'logo')) {
        addLayer('logo');
        const l = state.template.layers[state.template.layers.length - 1];
        l.url = body.asset.url; l.asset_id = body.asset.id;
        redraw();
      }
      loadAssets();
    }

    function fileToBase64(file) {
      return new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result).replace(/^data:[^;]+;base64,/, ''));
        fr.onerror = () => rej(new Error('read_failed'));
        fr.readAsDataURL(file);
      });
    }

    async function loadTemplates() {
      const { body } = await api('/api/admin/cover/templates');
      state.templates = body?.templates || [];
      renderTemplateList();
    }

    function renderTemplateList() {
      const ul = $('#cover-templates');
      if (!ul) return;
      clearChildren(ul);
      if (!state.templates.length) {
        const li = document.createElement('li'); li.className = 'dim';
        li.textContent = 'No templates saved yet.';
        ul.appendChild(li);
        return;
      }
      for (const t of state.templates) {
        const li = document.createElement('li');
        const name = document.createElement('strong'); name.textContent = t.name;
        if (t.is_default) {
          const badge = document.createElement('span'); badge.className = 'pill good';
          badge.textContent = 'default'; name.appendChild(document.createTextNode(' '));
          name.appendChild(badge);
        }
        const load = document.createElement('button'); load.className = 'btn btn-sm';
        load.textContent = 'Load';
        load.onclick = () => {
          if (!t.spec) return;
          state.template = JSON.parse(JSON.stringify(t.spec));
          for (const l of state.template.layers) l.id = l.id || uid();
          $('#cover-template-name').value = t.name;
          $('#cover-template-default').checked = !!t.is_default;
          state.selectedId = null;
          redraw();
        };
        const del = document.createElement('button'); del.className = 'btn btn-sm btn-ghost';
        del.textContent = 'Delete';
        del.onclick = async () => {
          if (!confirm('Delete template "' + t.name + '"?')) return;
          await api('/api/admin/cover/templates?id=' + encodeURIComponent(t.id), { method: 'DELETE' });
          loadTemplates();
        };
        li.append(name, load, del);
        ul.appendChild(li);
      }
    }

    async function saveTemplate() {
      const name = $('#cover-template-name').value.trim();
      const status = $('#cover-save-status');
      if (!name) { status.className = 'status bad'; status.textContent = 'Name the template first.'; return; }
      const spec = JSON.parse(JSON.stringify(state.template));
      for (const l of spec.layers) { delete l._alpha; }
      const is_default = $('#cover-template-default').checked;
      status.className = 'status'; status.textContent = 'Saving…';
      const { status: code, body } = await api('/api/admin/cover/templates', {
        method: 'POST',
        body: JSON.stringify({ name, spec, is_default }),
      });
      if (code !== 200 || !body?.ok) {
        status.className = 'status bad'; status.textContent = 'Save failed: ' + (body?.error || code); return;
      }
      status.className = 'status good';
      status.textContent = 'Saved.';
      setTimeout(() => { status.textContent = ''; }, 2000);
      loadTemplates();
    }

    async function loadPosts() {
      const r = await api('/api/admin/blog/list');
      state.posts = (r.body?.posts || []).filter((p) => p.status === 'published').slice(0, 50);
      const sel = $('#cover-preview-post');
      if (!sel) return;
      while (sel.options.length > 1) sel.remove(1);
      for (const p of state.posts) {
        const o = document.createElement('option'); o.value = p.id; o.textContent = p.title.slice(0, 70);
        sel.appendChild(o);
      }
    }

    // Build a full template context for the editor: title comes from
    // the chosen post (or the typed-override input), brand fields come
    // from the live settings call. The same shape as the server's
    // buildBrandContext() so tokens behave identically.
    async function buildPreviewCtx() {
      const titleField = $('#cover-preview-title').value.trim();
      const postId = $('#cover-preview-post').value;
      const post = postId ? state.posts.find((p) => p.id === postId) : null;
      const title = titleField || post?.title || '';
      const s = await api('/api/admin/settings');
      const settings = s.body?.settings || {};
      const env = { SITE_NAME: s.body?.settings?.site_name, SITE_URL: s.body?.settings?.site_url };
      const whoami = await api('/api/admin/whoami');
      return {
        title,
        primary_keyword: post?.primary_query || '',
        slug: post?.slug || '',
        provider: post?.ai_provider || '',
        has_image: !!post?.hero_image_key,
        has_logo:  state.template.layers.some((l) => l.kind === 'logo' && l.url),
        date: new Date(),
        brand: {
          name:           whoami.body?.site_name || env.SITE_NAME || 'this site',
          url:            whoami.body?.site_url  || env.SITE_URL  || '/',
          cta:            settings.site_cta || '',
          tone:           settings.brand_voice_tone || settings.site_tone || '',
          audience:       settings.brand_target_audience || settings.site_audience || '',
          business_type:  settings.brand_business_type || '',
          service_area:   settings.brand_service_area  || '',
          key_themes:     settings.brand_key_themes    || '',
          topics_to_avoid: settings.brand_topics_to_avoid || '',
        },
      };
    }

    async function runPreview() {
      const ctx = await buildPreviewCtx();
      redraw(ctx);
    }

    async function applyToTarget() {
      const postId = $('#cover-preview-post').value;
      const status = $('#cover-save-status');
      if (!postId) { status.className = 'status bad'; status.textContent = 'Pick a blog post first.'; return; }
      const post = state.posts.find((p) => p.id === postId);
      if (!post) { status.className = 'status bad'; status.textContent = 'Post not found.'; return; }
      status.className = 'status'; status.textContent = 'Rendering…';
      state._renderingFinal = true;
      const ctx = await buildPreviewCtx();
      ctx.title = post.title; // ensure the applied title wins
      await draw(ctx);
      state._renderingFinal = false;
      const canvas = $('#' + CANVAS_ID);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      if (!blob) { status.className = 'status bad'; status.textContent = 'Render failed.'; return; }
      const b64 = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = () => rej(new Error('read_failed'));
        fr.readAsDataURL(blob);
      });
      const { status: code, body } = await api('/api/admin/cover/apply', {
        method: 'POST',
        body: JSON.stringify({ target: 'post', id: postId, base64: b64 }),
      });
      if (code !== 200 || !body?.ok) {
        status.className = 'status bad'; status.textContent = 'Apply failed: ' + (body?.error || code);
        redraw();
        return;
      }
      status.className = 'status good';
      status.textContent = `Applied to "${post.title.slice(0, 40)}…". New key: ${body.hero_image_key}`;
      redraw();
    }

    function applyPreset() {
      const sel = $('#cover-canvas-preset'); if (!sel) return;
      const [w, h] = sel.value.split('x').map(Number);
      state.template.width = w; state.template.height = h;
      $('#cover-canvas-size').textContent = `${w} × ${h}`;
      redraw();
    }

    async function init() {
      // Always apply the current freeze state, even on repeat opens —
      // the user might have flipped the toggle in another tab.
      try {
        const s = await api('/api/admin/settings');
        applyHeroImageMode(s.body?.settings?.hero_image_mode || 'ai');
      } catch { /* leave whatever the previous state was */ }
      if (state.mounted) { redraw(); return; }
      state.mounted = true;
      bindCanvas();
      $('#cover-upload-bg')?.addEventListener('change', (e) => {
        const f = e.target.files[0]; if (f) uploadAsset('background', f); e.target.value = '';
      });
      $('#cover-upload-logo')?.addEventListener('change', (e) => {
        const f = e.target.files[0]; if (f) uploadAsset('logo', f); e.target.value = '';
      });
      $$('button[data-add-layer]').forEach((b) => {
        b.addEventListener('click', () => addLayer(b.dataset.addLayer));
      });
      $('#cover-canvas-preset')?.addEventListener('change', applyPreset);
      $('#cover-preview-go')?.addEventListener('click', runPreview);
      $('#cover-save-template')?.addEventListener('click', saveTemplate);
      $('#cover-apply-go')?.addEventListener('click', applyToTarget);
      await Promise.all([loadAssets(), loadTemplates(), loadPosts()]);
      redraw();
    }

    return { init, state };
  })();

  // (Command palette + slash-DSL removed at user request, 2026-05-19.
  // The action handlers below — runBlogChain, runProgNext, pingIndexNow,
  // loadUsage, refreshPricing, generateBrand, saveBrand, runBrandFilter,
  // applyToTarget, etc. — remain wired to their tab buttons.)

  // ── mount ───────────────────────────────────────────────────────
  function mount() {
    $('#gate').hidden = true;
    $('#dash').hidden = false;
    $$('.tab').forEach((t) => t.addEventListener('click', () => activateTab(t.dataset.tab)));
    $('#lock').addEventListener('click', doLogout);

    // overview quick-actions reuse the same handlers as their tabs.
    $('#qa-blog').addEventListener('click', () => { activateTab('blog'); runBlogChain(); });
    $('#qa-prog').addEventListener('click', () => { activateTab('prog'); runProgNext(); });
    $('#qa-ping').addEventListener('click', () => { activateTab('seo'); pingIndexNow(); });

    // blog tab
    $('#blog-go').addEventListener('click', runBlogChain);
    $('#jobs-refresh').addEventListener('click', loadJobs);

    // prog tab
    $('#pull-go').addEventListener('click', () => pullAndQueue(true));
    $('#pull-preview').addEventListener('click', () => pullAndQueue(false));
    $('#upload-go').addEventListener('click', uploadCsv);
    $('#queue-refresh').addEventListener('click', loadQueue);
    $('#queue-status').addEventListener('change', loadQueue);
    $('#prog-go').addEventListener('click', runProgNext);

    // seo tab
    $('#ping-go').addEventListener('click', pingIndexNow);

    // settings tab
    const saveBtn = $('#settings-save');
    if (saveBtn) saveBtn.addEventListener('click', saveSettings);
    const pricingRefresh = $('#pricing-refresh');
    if (pricingRefresh) pricingRefresh.addEventListener('click', refreshPricing);

    // "Go to settings" jump from any [data-jump-to] link.
    $$('[data-jump-to]').forEach((a) => {
      a.addEventListener('click', (e) => { e.preventDefault(); activateTab(a.dataset.jumpTo); });
    });

    // usage tab
    const uRef = $('#usage-refresh');
    const uWin = $('#usage-window');
    if (uRef) uRef.addEventListener('click', loadUsage);
    if (uWin) uWin.addEventListener('change', loadUsage);

    // brand DNA tab
    const bGen = $('#brand-generate');
    const bSave = $('#brand-save');
    const bClear = $('#brand-clear');
    const bFilterDry = $('#brand-filter-dry');
    const bFilterGo  = $('#brand-filter-go');
    if (bGen)        bGen.addEventListener('click', generateBrand);
    if (bSave)       bSave.addEventListener('click', saveBrand);
    if (bClear)      bClear.addEventListener('click', clearBrandFields);
    if (bFilterDry)  bFilterDry.addEventListener('click', () => runBrandFilter(true));
    if (bFilterGo)   bFilterGo.addEventListener('click', () => runBrandFilter(false));

    // embeds tab
    const eCreate = $('#embed-create-go');
    if (eCreate) eCreate.addEventListener('click', createEmbed);

    // calendar tab
    const cPrev = $('#cal-prev'); if (cPrev) cPrev.addEventListener('click', () => Calendar.shiftMonth(-1));
    const cNext = $('#cal-next'); if (cNext) cNext.addEventListener('click', () => Calendar.shiftMonth(1));
    const cToday = $('#cal-today'); if (cToday) cToday.addEventListener('click', () => Calendar.gotoToday());
    const cPlan = $('#cal-plan'); if (cPlan) cPlan.addEventListener('click', () => Calendar.regenerate());
    const cNew = $('#cal-new'); if (cNew) cNew.addEventListener('click', () => Calendar.openModal({ scheduled_for: Calendar.todayIso() }));

    // topbar
    const ow = $('#open-wizard'); if (ow) ow.addEventListener('click', () => Wizard.open());

    activateTab('overview');
    // First-login auto-launch — check onboarding state and offer the
    // wizard if it hasn't been completed yet.
    Wizard.maybeAutoOpen();
    // Background update check — paints the "N" badge on the Updates
    // tab if upstream has new commits. Doesn't block first paint.
    setTimeout(() => Updates.quietCheck(), 800);
  }

  // ── links / aliases ────────────────────────────────────────────
  // Manages the site_aliases table: named shortcuts the LLM uses
  // inside markdown links. Three flavours surface in the UI:
  //   - reserved (blog/home/rss/sitemap) — uneditable
  //   - manual                            — operator-curated, full CRUD
  //   - sitemap                           — auto-imported from blog/prog
  //                                          pages via /api/admin/aliases/sync
  const Links = (() => {
    let aliases = [];
    let editingName = null;

    async function load() {
      const { status, body } = await api('/api/admin/aliases');
      if (status !== 200) {
        $('#link-list-manual').innerHTML = '<div class="muted">Failed to load: ' + (body?.error || status) + '</div>';
        return;
      }
      aliases = body.aliases || [];
      render();
    }

    function render() {
      const escH = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' })[c]);
      const manual = aliases.filter((a) => a.kind === 'manual' || a.kind === 'reserved');
      const sitemap = aliases.filter((a) => a.kind === 'sitemap');

      const wrap = $('#link-list-manual');
      if (!manual.length) {
        wrap.innerHTML = '<div class="muted">No curated links yet. Click <b>+ Add link</b> to teach the AI about a page.</div>';
      } else {
        wrap.innerHTML = '';
        for (const a of manual) {
          const row = document.createElement('div');
          row.className = 'link-row' + (a.kind === 'reserved' ? ' is-reserved' : '');
          row.innerHTML = `
            <div class="link-name">${escH(a.name)}</div>
            <div class="link-meta">
              <span class="link-url">${escH(a.url)}</span>
              ${a.description ? `<span class="link-desc">${escH(a.description)}</span>` : ''}
            </div>
            <span class="link-kind ${a.kind === 'reserved' ? 'is-reserved' : ''}">${escH(a.kind)}</span>
            <button class="link-edit" type="button" data-name="${escH(a.name)}">Edit</button>
          `;
          wrap.appendChild(row);
        }
        wrap.querySelectorAll('.link-edit').forEach((btn) => {
          btn.addEventListener('click', () => {
            const name = btn.dataset.name;
            const a = aliases.find((x) => x.name === name);
            if (a && a.kind !== 'reserved') openModal(a);
          });
        });
      }

      const swrap = $('#link-list-sitemap');
      if (!sitemap.length) {
        swrap.innerHTML = '<div class="muted">No sitemap-imported links yet. Click <b>Sync from sitemap</b> after publishing a post.</div>';
      } else {
        swrap.innerHTML = '';
        for (const a of sitemap.slice(0, 200)) {
          const row = document.createElement('div');
          row.className = 'link-row';
          row.innerHTML = `
            <div class="link-meta">
              <span class="link-url">${escH(a.url)}</span>
              ${a.description ? `<span class="link-desc">${escH(a.description)}</span>` : ''}
            </div>
            <span class="link-kind is-sitemap">sitemap</span>
          `;
          swrap.appendChild(row);
        }
        if (sitemap.length > 200) {
          const more = document.createElement('div');
          more.className = 'muted';
          more.textContent = `+ ${sitemap.length - 200} more.`;
          swrap.appendChild(more);
        }
      }
    }

    function openModal(a) {
      editingName = a?.name || null;
      $('#link-modal-title').textContent = editingName ? 'Edit link' : 'Add link';
      $('#link-mod-name').value = a?.name || '';
      $('#link-mod-name').disabled = !!editingName; // names are immutable once created
      $('#link-mod-url').value  = a?.url  || '';
      $('#link-mod-desc').value = a?.description || '';
      $('#link-mod-delete').hidden = !editingName;
      $('#link-mod-err').textContent = '';
      $('#link-modal').hidden = false;
      setTimeout(() => (editingName ? $('#link-mod-url') : $('#link-mod-name')).focus(), 30);
    }
    function closeModal() {
      $('#link-modal').hidden = true;
      editingName = null;
    }

    async function save() {
      const name = $('#link-mod-name').value.trim().toLowerCase();
      const url  = $('#link-mod-url').value.trim();
      const desc = $('#link-mod-desc').value.trim();
      const err  = $('#link-mod-err'); err.textContent = '';
      if (!editingName) {
        if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(name)) {
          err.textContent = 'Name: lowercase letters, digits, _ or -; up to 40 chars.'; return;
        }
      }
      if (!url) { err.textContent = 'URL is required.'; return; }
      let res;
      if (editingName) {
        res = await api('/api/admin/aliases', {
          method: 'PATCH',
          body: JSON.stringify({ name: editingName, url, description: desc }),
        });
      } else {
        res = await api('/api/admin/aliases', {
          method: 'POST',
          body: JSON.stringify({ name, url, description: desc }),
        });
      }
      if (res.status !== 200) { err.textContent = res.body?.detail || res.body?.error || 'Save failed'; return; }
      closeModal();
      load();
    }

    async function remove() {
      if (!editingName) return;
      if (!confirm(`Delete link "${editingName}"?`)) return;
      const res = await api('/api/admin/aliases?name=' + encodeURIComponent(editingName), { method: 'DELETE' });
      if (res.status !== 200) { $('#link-mod-err').textContent = res.body?.error || 'Delete failed'; return; }
      closeModal();
      load();
    }

    async function sync() {
      const btn = $('#link-sync'); const orig = btn.textContent;
      btn.disabled = true; btn.textContent = 'Syncing…';
      const res = await api('/api/admin/aliases/sync', { method: 'POST' });
      btn.disabled = false; btn.textContent = orig;
      if (res.status === 200) {
        const r = res.body;
        const msg = `Sitemap synced — ${r.added || 0} added, ${r.removed || 0} removed (${r.total || 0} total).`;
        btn.textContent = '✓ ' + msg.slice(0, 50);
        setTimeout(() => { btn.textContent = orig; }, 3000);
      } else {
        alert(res.body?.error || 'Sync failed');
      }
      load();
    }

    function bindOnce() {
      if (bindOnce.done) return;
      bindOnce.done = true;
      $('#link-add').addEventListener('click', () => openModal(null));
      $('#link-sync').addEventListener('click', sync);
      $('#link-mod-save').addEventListener('click', save);
      $('#link-mod-cancel').addEventListener('click', closeModal);
      $('#link-mod-delete').addEventListener('click', remove);
      $('#link-modal').addEventListener('click', (e) => { if (e.target.id === 'link-modal') closeModal(); });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !$('#link-modal').hidden) closeModal();
      });
    }

    function init() { bindOnce(); load(); }
    return { init };
  })();

  // ── first-run setup ───────────────────────────────────────────
  // Renders the one-time setup card on a fresh one-click deploy.
  // The server's /api/setup applies the schema, generates secrets,
  // and creates the first user; we then log the operator in with
  // their just-set password so they land in the onboarding wizard.
  const Setup = (() => {
    // The setup magic-link token from ?setup=<hex>. Saved here so
    // submit() can forward it to /api/setup.
    let setupToken = '';

    // Read the magic-link token from ?setup=<token>. The installer
    // at seo.benjaminb.xyz/install sets SETUP_TOKEN as a Pages env
    // var on the new project AND hands the operator a URL of the
    // form https://<their-site>/admin?setup=<token>. The server's
    // /api/setup matches the token against env.SETUP_TOKEN; only a
    // matching token allows the password to be set.
    function readSetupToken() {
      const params = new URLSearchParams(location.search);
      const t = params.get('setup') || '';
      return /^[0-9a-f]{20,128}$/.test(t) ? t : '';
    }

    function clearTokenFromUrl() {
      // Remove the ?setup=… so a refresh doesn't keep the token in
      // the bar (and so the browser doesn't preserve it in history).
      try {
        const url = new URL(location.href);
        url.searchParams.delete('setup');
        history.replaceState(null, '', url.pathname + (url.search ? url.search : '') + (url.hash || ''));
      } catch { /* */ }
    }

    async function show() {
      $('#gate').hidden = true;
      $('#dash').hidden = true;
      $('#wiz').hidden = true;
      $('#setup').hidden = false;
      $('#setup-form-pane').hidden = false;
      $('#setup-success').hidden = true;

      // Capture the magic-link token (if present) and clear it from
      // the URL bar. We keep the value in setupToken for the POST.
      setupToken = readSetupToken();
      clearTokenFromUrl();

      // Sensible defaults for the new operator.
      const siteUrlInput = $('#setup-site-url');
      if (siteUrlInput && !siteUrlInput.value) siteUrlInput.value = location.origin;
      // Try to populate site name from the SITE_NAME env var via
      // whoami — that's set by the installer at provision time.
      try {
        const w = await api('/api/admin/whoami');
        const name = w?.body?.site_name;
        if (name && !$('#setup-site-name').value) $('#setup-site-name').value = name;
      } catch { /* fine, leave blank for manual entry */ }

      setTimeout(() => $('#setup-email').focus(), 50);
    }

    function showSuccess() {
      $('#setup-form-pane').hidden = true;
      $('#setup-success').hidden = false;
    }

    async function submit(e) {
      e.preventDefault();
      const err = $('#setup-err'); err.textContent = '';
      const site_name = $('#setup-site-name').value.trim();
      const site_url  = $('#setup-site-url').value.trim();
      const email     = $('#setup-email').value.trim().toLowerCase();
      const password  = $('#setup-password').value;
      if (!site_name) { err.textContent = 'Site name is required.'; return; }
      if (!/^https?:\/\/.+/i.test(site_url)) { err.textContent = 'Site URL must start with http(s)://'; return; }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { err.textContent = 'Enter a valid email address.'; return; }
      if (password.length < 8) { err.textContent = 'Password must be 8+ characters.'; return; }

      const btn = $('#setup-go');
      btn.disabled = true; btn.textContent = 'Setting up…';

      // The magic-link token (if any) gates this POST server-side.
      // Browser-flow installs have one; CLI installs leave it empty
      // and the server's gate is then skipped (the user-empty-table
      // check still prevents anyone else from hijacking the install).
      const { status, body } = await api('/api/setup', {
        method: 'POST',
        body: JSON.stringify({
          site_name, site_url, email, password,
          setup_token: setupToken,
        }),
      });
      if (status !== 200) {
        btn.disabled = false; btn.textContent = 'Finish setup →';
        err.textContent = body?.detail || body?.error || 'Setup failed.';
        return;
      }
      showSuccess();

      // Immediately log the operator in so the onboarding wizard can
      // take over without making them retype the password they just
      // chose.
      const loginR = await api('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      btn.disabled = false; btn.textContent = 'Finish setup →';
      if (loginR.status !== 200) {
        err.textContent = 'Account created, but auto-login failed. Please sign in manually.';
        $('#setup').hidden = true;
        const g = $('#gate'); g.hidden = false;
        return;
      }
      // Hide setup, reload so the SPA boots into the wizard.
      window.location.reload();
    }

    function bindOnce() {
      if (bindOnce.done) return;
      bindOnce.done = true;
      $('#setup-form').addEventListener('submit', submit);
    }

    bindOnce();
    return { show };
  })();

  // ── onboarding wizard ──────────────────────────────────────────
  // First-login guided setup. Walks new operators through:
  //   1. Welcome + paste your site URL
  //   2. Generate + review Brand DNA
  //   3. (Optional) paste cloud-provider API keys
  //   4. Auto-plan 28-day calendar, preview it, then mark complete
  // Reuses the existing /api/admin/brand-dna, /api/admin/secrets, and
  // /api/admin/calendar/plan endpoints — the wizard is just a flow,
  // not new server-side logic.
  const Wizard = (() => {
    let brand = {};

    // Each pane has a string id. The stepper shows four milestone
    // labels (1–4); beats are interstitials that don't move the
    // stepper. The map below tells the stepper which milestone the
    // current pane belongs to.
    //   pane '0'          → none yet (welcome)
    //   pane '1'          → milestone 1 (Hello/URL form)
    //   pane '2'          → milestone 2 (Brand DNA)
    //   pane 'beat-brand' → milestone 2 done
    //   pane '3'          → milestone 3 (Providers)
    //   pane '4'          → milestone 4 (Calendar)
    //   pane 'beat-done'  → milestone 4 done
    const PANE_TO_STEP = {
      '0': 0,
      '1': 1,
      '2': 2,
      'beat-brand': 2.5,
      '3': 3,
      '4': 4,
      'beat-done': 5,
    };

    function show(paneId) {
      const id = String(paneId);
      $$('.wiz-pane').forEach((el) => { el.hidden = el.dataset.pane !== id; });
      const step = PANE_TO_STEP[id] ?? 0;
      $$('.wiz-step').forEach((el) => {
        const k = parseInt(el.dataset.step, 10);
        el.classList.toggle('is-current', k === Math.floor(step) && step % 1 === 0 && step !== 0);
        el.classList.toggle('is-done', k < step);
      });
      // Scroll the wizard card into view in case the previous step left
      // the user scrolled mid-pane.
      $('#wiz').scrollTop = 0;
    }

    function open() {
      $('#wiz').hidden = false;
      show('0');
      // Pre-populate URL with the saved brand source_url if any.
      api('/api/admin/brand-dna').then(({ status, body }) => {
        if (status === 200 && body.brand?.source_url && !$('#wiz-url').value) {
          $('#wiz-url').value = body.brand.source_url;
        }
      }).catch(() => {});
    }

    function close() { $('#wiz').hidden = true; }

    async function maybeAutoOpen() {
      try {
        const { status, body } = await api('/api/admin/onboarding');
        if (status !== 200) return;
        if (!body.complete) open();
      } catch { /* offline / first-run db not ready */ }
    }

    // ── pane 0 → 1: just navigation, no work yet ──────────────────
    function welcomeNext() { show('1'); setTimeout(() => $('#wiz-url').focus(), 50); }

    // ── pane 1 → 2: generate brand DNA from URL ───────────────────
    async function step1Next() {
      const url = $('#wiz-url').value.trim();
      const err = $('#wiz-1-err');
      err.textContent = '';
      if (!/^https?:\/\/.+/i.test(url)) { err.textContent = 'Please enter a full URL starting with https://'; return; }
      const btn = $('#wiz-go-2');
      btn.disabled = true; btn.textContent = 'Reading…';
      // Switch to pane 2 with loading state; populate fields once back.
      show('2');
      $('#wiz-brand-loading').hidden = false;
      $('#wiz-brand-fields').hidden = true;
      $('#wiz-loading-url').textContent = new URL(url).hostname;
      $('#wiz-go-3').disabled = true;
      const { status, body } = await api('/api/admin/brand-dna', {
        method: 'POST',
        body: JSON.stringify({
          url,
          service_area:     $('#wiz-service-area').value.trim(),
          topics_to_avoid:  $('#wiz-avoid').value.trim(),
        }),
      });
      btn.disabled = false; btn.textContent = 'Read my site →';
      if (status !== 200 || !body?.brand) {
        $('#wiz-brand-loading').hidden = true;
        const msg = body?.detail || body?.error || 'Generation failed.';
        $('#wiz-2-err').textContent = msg;
        show('1');
        err.textContent = msg;
        return;
      }
      brand = body.brand;
      brand.source_url = url;
      $('#wiz-b-business').value = brand.business_type || '';
      $('#wiz-b-voice').value    = brand.voice_tone || '';
      $('#wiz-b-audience').value = brand.target_audience || '';
      $('#wiz-b-themes').value   = brand.key_themes || '';
      $('#wiz-b-area').value     = brand.service_area || '';
      $('#wiz-b-avoid').value    = brand.topics_to_avoid || '';
      $('#wiz-brand-loading').hidden = true;
      $('#wiz-brand-fields').hidden = false;
      $('#wiz-go-3').disabled = false;
    }

    // ── pane 2 → beat-brand: save brand DNA ───────────────────────
    async function step2Next() {
      const errEl = $('#wiz-2-err'); errEl.textContent = '';
      const btn = $('#wiz-go-3'); btn.disabled = true; btn.textContent = 'Saving…';
      const payload = {
        business_type:    $('#wiz-b-business').value.trim(),
        voice_tone:       $('#wiz-b-voice').value.trim(),
        target_audience:  $('#wiz-b-audience').value.trim(),
        key_themes:       $('#wiz-b-themes').value.trim(),
        service_area:     $('#wiz-b-area').value.trim(),
        topics_to_avoid:  $('#wiz-b-avoid').value.trim(),
        source_url:       brand.source_url || '',
        // The wizard fires its own /calendar/plan at step 4; tell the
        // server not to also auto-plan in the background, or we'd race.
        skip_auto_plan:   true,
      };
      const { status, body } = await api('/api/admin/brand-dna', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      btn.disabled = false; btn.textContent = 'Save & continue →';
      if (status !== 200) { errEl.textContent = body?.error || 'Save failed.'; return; }

      // Customise the beat's "your site" pill with the host.
      try { $('#wiz-beat-host').textContent = new URL(brand.source_url).hostname; }
      catch { /* leave the placeholder */ }

      show('beat-brand');
    }

    // ── beat-brand → 3: load providers, render the grid ───────────
    async function gotoProviders() {
      const secretsR = await api('/api/admin/secrets');
      const keys = secretsR.body?.keys || {};
      const configured = new Set(
        Object.entries(keys).filter(([, v]) => v && v !== 'unset').map(([k]) => k)
      );
      renderProviders(configured);
      show('3');
    }

    function renderProviders(configured) {
      const grid = $('#wiz-providers');
      grid.innerHTML = '';
      const opts = [
        { label: 'OpenAI',           envKey: 'OPENAI_API_KEY' },
        { label: 'Anthropic Claude', envKey: 'ANTHROPIC_API_KEY' },
        { label: 'Google Gemini',    envKey: 'GEMINI_API_KEY' },
        { label: 'Groq',             envKey: 'GROQ_API_KEY' },
        { label: 'DeepSeek',         envKey: 'DEEPSEEK_API_KEY' },
        { label: 'Mistral',          envKey: 'MISTRAL_API_KEY' },
        { label: 'Together',         envKey: 'TOGETHER_API_KEY' },
        { label: 'Cerebras',         envKey: 'CEREBRAS_API_KEY' },
      ];
      // Workers AI banner always-on note.
      const banner = document.createElement('div');
      banner.className = 'wiz-prov is-set';
      banner.style.gridColumn = '1 / -1';
      banner.innerHTML = '<div class="wiz-prov-head"><b>Cloudflare Workers AI</b><span class="wiz-prov-pill">Built in</span></div><div class="wiz-prov-hint">Llama 3.3 70B for text · Flux 1 schnell for images. No key needed — included on the Cloudflare free tier.</div>';
      grid.appendChild(banner);

      for (const p of opts) {
        const isSet = configured.has(p.envKey);
        const card = document.createElement('div');
        card.className = 'wiz-prov' + (isSet ? ' is-set' : '');
        card.innerHTML = `
          <div class="wiz-prov-head">
            <b>${p.label}</b>
            <span class="wiz-prov-pill">${isSet ? 'Saved' : 'Optional'}</span>
          </div>
          <input type="password" placeholder="${isSet ? '••••••••  (already saved)' : 'Paste API key'}" data-prov="${p.envKey}" autocomplete="off" />
        `;
        grid.appendChild(card);
      }
    }

    // ── pane 3 → 4: persist provider keys, kick off the planner ───
    async function step3Next() {
      const errEl = $('#wiz-3-err'); errEl.textContent = '';
      const inputs = $$('[data-prov]');
      const toSave = inputs
        .map((el) => ({ key: el.dataset.prov, val: el.value.trim() }))
        .filter((p) => p.val.length > 0);
      const btn = $('#wiz-go-4'); btn.disabled = true; btn.textContent = 'Saving…';
      for (const p of toSave) {
        await api('/api/admin/secrets', {
          method: 'POST',
          body: JSON.stringify({ name: p.key, value: p.val }),
        }).catch(() => {});
      }
      btn.disabled = false; btn.textContent = 'Continue →';

      show('4');
      // Kick off the planner. We don't pass replace:true — if the
      // user re-runs the wizard later, we keep existing scheduled
      // slots and only top up gaps.
      $('#wiz-plan-loading').hidden = false;
      $('#wiz-plan-list').hidden = true;
      $('#wiz-go-done').disabled = true;
      const { status, body } = await api('/api/admin/calendar/plan', {
        method: 'POST',
        body: JSON.stringify({ days: 28, replace: false }),
      });
      $('#wiz-plan-loading').hidden = true;
      if (status !== 200) {
        $('#wiz-4-err').textContent = body?.detail || body?.error || 'Planning failed.';
        $('#wiz-go-done').disabled = false;
        return;
      }
      renderPlan(body.slots || []);
      $('#wiz-go-done').disabled = false;
    }

    function renderPlan(slots) {
      const list = $('#wiz-plan-list');
      list.innerHTML = '';
      if (!slots.length) {
        const li = document.createElement('li');
        li.innerHTML = '<span class="wiz-plan-title">No new slots needed — your calendar already has upcoming content.</span>';
        list.appendChild(li);
      } else {
        const monthsShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        for (const s of slots) {
          const li = document.createElement('li');
          const dt = new Date(s.scheduled_for + 'T00:00:00Z');
          const dateLabel = `${dt.getUTCDate()} ${monthsShort[dt.getUTCMonth()]}`;
          li.innerHTML = `<span class="wiz-plan-date">${dateLabel}</span><div class="wiz-plan-title">${escH(s.title)}${s.primary_keyword ? `<span class="wiz-plan-kw">→ ${escH(s.primary_keyword)}</span>` : ''}</div>`;
          list.appendChild(li);
        }
      }
      list.hidden = false;
    }

    function escH(s) {
      return String(s || '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' })[c]);
    }

    async function done() {
      await api('/api/admin/onboarding', { method: 'POST' }).catch(() => {});
      close();
      activateTab('calendar');
    }

    async function skip() {
      // Skipping still marks complete so we don't nag on every login.
      await api('/api/admin/onboarding', { method: 'POST' }).catch(() => {});
      close();
    }

    function bindOnce() {
      if (bindOnce.done) return;
      bindOnce.done = true;
      $('#wiz-start').addEventListener('click', welcomeNext);
      $('#wiz-go-2').addEventListener('click', step1Next);
      $('#wiz-go-3').addEventListener('click', step2Next);
      $('#wiz-go-4').addEventListener('click', step3Next);
      $('#wiz-go-done').addEventListener('click', () => show('beat-done'));
      $('#wiz-done').addEventListener('click', done);
      $('#wiz-skip').addEventListener('click', skip);

      // `data-wiz-back="<paneId>"` jumps to a previous pane without
      // re-running its work. `data-wiz-next="3"` advances from a beat
      // (no state to capture).
      $$('[data-wiz-back]').forEach((el) => {
        el.addEventListener('click', () => show(el.dataset.wizBack));
      });
      $$('[data-wiz-next]').forEach((el) => {
        const next = el.dataset.wizNext;
        if (next === '3') el.addEventListener('click', gotoProviders);
        else el.addEventListener('click', () => show(next));
      });

      // Enter on the URL field jumps forward.
      $('#wiz-url').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); step1Next(); }
      });
    }

    bindOnce();
    return { open, close, maybeAutoOpen };
  })();

  // ── updates ────────────────────────────────────────────────────
  // Shows the operator the upstream commits between what they
  // installed and the latest main. Browser installs get a one-click
  // "trigger rebuild" via the Cloudflare API; CLI installs see the
  // one-liner they need to re-run.
  const Updates = (() => {
    const PERMS = [
      { key: 'page',             type: 'edit' },
      { key: 'd1',               type: 'edit' },
      { key: 'workers_r2',       type: 'edit' },
      { key: 'ai',               type: 'edit' },
      { key: 'workers_scripts',  type: 'edit' },
      { key: 'account_settings', type: 'read' },
    ];
    const TOKEN_LINK = 'https://dash.cloudflare.com/?to=/:account/api-tokens' +
      '&permissionGroupKeys=' + encodeURIComponent(JSON.stringify(PERMS)) +
      '&name=' + encodeURIComponent('pages-seo update');

    let lastState = null;

    function esc(s) {
      return String(s || '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' })[c]);
    }
    function relativeDate(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      const dh = Math.round((Date.now() - d.getTime()) / 3600000);
      if (dh < 1) return 'just now';
      if (dh < 24) return dh + 'h ago';
      const dd = Math.round(dh / 24);
      if (dd < 30) return dd + 'd ago';
      return d.toISOString().slice(0, 10);
    }

    function render(s) {
      lastState = s;
      const summary = $('#upd-summary');
      const changesCard = $('#upd-changes-card');
      const applyCard = $('#upd-apply-card');
      const cliCard = $('#upd-cli-card');
      const badge = $('#updates-badge');

      let pill, label, value;
      if (s.up_to_date) {
        pill = '<span class="upd-pill is-current">Up to date</span>';
        label = 'You\'re running the latest commit on upstream main.';
        value = s.current ? esc(s.current.short) : 'unknown';
        badge.hidden = true;
      } else if (!s.current) {
        pill = '<span class="upd-pill is-unknown">Unknown</span>';
        label = 'We don\'t know which commit this install came from. Apply an update to set a baseline.';
        value = '—';
        badge.hidden = true;
      } else {
        pill = '<span class="upd-pill is-behind">' + s.ahead + ' commit' + (s.ahead === 1 ? '' : 's') + ' behind</span>';
        label = 'Upstream has moved on. Have a look below and update when you\'re ready.';
        value = esc(s.current.short);
        badge.hidden = false;
        badge.textContent = s.ahead;
      }
      summary.innerHTML = `
        <div class="upd-row"><span class="upd-label">Status</span>${pill}</div>
        <div class="upd-row"><span class="upd-label">Installed</span><span class="upd-value">${value}</span></div>
        <div class="upd-row"><span class="upd-label">Latest upstream</span><span class="upd-value">${esc(s.latest?.short || '—')}${s.latest?.date ? ' · ' + esc(relativeDate(s.latest.date)) : ''}</span></div>
        <div class="upd-row"><span class="upd-label">Install method</span><span class="upd-value">${esc(s.install_method || 'unknown')}</span></div>
        <div class="upd-row" style="margin-top:6px;color:var(--ink-dim);font-size:13px">${esc(label)}</div>
      `;

      if (s.commits && s.commits.length) {
        changesCard.hidden = false;
        $('#upd-changes-lede').textContent = `${s.commits.length} commit${s.commits.length === 1 ? '' : 's'} from ${s.repo?.owner || 'Benjamin-Bloch'}/${s.repo?.name || 'pages-seo'} since your install.`;
        const stats = $('#upd-diff-stats');
        if (s.files_changed) {
          stats.hidden = false;
          stats.innerHTML = `${s.files_changed} file${s.files_changed === 1 ? '' : 's'} · <span class="add">+${s.additions}</span> <span class="del">−${s.deletions}</span>`;
        } else {
          stats.hidden = true;
        }
        const list = $('#upd-commit-list');
        list.innerHTML = '';
        for (const c of s.commits) {
          const li = document.createElement('li');
          li.innerHTML = `
            <span class="upd-sha"><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.short)}</a></span>
            <span class="upd-msg">${esc(c.message)}</span>
            <span class="upd-author">${esc(c.author)} · ${esc(relativeDate(c.date))}</span>
          `;
          list.appendChild(li);
        }
      } else {
        changesCard.hidden = true;
      }

      // Show the right action card.
      if (s.can_apply) {
        applyCard.hidden = false;
        cliCard.hidden = true;
        const owner = s.repo?.owner || '';
        const repo  = s.repo?.name  || 'pages-seo';
        if (owner) {
          $('#upd-sync-link').href = `https://github.com/${owner}/${repo}`;
          $('#upd-sync-link').textContent = `${owner}/${repo}`;
        }
        $('#upd-token-link').href = TOKEN_LINK;
      } else if (s.install_method === 'cli') {
        applyCard.hidden = true;
        cliCard.hidden = false;
      } else {
        applyCard.hidden = true;
        cliCard.hidden = true;
      }
    }

    async function check() {
      const { status, body } = await api('/api/admin/update');
      if (status !== 200 || !body?.ok) {
        $('#upd-summary').innerHTML = `<div class="status bad">Couldn't reach GitHub: ${esc(body?.detail || body?.error || status)}</div>`;
        return;
      }
      render(body);
    }

    async function apply() {
      const token = $('#upd-token').value.trim();
      const status = $('#upd-apply-status');
      const btn = $('#upd-apply-go');
      if (!token) { status.className = 'status bad'; status.textContent = 'Token required.'; return; }
      btn.disabled = true;
      status.className = 'status'; status.textContent = 'Triggering rebuild…';
      const { status: code, body } = await api('/api/admin/update/apply', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      btn.disabled = false;
      if (code !== 200 || !body?.ok) {
        status.className = 'status bad';
        status.textContent = body?.detail || body?.error || ('HTTP ' + code);
        return;
      }
      status.className = 'status good';
      status.textContent = 'Rebuild kicked off. Cloudflare usually takes 1–3 minutes to publish.';
      $('#upd-token').value = '';
      // Re-check after a moment so the UI flips to "up to date".
      setTimeout(check, 3000);
    }

    function bindOnce() {
      if (bindOnce.done) return;
      bindOnce.done = true;
      $('#upd-apply-go').addEventListener('click', apply);
    }

    function init() {
      bindOnce();
      check();
    }

    // Light-weight check used by the boot path to populate the
    // header badge without rendering the full pane. We just hit the
    // GET endpoint and look at .ahead.
    async function quietCheck() {
      try {
        const { status, body } = await api('/api/admin/update');
        if (status !== 200 || !body?.ok) return;
        const badge = $('#updates-badge');
        if (!badge) return;
        if (body.ahead && body.ahead > 0) {
          badge.textContent = body.ahead;
          badge.hidden = false;
        } else {
          badge.hidden = true;
        }
      } catch { /* ignore */ }
    }

    return { init, quietCheck };
  })();

  // ── content calendar ───────────────────────────────────────────
  const Calendar = (() => {
    let current = startOfMonth(new Date());
    let slots = [];
    let loading = false;
    let editingId = null;

    function startOfMonth(d) {
      const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
      return x;
    }
    function addMonths(d, n) {
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
    }
    function isoOf(d) { return d.toISOString().slice(0, 10); }
    function todayIso() { return new Date().toISOString().slice(0, 10); }
    // Monday-first weekday index (0=Mon … 6=Sun).
    function dowMonFirst(d) { return (d.getUTCDay() + 6) % 7; }

    function fmtRange(monthStart) {
      // Show "May – June 2026" if the visible grid spans across a month.
      const monthsShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const monthsLong  = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      const start = gridStart(monthStart);
      const end = addDays(start, 41);
      const sm = start.getUTCMonth(), em = end.getUTCMonth();
      const sy = start.getUTCFullYear(), ey = end.getUTCFullYear();
      if (sy === ey && sm === em) return `${monthsLong[sm]} ${sy}`;
      const a = monthsShort[sm];
      const b = monthsShort[em];
      return sy === ey ? `${a} – ${b} ${sy}` : `${a} ${sy} – ${b} ${ey}`;
    }
    function addDays(d, n) {
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));
    }
    function gridStart(monthStart) {
      // Start the grid on the Monday on/before the 1st of the month.
      return addDays(monthStart, -dowMonFirst(monthStart));
    }

    async function load() {
      if (loading) return;
      loading = true;
      const start = gridStart(current);
      const end   = addDays(start, 41);
      const { status, body } = await api(`/api/admin/calendar?from=${isoOf(start)}&to=${isoOf(end)}`);
      loading = false;
      if (status !== 200) {
        $('#cal-grid').innerHTML = '<div class="cal-empty">Failed to load calendar.</div>';
        return;
      }
      slots = body.slots || [];
      render();
    }

    function slotsForDate(d) {
      const k = isoOf(d);
      return slots.filter((s) => s.scheduled_for === k);
    }

    function render() {
      $('#cal-range').textContent = fmtRange(current);
      const grid = $('#cal-grid');
      grid.innerHTML = '';
      const start = gridStart(current);
      const todayK = todayIso();

      for (let i = 0; i < 42; i++) {
        const day = addDays(start, i);
        const k = isoOf(day);
        const otherMonth = day.getUTCMonth() !== current.getUTCMonth();
        const isToday = k === todayK;

        const cell = document.createElement('div');
        cell.className = 'cal-cell' + (otherMonth ? ' cal-other-month' : '') + (isToday ? ' cal-today-cell' : '');

        const dayLabel = document.createElement('div');
        dayLabel.className = 'cal-day';
        const dayNum = document.createElement('span');
        const firstOfMonth = day.getUTCDate() === 1;
        const monthsShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        dayNum.textContent = firstOfMonth ? `${monthsShort[day.getUTCMonth()]} ${day.getUTCDate()}` : day.getUTCDate();
        dayLabel.appendChild(dayNum);
        if (isToday) {
          const tag = document.createElement('span');
          tag.className = 'cal-day-tag';
          tag.textContent = 'Today';
          dayLabel.appendChild(tag);
        }
        cell.appendChild(dayLabel);

        const cellSlots = slotsForDate(day);
        for (const s of cellSlots) {
          if (s.status === 'published' && s.post?.hero_image_key) {
            const img = document.createElement('img');
            img.className = 'cal-thumb';
            img.src = '/image/' + s.post.hero_image_key;
            img.alt = s.title || '';
            img.loading = 'lazy';
            cell.appendChild(img);
          }
          const slot = document.createElement('button');
          slot.type = 'button';
          slot.className = 'cal-slot cal-slot-' + s.status;
          const icon = ({
            scheduled: '📅', generating: '⟳', draft: '📝', published: '✓', skipped: '—',
          })[s.status] || '•';
          const iconEl = document.createElement('span');
          iconEl.className = 'cal-slot-icon';
          iconEl.textContent = icon;
          const titleEl = document.createElement('span');
          titleEl.className = 'cal-slot-title';
          titleEl.textContent = s.title;
          slot.appendChild(iconEl);
          slot.appendChild(titleEl);
          slot.title = (s.angle || '') + (s.primary_keyword ? `\nKeyword: ${s.primary_keyword}` : '');
          slot.addEventListener('click', () => openModal(s));
          cell.appendChild(slot);
        }
        if (!cellSlots.length && !otherMonth) {
          const add = document.createElement('button');
          add.type = 'button';
          add.className = 'cal-add';
          add.textContent = '+';
          add.title = 'Add an article for this day';
          add.addEventListener('click', () => openModal({ scheduled_for: k }));
          cell.appendChild(add);
        }

        grid.appendChild(cell);
      }
    }

    function openModal(slot) {
      editingId = slot.id || null;
      $('#cal-modal-title').textContent = editingId ? 'Edit article' : 'New article';
      $('#cal-mod-title').value = slot.title || '';
      $('#cal-mod-date').value = slot.scheduled_for || todayIso();
      $('#cal-mod-keyword').value = slot.primary_keyword || '';
      $('#cal-mod-angle').value = slot.angle || '';
      const del = $('#cal-mod-delete');
      del.hidden = !editingId || slot.status === 'published';
      const save = $('#cal-mod-save');
      const isPub = slot.status === 'published';
      save.textContent = isPub ? 'OK' : 'Save';
      $('#cal-modal').hidden = false;
      setTimeout(() => $('#cal-mod-title').focus(), 30);
    }

    function closeModal() {
      $('#cal-modal').hidden = true;
      editingId = null;
    }

    async function save() {
      const title = $('#cal-mod-title').value.trim();
      const date  = $('#cal-mod-date').value.trim();
      const keyword = $('#cal-mod-keyword').value.trim();
      const angle = $('#cal-mod-angle').value.trim();
      if (!title) { $('#cal-mod-title').focus(); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { $('#cal-mod-date').focus(); return; }

      const body = { title, scheduled_for: date, primary_keyword: keyword, angle };
      let res;
      if (editingId) {
        res = await api('/api/admin/calendar', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: editingId, ...body }),
        });
      } else {
        res = await api('/api/admin/calendar', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
      if (res.status !== 200) {
        alert(res.body?.detail || res.body?.error || 'Save failed');
        return;
      }
      closeModal();
      load();
    }

    async function del() {
      if (!editingId) return;
      if (!confirm('Delete this article slot?')) return;
      const res = await api('/api/admin/calendar?id=' + encodeURIComponent(editingId), { method: 'DELETE' });
      if (res.status !== 200) {
        alert(res.body?.detail || res.body?.error || 'Delete failed');
        return;
      }
      closeModal();
      load();
    }

    async function regenerate() {
      const replace = confirm('Replace all future scheduled articles with a fresh plan?\n\nOK = wipe and re-plan.\nCancel = append to existing (no wipe).');
      const btn = $('#cal-plan');
      const orig = btn.textContent;
      btn.disabled = true; btn.textContent = 'Planning…';
      const res = await api('/api/admin/calendar/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ days: 28, replace }),
      });
      btn.disabled = false; btn.textContent = orig;
      if (res.status !== 200) {
        if (res.body?.error === 'no_brand_dna') {
          alert('Save your Brand DNA first — the planner uses it to pick topics.');
          activateTab('brand');
          return;
        }
        alert(res.body?.detail || res.body?.error || 'Planning failed');
        return;
      }
      load();
    }

    function shiftMonth(n) { current = addMonths(current, n); load(); }
    function gotoToday() { current = startOfMonth(new Date()); load(); }

    function bindModalOnce() {
      if (bindModalOnce.done) return;
      bindModalOnce.done = true;
      $('#cal-mod-save').addEventListener('click', save);
      $('#cal-mod-delete').addEventListener('click', del);
      $('#cal-mod-cancel').addEventListener('click', closeModal);
      $('#cal-modal').addEventListener('click', (e) => { if (e.target.id === 'cal-modal') closeModal(); });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !$('#cal-modal').hidden) closeModal();
      });
    }

    function init() {
      bindModalOnce();
      load();
    }

    return { init, shiftMonth, gotoToday, regenerate, openModal, todayIso };
  })();

  // ── boot ────────────────────────────────────────────────────────
  // Bind the login form handler immediately, synchronously, before any
  // network call. That way even if whoamiStatus() is in flight when a
  // user hammers Enter on the password field, the submit is captured
  // and preventDefault'd. Earlier we attached it lazily inside
  // showGate() — which left a small window where a fast Enter press
  // would do a native form submission.
  bindLoginForm();
  (async () => {
    const r = await whoamiStatus();
    if (r.ok) { mount(); return; }
    if (r.reason === 'setup')  { Setup.show(); return; }
    if (r.reason === 'config') { showConfigError(r.missing); return; }
    showGate();
  })();
})();
