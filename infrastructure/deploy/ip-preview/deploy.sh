#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf 'Usage: %s RELEASE_DIRECTORY RELEASE_ID [--app-only]\n' "$0" >&2
}

if [[ $# -lt 2 || $# -gt 3 ]]; then
  usage
  exit 64
fi

if [[ $EUID -ne 0 ]]; then
  printf 'Run this deployment script with sudo so its lock and Nginx update are atomic.\n' >&2
  exit 77
fi

release_directory=$(cd "$1" && pwd -P)
release_id=$2
deployment_mode=${3:-full}
if [[ $deployment_mode != full && $deployment_mode != --app-only ]]; then
  usage
  exit 64
fi
if [[ ! $release_id =~ ^[a-f0-9]{12,64}$ ]]; then
  printf 'RELEASE_ID must be a 12-64 character lowercase hexadecimal source digest\n' >&2
  exit 64
fi

deployment_directory="$release_directory/infrastructure/deploy/ip-preview"
compose_file="$deployment_directory/compose.yaml"
internal_override="$deployment_directory/compose.internal.yaml"
environment_file=/opt/spott/shared/ip-preview.env
nginx_source="$deployment_directory/nginx-spott.conf"
nginx_target=/etc/nginx/conf.d/spott-ip-preview.conf

exec 9>/run/lock/spott-ip-preview-deploy.lock
if ! flock --nonblock 9; then
  printf 'Another Spott deployment is already running.\n' >&2
  exit 75
fi

for required_file in "$compose_file" "$internal_override" "$environment_file" "$nginx_source"; do
  if ! sudo test -r "$required_file"; then
    printf 'Required deployment file is unavailable: %s\n' "$required_file" >&2
    exit 66
  fi
done

compose() {
  env "SPOTT_RELEASE_ID=$release_id" docker compose \
    --project-name spott-ip-preview \
    --env-file "$environment_file" \
    --file "$compose_file" \
    --file "$internal_override" \
    "$@"
}

wait_for_url() {
  local url=$1
  local attempts=${2:-60}
  local preview_mode=${3:-}
  local index
  local curl_arguments=(
    --fail --silent --show-error --connect-timeout 3 --max-time 12
    --output /dev/null
  )
  if [[ -n $preview_mode ]]; then
    curl_arguments+=(--header "X-Spott-Preview-Mode: $preview_mode")
  fi
  for ((index = 1; index <= attempts; index += 1)); do
    if curl "${curl_arguments[@]}" "$url"; then
      return 0
    fi
    sleep 2
  done
  printf 'Timed out waiting for %s\n' "$url" >&2
  return 1
}

compose config --quiet

# A t3.medium cannot safely run the existing Web/API containers beside a
# 2 GiB Node build. Stop only those replaceable stateless containers during
# the image build, and restart them automatically if the build fails.
build_stopped_containers=()
while IFS= read -r container; do
  [[ -n $container ]] || continue
  if docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null | grep -qx true; then
    docker stop --time 20 "$container" >/dev/null
    build_stopped_containers+=("$container")
  fi
done < <(compose ps --quiet api web)
restore_build_containers() {
  local status=$?
  local container
  for container in "${build_stopped_containers[@]}"; do
    docker start "$container" >/dev/null 2>&1 || true
  done
  exit "$status"
}
trap restore_build_containers ERR

available_memory_kib=$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo)
if [[ ! $available_memory_kib =~ ^[0-9]+$ || $available_memory_kib -lt 2359296 ]]; then
  printf 'At least 2.25 GiB of available memory is required for the immutable Web/API build.\n' >&2
  false
fi
available_disk_kib=$(df -Pk /var/lib/docker | awk 'NR == 2 { print $4 }')
if [[ ! $available_disk_kib =~ ^[0-9]+$ || $available_disk_kib -lt 10485760 ]]; then
  printf 'At least 10 GiB of Docker filesystem space is required; inspect docker system df without pruning.\n' >&2
  false
fi
compose build --pull api
for container in "${build_stopped_containers[@]}"; do
  docker start "$container" >/dev/null
done
build_stopped_containers=()
trap - ERR

compose up --detach postgres
if [[ $deployment_mode == full ]]; then
  compose run --rm migrate
  compose run --rm migrate pnpm exec tsx infrastructure/deploy/ip-preview/grant-runtime-access.ts
  compose run --rm seed
fi
compose up --detach api web

wait_for_url http://127.0.0.1:4100/v1/health 60
api_health=$(curl --fail --silent --show-error --connect-timeout 3 --max-time 15 \
  http://127.0.0.1:4100/v1/health)
grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' <<< "$api_health"
grep -Eq '"postgres"[[:space:]]*:[[:space:]]*"ok"' <<< "$api_health"
grep -Eq '"version"[[:space:]]*:[[:space:]]*"ip-preview-'"$release_id"'"' <<< "$api_health"
wait_for_url http://127.0.0.1:3000/discover 90 read-only

nginx_candidate=$(mktemp /etc/nginx/conf.d/.spott-ip-preview.conf.XXXXXX)
nginx_validation=$(mktemp /tmp/spott-nginx-validation.XXXXXX)
nginx_validation_pid="${nginx_validation}.pid"
nginx_backup=
nginx_installed=0

cleanup_nginx_files() {
  local path
  for path in "${nginx_candidate:-}" "${nginx_validation:-}" \
    "${nginx_validation_pid:-}" "${nginx_backup:-}"; do
    if [[ -n $path && -e $path ]]; then
      rm -f "$path"
    fi
  done
}

restore_nginx_on_error() {
  local status=$?
  if [[ $nginx_installed -eq 1 ]]; then
    if [[ -n $nginx_backup && -f $nginx_backup ]]; then
      mv -f "$nginx_backup" "$nginx_target"
      nginx_backup=
    else
      rm -f "$nginx_target"
    fi
    nginx -t >/dev/null 2>&1 && systemctl reload nginx >/dev/null 2>&1 || true
  fi
  cleanup_nginx_files
  exit "$status"
}
trap restore_nginx_on_error ERR
trap cleanup_nginx_files EXIT

install -m 0644 "$nginx_source" "$nginx_candidate"
printf 'pid %s;\nevents {}\nhttp { include /etc/nginx/mime.types; include %s; }\n' \
  "$nginx_validation_pid" "$nginx_candidate" > "$nginx_validation"
nginx -t -c "$nginx_validation"

if [[ -f $nginx_target ]]; then
  nginx_backup=$(mktemp /etc/nginx/conf.d/.spott-ip-preview.backup.XXXXXX)
  cp -p "$nginx_target" "$nginx_backup"
fi
mv -f "$nginx_candidate" "$nginx_target"
nginx_candidate=
nginx_installed=1
nginx -t
systemctl enable --now nginx
systemctl reload nginx
nginx_installed=0
if [[ -n $nginx_backup && -f $nginx_backup ]]; then
  rm -f "$nginx_backup"
fi
nginx_backup=

"$deployment_directory/verify.sh" http://127.0.0.1 public "$release_id"
"$deployment_directory/verify.sh" http://127.0.0.1:8080 internal "$release_id"
ln -sfn "$release_directory" /opt/spott/current

compose ps
printf 'Spott IP preview deployed from %s (%s)\n' "$release_directory" "$release_id"
