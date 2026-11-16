#!/usr/bin/env bash
set -euo pipefail
# All gateway traffic is confined to loopback, including external-provider probes.
scratch="$3"
[[ "$scratch" == /tmp/opencode/c1/w-* ]] || exit 2
mkdir -p "$scratch"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=api.openai.com' -addext 'subjectAltName=DNS:api.openai.com' -addext 'basicConstraints=critical,CA:FALSE' -keyout "$scratch/key.pem" -out "$scratch/cert.pem" 2>/dev/null
echo '127.0.0.1 localhost api.openai.com' > "$scratch/hosts"
export PATH="/home/homebrew/.bun/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin"
exec unshare -Urnm bash -c '
set -euo pipefail
ip link set lo up
mount --bind "$3/hosts" /etc/hosts
bun --no-env-file conformance/e2e/smart-router.ts --ts "$1" --rust "$2" --work "$3" --cert "$3/cert.pem" --key "$3/key.pem"
' bash "$1" "$2" "$scratch"
