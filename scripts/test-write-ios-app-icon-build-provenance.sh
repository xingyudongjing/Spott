#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRITER="$ROOT_DIR/scripts/write-ios-app-icon-build-provenance.sh"
BUILD_LOG="${SPOTT_APP_ICON_BUILD_LOG:-$ROOT_DIR/artifacts/task20/app-icon/release-build.log}"
BUILT_APP="${1:-/private/tmp/spott-task20-icon-derived/Build/Products/Release-iphonesimulator/Spott.app}"
DERIVED_DATA="${BUILT_APP%/Build/Products/Release-iphonesimulator/Spott.app}"
ICON_DIR="$ROOT_DIR/Spott/AppIcon.icon"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

canonical_path() {
  local path="$1"
  local directory
  directory="$(cd "$(dirname "$path")" && pwd -P)"
  printf '%s/%s\n' "$directory" "$(basename "$path")"
}

sha256() {
  shasum -a 256 "$1" | awk '{ print $1 }'
}

[[ -x "$WRITER" ]] || fail "build provenance writer is missing or not executable: $WRITER"
[[ -s "$BUILD_LOG" && -f "$BUILT_APP/Assets.car" ]] || fail "baseline build evidence is unavailable"

temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/spott-icon-provenance-writer-test.XXXXXX")"
trap 'rm -rf "$temp_dir"' EXIT
output="$temp_dir/provenance.json"

log_mtime="$(stat -f %m "$BUILD_LOG")"
assets_mtime="$(stat -f %m "$BUILT_APP/Assets.car")"
app_mtime="$(stat -f %m "$BUILT_APP")"
executable_name="$(plutil -extract CFBundleExecutable raw "$BUILT_APP/Info.plist")"
executable_mtime="$(stat -f %m "$BUILT_APP/$executable_name")"
info_mtime="$(stat -f %m "$BUILT_APP/Info.plist")"
earliest="$(printf '%s\n' "$log_mtime" "$assets_mtime" "$app_mtime" "$executable_mtime" "$info_mtime" | sort -n | head -1)"
latest="$(printf '%s\n' "$log_mtime" "$assets_mtime" "$app_mtime" "$executable_mtime" "$info_mtime" | sort -n | tail -1)"
started="$((earliest - 1))"
completed="$latest"

"$WRITER" \
  "$BUILT_APP" \
  "$BUILD_LOG" \
  "$ICON_DIR" \
  "$DERIVED_DATA" \
  "$started" \
  "$completed" \
  "$output"

[[ -s "$output" ]] || fail "writer did not create provenance JSON"
jq -e \
  --arg app "$(canonical_path "$BUILT_APP")" \
  --arg log "$(canonical_path "$BUILD_LOG")" \
  --arg icon "$(canonical_path "$ICON_DIR")" \
  --arg assetsSHA "$(sha256 "$BUILT_APP/Assets.car")" \
  --arg logSHA "$(sha256 "$BUILD_LOG")" '
    .schemaVersion == 1
    and .build.configuration == "Release"
    and .build.sdk == "iphonesimulator"
    and .paths.builtApp == $app
    and .paths.buildLog == $log
    and .paths.iconSource == $icon
    and .sha256.assetsCar == $assetsSHA
    and .sha256.buildLog == $logSHA
    and (.mtimeEpochSeconds.assetsCar | type == "number")
    and (.mtimeEpochSeconds.buildLog | type == "number")
  ' "$output" >/dev/null || fail "writer provenance content is incomplete or incorrect"

printf 'PASS: AppIcon Release provenance writer verified\n'
