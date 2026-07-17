#!/usr/bin/env bash
set -Eeuo pipefail

origin=${1:-http://127.0.0.1}
mode=${2:-public}
expected_release_id=${3:-}

if [[ $mode != public && $mode != internal ]]; then
  printf 'Mode must be public or internal\n' >&2
  exit 64
fi
if [[ -n $expected_release_id && ! $expected_release_id =~ ^[a-f0-9]{12,64}$ ]]; then
  printf 'Expected release ID must be a 12-64 character lowercase hexadecimal digest\n' >&2
  exit 64
fi

expect_status() {
  local expected=$1
  local method=$2
  local path=$3
  local actual
  actual=$(curl --silent --show-error --connect-timeout 3 --max-time 15 \
    --output /dev/null --write-out '%{http_code}' \
    --request "$method" "${origin}${path}")
  if [[ $actual != "$expected" ]]; then
    printf 'Expected %s %s to return %s, got %s\n' "$method" "$path" "$expected" "$actual" >&2
    return 1
  fi
}

for path in /discover /tokyo /ja/tokyo /en/tokyo /privacy /terms; do
  expect_status 200 GET "$path"
done

rendered_discover=$(curl --silent --show-error --include \
  --connect-timeout 3 --max-time 15 "${origin}/discover")
if grep -Eq '/Users/|\.worktrees/|/private/tmp/|/app/apps/web/' <<< "$rendered_discover"; then
  printf 'Rendered discovery response leaked an absolute build path\n' >&2
  exit 1
fi
font_path=$(grep -oE '/assets/_vinext_fonts/[^>;,[:space:]]+\.woff2' \
  <<< "$rendered_discover" | head -n 1 || true)
if [[ -z $font_path ]]; then
  printf 'Rendered discovery response did not advertise a public font asset\n' >&2
  exit 1
fi
expect_status 200 GET "$font_path"

root_redirect=$(curl --silent --show-error --connect-timeout 3 --max-time 15 \
  --output /dev/null --write-out '%{http_code} %{redirect_url}' \
  "${origin}/")
if [[ $mode == public ]]; then
  expected_root_redirect='307 http://18.178.203.117/discover'
else
  expected_root_redirect="307 ${origin}/discover"
fi
if [[ $root_redirect != "$expected_root_redirect" ]]; then
  printf 'Expected GET / redirect %s, got %s\n' \
    "$expected_root_redirect" "$root_redirect" >&2
  exit 1
fi

health=$(curl --fail --silent --show-error --connect-timeout 3 --max-time 15 \
  "${origin}/v1/health")
grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' <<< "$health"
grep -Eq '"postgres"[[:space:]]*:[[:space:]]*"ok"' <<< "$health"
if [[ -n $expected_release_id ]]; then
  grep -Eq '"version"[[:space:]]*:[[:space:]]*"ip-preview-'"$expected_release_id"'"' \
    <<< "$health"
fi

if [[ $mode == public ]]; then
  expect_status 404 GET /v1/ops
  expect_status 404 GET /v1/shares/nonexistent-preview-code
  expect_status 404 GET /s/nonexistent-preview-code
  expect_status 404 POST /v1/auth/email/challenges
  expect_status 405 POST /v1/events
  expect_status 405 POST /
  expected_header=read-only
else
  expected_header=internal-test
fi

preview_header=$(curl --silent --show-error --connect-timeout 3 --max-time 15 \
  --head "${origin}/discover" \
  | tr -d '\r' \
  | grep -i '^X-Spott-Preview-Mode:' || true)
if [[ $preview_header != *"$expected_header"* ]]; then
  printf 'Missing expected %s preview response header\n' "$expected_header" >&2
  exit 1
fi

printf '%s checks passed for %s\n' "$mode" "$origin"
