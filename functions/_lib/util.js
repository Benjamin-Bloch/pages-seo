// Shared helpers used across functions.

export function nowSec() { return Math.floor(Date.now() / 1000); }

// 16-byte random hex (32 chars). Used as opaque row IDs across the schema.
export function newId() {
  const buf = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// JSON Response helper with no-store cache by default.
export function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

// HTML-escape arbitrary text for safe insertion into rendered pages.
export function esc(s) {
  return String(s == null ? '' : s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

// kebab-case slugifier — keeps a-z 0-9, collapses everything else.
export function slugify(input) {
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'page-' + Date.now();
}

// Write a row to audit_log. Best-effort — caller doesn't await.
export async function audit(env, actor, action, targetId, details) {
  if (!env?.DB) return;
  try {
    await env.DB.prepare(
      `INSERT INTO audit_log (id, actor, action, target_id, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      newId(), actor || 'system', action, targetId || null,
      typeof details === 'string' ? details : JSON.stringify(details || {}),
      nowSec()
    ).run();
  } catch { /* logging never blocks the main flow */ }
}
