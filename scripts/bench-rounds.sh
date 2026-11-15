#!/usr/bin/env bash
set -euo pipefail
# BASE_GATEWAY/HEAD_GATEWAY are argv strings, CLI is the setup CLI argv string.
: "${BASE_GATEWAY:?required}" "${HEAD_GATEWAY:?required}" "${CLI:?required}"
out=${OUT:-/tmp/opencode/bench-matrix/rounds}
mkdir -p "$out"
if find "$out" -mindepth 1 -print -quit | grep -q .; then echo 'refusing non-empty OUT' >&2; exit 2; fi
out=$(cd -- "$out" && pwd)
rounds=${ROUNDS:-5}
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
source "$script_dir/bench-load-wait.sh"
mkdir -p "$out/base" "$out/head"
bun "$script_dir/bench-manifest.ts" "$out/base" "$rounds"
bun "$script_dir/bench-manifest.ts" "$out/head" "$rounds"
uptime > "$out/host-before.txt"
trap 'uptime > "$out/host-after.txt"' EXIT
for ((round=1; round<=rounds; round++)); do
  sides=(base head)
  if ((round % 2 == 0)); then sides=(head base); fi
  for side in "${sides[@]}"; do
    wait_for_load
    gateway=$BASE_GATEWAY
    if [[ $side == head ]]; then gateway=$HEAD_GATEWAY; fi
    if [[ -e "$out/$side/$round.json" ]]; then
      echo "refusing to overwrite $out/$side/$round.json" >&2
      exit 2
    fi
    uptime > "$out/$side/$round.before.txt"
    printf 'load_begin=%s waited_seconds=%s start_load=%s\n' "$load_begin" "$load_waited" "$load_start" >> "$out/$side/$round.before.txt"
    command=(bash "$script_dir/bench-matrix.sh" --gateway "$gateway" --cli "$CLI"
      --label "$side-$round" --out "$out/$side/$round.json" "$@")
    if [[ -n ${OMNI_RUST_BINARY:-} ]]; then
      printf 'OMNI_RUST_BINARY=%q ' "$OMNI_RUST_BINARY" >> "$out/commands.sh"
    fi
    printf '%q ' "${command[@]}" >> "$out/commands.sh"
    printf '\n' >> "$out/commands.sh"
    code=0
    "${command[@]}" > "$out/$side/$round.log" 2>&1 || code=$?
    if [[ -f "$out/$side/$round.json" ]]; then
      bun -e 'const [file, begin, waited, start] = process.argv.slice(1); const r = await Bun.file(file).json(); r.loadWait = {beginLoad: Number(begin), waitedSeconds: Number(waited), startLoad: Number(start)}; await Bun.write(file, JSON.stringify(r, null, 2) + "\n");' "$out/$side/$round.json" "$load_begin" "$load_waited" "$load_start"
    fi
    bun "$script_dir/bench-manifest.ts" "$out/$side" "$rounds"
    if ((code != 0)); then exit "$code"; fi
    uptime > "$out/$side/$round.after.txt"
  done
done
bun "$script_dir/bench-compare.ts" "$out/base" "$out/head" > "$out/comparison.md"
