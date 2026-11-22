#!/usr/bin/env bash
# Pretraffic bucket sweep: remove the long-window limiter buckets (`omni:b:*`, counts and
# their `:meta` companions) from the fleet's Redis/Valkey, as docs/rust-cluster-bucket-sweep.md
# requires after a Postgres lineage change, DB restore/replacement or xid-domain change.
# Nothing else is touched: sessions (`omni:kv:*`), leases, locks, 1m windows and gauges keep
# their keys.
#
# Run only with EVERY gateway writing to this database stopped. This script cannot check
# that. One connection scans one node: point it at a standalone server or a proxy, not at
# one member of a Redis Cluster.
#
#   OMNI_REDIS_URL=redis://… scripts/cluster-bucket-sweep.sh            # dry run: count only
#   OMNI_REDIS_URL=redis://… scripts/cluster-bucket-sweep.sh --apply    # count, UNLINK, verify
#
# Needs `valkey-cli` or `redis-cli` with `--csv` (override with REDIS_CLI=…). The password is
# taken out of the URL and handed over as REDISCLI_AUTH, so it is not in the CLI's argv; an
# ACL username stays in the URL. `rediss://` adds `--tls` (the CLI must be built with TLS).
# `omnigateway cluster-bucket-sweep` does the same sweep from inside the gateway binary.
set -euo pipefail
export LC_ALL=C

apply=0
url="${OMNI_REDIS_URL:-}"
for arg in "$@"; do
  case "$arg" in
    --apply) apply=1 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
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

# SCAN in `--csv`: one reply per line, every name a double-quoted field with `\"`, `\\`, `\n`
# and `\xHH` escapes. That is the same quoting redis-cli parses on stdin, so a field is handed
# back to UNLINK verbatim and round-trips byte for byte — a name holding a newline or any
# other byte stays one name. Names are never decoded, word-split or globbed.
#
# fields LINE: the quoted fields of one CSV line, one per output line.
fields() {
  awk '{
    line = $0; i = 1; n = length(line)
    while (i <= n) {
      if (substr(line, i, 1) != "\"") { i++; continue }
      j = i + 1
      while (j <= n) {
        c = substr(line, j, 1)
        if (c == "\\") { j += 2; continue }
        if (c == "\"") break
        j++
      }
      if (j > n) { print "unterminated CSV field" > "/dev/stderr"; exit 3 }
      print substr(line, i, j - i + 1)
      i = j + 1
    }
  }'
}

# Every matching name as a quoted field, one per line, via a full SCAN to cursor 0. SCAN may
# repeat a name and may return empty pages before the end; both are fine. A reply that is not
# a quoted numeric cursor (an error, an empty reply) stops the script rather than looping.
scan_all() {
  local cursor=0 out page
  while :; do
    out="$(r --no-raw --csv SCAN "$cursor" MATCH "$pattern" COUNT "$batch")"
    page="$(printf '%s\n' "$out" | fields)"
    cursor="${page%%$'\n'*}"
    [[ "$cursor" =~ ^\"[0-9]+\"$ ]] || { echo "unexpected SCAN reply: ${out:0:120}" >&2; return 1; }
    cursor="${cursor//\"/}"
    [[ "$page" == *$'\n'* ]] && printf '%s\n' "${page#*$'\n'}"
    [ "$cursor" = "0" ] && break
  done
}

pong="$(r PING)" || { echo "cannot reach Redis" >&2; exit 1; }
[ "$pong" = "PONG" ] || { echo "unexpected PING reply: $pong" >&2; exit 1; }

before="$(scan_all | sed '/^$/d' | sort -u)"
count=0
[ -z "$before" ] || count="$(printf '%s\n' "$before" | wc -l | tr -d ' ')"
meta="$(printf '%s\n' "$before" | grep -c ':meta"$' || true)"
echo "found $count $pattern keys ($meta :meta companions)"

# Defence in depth: every field must be a quoted name inside the namespace.
if [ -n "$before" ] && printf '%s\n' "$before" | grep -q -v '^"omni:b:.*"$'; then
  echo "a SCAN field is not a quoted $pattern name; refusing" >&2
  exit 1
fi

if [ "$apply" -eq 0 ]; then
  printf '%s\n' "$before" | awk 'NF && n++ < 5 {print "  e.g. " $0}'
  echo "dry run: nothing removed. Re-run with --apply once every gateway is stopped."
  exit 0
fi

removed=0
if [ "$count" -gt 0 ]; then
  # One UNLINK per returned name, the quoted field passed back as is, through one pipelined
  # connection; a name already gone answers 0, which is fine.
  removed="$(
    printf '%s\n' "$before" | sed 's/^/UNLINK /' |
      r --raw | awk '/^[0-9]+$/ {s += $1} END {print s + 0}'
  )"
fi
echo "unlinked $removed"

left="$(scan_all | sed '/^$/d' | sort -u | wc -l | tr -d ' ')"
if [ "$left" -ne 0 ]; then
  echo "verification scan still finds $left $pattern keys: a writer is live, or re-run" >&2
  exit 1
fi
echo "verified: 0 $pattern keys remain"
