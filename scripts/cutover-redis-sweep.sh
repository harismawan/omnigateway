#!/usr/bin/env bash
# TS→Rust cutover: remove the long-window limiter buckets (`omni:b:*`, counts and their
# `:meta` companions) from the fleet's Redis/Valkey, as docs/rust-cutover-runbook.md §5 step 3
# requires. Nothing else is touched: sessions (`omni:kv:*`), leases, locks, 1m windows and
# gauges keep their keys.
#
# Run only with EVERY gateway (TS and Rust) writing to this database stopped. This script
# cannot check that. One connection scans one node: point it at a standalone server or a
# proxy, not at one member of a Redis Cluster.
#
#   OMNI_REDIS_URL=redis://… scripts/cutover-redis-sweep.sh            # dry run: count only
#   OMNI_REDIS_URL=redis://… scripts/cutover-redis-sweep.sh --apply    # count, UNLINK, verify
#
# Needs `valkey-cli` or `redis-cli` (override with REDIS_CLI=…). The password is taken out of
# the URL and handed over as REDISCLI_AUTH, so it is not in the CLI's argv; an ACL username
# stays in the URL. `rediss://` adds `--tls` (the CLI must be built with TLS).
# `omnigateway cluster-cutover-sweep` does the same sweep from inside the gateway binary.
set -euo pipefail
export LC_ALL=C

apply=0
url="${OMNI_REDIS_URL:-}"
for arg in "$@"; do
  case "$arg" in
    --apply) apply=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg (pass the URL as OMNI_REDIS_URL)" >&2; exit 2 ;;
  esac
done
[ -n "$url" ] || { echo "set OMNI_REDIS_URL" >&2; exit 2; }

cli="${REDIS_CLI:-$(command -v valkey-cli || command -v redis-cli || true)}"
[ -n "$cli" ] && command -v "$cli" >/dev/null ||
  { echo "valkey-cli or redis-cli not found (set REDIS_CLI)" >&2; exit 2; }

# scheme://[user[:password]@]host… — move the password into the environment.
tls=()
case "$url" in
  rediss://*) tls=(--tls) ;;
  redis://*) ;;
  *) echo "OMNI_REDIS_URL must be redis:// or rediss://" >&2; exit 2 ;;
esac
scheme="${url%%://*}://"
rest="${url#*://}"
user=()
if [[ "$rest" == *@* ]]; then
  userinfo="${rest%%@*}"
  rest="${rest#*@}"
  if [[ "$userinfo" == *:* ]]; then
    export REDISCLI_AUTH="${userinfo#*:}"
    userinfo="${userinfo%%:*}"
  fi
  # A user left in `-u` without its password is dropped by the CLI, which then authenticates
  # as `default`; pass it explicitly instead.
  [ -n "$userinfo" ] && user=(--user "$userinfo")
fi
url="$scheme$rest"

pattern='omni:b:*'
batch=1000
r() { "$cli" -u "$url" "${user[@]}" "${tls[@]}" --no-auth-warning "$@"; }

# Every key matching the pattern, one per line, via a full SCAN to cursor 0. SCAN may repeat
# a name and may return empty pages before the end; both are fine. Any reply that is not a
# numeric cursor (an error, an empty reply) stops the script rather than looping.
scan_all() {
  local cursor=0 out
  while :; do
    out="$(r --raw SCAN "$cursor" MATCH "$pattern" COUNT "$batch")"
    cursor="${out%%$'\n'*}"
    [[ "$cursor" =~ ^[0-9]+$ ]] || { echo "unexpected SCAN reply: ${cursor:0:120}" >&2; return 1; }
    [[ "$out" == *$'\n'* ]] && printf '%s\n' "${out#*$'\n'}"
    [ "$cursor" = "0" ] && break
  done
}

pong="$(r PING)" || { echo "cannot reach Redis" >&2; exit 1; }
[ "$pong" = "PONG" ] || { echo "unexpected PING reply: $pong" >&2; exit 1; }

raw="$(scan_all)"
before="$(printf '%s\n' "$raw" | sed '/^$/d' | sort -u)"
count=0
[ -z "$before" ] || count="$(printf '%s\n' "$before" | wc -l | tr -d ' ')"
meta="$(printf '%s\n' "$before" | grep -c ':meta$' || true)"
echo "found $count $pattern keys ($meta :meta companions)"

# Names are handled one per line. A name holding a control character (newline, CR, …) would
# split into fragments that are not keys of this namespace, so refuse before deleting.
if printf '%s' "$raw" | tr -d '\n' | grep -q '[[:cntrl:]]'; then
  echo "a returned name contains a control character; refusing" \
    "(use omnigateway cluster-cutover-sweep)" >&2
  exit 1
fi
if [ -n "$before" ] && printf '%s\n' "$before" | grep -q -v '^omni:b:'; then
  echo "a returned line lies outside $pattern (a name with an embedded newline?); refusing" \
    "(use omnigateway cluster-cutover-sweep)" >&2
  exit 1
fi

if [ "$apply" -eq 0 ]; then
  printf '%s\n' "$before" | awk 'NF && n++ < 5 {print "  e.g. " $0}'
  echo "dry run: nothing removed. Re-run with --apply once every gateway is stopped."
  exit 0
fi

removed=0
if [ "$count" -gt 0 ]; then
  # One UNLINK per returned name, each a single quoted argument (`"` and `\` escaped), through
  # one pipelined connection; a name already gone answers 0, which is fine.
  removed="$(
    printf '%s\n' "$before" | while IFS= read -r name; do
      printf 'UNLINK "%s"\n' "$(printf '%s' "$name" | sed 's/\\/\\\\/g; s/"/\\"/g')"
    done | r --raw | awk '/^[0-9]+$/ {s += $1} END {print s + 0}'
  )"
fi
echo "unlinked $removed"

left="$(scan_all | sed '/^$/d' | sort -u | wc -l | tr -d ' ')"
if [ "$left" -ne 0 ]; then
  echo "verification scan still finds $left $pattern keys: a writer is live, or re-run" >&2
  exit 1
fi
echo "verified: 0 $pattern keys remain"
