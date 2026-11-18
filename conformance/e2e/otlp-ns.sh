#!/usr/bin/env bash
set -euo pipefail
TS=$(realpath "$1")
RUST=$(realpath "$2")
OUT=$(realpath -m "$3")
mkdir -p "$OUT"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$OUT/key.pem" -out "$OUT/cert.pem" -days 1 -subj /CN=api.anthropic.com -addext 'subjectAltName=DNS:api.anthropic.com' -addext 'basicConstraints=critical,CA:FALSE' >"$OUT/openssl.log" 2>&1
unshare -Urnm bash -c '
set -euo pipefail
ip link set lo up
cp /etc/hosts "$3/hosts"
echo "127.0.0.1 api.anthropic.com" >> "$3/hosts"
mount --bind "$3/hosts" /etc/hosts
exec env -i PATH=/usr/sbin:/usr/bin:/bin:/home/homebrew/.bun/bin:/home/linuxbrew/.linuxbrew/bin bun --no-env-file conformance/e2e/otlp.ts --ts "$1" --rust "$2" --out "$3/work" --cert "$3/cert.pem" --key "$3/key.pem"
' bash "$TS" "$RUST" "$OUT"
