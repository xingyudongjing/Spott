#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf 'Usage: %s ENVIRONMENT_PATH PUBLIC_IPV4\n' "$0" >&2
}

if [[ $# -ne 2 ]]; then
  usage
  exit 64
fi

environment_path=$1
public_ipv4=$2

if [[ ! $public_ipv4 =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  printf 'PUBLIC_IPV4 must be an IPv4 address\n' >&2
  exit 64
fi
if [[ -e $environment_path ]]; then
  printf 'Refusing to overwrite existing environment file: %s\n' "$environment_path" >&2
  exit 73
fi

umask 077
environment_directory=$(dirname "$environment_path")
if [[ ! -d $environment_directory ]]; then
  install -d -m 0700 "$environment_directory"
fi
temporary_path=$(mktemp "${environment_path}.tmp.XXXXXX")
cleanup() {
  if [[ -n ${temporary_path:-} && -e $temporary_path ]]; then
    rm -f "$temporary_path"
  fi
}
trap cleanup EXIT

postgres_admin_password=$(openssl rand -hex 24)
app_database_password=$(openssl rand -hex 24)
access_token_secret=$(openssl rand -hex 48)
refresh_token_secret=$(openssl rand -hex 48)
field_encryption_key=$(openssl rand -base64 32 | tr -d '\n')
lookup_hmac_pepper=$(openssl rand -hex 32)
bff_key=$(openssl rand -hex 32)
refresh_derivation_key=$(openssl rand -hex 32)

{
  printf 'POSTGRES_DB=spott\n'
  printf 'POSTGRES_ADMIN_USER=spott_admin\n'
  printf 'POSTGRES_ADMIN_PASSWORD=%s\n' "$postgres_admin_password"
  printf 'APP_DATABASE_USER=spott_app\n'
  printf 'APP_DATABASE_PASSWORD=%s\n' "$app_database_password"
  printf 'SPOTT_PUBLIC_ORIGIN=http://%s\n' "$public_ipv4"
  # SPOTT_CANONICAL_ORIGIN MUST stay https:// even though the preview is served
  # over plain HTTP. The API (NODE_ENV=production) hard-fails at startup unless
  # SPOTT_WEB_CANONICAL_ORIGIN is https (services/api/src/config.ts:239-241), and
  # the value is otherwise never read at runtime. HTTP login does NOT depend on
  # it: the web client carries its session as a Bearer token in localStorage,
  # WEB_SESSION_BFF_ENFORCEMENT=off, and http://<ip> is already in WEB_ORIGIN.
  # Do NOT change this to http:// — doing so crashes the api container.
  printf 'SPOTT_CANONICAL_ORIGIN=https://%s\n' "$public_ipv4"
  printf 'NEXT_PUBLIC_MAP_STYLE_URL=https://demotiles.maplibre.org/style.json\n'
  printf 'ACCESS_TOKEN_SECRET=%s\n' "$access_token_secret"
  printf 'REFRESH_TOKEN_SECRET=%s\n' "$refresh_token_secret"
  printf 'FIELD_ENCRYPTION_KEY_BASE64=%s\n' "$field_encryption_key"
  printf 'LOOKUP_HMAC_PEPPER=%s\n' "$lookup_hmac_pepper"
  printf 'SPOTT_WEB_BFF_KEYS=ip-preview-bff-2026-07:%s\n' "$bff_key"
  printf 'SPOTT_WEB_BFF_CURRENT_KID=ip-preview-bff-2026-07\n'
  printf 'REFRESH_TOKEN_DERIVATION_KEYS=ip-preview-refresh-2026-07:%s\n' "$refresh_derivation_key"
  printf 'REFRESH_TOKEN_DERIVATION_CURRENT_KID=ip-preview-refresh-2026-07\n'
} > "$temporary_path"

chmod 600 "$temporary_path"
mv "$temporary_path" "$environment_path"
temporary_path=
printf 'Created protected deployment environment: %s\n' "$environment_path"
