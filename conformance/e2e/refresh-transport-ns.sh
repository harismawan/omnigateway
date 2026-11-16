#!/usr/bin/env bash
set -euo pipefail
scratch="$3"
mkdir -p "$scratch"
hosts='auth.openai.com api.openai.com chatgpt.com claude.ai console.anthropic.com api.anthropic.com platform.claude.com accounts.google.com oauth2.googleapis.com www.googleapis.com cloudcode-pa.googleapis.com daily-cloudcode-pa.googleapis.com'
san="DNS:${hosts// /,DNS:}"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=oauth2.googleapis.com' -addext "subjectAltName=$san" -addext 'basicConstraints=critical,CA:FALSE' -keyout "$scratch/key.pem" -out "$scratch/cert.pem" 2>/dev/null
echo "127.0.0.1 localhost $hosts" > "$scratch/hosts"
exec unshare -Urnm bash -c '
set -euo pipefail
ip link set lo up
mount --bind "$3/hosts" /etc/hosts
bun --no-env-file conformance/e2e/refresh-transport.ts --ts "$1" --rust "$2" --work "$3" --cert "$3/cert.pem" --key "$3/key.pem"
' bash "$1" "$2" "$scratch"
