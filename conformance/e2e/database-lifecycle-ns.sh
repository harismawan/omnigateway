#!/usr/bin/env bash
set -euo pipefail
TS=$(realpath "$1")
RUST=$(realpath "$2")
OUT=$(realpath -m "$3")
mkdir -p "$OUT/home" "$OUT/tmp"
unshare -Urn bash -c '
set -euo pipefail
ip link set lo up
exec env -i PATH=/usr/sbin:/usr/bin:/bin:/home/homebrew/.bun/bin:/home/linuxbrew/.linuxbrew/bin HOME="$3/home" TMPDIR="$3/tmp" bun --no-env-file conformance/e2e/database-lifecycle.ts --ts "$1" --rust "$2" --out "$3"
' bash "$TS" "$RUST" "$OUT"
