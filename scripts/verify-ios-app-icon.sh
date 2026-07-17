#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ICON_DIR="$ROOT_DIR/Spott/AppIcon.icon"
ICON_JSON="$ICON_DIR/icon.json"
PROJECT_FILE="$ROOT_DIR/Spott.xcodeproj/project.pbxproj"
LEGACY_ICON_SET="$ROOT_DIR/Spott/Assets.xcassets/AppIcon.appiconset"
BUILD_LOG="${SPOTT_APP_ICON_BUILD_LOG:-$ROOT_DIR/artifacts/task20/app-icon/release-build.log}"
ASSETUTIL_EVIDENCE="${SPOTT_APP_ICON_ASSETUTIL_JSON:-$ROOT_DIR/artifacts/task20/app-icon/assetutil.json}"
BUILD_PROVENANCE="${SPOTT_APP_ICON_BUILD_PROVENANCE:-$ROOT_DIR/artifacts/task20/app-icon/release-build-provenance.json}"
BUILT_APP="${1:-}"

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

command -v jq >/dev/null 2>&1 || fail "jq is required"
command -v xcrun >/dev/null 2>&1 || fail "xcrun is required"
command -v plutil >/dev/null 2>&1 || fail "plutil is required"

[[ -d "$ICON_DIR" && -f "$ICON_JSON" && -d "$ICON_DIR/Assets" ]] || \
  fail "missing multi-layer Spott/AppIcon.icon"

jq -e . "$ICON_JSON" >/dev/null || fail "Spott/AppIcon.icon/icon.json is invalid JSON"

for layer in background.svg orbit.svg spott-s.svg; do
  jq -e --arg layer "$layer" \
    '[.groups[]?.layers[]?["image-name"]] | index($layer) != null' \
    "$ICON_JSON" >/dev/null || fail "missing required Icon Composer layer: $layer"
  [[ -f "$ICON_DIR/Assets/$layer" ]] || fail "missing Icon Composer asset: Assets/$layer"
  [[ -f "$ROOT_DIR/docs/design/brand/app-icon-layers/$layer" ]] || \
    fail "missing editable brand source: docs/design/brand/app-icon-layers/$layer"
  cmp -s "$ICON_DIR/Assets/$layer" "$ROOT_DIR/docs/design/brand/app-icon-layers/$layer" || \
    fail "Icon Composer asset diverges from editable brand source: $layer"
done

layer_count="$(jq '[.groups[]?.layers[]?] | length' "$ICON_JSON")"
group_count="$(jq '[.groups[]?] | length' "$ICON_JSON")"
[[ "$layer_count" -ge 3 && "$group_count" -ge 3 ]] || \
  fail "AppIcon.icon must contain at least three independently composited groups/layers"

jq -e '
  [
    .groups[]?.layers[]?
    | (.["fill-specializations"] // [])[]?
    | .appearance // "default"
  ] as $appearances
  | ($appearances | index("dark") != null)
    and ($appearances | index("tinted") != null)
' "$ICON_JSON" >/dev/null || fail "AppIcon.icon must explicitly annotate Dark and Mono/tinted appearances"

temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/spott-app-icon-verifier.XXXXXX")"
trap 'rm -rf "$temp_dir"' EXIT
project_json="$temp_dir/project.json"
plutil -convert json -o "$project_json" "$PROJECT_FILE"

for configuration in Debug Release; do
  jq -e --arg configuration "$configuration" '
    any(.objects[];
      .isa? == "XCBuildConfiguration"
      and .name? == $configuration
      and .buildSettings.PRODUCT_BUNDLE_IDENTIFIER? == "com.yaokai.Spott"
      and .buildSettings.ASSETCATALOG_COMPILER_APPICON_NAME? == "AppIcon"
    )
  ' "$project_json" >/dev/null || \
    fail "ASSETCATALOG_COMPILER_APPICON_NAME is not AppIcon for $configuration"
done

jq -e '
  .objects as $objects
  | first(
      $objects | to_entries[]
      | select(.value.isa? == "PBXNativeTarget" and .value.name? == "Spott")
      | .value.fileSystemSynchronizedGroups[]?
    ) as $group_id
  | ($objects[$group_id].path? == "Spott")
    and all(
      $objects[$group_id].exceptions[]?;
      (($objects[.]?.membershipExceptions // []) | index("AppIcon.icon") == null)
    )
' "$project_json" >/dev/null || \
  fail "Spott/AppIcon.icon is not included in the synchronized Spott target"

[[ ! -d "$LEGACY_ICON_SET" ]] || \
  fail "legacy AppIcon.appiconset remains selected by the synchronized target"

[[ -n "$BUILT_APP" ]] || fail "built app path is required after source verification"
[[ -d "$BUILT_APP" ]] || fail "built app does not exist: $BUILT_APP"
[[ -f "$BUILT_APP/Assets.car" ]] || fail "built Assets.car is missing"
[[ -f "$BUILD_LOG" ]] || fail "release build log is missing: $BUILD_LOG"
[[ -f "$ASSETUTIL_EVIDENCE" ]] || fail "assetutil evidence is missing: $ASSETUTIL_EVIDENCE"
[[ -f "$BUILD_PROVENANCE" ]] || fail "release build provenance is missing: $BUILD_PROVENANCE"
[[ -s "$BUILD_LOG" ]] || fail "release build log is empty"
[[ -s "$BUILD_PROVENANCE" ]] || fail "release build provenance is empty"

last_build_log_line="$(awk 'NF { line = $0 } END { print line }' "$BUILD_LOG")"
[[ "$last_build_log_line" == "** BUILD SUCCEEDED **" ]] || \
  fail "release build log does not end in ** BUILD SUCCEEDED **"

built_app_real="$(canonical_path "$BUILT_APP")"
icon_dir_real="$(canonical_path "$ICON_DIR")"
assets_car_real="$(canonical_path "$BUILT_APP/Assets.car")"
build_log_real="$(canonical_path "$BUILD_LOG")"
build_provenance_real="$(canonical_path "$BUILD_PROVENANCE")"
product_suffix="/Build/Products/Release-iphonesimulator/Spott.app"
[[ "$built_app_real" == *"$product_suffix" ]] || \
  fail "built app is not a Release-iphonesimulator Spott.app product"
derived_data_real="${built_app_real%$product_suffix}"
built_app_log_alias="$built_app_real"
if [[ "$built_app_log_alias" == /private/tmp/* ]]; then
  built_app_log_alias="/tmp/${built_app_log_alias#/private/tmp/}"
fi

awk -v app="$built_app_real" -v alias="$built_app_log_alias" -v icon="$icon_dir_real" '
  index($0, "CompileAssetCatalogVariant ") == 1 && (index($0, app) || index($0, alias)) && index($0, icon) { found = 1 }
  END { exit(found ? 0 : 1) }
' "$BUILD_LOG" || \
  fail "release build log does not prove CompileAssetCatalogVariant used AppIcon.icon for the built app"

awk -v icon="$icon_dir_real" '
  index($0, "/actool ") && index($0, icon) && index($0, "--compile ") && index($0, "--app-icon AppIcon") && index($0, "--platform iphonesimulator") { found = 1 }
  END { exit(found ? 0 : 1) }
' "$BUILD_LOG" || \
  fail "release build log does not contain the real actool AppIcon.icon compilation command"

awk -v app="$built_app_real" -v alias="$built_app_log_alias" -v icon="$icon_dir_real" '
  index($0, "LinkAssetCatalog ") == 1 && index($0, icon) { linked = 1 }
  index($0, "builtin-linkAssetCatalog ") && (index($0, "--output " app) || index($0, "--output " alias)) { output = 1 }
  index($0, "note: Emplaced ") && (index($0, app "/Assets.car") || index($0, alias "/Assets.car")) { emplaced = 1 }
  END { exit(linked && output && emplaced ? 0 : 1) }
' "$BUILD_LOG" || \
  fail "release build log does not bind LinkAssetCatalog and Assets.car to the built app"

executable_name="$(plutil -extract CFBundleExecutable raw "$BUILT_APP/Info.plist")"
executable_real="$(canonical_path "$BUILT_APP/$executable_name")"
info_plist_real="$(canonical_path "$BUILT_APP/Info.plist")"
[[ -f "$BUILT_APP/$executable_name" ]] || fail "built executable is missing"

jq -e \
  --arg derivedData "$derived_data_real" \
  --arg builtApp "$built_app_real" \
  --arg assetsCar "$assets_car_real" \
  --arg executable "$executable_real" \
  --arg infoPlist "$info_plist_real" \
  --arg buildLog "$build_log_real" \
  --arg iconSource "$icon_dir_real" '
    .schemaVersion == 1
    and .build.configuration == "Release"
    and .build.sdk == "iphonesimulator"
    and (.build.startedAtEpochSeconds | type == "number")
    and (.build.completedAtEpochSeconds | type == "number")
    and .paths.derivedData == $derivedData
    and .paths.builtApp == $builtApp
    and .paths.assetsCar == $assetsCar
    and .paths.executable == $executable
    and .paths.infoPlist == $infoPlist
    and .paths.buildLog == $buildLog
    and .paths.iconSource == $iconSource
  ' "$BUILD_PROVENANCE" >/dev/null || \
  fail "release build provenance paths/configuration do not match the built app and evidence"

[[ "$(jq -r '.sha256.buildLog' "$BUILD_PROVENANCE")" == "$(sha256 "$BUILD_LOG")" ]] || \
  fail "build provenance log SHA-256 does not match the release build log"
[[ "$(jq -r '.sha256.assetsCar' "$BUILD_PROVENANCE")" == "$(sha256 "$BUILT_APP/Assets.car")" ]] || \
  fail "build provenance Assets.car SHA-256 does not match the built app"
[[ "$(jq -r '.sha256.executable' "$BUILD_PROVENANCE")" == "$(sha256 "$BUILT_APP/$executable_name")" ]] || \
  fail "build provenance executable SHA-256 does not match the built app"
[[ "$(jq -r '.sha256.infoPlist' "$BUILD_PROVENANCE")" == "$(sha256 "$BUILT_APP/Info.plist")" ]] || \
  fail "build provenance Info.plist SHA-256 does not match the built app"

started_at="$(jq -r '.build.startedAtEpochSeconds' "$BUILD_PROVENANCE")"
completed_at="$(jq -r '.build.completedAtEpochSeconds' "$BUILD_PROVENANCE")"
[[ "$started_at" =~ ^[0-9]+$ && "$completed_at" =~ ^[0-9]+$ ]] || \
  fail "build provenance timestamps are not unsigned integer epochs"
[[ "$started_at" -le "$completed_at" && $((completed_at - started_at)) -le 7200 ]] || \
  fail "build provenance time window is invalid or exceeds two hours"

while IFS='|' read -r json_key path; do
  observed_mtime="$(stat -f %m "$path")"
  [[ "$(jq -r ".mtimeEpochSeconds.$json_key" "$BUILD_PROVENANCE")" == "$observed_mtime" ]] || \
    fail "build provenance mtime does not match $json_key"
  [[ "$observed_mtime" -ge "$started_at" && "$observed_mtime" -le "$completed_at" ]] || \
    fail "build product mtime is outside the recorded build window: $json_key"
done <<EOF
buildLog|$BUILD_LOG
assetsCar|$BUILT_APP/Assets.car
executable|$BUILT_APP/$executable_name
infoPlist|$BUILT_APP/Info.plist
builtApp|$BUILT_APP
EOF

if rg -i -n 'warning:.*(AppIcon|app icon|unassigned.*icon|icon.*unassigned|alpha.*icon|icon.*alpha)' "$BUILD_LOG"; then
  fail "release build emitted an AppIcon missing/unassigned/alpha warning"
fi

fresh_assetutil="$temp_dir/fresh-assetutil.json"
xcrun assetutil --info "$BUILT_APP/Assets.car" > "$fresh_assetutil"

jq -e '
  [.[] | select(
    .AssetType? == "IconImageStack"
    and .Name? == "AppIcon"
    and .CompositeImagePresent? == false
    and (.LayerCount? >= 3)
  ) | .Appearance] | unique
  | (index("UIAppearanceLight") != null)
    and (index("UIAppearanceDark") != null)
    and (index("ISAppearanceTintable") != null)
' "$fresh_assetutil" >/dev/null || \
  fail "Assets.car does not contain the layered AppIcon stack for Default, Dark, and Mono/tinted"

for idiom in phone pad; do
  jq -e --arg idiom "$idiom" '
    any(.[];
      .AssetType? == "MultiSized Image"
      and .Name? == "AppIcon"
      and .Idiom? == $idiom
      and any(.Sizes[]?; startswith("1024x1024 "))
    )
  ' "$fresh_assetutil" >/dev/null || \
    fail "Assets.car is missing the compiler-generated legacy $idiom raster family"
done

jq -e '
  [.[] | select(.AssetType? == "Icon Image" and .Name? == "AppIcon")] as $icons
  | ($icons | length) >= 6
    and all($icons[]; .Opaque? == true)
' "$fresh_assetutil" >/dev/null || \
  fail "Assets.car reports a non-opaque or incomplete compiled AppIcon rendition"

jq -S . "$fresh_assetutil" > "$temp_dir/fresh-assetutil.sorted.json"
jq -S . "$ASSETUTIL_EVIDENCE" > "$temp_dir/evidence-assetutil.sorted.json"
if ! cmp -s "$temp_dir/fresh-assetutil.sorted.json" "$temp_dir/evidence-assetutil.sorted.json"; then
  fail "assetutil evidence does not match the currently built Assets.car"
fi

for raster_spec in \
  "AppIcon60x60@2x.png:120" \
  "AppIcon76x76@2x~ipad.png:152"; do
  raster="${raster_spec%%:*}"
  expected_size="${raster_spec##*:}"
  [[ -f "$BUILT_APP/$raster" ]] || fail "missing compiler-generated legacy raster: $raster"
  dimensions="$(xcrun sips -g pixelWidth -g pixelHeight "$BUILT_APP/$raster" 2>/dev/null)"
  [[ "$(printf '%s\n' "$dimensions" | awk '/pixelWidth:/ { print $2 }')" == "$expected_size" ]] || \
    fail "compiler-generated legacy raster has an unexpected width: $raster"
  [[ "$(printf '%s\n' "$dimensions" | awk '/pixelHeight:/ { print $2 }')" == "$expected_size" ]] || \
    fail "compiler-generated legacy raster has an unexpected height: $raster"
done

printf 'PASS: multi-layer Icon Composer AppIcon and compiled legacy fallbacks verified\n'
