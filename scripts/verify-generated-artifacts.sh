#!/usr/bin/env bash

set -euo pipefail
umask 077

if [[ "$#" -ne 2 || "$1" != "--repo-root" ]]; then
  echo "USAGE: expected --repo-root PATH" >&2
  exit 2
fi

if [[ ! -d "$2" ]]; then
  echo "REPOSITORY_INVALID: repository root is missing" >&2
  exit 1
fi

repository_root="$(cd "$2" && pwd -P)"
bundle_relative="packages/contracts/openapi.bundle.yaml"
schema_relative="packages/api-client/src/schema.d.ts"
bundle_path="${repository_root}/${bundle_relative}"
schema_path="${repository_root}/${schema_relative}"
openapi_source="${repository_root}/packages/contracts/openapi.yaml"
redocly="${repository_root}/node_modules/.bin/redocly"
openapi_typescript="${repository_root}/packages/api-client/node_modules/.bin/openapi-typescript"

for generated_path in "$bundle_path" "$schema_path"; do
  if [[ ! -f "$generated_path" || -L "$generated_path" ]]; then
    echo "GENERATED_FILE_UNSAFE: required generated file is absent or not regular" >&2
    exit 1
  fi
done

for generator in "$redocly" "$openapi_typescript"; do
  if [[ ! -x "$generator" ]]; then
    echo "GENERATOR_UNAVAILABLE: reviewed local generator is missing" >&2
    exit 1
  fi
done

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/spott-generated-verifier.XXXXXX")"
cleanup() {
  rm -rf "$temporary_directory"
}
trap cleanup EXIT INT TERM

hash_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

run_generator_step() {
  local label="$1"
  shift
  if ! "$@" >"${temporary_directory}/${label}.log" 2>&1; then
    echo "GENERATOR_FAILED: ${label}" >&2
    exit 1
  fi
}

before_bundle="$(hash_file "$bundle_path")"
before_schema="$(hash_file "$schema_path")"

cd "$repository_root"
run_generator_step contract_lint "$redocly" lint "$openapi_source"
run_generator_step contract_bundle "$redocly" bundle "$openapi_source" -o "$bundle_path"
run_generator_step api_client "$openapi_typescript" "$openapi_source" -o "$schema_path"

for generated_path in "$bundle_path" "$schema_path"; do
  if [[ ! -f "$generated_path" || -L "$generated_path" ]]; then
    echo "GENERATOR_FAILED: generator removed or replaced a required output" >&2
    exit 1
  fi
done

after_bundle="$(hash_file "$bundle_path")"
after_schema="$(hash_file "$schema_path")"
drift=0

if [[ "$before_bundle" != "$after_bundle" ]]; then
  echo "GENERATED_DRIFT: ${bundle_relative}" >&2
  drift=1
fi
if [[ "$before_schema" != "$after_schema" ]]; then
  echo "GENERATED_DRIFT: ${schema_relative}" >&2
  drift=1
fi
if [[ "$drift" -ne 0 ]]; then
  exit 1
fi

echo "GENERATED_ARTIFACTS_OK files=2"
