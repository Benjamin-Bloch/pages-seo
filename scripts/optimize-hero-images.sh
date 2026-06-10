#!/usr/bin/env bash
# Recompress AI-generated hero PNGs in R2 to WebP (~97% smaller) and
# repoint blog_posts at the new keys. Old PNGs are left in place so
# any cached HTML keeps working.
#
# Requirements: wrangler (authenticated), cwebp (brew install webp),
# python3. Run from the repo root. Reads the bucket + database names
# from wrangler.toml.
#
# Usage: bash scripts/optimize-hero-images.sh [quality]   (default 82)
set -euo pipefail
cd "$(dirname "$0")/.."

QUALITY="${1:-82}"
BUCKET=$(awk -F\" '/^bucket_name *=/{print $2; exit}' wrangler.toml)
DB=$(awk -F\" '/^database_name *=/{print $2; exit}' wrangler.toml)
[[ -n "$BUCKET" && -n "$DB" ]] || { echo "could not read bucket/database from wrangler.toml" >&2; exit 1; }
command -v cwebp >/dev/null || { echo "cwebp not found — brew install webp" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "▸ Listing PNG heroes in $DB"
wrangler d1 execute "$DB" --remote --json \
  --command "SELECT id, hero_image_key FROM blog_posts WHERE hero_image_key LIKE '%.png'" \
  > "$WORK/rows.json"

python3 - "$WORK" "$BUCKET" "$DB" "$QUALITY" <<'EOF'
import json, subprocess, os, sys
work, bucket, db, q = sys.argv[1:5]
rows = json.load(open(f"{work}/rows.json"))[0]["results"]
print(f"{len(rows)} images to optimize")
for r in rows:
    key, newkey = r["hero_image_key"], r["hero_image_key"][:-4] + ".webp"
    png, webp = f"{work}/in.png", f"{work}/out.webp"
    subprocess.run(["wrangler", "r2", "object", "get", f"{bucket}/{key}", f"--file={png}", "--remote"],
                   check=True, capture_output=True)
    subprocess.run(["cwebp", "-quiet", "-q", q, png, "-o", webp], check=True)
    subprocess.run(["wrangler", "r2", "object", "put", f"{bucket}/{newkey}", f"--file={webp}",
                    "--content-type=image/webp",
                    "--cache-control=public, max-age=31536000, immutable", "--remote"],
                   check=True, capture_output=True)
    subprocess.run(["wrangler", "d1", "execute", db, "--remote", "--command",
                    f"UPDATE blog_posts SET hero_image_key='{newkey}' WHERE id='{r['id']}'"],
                   check=True, capture_output=True)
    print(f"  {key}: {os.path.getsize(png)//1024}KB -> {os.path.getsize(webp)//1024}KB")
print("done")
EOF
