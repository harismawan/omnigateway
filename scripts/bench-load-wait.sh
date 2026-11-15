#!/usr/bin/env bash
# BENCH_TEST_LOAD_FILE is solely for deterministic guard tests.
wait_for_load() {
  local source=${BENCH_TEST_LOAD_FILE:-/proc/loadavg}
  local threshold=${MAX_LOAD:-1} bound=${LOAD_WAIT:-600} poll=${LOAD_POLL:-5}
  local began=$SECONDS announced=0 remaining
  load_begin=$(cut -d' ' -f1 "$source")
  load_start=$load_begin
  load_waited=0
  if [[ ${ALLOW_BUSY:-0} == 1 ]]; then return 0; fi
  while awk "BEGIN { exit !($load_start > $threshold) }"; do
    if ((announced == 0)); then
      echo "load wait started: load $load_begin > $threshold (limit ${bound}s)" >&2
      announced=1
    fi
    load_waited=$((SECONDS - began))
    remaining=$((bound - load_waited))
    if ((remaining <= 0)); then
      echo "load wait ended: refusing after ${load_waited}s; last load $load_start > $threshold" >&2
      return 2
    fi
    sleep "$(awk "BEGIN { print ($poll < $remaining ? $poll : $remaining) }")"
    load_start=$(cut -d' ' -f1 "$source")
  done
  load_waited=$((SECONDS - began))
  if ((announced)); then echo "load wait ended: waited ${load_waited}s; start load $load_start <= $threshold" >&2; fi
  return 0
}
