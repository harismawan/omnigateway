#!/bin/sh
# Production launch policy for the slice1 Rust binary. Set before process
# startup: mimalloc initializes before main, and mutating process environment
# inside Rust is unsafe. Operators may override the allocator policy explicitly.
set -eu
: "${MIMALLOC_PURGE_DELAY:=1}"
export MIMALLOC_PURGE_DELAY
# Parameter expansion avoids spawning dirname during startup. Match dirname's
# no-slash case as well; the installed binary override remains supported.
case "$0" in
  */*) script_dir=${0%/*} ;;
  *) script_dir=. ;;
esac
exec "${OMNI_RUST_BINARY:-$script_dir/../target/release/omnigateway}" "$@"
