#!/usr/bin/env bash
set -euo pipefail
# Caller supplies an explicit scrubbed environment/private HOME.
exec unshare -Urn bash -c '
set -euo pipefail
ip link set lo up
exec bun --no-env-file conformance/e2e/idle-timeout.ts --ts "$1" --rust "$2" --work "$3"
' bash "$1" "$2" "$3"
