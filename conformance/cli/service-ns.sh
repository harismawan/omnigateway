#!/usr/bin/env bash
# All runtime subprocesses inherit a private network and allowlisted environment.
set -euo pipefail
cli=$(realpath "$1")
gateway=$(realpath "$2")
oracle=$(realpath "$3")
out=$(realpath -m "$4")
mkdir -p "$out/home" "$out/tmp"
exec unshare -Urn env -i PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/home/homebrew/.bun/bin:/home/linuxbrew/.linuxbrew/bin HOME="$out/home" TMPDIR="$out/tmp" bash -euc 'ip link set lo up; exec python3 conformance/cli/service.py "$1" "$2" "$3"' bash "$cli" "$gateway" "$oracle"
