#!/usr/bin/env bash
# Regenerates public/icon/{16,32,48,96,128}.png from the SVG sources in icons/.
#
# Usage:
#   scripts/generate-icons.sh
#
# Each source is drawn for the sizes it feeds: icon-16.svg is pixel-aligned for
# 16px.
#
#   icons/icon-16.svg -> 16.png
#   icons/icon.svg    -> 32.png, 48.png, 96.png, 128.png
#
# Rendering goes through rsvg-convert (librsvg) rather than ImageMagick: a
# 'magick' built without librsvg silently falls back to its internal MSVG coder,
# which drops every `fill="none"` stroked path — i.e. the whole glyph — and
# still exits 0.
set -euo pipefail

cd "$(dirname "$0")/.."

# "<source>:<size>[,<size>...]"
sources=(
	"icons/icon-16.svg:16"
	"icons/icon.svg:32,48,96,128"
)

if ! command -v rsvg-convert >/dev/null 2>&1; then
	echo "error: rsvg-convert is not installed (apt install librsvg2-bin)" >&2
	exit 1
fi

for entry in "${sources[@]}"; do
	source_image="${entry%%:*}"
	if [[ ! -f "$source_image" ]]; then
		echo "error: source image '$source_image' not found" >&2
		exit 1
	fi
done

mkdir -p public/icon

generated=()

for entry in "${sources[@]}"; do
	source_image="${entry%%:*}"
	IFS=',' read -ra sizes <<<"${entry#*:}"

	for size in "${sizes[@]}"; do
		# Rasterize straight at the target resolution, no downsampling pass, so
		# the 16px source stays pixel-aligned.
		rsvg-convert -w "$size" -h "$size" \
			-o "public/icon/${size}.png" "$source_image"
		generated+=("${size}.png")
	done
done

echo "Generated public/icon/{$(
	IFS=,
	echo "${generated[*]}"
)}"
