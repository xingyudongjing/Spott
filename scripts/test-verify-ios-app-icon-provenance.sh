#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFIER="$ROOT_DIR/scripts/verify-ios-app-icon.sh"
ICON_DIR="$ROOT_DIR/Spott/AppIcon.icon"
BASE_LOG="${SPOTT_APP_ICON_BUILD_LOG:-$ROOT_DIR/artifacts/task20/app-icon/release-build.log}"
ASSETUTIL_EVIDENCE="${SPOTT_APP_ICON_ASSETUTIL_JSON:-$ROOT_DIR/artifacts/task20/app-icon/assetutil.json}"
BUILT_APP="${1:-/private/tmp/spott-task20-icon-derived/Build/Products/Release-iphonesimulator/Spott.app}"
DERIVED_DATA="${BUILT_APP%/Build/Products/Release-iphonesimulator/Spott.app}"

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

write_fixture_provenance() {
  local build_log="$1"
  local output="$2"
  local app_real assets_real executable_name executable_real info_real log_real icon_real derived_real
  local log_mtime assets_mtime executable_mtime info_mtime app_mtime earliest latest started completed

  app_real="$(canonical_path "$BUILT_APP")"
  assets_real="$(canonical_path "$BUILT_APP/Assets.car")"
  executable_name="$(plutil -extract CFBundleExecutable raw "$BUILT_APP/Info.plist")"
  executable_real="$(canonical_path "$BUILT_APP/$executable_name")"
  info_real="$(canonical_path "$BUILT_APP/Info.plist")"
  log_real="$(canonical_path "$build_log")"
  icon_real="$(canonical_path "$ICON_DIR")"
  derived_real="$(canonical_path "$DERIVED_DATA")"
  log_mtime="$(stat -f %m "$build_log")"
  assets_mtime="$(stat -f %m "$BUILT_APP/Assets.car")"
  executable_mtime="$(stat -f %m "$BUILT_APP/$executable_name")"
  info_mtime="$(stat -f %m "$BUILT_APP/Info.plist")"
  app_mtime="$(stat -f %m "$BUILT_APP")"
  earliest="$(printf '%s\n' "$log_mtime" "$assets_mtime" "$executable_mtime" "$info_mtime" "$app_mtime" | sort -n | head -1)"
  latest="$(printf '%s\n' "$log_mtime" "$assets_mtime" "$executable_mtime" "$info_mtime" "$app_mtime" | sort -n | tail -1)"
  started="$((earliest - 600))"
  completed="$latest"

  jq -n \
    --argjson schemaVersion 1 \
    --arg configuration Release \
    --arg sdk iphonesimulator \
    --argjson started "$started" \
    --argjson completed "$completed" \
    --arg derivedData "$derived_real" \
    --arg builtApp "$app_real" \
    --arg assetsCar "$assets_real" \
    --arg executable "$executable_real" \
    --arg infoPlist "$info_real" \
    --arg buildLog "$log_real" \
    --arg iconSource "$icon_real" \
    --arg logSHA "$(sha256 "$build_log")" \
    --arg assetsSHA "$(sha256 "$BUILT_APP/Assets.car")" \
    --arg executableSHA "$(sha256 "$BUILT_APP/$executable_name")" \
    --arg infoSHA "$(sha256 "$BUILT_APP/Info.plist")" \
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
    }' > "$output"
}

[[ -x "$VERIFIER" ]] || fail "verifier is not executable: $VERIFIER"
[[ -s "$BASE_LOG" ]] || fail "baseline Release log is unavailable: $BASE_LOG"
[[ -d "$BUILT_APP" && -f "$BUILT_APP/Assets.car" ]] || fail "baseline built app is unavailable: $BUILT_APP"
[[ -s "$ASSETUTIL_EVIDENCE" ]] || fail "baseline assetutil evidence is unavailable: $ASSETUTIL_EVIDENCE"

temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/spott-icon-provenance-test.XXXXXX")"
trap 'rm -rf "$temp_dir"' EXIT

zero_log="$temp_dir/zero.log"
missing_success_log="$temp_dir/missing-success.log"
missing_compile_log="$temp_dir/missing-compile.log"
mismatched_path_log="$temp_dir/mismatched-path.log"
valid_log="$temp_dir/valid.log"

: > "$zero_log"
sed '/^\*\* BUILD SUCCEEDED \*\*$/d' "$BASE_LOG" > "$missing_success_log"
sed '/AppIcon\.icon/d' "$BASE_LOG" > "$missing_compile_log"
sed \
  -e 's#/private/tmp/spott-task20-icon-derived#/private/tmp/spott-wrong-derived#g' \
  -e 's#/tmp/spott-task20-icon-derived#/tmp/spott-wrong-derived#g' \
  "$BASE_LOG" > "$mismatched_path_log"
cp "$BASE_LOG" "$valid_log"

for log in "$zero_log" "$missing_success_log" "$missing_compile_log" "$mismatched_path_log" "$valid_log"; do
  touch -r "$BASE_LOG" "$log"
  write_fixture_provenance "$log" "$log.provenance.json"
done

cp "$valid_log.provenance.json" "$temp_dir/bad-assets-hash.provenance.json"
jq '.sha256.assetsCar = "0000000000000000000000000000000000000000000000000000000000000000"' \
  "$temp_dir/bad-assets-hash.provenance.json" > "$temp_dir/bad-assets-hash.tmp.json"
mv "$temp_dir/bad-assets-hash.tmp.json" "$temp_dir/bad-assets-hash.provenance.json"

failures=0

expect_rejected() {
  local name="$1"
  local log="$2"
  local provenance="$3"
  local expected="$4"
  local output="$temp_dir/$name.output"

  if SPOTT_APP_ICON_BUILD_LOG="$log" \
    SPOTT_APP_ICON_ASSETUTIL_JSON="$ASSETUTIL_EVIDENCE" \
    SPOTT_APP_ICON_BUILD_PROVENANCE="$provenance" \
    "$VERIFIER" "$BUILT_APP" > "$output" 2>&1; then
    printf 'FAIL: verifier accepted invalid provenance fixture: %s\n' "$name" >&2
    failures=$((failures + 1))
    return
  fi
  if ! rg -F -q "$expected" "$output"; then
    printf 'FAIL: %s rejected for the wrong reason; expected %s\n' "$name" "$expected" >&2
    sed -n '1,20p' "$output" >&2
    failures=$((failures + 1))
    return
  fi
  printf 'PASS: rejected %s\n' "$name"
}

expect_rejected zero-byte "$zero_log" "$zero_log.provenance.json" \
  'release build log is empty'
expect_rejected missing-build-succeeded "$missing_success_log" "$missing_success_log.provenance.json" \
  'release build log does not end in ** BUILD SUCCEEDED **'
expect_rejected missing-appicon-compile "$missing_compile_log" "$missing_compile_log.provenance.json" \
  'release build log does not prove CompileAssetCatalogVariant used AppIcon.icon for the built app'
expect_rejected mismatched-built-app "$mismatched_path_log" "$mismatched_path_log.provenance.json" \
  'release build log does not prove CompileAssetCatalogVariant used AppIcon.icon for the built app'
expect_rejected mismatched-assets-hash "$valid_log" "$temp_dir/bad-assets-hash.provenance.json" \
  'build provenance Assets.car SHA-256 does not match the built app'

valid_output="$temp_dir/valid.output"
if ! SPOTT_APP_ICON_BUILD_LOG="$valid_log" \
  SPOTT_APP_ICON_ASSETUTIL_JSON="$ASSETUTIL_EVIDENCE" \
  SPOTT_APP_ICON_BUILD_PROVENANCE="$valid_log.provenance.json" \
  "$VERIFIER" "$BUILT_APP" > "$valid_output" 2>&1; then
  printf 'FAIL: verifier rejected the valid build provenance fixture\n' >&2
  sed -n '1,30p' "$valid_output" >&2
  failures=$((failures + 1))
else
  printf 'PASS: accepted valid build provenance fixture\n'
fi

[[ "$failures" -eq 0 ]] || fail "$failures provenance verifier assertions failed"
printf 'PASS: AppIcon build-log provenance fixtures verified\n'
