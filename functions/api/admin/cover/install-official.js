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

// Build the spec. Premium magazine-cover aesthetic: black background,
// big serif title bottom-left, a thin gold rule, a brand mark + verified
// badge top-right.
function buildOfficialSpec() {
  return {
    width: 1200,
    height: 630,
    background: null, // solid colour via the dark backdrop layer below
    __official: true,
    __version: 1,
    layers: [
      // Solid black backdrop. We use a box layer rather than the
      // canvas background so the spec is self-contained (no R2 asset
      // dependency).
      { id: 'l-bg',     kind: 'box',  x: 0,   y: 0,   w: 1200, h: 630,
        fill: 'rgba(8,9,12,1)', radius: 0, locked: true, __role: 'backdrop' },

      // Top gold rule.
      { id: 'l-rule-top', kind: 'box', x: 80, y: 60, w: 200, h: 2,
        fill: 'rgba(212,175,98,1)', radius: 0, locked: true, __role: 'rule' },

      // Brand eyebrow above the title.
      { id: 'l-eyebrow', kind: 'text',
        x: 80, y: 80, w: 700, h: 36,
        text: '{brand.name|upper}',
        size: 18, family: '"JetBrains Mono", monospace',
        weight: '500', align: 'left',
        color: '#d4af62', shadow: false, lineHeight: 1.2,
        __role: 'eyebrow', locked: false,
      },

      // Big title bottom-left. {title} expands at render time.
      { id: 'l-title', kind: 'text',
        x: 80, y: 360, w: 1040, h: 200,
        text: '{title}',
        size: 76, family: '"Playfair Display", Georgia, serif',
        weight: '700', align: 'left',
        color: '#f5f0e6', shadow: false, lineHeight: 1.08,
        __role: 'title', locked: false,
      },

      // Date / kicker.
      { id: 'l-date', kind: 'text',
        x: 80, y: 560, w: 600, h: 32,
        text: '{date|date:long}',
        size: 16, family: '"JetBrains Mono", monospace',
        weight: '400', align: 'left',
        color: 'rgba(245,240,230,0.55)', shadow: false, lineHeight: 1.2,
        __role: 'date', locked: false,
      },

      // Verified badge top-right. Gold ring + checkmark drawn as
      // overlapping primitives so we don't need an external asset.
      // Three layers stacked:
      //   1. outer ring (box, circular via radius=999)
      //   2. inner fill
      //   3. the check text glyph
      { id: 'l-badge-ring', kind: 'box',
        x: 1080, y: 60, w: 60, h: 60,
        fill: 'rgba(212,175,98,1)', radius: 999,
        __role: 'badge-ring', locked: true,
      },
      { id: 'l-badge-inner', kind: 'box',
        x: 1086, y: 66, w: 48, h: 48,
        fill: 'rgba(8,9,12,1)', radius: 999,
        __role: 'badge-inner', locked: true,
      },
      { id: 'l-badge-check', kind: 'text',
        x: 1080, y: 73, w: 60, h: 40,
        text: '✓',
        size: 32, family: '"Inter", sans-serif',
        weight: '700', align: 'center',
        color: '#d4af62', shadow: false, lineHeight: 1,
        __role: 'badge-check', locked: true,
      },

      // Footer signature.
      { id: 'l-sig', kind: 'text',
        x: 1080, y: 568, w: 100, h: 24,
        text: 'verified',
        size: 11, family: '"JetBrains Mono", monospace',
        weight: '500', align: 'right',
        color: 'rgba(212,175,98,0.65)', shadow: false, lineHeight: 1,
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
