#!/usr/bin/env bash
set -euo pipefail
ts=$(realpath "$1")
rust=$(realpath "$2")
out=$(realpath -m "$3")
mkdir -p "$out/home" "$out/tmp"
hosts='chatgpt.com api.anthropic.com cloudcode-pa.googleapis.com auth.openai.com'
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=chatgpt.com' -addext "subjectAltName=DNS:${hosts// /,DNS:}" -addext 'basicConstraints=critical,CA:FALSE' -keyout "$out/key.pem" -out "$out/cert.pem" 2>/dev/null
echo "127.0.0.1 localhost $hosts" > "$out/hosts"
exec unshare -Urnm env -i PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/home/homebrew/.bun/bin:/home/linuxbrew/.linuxbrew/bin HOME="$out/home" TMPDIR="$out/tmp" bash -euc 'ip link set lo up; mount --bind "$3/hosts" /etc/hosts; exec bun --no-env-file conformance/e2e/quota-gateway.ts "$1" "$2" "$3"' bash "$ts" "$rust" "$out"
