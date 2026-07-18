#!/usr/bin/env bash
set -Eeuo pipefail

release_root=${1:-/opt/spott/current}
backup_root=${2:-/opt/spott/backups}
env_file=${SPOTT_ENV_FILE:-/opt/spott/shared/ip-preview.env}

if [[ $(id -u) -ne 0 ]]; then
  printf 'Run this backup check as root\n' >&2
  exit 77
fi
if [[ ! -d $release_root ]]; then
  printf 'Preview release directory is missing\n' >&2
  exit 66
fi
release_directory=$(cd "$release_root" && pwd -P)
release_id=$(basename "$release_directory")
if [[ ! $release_id =~ ^[a-f0-9]{12,64}$ ]]; then
  printf 'Preview release directory must end with its immutable source digest\n' >&2
  exit 64
fi
if [[ ! -f $env_file ]]; then
  printf 'Preview environment file is missing\n' >&2
  exit 66
fi
if [[ ! -f $release_directory/infrastructure/deploy/ip-preview/compose.yaml ]]; then
  printf 'Preview release is incomplete\n' >&2
  exit 66
fi

compose=(
  env "SPOTT_RELEASE_ID=$release_id" docker compose
  --project-name spott-ip-preview
  --env-file "$env_file"
  -f "$release_directory/infrastructure/deploy/ip-preview/compose.yaml"
  -f "$release_directory/infrastructure/deploy/ip-preview/compose.internal.yaml"
)

install -d -m 700 -o root -g root "$backup_root"
umask 077
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
dump_path="$backup_root/spott-ip-preview-$timestamp.dump"
checksum_path="$dump_path.sha256"
if [[ -e $dump_path || -e $checksum_path ]]; then
  printf 'Backup path already exists\n' >&2
  exit 73
fi
dump_tmp=$(mktemp "$backup_root/.spott-ip-preview-$timestamp.XXXXXX.dump")
checksum_tmp=
restore_database=

cleanup() {
  local status=$?
  local cleanup_failed=0
  if [[ -n $restore_database ]]; then
    if ! "${compose[@]}" exec -T postgres sh -ceu '
        export PGPASSWORD="$POSTGRES_PASSWORD"
        dropdb --if-exists --force --username="$POSTGRES_USER" "$1"
      ' sh "$restore_database" >/dev/null 2>&1; then
      printf 'Failed to remove restore-check database: %s\n' "$restore_database" >&2
      cleanup_failed=1
    else
      restore_database=
    fi
  fi
  if [[ -n $dump_tmp && -e $dump_tmp ]] && ! rm -f "$dump_tmp"; then
    printf 'Failed to remove temporary database dump\n' >&2
    cleanup_failed=1
  fi
  if [[ -n $checksum_tmp && -e $checksum_tmp ]] && ! rm -f "$checksum_tmp"; then
    printf 'Failed to remove temporary checksum\n' >&2
    cleanup_failed=1
  fi
  if [[ $cleanup_failed -ne 0 ]]; then
    exit 1
  fi
  exit "$status"
}
trap cleanup EXIT

"${compose[@]}" exec -T postgres sh -ceu '
  export PGPASSWORD="$POSTGRES_PASSWORD"
  exec pg_dump \
    --format=custom \
    --compress=9 \
    --no-owner \
    --no-acl \
    --username="$POSTGRES_USER" \
    --dbname="$POSTGRES_DB"
' >"$dump_tmp"

if [[ ! -s $dump_tmp ]]; then
  printf 'Database backup is empty\n' >&2
  exit 1
fi

"${compose[@]}" exec -T postgres pg_restore --list <"$dump_tmp" >/dev/null

restore_database="spott_restore_check_$(openssl rand -hex 12)"
"${compose[@]}" exec -T postgres sh -ceu '
  export PGPASSWORD="$POSTGRES_PASSWORD"
  createdb --username="$POSTGRES_USER" "$1"
' sh "$restore_database"

"${compose[@]}" exec -T postgres sh -ceu '
  export PGPASSWORD="$POSTGRES_PASSWORD"
  exec pg_restore \
    --exit-on-error \
    --no-owner \
    --no-acl \
    --username="$POSTGRES_USER" \
    --dbname="$1"
' sh "$restore_database" <"$dump_tmp" >/dev/null

verification=$("${compose[@]}" exec -T postgres sh -ceu '
  export PGPASSWORD="$POSTGRES_PASSWORD"
  exec psql \
    --username="$POSTGRES_USER" \
    --dbname="$1" \
    --tuples-only \
    --no-align \
    --set=ON_ERROR_STOP=1 \
    --command="SELECT (SELECT COUNT(*) FROM schema_migrations)::text || chr(9) || (SELECT extversion FROM pg_extension WHERE extname = '\''postgis'\'');"
' sh "$restore_database")

migration_count=${verification%%$'\t'*}
postgis_version=${verification#*$'\t'}
if [[ ! $migration_count =~ ^[1-9][0-9]*$ || -z $postgis_version || $postgis_version == "$verification" ]]; then
  printf 'Restored database verification failed\n' >&2
  exit 1
fi

"${compose[@]}" exec -T postgres sh -ceu '
  export PGPASSWORD="$POSTGRES_PASSWORD"
  dropdb --if-exists --force --username="$POSTGRES_USER" "$1"
' sh "$restore_database" >/dev/null
restore_database=

checksum_tmp=$(mktemp "$backup_root/.spott-ip-preview-$timestamp.XXXXXX.sha256")
dump_checksum=$(sha256sum "$dump_tmp")
dump_checksum=${dump_checksum%% *}
if [[ ! $dump_checksum =~ ^[a-f0-9]{64}$ ]]; then
  printf 'Database backup checksum is invalid\n' >&2
  exit 1
fi
printf '%s  %s\n' "$dump_checksum" "$(basename "$dump_path")" >"$checksum_tmp"
chmod 600 "$dump_tmp" "$checksum_tmp"
mv "$dump_tmp" "$dump_path"
dump_tmp=
mv "$checksum_tmp" "$checksum_path"
checksum_tmp=

printf 'backup=%s\n' "$dump_path"
printf 'migrations=%s postgis=%s\n' "$migration_count" "$postgis_version"
printf 'restore_check=passed\n'

trap - EXIT
