#!/usr/bin/env bash
set -euo pipefail
# No provider traffic can leave this loopback-only network namespace.
scratch="$3"
mkdir -p "$scratch"
hosts='daily-cloudcode-pa.googleapis.com oauth2.googleapis.com cloudcode-pa.googleapis.com accounts.google.com www.googleapis.com'
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=daily-cloudcode-pa.googleapis.com' -addext 'subjectAltName=DNS:daily-cloudcode-pa.googleapis.com,DNS:oauth2.googleapis.com,DNS:cloudcode-pa.googleapis.com,DNS:accounts.google.com,DNS:www.googleapis.com' -addext 'basicConstraints=critical,CA:FALSE' -keyout "$scratch/key.pem" -out "$scratch/cert.pem" 2>/dev/null
echo "127.0.0.1 localhost $hosts" > "$scratch/hosts"
export NODE_EXTRA_CA_CERTS="$scratch/cert.pem" SSL_CERT_FILE="$scratch/cert.pem"
exec unshare -Urnm bash -c '
set -euo pipefail
ip link set lo up
mount --bind "$3/hosts" /etc/hosts
bun --no-env-file conformance/e2e/antigravity.ts --ts "$1" --rust "$2" --work "$3" --cert "$3/cert.pem" --key "$3/key.pem"
' bash "$1" "$2" "$scratch"
