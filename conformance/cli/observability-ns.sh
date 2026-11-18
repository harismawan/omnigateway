#!/usr/bin/env bash
# Usage: bash conformance/cli/observability-ns.sh CLI_BINARY FROZEN_CHECKOUT SCRATCH
set -euo pipefail
binary="$(realpath "$1")"
oracle="$(realpath "$2")"
work="$(realpath "$3")"
mkdir -p "$work/home" "$work/tmp"
exec unshare -Urn env -i PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/home/homebrew/.bun/bin:/home/linuxbrew/.linuxbrew/bin HOME="$work/home" TMPDIR="$work/tmp" OMNI_CLI_BIN="$binary" E3_ORACLE_ROOT="$oracle" bash -euc 'ip link set lo up; exec python3 conformance/cli/observability.py'
