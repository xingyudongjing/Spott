#!/bin/bash

set -euo pipefail

BUILT_APP="${1:-}"
BUILD_LOG="${2:-}"
ICON_SOURCE="${3:-}"
DERIVED_DATA="${4:-}"
STARTED_AT="${5:-}"
COMPLETED_AT="${6:-}"
OUTPUT="${7:-}"

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

[[ -n "$BUILT_APP" && -d "$BUILT_APP" ]] || fail "built app is required"
[[ -n "$BUILD_LOG" && -f "$BUILD_LOG" ]] || fail "build log is required"
[[ -n "$ICON_SOURCE" && -d "$ICON_SOURCE" ]] || fail "Icon Composer source is required"
[[ -n "$DERIVED_DATA" && -d "$DERIVED_DATA" ]] || fail "DerivedData directory is required"
[[ "$STARTED_AT" =~ ^[0-9]+$ && "$COMPLETED_AT" =~ ^[0-9]+$ ]] || \
  fail "build start/completion epochs must be unsigned integers"
[[ "$STARTED_AT" -le "$COMPLETED_AT" ]] || fail "build start is after completion"
[[ $((COMPLETED_AT - STARTED_AT)) -le 7200 ]] || fail "build provenance window exceeds two hours"
[[ -n "$OUTPUT" ]] || fail "output path is required"

assets_car="$BUILT_APP/Assets.car"
info_plist="$BUILT_APP/Info.plist"
[[ -f "$assets_car" ]] || fail "built Assets.car is missing"
[[ -f "$info_plist" ]] || fail "built Info.plist is missing"
executable_name="$(plutil -extract CFBundleExecutable raw "$info_plist")"
executable="$BUILT_APP/$executable_name"
[[ -f "$executable" ]] || fail "built executable is missing"

log_mtime="$(stat -f %m "$BUILD_LOG")"
assets_mtime="$(stat -f %m "$assets_car")"
executable_mtime="$(stat -f %m "$executable")"
info_mtime="$(stat -f %m "$info_plist")"
app_mtime="$(stat -f %m "$BUILT_APP")"

for observed in "$log_mtime" "$assets_mtime" "$executable_mtime" "$info_mtime" "$app_mtime"; do
  [[ "$observed" -ge "$STARTED_AT" && "$observed" -le "$COMPLETED_AT" ]] || \
    fail "built product timestamp is outside the declared build window"
done

mkdir -p "$(dirname "$OUTPUT")"
jq -n \
  --argjson schemaVersion 1 \
  --arg configuration Release \
  --arg sdk iphonesimulator \
  --argjson started "$STARTED_AT" \
  --argjson completed "$COMPLETED_AT" \
  --arg derivedData "$(canonical_path "$DERIVED_DATA")" \
  --arg builtApp "$(canonical_path "$BUILT_APP")" \
  --arg assetsCar "$(canonical_path "$assets_car")" \
  --arg executable "$(canonical_path "$executable")" \
  --arg infoPlist "$(canonical_path "$info_plist")" \
  --arg buildLog "$(canonical_path "$BUILD_LOG")" \
  --arg iconSource "$(canonical_path "$ICON_SOURCE")" \
  --arg logSHA "$(sha256 "$BUILD_LOG")" \
  --arg assetsSHA "$(sha256 "$assets_car")" \
  --arg executableSHA "$(sha256 "$executable")" \
  --arg infoSHA "$(sha256 "$info_plist")" \
  --argjson logMTime "$log_mtime" \
  --argjson assetsMTime "$assets_mtime" \
  --argjson executableMTime "$executable_mtime" \
  --argjson infoMTime "$info_mtime" \
  --argjson appMTime "$app_mtime" \
  '{
    schemaVersion: $schemaVersion,
    build: {
      configuration: $configuration,
      sdk: $sdk,
      startedAtEpochSeconds: $started,
      completedAtEpochSeconds: $completed
    },
    paths: {
      derivedData: $derivedData,
      builtApp: $builtApp,
      assetsCar: $assetsCar,
      executable: $executable,
      infoPlist: $infoPlist,
      buildLog: $buildLog,
      iconSource: $iconSource
    },
    sha256: {
      buildLog: $logSHA,
      assetsCar: $assetsSHA,
      executable: $executableSHA,
      infoPlist: $infoSHA
    },
    mtimeEpochSeconds: {
      buildLog: $logMTime,
      assetsCar: $assetsMTime,
      executable: $executableMTime,
      infoPlist: $infoMTime,
      builtApp: $appMTime
    }
  }' > "$OUTPUT"

printf 'WROTE: %s\n' "$OUTPUT"
