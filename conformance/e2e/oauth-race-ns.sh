#!/usr/bin/env bash
set -euo pipefail
# Usage: bash conformance/e2e/oauth-race-ns.sh TS RUST /tmp/opencode/f3/race-witness/RUN
[[ $# == 3 ]] || exit 64
[[ ! -e /tmp/opencode/QUIET-WINDOW ]] || { echo 'F3 quiet window active' >&2; exit 75; }
base=/tmp/opencode/f3/race-witness
[[ $(df -B1 --output=avail "$base" | tail -1) -ge $((5 * 1024**3)) ]] || exit 75
scratch=$(realpath -m -- "$3")
[[ $(dirname -- "$scratch") == "$base" ]] || exit 64
driver=$(realpath -- "$(dirname -- "$0")/oauth-race.ts")
umask 077
mkdir -- "$scratch"
mkdir -- "$scratch/home" "$scratch/tmp"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=auth.openai.com' \
  -addext 'subjectAltName=DNS:auth.openai.com,DNS:api.anthropic.com' \
  -addext 'basicConstraints=critical,CA:FALSE' \
  -keyout "$scratch/key.pem" -out "$scratch/cert.pem" 2>"$scratch/cert.log"
printf '127.0.0.1 localhost auth.openai.com api.anthropic.com\n' > "$scratch/hosts"
exec env -i PATH="$PATH" HOME="$scratch/home" TMPDIR="$scratch/tmp" unshare -Urnm bash -c '
  set -euo pipefail
  ip link set lo up
  mount --bind "$3/hosts" /etc/hosts
  ip -brief link
  [[ $(ip -o link show | wc -l) -eq 1 ]]
  export OMNI_RACE_NETNS=$(readlink /proc/self/ns/net)
  exec bun --no-env-file "$4" "$1" "$2" "$3"
' bash "$(realpath -- "$1")" "$(realpath -- "$2")" "$scratch" "$driver"
