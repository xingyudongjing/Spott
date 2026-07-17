#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFIER="$ROOT_DIR/scripts/verify-ios-app-icon-screenshots.sh"
BASE_DIR="$ROOT_DIR/artifacts/task20/app-icon"
BASE_MANIFEST="$BASE_DIR/installed-screenshot-manifest.json"
BASE_MATRIX="$BASE_DIR/installed-runtime-matrix.txt"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ -x "$VERIFIER" ]] || fail "screenshot verifier is missing or not executable: $VERIFIER"
[[ -s "$BASE_MANIFEST" && -s "$BASE_MATRIX" ]] || fail "baseline screenshot evidence is unavailable"

temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/spott-icon-screenshot-test.XXXXXX")"
trap 'rm -rf "$temp_dir"' EXIT
fixture="$temp_dir/evidence"
mkdir -p "$fixture"

while IFS= read -r filename; do
  ln -s "$BASE_DIR/$filename" "$fixture/$filename"
done < <(jq -r '.screenshots[].file' "$BASE_MANIFEST")
cp "$BASE_MANIFEST" "$fixture/manifest.json"
cp "$BASE_MATRIX" "$fixture/matrix.txt"

run_verifier() {
  SPOTT_APP_ICON_SCREENSHOT_DIR="$fixture" \
    SPOTT_APP_ICON_SCREENSHOT_MANIFEST="$fixture/manifest.json" \
    SPOTT_APP_ICON_RUNTIME_MATRIX="$fixture/matrix.txt" \
    "$VERIFIER"
}

expect_rejected() {
  local name="$1"
  local expected="$2"
  local output="$temp_dir/$name.output"

  if run_verifier > "$output" 2>&1; then
    fail "verifier accepted invalid screenshot fixture: $name"
  fi
  rg -F -q "$expected" "$output" || {
    sed -n '1,30p' "$output" >&2
    fail "$name rejected for the wrong reason; expected: $expected"
  }
  printf 'PASS: rejected %s\n' "$name"
}

run_verifier >/dev/null
printf 'PASS: accepted complete screenshot evidence\n'

rm "$fixture/iphone-ios26-default-light.png"
expect_rejected missing-screenshot 'missing screenshot: iphone-ios26-default-light.png'
ln -s "$BASE_DIR/iphone-ios26-default-light.png" "$fixture/iphone-ios26-default-light.png"

rm "$fixture/iphone-ios26-default-light.png"
ln -s "$BASE_DIR/ipad-ios26-default-light.png" "$fixture/iphone-ios26-default-light.png"
expect_rejected wrong-dimensions 'unexpected dimensions for iphone-ios26-default-light.png'
rm "$fixture/iphone-ios26-default-light.png"
ln -s "$BASE_DIR/iphone-ios26-default-light.png" "$fixture/iphone-ios26-default-light.png"

rm "$fixture/iphone-ios26-default-dark.png"
ln -s "$BASE_DIR/iphone-ios26-default-light.png" "$fixture/iphone-ios26-default-dark.png"
expect_rejected duplicate-screenshot 'duplicate screenshot content detected'
rm "$fixture/iphone-ios26-default-dark.png"
ln -s "$BASE_DIR/iphone-ios26-default-dark.png" "$fixture/iphone-ios26-default-dark.png"

jq '(.screenshots[] | select(.file == "iphone-ios26-tinted.png") | .sha256) = "0000000000000000000000000000000000000000000000000000000000000000"' \
  "$BASE_MANIFEST" > "$fixture/manifest.json"
expect_rejected manifest-hash-mismatch 'manifest SHA-256 mismatch for iphone-ios26-tinted.png'
cp "$BASE_MANIFEST" "$fixture/manifest.json"

jq '.lockedRuntime.build = "22A000"' "$BASE_MANIFEST" > "$fixture/manifest.json"
expect_rejected runtime-build-mismatch 'manifest is not locked to iOS 26.5 build 23F77'
cp "$BASE_MANIFEST" "$fixture/manifest.json"

cp "$BASE_MATRIX" "$fixture/matrix.txt"
printf '\nPASS iPhone iOS 18.5 fallback\n' >> "$fixture/matrix.txt"
expect_rejected old-runtime-final-row 'runtime matrix contains a non-iOS 26.5 final acceptance row'

printf 'PASS: AppIcon installed screenshot evidence fixtures verified\n'
