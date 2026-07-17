#!/usr/bin/env bash
set -euo pipefail

umask 077

fail() {
  local code="$1"
  local message="$2"
  printf '[%s] %s\n' "$code" "$message" >&2
  exit 1
}

url=''
expected_sha256=''
expected_bytes=''
archive_format=''
destination=''
ca_certificate=''
signature_path=''
signature_authority=''
team_identifier=''

while (($# > 0)); do
  (($# >= 2)) || fail USAGE 'every option requires one value'
  case "$1" in
    --url) url="$2" ;;
    --sha256) expected_sha256="$2" ;;
    --bytes) expected_bytes="$2" ;;
    --archive-format) archive_format="$2" ;;
    --destination) destination="$2" ;;
    --ca-certificate) ca_certificate="$2" ;;
    --signature-path) signature_path="$2" ;;
    --signature-authority) signature_authority="$2" ;;
    --team-identifier) team_identifier="$2" ;;
    *) fail USAGE 'unknown option' ;;
  esac
  shift 2
done

[[ "$url" == https://* ]] || fail HTTPS_REQUIRED 'download URL must use HTTPS'
[[ "$url" != *[[:space:]]* ]] || fail HTTPS_REQUIRED 'download URL contains whitespace'
[[ "$url" != https://*@* ]] || fail HTTPS_REQUIRED 'download URL must not contain user-info'
[[ "$expected_sha256" =~ ^[0-9a-f]{64}$ ]] || fail USAGE 'SHA-256 must be lowercase hexadecimal'
[[ "$expected_bytes" =~ ^[1-9][0-9]*$ ]] || fail USAGE 'byte size must be a positive integer'
case "$archive_format" in
  tar.gz|tar.bz2|tar.xz|zip|pkg|dmg) ;;
  *) fail USAGE 'unsupported archive format' ;;
esac

[[ -n "$destination" && -d "$destination" && ! -L "$destination" ]] || \
  fail DESTINATION_INVALID 'destination must be an existing regular directory'
[[ -w "$destination" ]] || fail DESTINATION_INVALID 'destination is not writable'
if [[ -n "$(ls -A "$destination")" ]]; then
  fail DESTINATION_NOT_EMPTY 'destination must be empty'
fi
if [[ -n "$ca_certificate" ]]; then
  [[ -f "$ca_certificate" && ! -L "$ca_certificate" ]] || \
    fail CA_INVALID 'CA certificate must be a regular file'
fi

signature_count=0
[[ -n "$signature_path" ]] && ((signature_count += 1))
[[ -n "$signature_authority" ]] && ((signature_count += 1))
[[ -n "$team_identifier" ]] && ((signature_count += 1))
if ((signature_count != 0 && signature_count != 3)); then
  fail SIGNATURE_POLICY_INVALID 'signature path, authority, and team identifier are atomic'
fi
if [[ "$archive_format" == dmg && "$signature_count" -ne 3 ]]; then
  fail SIGNATURE_POLICY_INVALID 'DMG extraction requires a declared signed target'
fi

case "$signature_path" in
  ''|/*|..|../*|*/../*|*/..) 
    if [[ -n "$signature_path" ]]; then
      fail SIGNATURE_POLICY_INVALID 'signature path must stay inside the archive'
    fi
    ;;
esac

temporary_directory="$(mktemp -d "${destination}/.spott-verified-download.XXXXXX")"
archive_path="${temporary_directory}/artifact"
stage_directory="${temporary_directory}/stage"
mount_directory=''

cleanup() {
  if [[ -n "$mount_directory" ]] && mount | grep -Fq " on ${mount_directory} "; then
    hdiutil detach "$mount_directory" >/dev/null 2>&1 || true
  fi
  rm -rf "$temporary_directory"
}
trap cleanup EXIT HUP INT TERM

curl_arguments=(
  --fail
  --location
  --silent
  --show-error
  --proto '=https'
  --proto-redir '=https'
  --tlsv1.2
  --output "$archive_path"
)
if [[ -n "$ca_certificate" ]]; then
  curl_arguments+=(--cacert "$ca_certificate")
fi
curl "${curl_arguments[@]}" "$url"

actual_bytes="$(wc -c < "$archive_path" | tr -d '[:space:]')"
[[ "$actual_bytes" == "$expected_bytes" ]] || fail SIZE_MISMATCH 'downloaded byte size differs'

if command -v sha256sum >/dev/null 2>&1; then
  actual_sha256="$(sha256sum "$archive_path" | awk '{print $1}')"
else
  actual_sha256="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
fi
[[ "$actual_sha256" == "$expected_sha256" ]] || fail HASH_MISMATCH 'downloaded SHA-256 differs'

archive_entry_is_unsafe() {
  local entry="$1"
  while [[ "$entry" == ./* ]]; do entry="${entry#./}"; done
  case "$entry" in
    ''|.|/*|..|../*|*/../*|*/..) return 0 ;;
  esac
  [[ "$entry" == *$'\n'* || "$entry" == *$'\r'* ]]
}

validate_extracted_tree() {
  local tree="$1"
  if find "$tree" -type l -o -type b -o -type c -o -type p -o -type s | grep -q .; then
    fail UNSAFE_ARCHIVE 'extracted tree contains a link or special file'
  fi
}

verify_signature() {
  local target="$1"
  [[ "$signature_count" -eq 3 ]] || return 0
  [[ -e "$target" && ! -L "$target" ]] || fail SIGNATURE_MISMATCH 'signed target is absent'
  command -v codesign >/dev/null 2>&1 || fail SIGNATURE_MISMATCH 'codesign is unavailable'
  codesign --verify --deep --strict "$target" >/dev/null 2>&1 || \
    fail SIGNATURE_MISMATCH 'code signature verification failed'
  local details="${temporary_directory}/codesign.txt"
  codesign -d --verbose=4 "$target" > /dev/null 2> "$details"
  grep -Fqx "Authority=${signature_authority}" "$details" || \
    fail SIGNATURE_MISMATCH 'signing authority differs'
  grep -Fqx "TeamIdentifier=${team_identifier}" "$details" || \
    fail SIGNATURE_MISMATCH 'team identifier differs'
}

case "$archive_format" in
  tar.gz|tar.bz2|tar.xz)
    names="${temporary_directory}/archive-names.txt"
    types="${temporary_directory}/archive-types.txt"
    tar -tf "$archive_path" > "$names" || fail UNSAFE_ARCHIVE 'tar listing failed'
    while IFS= read -r entry || [[ -n "$entry" ]]; do
      archive_entry_is_unsafe "$entry" && fail UNSAFE_ARCHIVE 'tar path is unsafe'
    done < "$names"
    tar -tvf "$archive_path" > "$types" || fail UNSAFE_ARCHIVE 'tar type listing failed'
    while IFS= read -r entry || [[ -n "$entry" ]]; do
      case "${entry:0:1}" in
        -|d) ;;
        *) fail UNSAFE_ARCHIVE 'tar contains a link or special file' ;;
      esac
    done < "$types"
    mkdir "$stage_directory"
    tar -xf "$archive_path" -C "$stage_directory"
    validate_extracted_tree "$stage_directory"
    ;;
  zip)
    command -v unzip >/dev/null 2>&1 || fail UNSAFE_ARCHIVE 'unzip is unavailable'
    command -v zipinfo >/dev/null 2>&1 || fail UNSAFE_ARCHIVE 'zipinfo is unavailable'
    names="${temporary_directory}/archive-names.txt"
    types="${temporary_directory}/archive-types.txt"
    unzip -Z -1 "$archive_path" > "$names" || fail UNSAFE_ARCHIVE 'zip listing failed'
    while IFS= read -r entry || [[ -n "$entry" ]]; do
      archive_entry_is_unsafe "$entry" && fail UNSAFE_ARCHIVE 'zip path is unsafe'
    done < "$names"
    zipinfo -l "$archive_path" > "$types" || fail UNSAFE_ARCHIVE 'zip type listing failed'
    if grep -Eq '^l|^[bcpds]' "$types"; then
      fail UNSAFE_ARCHIVE 'zip contains a link or special file'
    fi
    mkdir "$stage_directory"
    unzip -qq "$archive_path" -d "$stage_directory"
    validate_extracted_tree "$stage_directory"
    ;;
  pkg)
    command -v pkgutil >/dev/null 2>&1 || fail UNSAFE_ARCHIVE 'pkgutil is unavailable'
    mkdir "$stage_directory"
    pkgutil --expand-full "$archive_path" "$stage_directory" >/dev/null
    validate_extracted_tree "$stage_directory"
    ;;
  dmg)
    command -v hdiutil >/dev/null 2>&1 || fail UNSAFE_ARCHIVE 'hdiutil is unavailable'
    mount_directory="${temporary_directory}/mount"
    mkdir "$mount_directory"
    hdiutil attach -nobrowse -readonly -mountpoint "$mount_directory" "$archive_path" \
      > "${temporary_directory}/hdiutil.txt"
    verify_signature "${mount_directory}/${signature_path}"
    mkdir "$stage_directory"
    cp -R "${mount_directory}/${signature_path}" "$stage_directory/"
    hdiutil detach "$mount_directory" >/dev/null
    mount_directory=''
    validate_extracted_tree "$stage_directory"
    ;;
esac

if [[ "$archive_format" != dmg && "$signature_count" -eq 3 ]]; then
  verify_signature "${stage_directory}/${signature_path}"
fi

cp -R "${stage_directory}/." "$destination/"
printf 'VERIFIED_DOWNLOAD_OK\n'
