#!/usr/bin/env bash
# BENCH_TEST_LOAD_FILE is solely for deterministic guard tests.
wait_for_load() {
  local source=${BENCH_TEST_LOAD_FILE:-/proc/loadavg}
  local threshold=${MAX_LOAD:-1} bound=${LOAD_WAIT:-600} poll=${LOAD_POLL:-5}
  # SECONDS truncates wall-clock seconds: a one-second budget could expire
  # immediately at the next boundary. Measure the actual elapsed interval.
  local began=$EPOCHREALTIME announced=0 remaining
  load_begin=$(cut -d' ' -f1 "$source")
  load_start=$load_begin
  load_waited=0
  if [[ ${ALLOW_BUSY:-0} == 1 ]]; then return 0; fi
  while awk "BEGIN { exit !($load_start > $threshold) }"; do
    if ((announced == 0)); then
      echo "load wait started: load $load_begin > $threshold (limit ${bound}s)" >&2
      announced=1
    fi
    load_waited=$(awk -v now="$EPOCHREALTIME" -v began="$began" 'BEGIN { printf "%.6f", now-began }')
    remaining=$(awk -v bound="$bound" -v elapsed="$load_waited" 'BEGIN { print bound-elapsed }')
    if awk -v remaining="$remaining" 'BEGIN { exit !(remaining <= 0) }'; then
      echo "load wait ended: refusing after ${load_waited}s; last load $load_start > $threshold" >&2
      return 2
    fi
    sleep "$(awk "BEGIN { print ($poll < $remaining ? $poll : $remaining) }")"
    load_start=$(cut -d' ' -f1 "$source")
  done
  load_waited=$(awk -v now="$EPOCHREALTIME" -v began="$began" 'BEGIN { printf "%.6f", now-began }')
  if ((announced)); then echo "load wait ended: waited ${load_waited}s; start load $load_start <= $threshold" >&2; fi
  return 0
}
