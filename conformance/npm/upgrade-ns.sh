#!/usr/bin/env bash
# Usage: bash conformance/npm/upgrade-ns.sh <ts-0.15.5.tgz> <release binary> <scratch> <scripts|blocked>
# A private network namespace with loopback only: npm reaches nothing but the
# local registry the driver serves, and the gateway reaches no provider.
set -euo pipefail
[[ $# == 4 ]] || exit 64
scratch=$(realpath -m -- "$3")
mkdir -p -- "$scratch"
[[ -z $(ls -A -- "$scratch") ]] || { echo "scratch $scratch is not empty" >&2; exit 64; }
driver=$(realpath -- "$(dirname -- "$0")/upgrade.ts")
exec env -i PATH="$(dirname "$(command -v node)"):$(dirname "$(command -v bun)"):/usr/local/bin:/usr/bin:/bin:/usr/sbin" \
  HOME="$scratch/home" TMPDIR="$scratch" unshare -Urn bash -c '
  set -euo pipefail
  ip link set lo up
  [[ $(ip -o link show | wc -l) -eq 1 ]]
  exec bun --no-env-file "$1" "$2" "$3" "$4" "$5"
' bash "$driver" "$(realpath -- "$1")" "$(realpath -- "$2")" "$scratch" "$4"
