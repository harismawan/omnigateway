#!/usr/bin/env bash
# CLI OAuth oracle. No provider request may leave this private namespace.
set -euo pipefail
work="$(realpath "$2")"
mkdir -p "$work/home" "$work/tmp"
hosts='auth.openai.com api.anthropic.com oauth2.googleapis.com www.googleapis.com cloudcode-pa.googleapis.com'
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=auth.openai.com' -addext "subjectAltName=DNS:${hosts// /,DNS:}" -addext 'basicConstraints=critical,CA:FALSE' -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null
echo "127.0.0.1 localhost $hosts" > "$work/hosts"
exec unshare -Urnm env -i PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/home/homebrew/.bun/bin:/home/linuxbrew/.linuxbrew/bin HOME="$work/home" TMPDIR="$work/tmp" bash -c '
set -euo pipefail
ip link set lo up
mount --bind "$2/hosts" /etc/hosts
bun --no-env-file conformance/cli/credentials-network.ts "$1" "$2"
python3 conformance/cli/credentials-tty.py "$1" "$2"
' bash "$(realpath "$1")" "$work"
