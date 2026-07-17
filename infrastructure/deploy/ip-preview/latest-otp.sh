#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 2 || ($1 != email && $1 != phone) ]]; then
  printf 'Usage: %s email|phone SUBJECT\n' "$0" >&2
  exit 64
fi

kind=$1
subject=$2
case $kind in
  email)
    if [[ ! $subject =~ ^[^[:space:]@=]+@[^[:space:]@=]+$ ]]; then
      printf 'SUBJECT must be a single valid-looking email token\n' >&2
      exit 64
    fi
    ;;
  phone)
    if [[ ! $subject =~ ^\+81[1-9][0-9]{8,9}$ ]]; then
      printf 'SUBJECT must be a Japanese E.164 phone number\n' >&2
      exit 64
    fi
    ;;
esac

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
parser=$script_directory/extract-latest-otp.awk
if [[ ! -r $parser ]]; then
  printf 'OTP parser is missing or unreadable\n' >&2
  exit 70
fi

container_id=$(sudo docker ps \
  --filter label=com.docker.compose.project=spott-ip-preview \
  --filter label=com.docker.compose.service=api \
  --format '{{.ID}}' | head -n 1)
if [[ -z $container_id ]]; then
  printf 'Spott API container is not running\n' >&2
  exit 69
fi

code=$(sudo docker logs --since 10m "$container_id" 2>&1 \
  | awk -v "kind=$kind" -v "subject=$subject" -f "$parser" || true)
if [[ ! $code =~ ^[0-9]{6}$ ]]; then
  printf 'No matching OTP was found in the last 10 minutes\n' >&2
  exit 1
fi
printf '%s\n' "$code"
