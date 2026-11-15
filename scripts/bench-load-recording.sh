#!/usr/bin/env bash
set -euo pipefail
# Direct stub sanity, recording vs no recording, alternating order.
dir=$(cd -- "$(dirname -- "$0")" && pwd)
out=${OUT:-/tmp/opencode/bench-matrix-fix-rest/recording}
mkdir -p "$out"
if find "$out" -mindepth 1 -print -quit | grep -q .; then
 echo 'refusing non-empty recording evidence directory' >&2
 exit 2
fi
oha --version > "$out/oha-version.txt"
uptime > "$out/host-before.txt"
pids=()
trap 'kill "${pids[@]}" 2>/dev/null || true; uptime > "$out/host-after.txt"' EXIT
for copy in 1 2; do
 taskset -c "${UPSTREAM_CPUS:-4-5}" bun "$dir/bench-gateway-upstream.ts" --matrix --port 18119 &
 pids+=("$!")
done
sleep 1
for round in 1 2 3; do
 modes=(off on); if ((round % 2 == 0)); then modes=(on off); fi
 for c in 64 1; do
 for mode in "${modes[@]}"; do
  extra=(); if [[ $mode == on ]]; then extra=(--db-url "$out/$c-$round.db"); fi
  taskset -c "${LOAD_CPUS:-6-7}" oha --no-tui --output-format json -w -z "${DURATION:-2s}" -c "$c" \
   -m POST -H 'content-type: application/json' -d '{"model":"mock-c1-d0","stream":true}' \
   "${extra[@]}" http://127.0.0.1:18119/v1/chat/completions > "$out/$c-$round-$mode.json"
 done
 done
done
