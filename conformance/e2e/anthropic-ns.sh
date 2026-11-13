#!/usr/bin/env bash
set -euo pipefail
# Arguments: TS binary, Rust binary, scratch directory. Neither binary may
# reside in a checkout. All namespace mounts disappear on process exit.
scratch="$3"
mkdir -p "$scratch"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=api.anthropic.com' -addext 'subjectAltName=DNS:api.anthropic.com' -addext 'basicConstraints=critical,CA:FALSE' -keyout "$scratch/key.pem" -out "$scratch/cert.pem" 2>/dev/null
echo '127.0.0.1 localhost api.anthropic.com' > "$scratch/hosts"
export NODE_EXTRA_CA_CERTS="$scratch/cert.pem" SSL_CERT_FILE="$scratch/cert.pem"
exec unshare -Urnm bash -c '
set -euo pipefail
ip link set lo up
mount --bind "$3/hosts" /etc/hosts
bun conformance/e2e/anthropic.ts --ts "$1" --rust "$2" --cert "$3/cert.pem" --key "$3/key.pem"
' bash "$1" "$2" "$scratch"
