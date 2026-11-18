#!/usr/bin/env bash
set -euo pipefail
binary=$(realpath "$1")
out=$(realpath -m "$2")
mkdir -p "$out/root" "$out/home" "$out/tmp"
# Private root supplies /.dockerenv without creating anything in the host root.
unshare -Urnm bash -c '
set -euo pipefail
ip link set lo up
root="$2/root"
mount -t tmpfs tmpfs "$root"
mkdir -p "$root/usr" "$root/home" "$root/tmp" "$root/proc" "$root/dev" "$root/etc"
for dir in usr home tmp dev etc proc; do mount --rbind "/$dir" "$root/$dir"; done
ln -s usr/bin "$root/bin"
ln -s usr/lib "$root/lib"
ln -s usr/lib64 "$root/lib64"
touch "$root/.dockerenv"
exec env -i PATH=/usr/sbin:/usr/bin:/bin:/home/homebrew/.bun/bin:/home/linuxbrew/.linuxbrew/bin HOME="$2/home" TMPDIR="$2/tmp" chroot "$root" /home/homebrew/.bun/bin/bun --no-env-file "$3/conformance/e2e/lifecycle-exit.ts" "$1" "$2"
' bash "$binary" "$out" "$PWD"
