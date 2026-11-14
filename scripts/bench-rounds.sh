#!/usr/bin/env bash
set -euo pipefail
# BASE_GATEWAY/HEAD_GATEWAY are argv strings, CLI is the setup CLI argv string.
: "${BASE_GATEWAY:?required}" "${HEAD_GATEWAY:?required}" "${CLI:?required}"
out=${OUT:-/tmp/opencode/bench-matrix/rounds}
mkdir -p "$out"
out=$(cd -- "$out" && pwd)
rounds=${ROUNDS:-5}
threshold=${MAX_LOAD:-1.0}
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
load=$(cut -d' ' -f1 /proc/loadavg)
if [[ ${ALLOW_BUSY:-0} != 1 ]] && awk "BEGIN { exit !($load > $threshold) }"; then
  echo "refusing load $load > $threshold; ALLOW_BUSY=1 overrides" >&2
  exit 2
fi
mkdir -p "$out/base" "$out/head"
uptime > "$out/host-before.txt"
trap 'uptime > "$out/host-after.txt"' EXIT
for ((round=1; round<=rounds; round++)); do
  sides=(base head)
  if ((round % 2 == 0)); then sides=(head base); fi
  for side in "${sides[@]}"; do
    gateway=$BASE_GATEWAY
    if [[ $side == head ]]; then gateway=$HEAD_GATEWAY; fi
    if [[ -e "$out/$side/$round.json" ]]; then
      echo "refusing to overwrite $out/$side/$round.json" >&2
      exit 2
    fi
    uptime > "$out/$side/$round.before.txt"
    bash "$script_dir/bench-matrix.sh" --gateway "$gateway" --cli "$CLI" \
      --label "$side-$round" --out "$out/$side/$round.json" "$@" > "$out/$side/$round.log" 2>&1
    uptime > "$out/$side/$round.after.txt"
  done
done
bun "$script_dir/bench-compare.ts" "$out/base" "$out/head" > "$out/comparison.md"
