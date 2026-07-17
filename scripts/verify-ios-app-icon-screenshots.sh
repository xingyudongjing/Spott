#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCREENSHOT_DIR="${SPOTT_APP_ICON_SCREENSHOT_DIR:-$ROOT_DIR/artifacts/task20/app-icon}"
MANIFEST="${SPOTT_APP_ICON_SCREENSHOT_MANIFEST:-$SCREENSHOT_DIR/installed-screenshot-manifest.json}"
RUNTIME_MATRIX="${SPOTT_APP_ICON_RUNTIME_MATRIX:-$SCREENSHOT_DIR/installed-runtime-matrix.txt}"
BUILD_PROVENANCE="${SPOTT_APP_ICON_BUILD_PROVENANCE:-$ROOT_DIR/artifacts/task20/app-icon/release-build-provenance.json}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

sha256() {
  shasum -a 256 "$1" | awk '{ print $1 }'
}

command -v jq >/dev/null 2>&1 || fail "jq is required"
command -v rg >/dev/null 2>&1 || fail "rg is required"
command -v sips >/dev/null 2>&1 || fail "sips is required"
command -v file >/dev/null 2>&1 || fail "file is required"

[[ -d "$SCREENSHOT_DIR" ]] || fail "screenshot evidence directory is missing: $SCREENSHOT_DIR"
[[ -s "$MANIFEST" ]] || fail "installed screenshot manifest is missing: $MANIFEST"
[[ -s "$RUNTIME_MATRIX" ]] || fail "installed runtime matrix is missing: $RUNTIME_MATRIX"
[[ -s "$BUILD_PROVENANCE" ]] || fail "Release build provenance is missing: $BUILD_PROVENANCE"
jq -e . "$MANIFEST" >/dev/null || fail "installed screenshot manifest is invalid JSON"

release_assets_sha="$(jq -r '.sha256.assetsCar // empty' "$BUILD_PROVENANCE")"
[[ "$release_assets_sha" =~ ^[0-9a-f]{64}$ ]] || fail "Release provenance Assets.car SHA-256 is invalid"

jq -e \
  --arg releaseSHA "$release_assets_sha" '
    .schemaVersion == 2
    and (.capturedAtUTC | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
    and .releaseAssetsCarSHA256 == $releaseSHA
    and .lockedRuntime.name == "iOS 26.5"
    and .lockedRuntime.version == "26.5"
    and .lockedRuntime.build == "23F77"
    and .lockedRuntime.identifier == "com.apple.CoreSimulator.SimRuntime.iOS-26-5"
    and (.screenshots | type == "array" and length == 12)
    and all(.screenshots[]; .runtime == "iOS 26.5" and .runtimeBuild == "23F77")
    and ((.externalBlockers // []) | length == 0)
  ' "$MANIFEST" >/dev/null || fail "manifest is not locked to iOS 26.5 build 23F77"

temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/spott-icon-screenshot-verifier.XXXXXX")"
trap 'rm -rf "$temp_dir"' EXIT
hashes="$temp_dir/hashes.txt"
: > "$hashes"

while IFS='|' read -r filename width height platform runtime mode; do
  path="$SCREENSHOT_DIR/$filename"
  [[ -s "$path" ]] || fail "missing screenshot: $filename"
  file -b "$path" | rg -q '^PNG image data' || fail "screenshot is not a PNG: $filename"

  dimensions="$(sips -g pixelWidth -g pixelHeight "$path" 2>/dev/null)"
  observed_width="$(printf '%s\n' "$dimensions" | awk '/pixelWidth:/ { print $2 }')"
  observed_height="$(printf '%s\n' "$dimensions" | awk '/pixelHeight:/ { print $2 }')"
  [[ "$observed_width" == "$width" && "$observed_height" == "$height" ]] || \
    fail "unexpected dimensions for $filename: ${observed_width}x${observed_height}, expected ${width}x${height}"

  observed_sha="$(sha256 "$path")"
  if rg -F -q "$observed_sha " "$hashes"; then
    duplicate="$(rg -F "$observed_sha " "$hashes" | awk '{ print $2 }' | head -1)"
    fail "duplicate screenshot content detected: $filename duplicates $duplicate"
  fi
  printf '%s %s\n' "$observed_sha" "$filename" >> "$hashes"

  jq -e \
    --arg filename "$filename" \
    --argjson width "$width" \
    --argjson height "$height" \
    --arg platform "$platform" \
    --arg runtime "$runtime" \
    --arg mode "$mode" \
    --arg sha "$observed_sha" '
      ([.screenshots[] | select(.file == $filename)] | length) == 1
      and any(.screenshots[];
        .file == $filename
        and .width == $width
        and .height == $height
        and .platform == $platform
        and .runtime == $runtime
        and .runtimeBuild == "23F77"
        and .mode == $mode
        and .sha256 == $sha
        and (.capture | type == "string" and length > 20)
      )
    ' "$MANIFEST" >/dev/null || fail "manifest SHA-256 mismatch for $filename"

  rg -F -q "$filename" "$RUNTIME_MATRIX" || fail "runtime matrix is missing screenshot evidence: $filename"
done <<'EOF'
iphone-ios26-default-light.png|1206|2622|iPhone|iOS 26.5|default-light
iphone-ios26-default-dark.png|1206|2622|iPhone|iOS 26.5|default-dark
iphone-ios26-tinted.png|1206|2622|iPhone|iOS 26.5|tinted
iphone-ios26-clear-light.png|1206|2622|iPhone|iOS 26.5|clear-light
iphone-ios26-clear-dark.png|1206|2622|iPhone|iOS 26.5|clear-dark
iphone-ios26-smart-invert.png|1206|2622|iPhone|iOS 26.5|smart-invert
ipad-ios26-default-light.png|1488|2266|iPad|iOS 26.5|default-light
ipad-ios26-default-dark.png|1488|2266|iPad|iOS 26.5|default-dark
ipad-ios26-tinted.png|1488|2266|iPad|iOS 26.5|tinted
ipad-ios26-clear-light.png|1488|2266|iPad|iOS 26.5|clear-light
ipad-ios26-clear-dark.png|1488|2266|iPad|iOS 26.5|clear-dark
ipad-ios26-smart-invert.png|1488|2266|iPad|iOS 26.5|smart-invert
EOF

rg -F -q "Release Assets.car SHA-256: $release_assets_sha" "$RUNTIME_MATRIX" || \
  fail "runtime matrix Release Assets.car SHA-256 does not match provenance"
rg -F -q 'Locked runtime: iOS 26.5 (23F77)' "$RUNTIME_MATRIX" || \
  fail "runtime matrix is not locked to iOS 26.5 build 23F77"
[[ "$(rg -F -c "Installed Assets.car SHA-256: $release_assets_sha" "$RUNTIME_MATRIX")" == "2" ]] || \
  fail "runtime matrix does not bind both installed acceptance rows to the fresh Release Assets.car"
rg -F -q 'PASS iPhone iOS 26.5 build 23F77' "$RUNTIME_MATRIX" || \
  fail "runtime matrix is missing the iPhone iOS 26.5 build 23F77 PASS row"
rg -F -q 'PASS iPad iOS 26.5 build 23F77' "$RUNTIME_MATRIX" || \
  fail "runtime matrix is missing the iPad iOS 26.5 build 23F77 PASS row"

pass_rows="$(rg '^PASS ' "$RUNTIME_MATRIX" || true)"
[[ "$(printf '%s\n' "$pass_rows" | awk 'NF { count += 1 } END { print count + 0 }')" == "2" ]] || \
  fail "runtime matrix contains a non-iOS 26.5 final acceptance row"
if printf '%s\n' "$pass_rows" | rg -v -q '^PASS (iPhone|iPad) iOS 26\.5 build 23F77$'; then
  fail "runtime matrix contains a non-iOS 26.5 final acceptance row"
fi

printf 'PASS: 12 installed iOS 26.5 build 23F77 AppIcon screenshots verified\n'
