// pages-seo · admin dashboard logic.
//
// Single bundle, no framework. Auth model: paste ADMIN_TOKEN on first
// load → validated against /api/admin/whoami → stored in localStorage so
// the same machine doesn't have to re-paste. "Lock" clears it.
(() => {
  const TOKEN_KEY = 'pages-seo:admin-token';

  // ── helpers ─────────────────────────────────────────────────────
  function $(sel, root = document) { return root.querySelector(sel); }
  function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
  function setText(el, text) { if (el) el.textContent = String(text == null ? '' : text); }
  function showLog(el, text) { if (!el) return; el.hidden = false; el.textContent = String(text); }
  function appendLog(el, text) { if (!el) return; el.hidden = false; el.textContent += '\n' + String(text); el.scrollTop = el.scrollHeight; }
  function clearChildren(el) { if (el) el.replaceChildren(); }

  function token() { return localStorage.getItem(TOKEN_KEY) || ''; }
  function setToken(v) { if (v) localStorage.setItem(TOKEN_KEY, v); else localStorage.removeItem(TOKEN_KEY); }

  async function api(path, opts = {}) {
    const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
    const t = token();
    if (t) headers['Authorization'] = 'Bearer ' + t;
    const r = await fetch(path, { ...opts, headers });
    let body = null;
    try { body = await r.json(); } catch { /* not JSON */ }
    return { status: r.status, body };
  }

  // ── token gate ──────────────────────────────────────────────────
  // Returns { ok: true, info } when authenticated and configured,
  // { ok: false, reason: 'config', missing: [...] } when deployment is
  // missing required settings (SITE_NAME / SITE_URL / ADMIN_TOKEN),
  // { ok: false, reason: 'unauth' } when the stored token is wrong/missing.
  async function whoamiStatus() {
    if (!token()) {
      // Even with no token, hit whoami once so we can detect a 503 config error.
      const { status, body } = await api('/api/admin/whoami');
      if (status === 503) return { ok: false, reason: 'config', missing: body?.missing || [] };
      return { ok: false, reason: 'unauth' };
    }
    const { status, body } = await api('/api/admin/whoami');
    if (status === 200) return { ok: true, info: body };
    if (status === 503) return { ok: false, reason: 'config', missing: body?.missing || [] };
    return { ok: false, reason: 'unauth' };
  }

  function showConfigError(missing) {
    $('#gate').hidden = false;
    $('#dash').hidden = true;
    const err = $('#gate-err');
    const input = $('#gate-token');
    const go = $('#gate-go');
    input.disabled = true;
    go.disabled = true;
    err.textContent =
      'Setup is not complete. Missing: ' + (missing.join(', ') || 'unknown') +
      '. Run setup.sh / setup.py / setup.js, or push the missing secrets with `wrangler pages secret put <NAME>`, then redeploy.';
  }

  async function showGate(initial) {
    $('#gate').hidden = false;
    $('#dash').hidden = true;
    const input = $('#gate-token');
    const err = $('#gate-err');
    const go = $('#gate-go');
    input.disabled = false;
    go.disabled = false;
    input.value = '';
    err.textContent = initial?.note || '';
    input.focus();
    go.onclick = unlock;
    input.onkeydown = (e) => { if (e.key === 'Enter') unlock(); };

    async function unlock() {
      const v = input.value.trim();
      if (!v) { err.textContent = 'Token required.'; return; }
      setToken(v);
      const r = await whoamiStatus();
      if (r.ok) { mount(); return; }
      if (r.reason === 'config') { showConfigError(r.missing); return; }
      setToken(''); err.textContent = 'Invalid token.';
    }
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
    if (name === 'settings') { loadSettings(); }
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
    $$('[data-setting]').forEach((el) => {
      if (el.tagName === 'SELECT') return; // handled above
      const key = el.dataset.setting;
      el.value = body.settings?.[key] ?? '';
    });
  }

  async function saveSettings() {
    const status = $('#settings-status');
    setText(status, 'saving…');
    const payload = {};
    $$('[data-setting]').forEach((el) => {
      payload[el.dataset.setting] = (el.value || '').toString();
    });
    const r = await api('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    if (r.status === 200) {
      setText(status, `saved ${r.body?.updated?.length || 0} field(s)`);
      setTimeout(() => setText(status, ''), 2500);
    } else {
      setText(status, `error: ${r.body?.error || r.status}`);
    }
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

  // ── mount ───────────────────────────────────────────────────────
  function mount() {
    $('#gate').hidden = true;
    $('#dash').hidden = false;
    $$('.tab').forEach((t) => t.addEventListener('click', () => activateTab(t.dataset.tab)));
    $('#lock').addEventListener('click', () => { setToken(''); showGate(); });

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

    activateTab('overview');
  }

  // ── boot ────────────────────────────────────────────────────────
  (async () => {
    const r = await whoamiStatus();
    if (r.ok) { mount(); return; }
    if (r.reason === 'config') { showConfigError(r.missing); return; }
    showGate();
  })();
})();
