#!/usr/bin/env bash
set -euo pipefail
work="$(realpath "$2")"
mkdir -p "$work/home" "$work/tmp"
hosts='chatgpt.com api.anthropic.com cloudcode-pa.googleapis.com auth.openai.com'
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=chatgpt.com' -addext "subjectAltName=DNS:${hosts// /,DNS:}" -addext 'basicConstraints=critical,CA:FALSE' -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null
echo "127.0.0.1 localhost $hosts" > "$work/hosts"
exec unshare -Urnm env -i PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/home/homebrew/.bun/bin:/home/linuxbrew/.linuxbrew/bin HOME="$work/home" TMPDIR="$work/tmp" bash -euc 'ip link set lo up; mount --bind "$2/hosts" /etc/hosts; exec bun --no-env-file conformance/cli/quota-operations.ts "$1" "$2"' bash "$(realpath "$1")" "$work"
