#!/usr/bin/env bash
set -euo pipefail
# BASE_GATEWAY/HEAD_GATEWAY are argv strings, CLI is the setup CLI argv string.
: "${BASE_GATEWAY:?required}" "${HEAD_GATEWAY:?required}" "${CLI:?required}"
out=${OUT:-/tmp/opencode/bench-matrix/rounds}
mkdir -p "$out"
if find "$out" -mindepth 1 -print -quit | grep -q .; then echo 'refusing non-empty OUT' >&2; exit 2; fi
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
bun "$script_dir/bench-manifest.ts" "$out/base" "$rounds"
bun "$script_dir/bench-manifest.ts" "$out/head" "$rounds"
uptime > "$out/host-before.txt"
trap 'uptime > "$out/host-after.txt"' EXIT
for ((round=1; round<=rounds; round++)); do
  sides=(base head)
  if ((round % 2 == 0)); then sides=(head base); fi
  for side in "${sides[@]}"; do
    load=$(cut -d' ' -f1 /proc/loadavg)
    if [[ ${ALLOW_BUSY:-0} != 1 ]] && awk "BEGIN { exit !($load > $threshold) }"; then echo "refusing round: load $load > $threshold" >&2; exit 2; fi
    gateway=$BASE_GATEWAY
    if [[ $side == head ]]; then gateway=$HEAD_GATEWAY; fi
    if [[ -e "$out/$side/$round.json" ]]; then
      echo "refusing to overwrite $out/$side/$round.json" >&2
      exit 2
    fi
    uptime > "$out/$side/$round.before.txt"
    command=(bash "$script_dir/bench-matrix.sh" --gateway "$gateway" --cli "$CLI"
      --label "$side-$round" --out "$out/$side/$round.json" "$@")
    if [[ -n ${OMNI_RUST_BINARY:-} ]]; then
      printf 'OMNI_RUST_BINARY=%q ' "$OMNI_RUST_BINARY" >> "$out/commands.sh"
    fi
    printf '%q ' "${command[@]}" >> "$out/commands.sh"
    printf '\n' >> "$out/commands.sh"
    code=0
    "${command[@]}" > "$out/$side/$round.log" 2>&1 || code=$?
    bun "$script_dir/bench-manifest.ts" "$out/$side" "$rounds"
    if ((code != 0)); then exit "$code"; fi
    uptime > "$out/$side/$round.after.txt"
  done
done
bun "$script_dir/bench-compare.ts" "$out/base" "$out/head" > "$out/comparison.md"
