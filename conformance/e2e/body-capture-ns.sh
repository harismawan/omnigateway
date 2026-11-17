#!/usr/bin/env bash
set -euo pipefail
# Usage: body-capture-ns.sh TS RUST SCRATCH (fresh scratch required).
scratch="$3"
mkdir -p "$scratch"
scratch="$(realpath "$scratch")"
mkdir "$scratch/home"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=api.anthropic.com' -addext 'subjectAltName=DNS:api.anthropic.com,DNS:console.anthropic.com' -addext 'basicConstraints=critical,CA:FALSE' -keyout "$scratch/key.pem" -out "$scratch/cert.pem" 2>/dev/null
echo '127.0.0.1 localhost api.anthropic.com console.anthropic.com' > "$scratch/hosts"
exec env -i HOME="$scratch/home" CARGO_HOME=/home/homebrew/.cargo PATH=/usr/sbin:/usr/bin:/bin:/home/homebrew/.bun/bin:/home/linuxbrew/.linuxbrew/bin NODE_EXTRA_CA_CERTS="$scratch/cert.pem" SSL_CERT_FILE="$scratch/cert.pem" unshare -Urnm bash -c '
set -euo pipefail
ip link set lo up
mount --bind "$3/hosts" /etc/hosts
exec bun --no-env-file conformance/e2e/body-capture.ts --ts "$1" --rust "$2" --scratch "$3/driver" --cert "$3/cert.pem" --key "$3/key.pem"
' bash "$1" "$2" "$scratch"
