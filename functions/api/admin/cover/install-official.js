// POST /api/admin/cover/install-official
//
// Idempotent: creates (or refreshes) a curated "main — official"
// template owned by the maintainer's install. The spec is built
// server-side so all installs that have access to this endpoint
// land on the same canonical layout — useful for the demo site
// at seo.benjaminb.xyz where the maintainer wants a consistent
// premium look.
//
// What "official" means here:
//   - `spec.__official = true` in the saved JSON. This flag is
//     informational (anyone with admin can copy the JSON), but it
//     lets the editor render a small badge layer + show the
//     "official" pill on the template list.
//   - The template is marked is_default = 1 so new posts pick it up
//     if hero_image_mode = 'cover' (the actual render-from-template
//     wiring is still server-side TODO — see /render-server.js).
//
// Re-running this endpoint UPSERTS by name: if a template called
// "main — official" exists, its spec is replaced; otherwise a fresh
// row is inserted.

import { json, newId, nowSec, audit } from '../../../_lib/util.js';
import { adminGate } from '../../../_lib/auth.js';

const TEMPLATE_NAME = 'main — official';

// Build the spec. Premium magazine-cover aesthetic with the full
// variable set: brand name eyebrow + tagline, big serif title,
// pub date + reading time in the kicker, verified badge top-right.
// Uses {brand.primary_color} and {brand.accent_color} so the colours
// follow the user's brand settings when they're customised.
function buildOfficialSpec() {
  return {
    width: 1200,
    height: 630,
    background: null,
    __official: true,
    __version: 2,
    layers: [
      // Backdrop. {brand.primary_color} resolves at render time from
      // settings.brand_primary_color, defaulting to '#0a0c10'. The
      // spec stores a literal RGBA as a fallback so the editor's
      // canvas preview still shows something while the user hasn't
      // configured colours yet.
      { id: 'l-bg', kind: 'box', x: 0, y: 0, w: 1200, h: 630,
        fill: 'rgba(8,9,12,1)', radius: 0, locked: true, __role: 'backdrop' },

      // Top gold rule.
      { id: 'l-rule-top', kind: 'box', x: 80, y: 60, w: 200, h: 2,
        fill: '#d4af62', radius: 0, locked: true, __role: 'rule' },

      // Brand eyebrow — uppercased brand name. Eg "BENJAMINB · BLOG".
      { id: 'l-eyebrow', kind: 'text',
        x: 80, y: 80, w: 900, h: 36,
        text: '{brand.name|upper}{if brand.tagline} · {brand.tagline}{/if}',
        size: 20, family: '"JetBrains Mono", monospace',
        weight: '600', align: 'left',
        color: '#d4af62', shadow: false, lineHeight: 1.2,
        __role: 'eyebrow', locked: false,
      },

      // Big title bottom-left. {title} expands at render time.
      { id: 'l-title', kind: 'text',
        x: 80, y: 320, w: 1040, h: 220,
        text: '{title}',
        size: 76, family: '"Playfair Display", Georgia, serif',
        weight: '700', align: 'left',
        color: '#f5f0e6', shadow: false, lineHeight: 1.08,
        __role: 'title', locked: false,
      },

      // Excerpt / subtitle.
      { id: 'l-excerpt', kind: 'text',
        x: 80, y: 540, w: 760, h: 40,
        text: '{excerpt|truncate:140}',
        size: 18, family: '"Inter", sans-serif',
        weight: '400', align: 'left',
        color: 'rgba(245,240,230,0.7)', shadow: false, lineHeight: 1.4,
        __role: 'excerpt', locked: false,
      },

      // Kicker: pub date + reading time.
      { id: 'l-meta', kind: 'text',
        x: 80, y: 600, w: 760, h: 22,
        text: '{pub_date|date:long} · {reading_time}',
        size: 13, family: '"JetBrains Mono", monospace',
        weight: '500', align: 'left',
        color: 'rgba(212,175,98,0.75)', shadow: false, lineHeight: 1,
        __role: 'meta', locked: false,
      },

      // Verified badge top-right. Gold ring + dark inner + checkmark.
      { id: 'l-badge-ring', kind: 'box',
        x: 1080, y: 60, w: 60, h: 60,
        fill: '#d4af62', radius: 999,
        __role: 'badge-ring', locked: true,
      },
      { id: 'l-badge-inner', kind: 'box',
        x: 1086, y: 66, w: 48, h: 48,
        fill: '#0a0c10', radius: 999,
        __role: 'badge-inner', locked: true,
      },
      { id: 'l-badge-check', kind: 'text',
        x: 1080, y: 78, w: 60, h: 40,
        text: '✓',
        size: 30, family: '"Inter", sans-serif',
        weight: '800', align: 'center',
        color: '#d4af62', shadow: false, lineHeight: 1,
        __role: 'badge-check', locked: true,
      },

      // Footer signature on the right — verified · domain.
      { id: 'l-sig', kind: 'text',
        x: 880, y: 600, w: 240, h: 22,
        text: 'verified · {brand.domain}',
        size: 12, family: '"JetBrains Mono", monospace',
        weight: '500', align: 'right',
        color: 'rgba(212,175,98,0.7)', shadow: false, lineHeight: 1,
        __role: 'sig', locked: true,
      },
    ],
  };
}

export const onRequestPost = async ({ env, request }) => {
  const gate = await adminGate(env, request); if (gate) return gate;
  const spec = buildOfficialSpec();
  const spec_json = JSON.stringify(spec);
  const t = nowSec();

  // Upsert by name.
  const existing = await env.DB.prepare(
    'SELECT id FROM cover_templates WHERE name = ? LIMIT 1'
  ).bind(TEMPLATE_NAME).first();

  let id;
  if (existing?.id) {
    id = existing.id;
    // Demote any other default if we're about to install this one.
    await env.DB.prepare(
      'UPDATE cover_templates SET is_default = 0 WHERE is_default = 1 AND id != ?'
    ).bind(id).run();
    await env.DB.prepare(
      `UPDATE cover_templates SET spec_json = ?, is_default = 1, updated_at = ? WHERE id = ?`
    ).bind(spec_json, t, id).run();
  } else {
    id = newId();
    await env.DB.prepare(
      'UPDATE cover_templates SET is_default = 0 WHERE is_default = 1'
    ).run();
    await env.DB.prepare(
      `INSERT INTO cover_templates (id, name, is_default, spec_json, thumb_r2_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, TEMPLATE_NAME, 1, spec_json, null, t, t).run();
  }

  audit(env, 'admin', 'cover_install_official', id, { name: TEMPLATE_NAME });

  return json(200, {
    ok: true,
    id,
    name: TEMPLATE_NAME,
    action: existing ? 'updated' : 'created',
  });
};
