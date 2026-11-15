#!/usr/bin/env bash
set -euo pipefail
# A private network/mount namespace: fixed provider hosts cannot reach the internet.
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
scratch=$(mktemp -d /tmp/opencode/bench-matrix-tls-XXXXXX)
trap 'rm -rf "$scratch"' EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=api.anthropic.com' \
  -addext 'subjectAltName=DNS:api.anthropic.com,DNS:console.anthropic.com' \
  -addext 'basicConstraints=critical,CA:FALSE' -keyout "$scratch/key.pem" -out "$scratch/cert.pem" 2>/dev/null
echo '127.0.0.1 localhost api.anthropic.com console.anthropic.com' > "$scratch/hosts"
export NODE_EXTRA_CA_CERTS="$scratch/cert.pem" SSL_CERT_FILE="$scratch/cert.pem"
export OMNI_BENCH_CERT="$scratch/cert.pem" OMNI_BENCH_TLS_KEY="$scratch/key.pem"
unshare -Urnm bash -c '
  set -euo pipefail
  ip link set lo up
  mount --bind "$1/hosts" /etc/hosts
  shift
  exec bun "$@"
' bash "$scratch" "$script_dir/bench-gateway.ts" --matrix "$@"
