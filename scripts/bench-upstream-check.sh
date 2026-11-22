#!/usr/bin/env bash
set -euo pipefail
# Direct fixture capacity evidence, independent of gateway. TLS needs no hosts override.
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
out=${OUT:-${TMPDIR:-/tmp}/bench-matrix/upstreams}
mkdir -p "$out"
scratch=$(mktemp -d "${TMPDIR:-/tmp}"/bench-upstream-XXXXXX)
pids=()
trap 'kill "${pids[@]}" 2>/dev/null || true; rm -rf "$scratch"' EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=localhost' -keyout "$scratch/key" -out "$scratch/cert" 2>/dev/null
for wire in chat responses messages; do
  pids=()
  script=bench-gateway-upstream.ts
  url=http://127.0.0.1:18110/v1/chat/completions
  extra=(--matrix)
  if [[ $wire == responses ]]; then url=http://127.0.0.1:18110/v1/responses; fi
  if [[ $wire == messages ]]; then
    script=bench-anthropic-upstream.ts
    url=https://127.0.0.1:18110/v1/messages
    extra=(--cert "$scratch/cert" --key "$scratch/key")
  fi
  for copy in 1 2; do
    taskset -c "${UPSTREAM_CPUS:-4-5}" bun "$script_dir/$script" --port 18110 "${extra[@]}" &
    pids+=("$!")
  done
  sleep 1
  for shape in 1:64 1:1 2000:16; do
    chunks=${shape%:*}; clients=${shape#*:}
    suffix=""; if [[ $clients == 1 ]]; then suffix="-clients1"; fi
    taskset -c "${LOAD_CPUS:-6-7}" oha --insecure --no-tui --output-format json --wait-ongoing-requests-after-deadline -z "${DURATION:-2s}" -c "$clients" \
      -m POST -H 'content-type: application/json' -d "{\"model\":\"mock-c$chunks-d0\",\"stream\":true}" "$url" > "$out/$wire-c$chunks$suffix.json"
  done
  kill "${pids[@]}"
  wait "${pids[@]}" 2>/dev/null || true
done
