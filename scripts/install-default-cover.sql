-- Installs a clean, on-brand default cover template for posts that
-- don't have an AI-generated hero image. Editorial dark-card style:
-- near-black background, large serif headline, yellow accent rule,
-- small metadata footer. Renders at 1200x630 so it doubles as the
-- OG/Twitter card.
--
-- Idempotent: uses INSERT OR REPLACE keyed on a stable id.

INSERT OR REPLACE INTO cover_templates (id, name, is_default, spec_json, thumb_r2_key, created_at, updated_at)
VALUES (
  'cover-default-editorial-v1',
  'Editorial default',
  1,
  '{
    "width": 1200,
    "height": 630,
    "layers": [
      { "kind": "box",  "x": 0,    "y": 0,   "w": 1200, "h": 630, "fill": "#0a0c10" },
      { "kind": "box",  "x": 64,   "y": 64,  "w": 8,    "h": 80,  "fill": "#f5cf3e" },
      { "kind": "text", "x": 96,   "y": 64,  "w": 600,  "h": 40,
        "text": "{site_name|default:''pages-seo''|upper}",
        "size": 18, "family": "\"Inter\", sans-serif", "weight": "600", "color": "#f5cf3e" },
      { "kind": "text", "x": 96,   "y": 100, "w": 1040, "h": 60,
        "text": "{pub_date_long}",
        "size": 16, "family": "\"Inter\", sans-serif", "weight": "400", "color": "#a09c93" },
      { "kind": "text", "x": 64,   "y": 200, "w": 1072, "h": 320,
        "text": "{title}",
        "size": 72, "family": "\"Instrument Serif\", serif", "weight": "400",
        "color": "#f0eee8", "lineHeight": 1.1 },
      { "kind": "box",  "x": 64,   "y": 560, "w": 1072, "h": 1,   "fill": "#262932" },
      { "kind": "text", "x": 64,   "y": 580, "w": 600,  "h": 40,
        "text": "{reading_time}",
        "size": 14, "family": "\"Inter\", sans-serif", "weight": "500", "color": "#a09c93" }
    ]
  }',
  NULL,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

-- Make sure no other template is marked default (only one wins; the
-- query is `WHERE is_default = 1 LIMIT 1`, so duplicates are
-- harmless but wasteful).
UPDATE cover_templates SET is_default = 0 WHERE id != 'cover-default-editorial-v1';

-- Flip site setting so the renderer prefers the cover template path
-- (vs falling back to the AI-generated hero image when one exists).
INSERT OR REPLACE INTO settings (key, value, updated_at)
VALUES ('hero_image_mode', 'cover', strftime('%s', 'now'));
