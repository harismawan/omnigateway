#!/usr/bin/env bash
set -euo pipefail
# Usage: bash conformance/e2e/connect-ns.sh TS RUST /tmp/opencode/a15/RUN
scratch="$3"
case "$scratch" in /tmp/opencode/a15/*|/tmp/opencode/b4/connect2/*) ;; *) exit 2 ;; esac
mkdir -p "$scratch"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=auth.openai.com' -addext 'subjectAltName=DNS:auth.openai.com,DNS:api.openai.com,DNS:chatgpt.com,DNS:claude.ai,DNS:api.anthropic.com,DNS:platform.claude.com,DNS:accounts.google.com,DNS:oauth2.googleapis.com,DNS:www.googleapis.com,DNS:cloudcode-pa.googleapis.com,DNS:daily-cloudcode-pa.googleapis.com' -addext 'basicConstraints=critical,CA:FALSE' -keyout "$scratch/key.pem" -out "$scratch/cert.pem" 2>/dev/null
echo '127.0.0.1 localhost auth.openai.com api.openai.com chatgpt.com claude.ai api.anthropic.com platform.claude.com accounts.google.com oauth2.googleapis.com www.googleapis.com cloudcode-pa.googleapis.com daily-cloudcode-pa.googleapis.com' > "$scratch/hosts"
exec unshare -Urnm bash -c '
set -euo pipefail
ip link set lo up
mount --bind "$3/hosts" /etc/hosts
bun --no-env-file conformance/e2e/connect.ts --ts "$1" --rust "$2" --work "$3" --cert "$3/cert.pem" --key "$3/key.pem"
' bash "$1" "$2" "$scratch"
