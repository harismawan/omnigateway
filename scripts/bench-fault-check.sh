#!/usr/bin/env bash
set -u
# Functional regression: first upstream reply passes smoke, subsequent load lies.
# Setup always goes through `omni`.
: "${OMNI_RUST_BINARY:?required}"
dir=$(cd -- "$(dirname -- "$0")" && pwd)
out=${OUT:-${TMPDIR:-/tmp}/bench-fault-check}
mkdir -p "$out"
failed=0
sides=(rust)
for side in "${sides[@]}"; do
  gateway="sh $dir/run-rust-gateway.sh"
  for fault in empty-after-first error-frame-after-first 500-after-first; do
    for mode in json stream; do
      file="$out/$side-$fault-$mode.json"
      OMNI_BENCH_FAULT=$fault bash "$dir/bench-matrix.sh" --gateway "$gateway" \
        --cli "sh $dir/run-rust-gateway.sh omni" --only "custom-chat.chat.$mode" \
        --duration 2s --warmup 1s --boots 1 --out "$file" > "${file%.json}.log" 2>&1
      bun -e 'const x=await Bun.file(process.argv[1]).json(); const s=x.scenarios[0]; if(s.classification!=="failed"||s.metrics!==null)process.exit(1)' "$file" || failed=1
    done
  done
done
exit "$failed"
