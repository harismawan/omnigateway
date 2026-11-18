#!/usr/bin/env bash
# Full A9 composition. Every child gets private HOME/TMPDIR and no inherited env.
set -euo pipefail
ts=$(realpath "$1")
rust=$(realpath "$2")
work=$(realpath -m "$3")
repo=$(cd "$(dirname "$0")/../.." && pwd)
mkdir -p "$work/home" "$work/tmp"
path="$(dirname "$(command -v bun)"):/usr/local/bin:/usr/bin:/bin:/usr/sbin"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=auth.openai.com' \
  -addext 'subjectAltName=DNS:auth.openai.com' -addext 'basicConstraints=critical,CA:FALSE' \
  -keyout "$work/key.pem" -out "$work/cert.pem" 2>"$work/cert.log"
echo '127.0.0.1 localhost auth.openai.com' > "$work/hosts"
exec env -i HOME="$work/home" TMPDIR="$work/tmp" PATH="$path" \
  S9_CERT="$work/cert.pem" S9_KEY="$work/key.pem" \
  NODE_EXTRA_CA_CERTS="$work/cert.pem" SSL_CERT_FILE="$work/cert.pem" \
  unshare -Urnm bash -c '
set -euo pipefail
ip link set lo up
cd "$1"
ts=$2; rust=$3; work=$4
mount --bind "$work/hosts" /etc/hosts
bun --no-env-file conformance/e2e/stream-handshake.ts "$ts" "$work/handshake-ts"
bun --no-env-file conformance/e2e/stream-handshake.ts "$rust" "$work/handshake-rust" "$work/handshake-ts" authoritative
for mode in normal closed phase idle; do
  if [[ $mode == normal ]]; then args=(); else args=("$mode"); fi
  python3 conformance/e2e/stream-lifecycle.py "$rust" "$work/handshake-rust" "$work/lifecycle-$mode.json" "${args[@]}"
done
bun --no-env-file conformance/e2e/stream-publish.ts "$ts" "$rust" "$work/publish"
python3 conformance/e2e/stream-console.py "$ts" "$rust" "$work/console"
python3 conformance/e2e/stream-pressure.py "$ts" "$rust" "$work/pressure"
' bash "$repo" "$ts" "$rust" "$work"
