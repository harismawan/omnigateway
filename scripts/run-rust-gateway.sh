#!/bin/sh
# Production launch policy for the slice1 Rust binary. Set before process
# startup: mimalloc initializes before main, and mutating process environment
# inside Rust is unsafe. Operators may override the allocator policy explicitly.
set -eu
: "${MIMALLOC_PURGE_DELAY:=1}"
export MIMALLOC_PURGE_DELAY
exec "${OMNI_RUST_BINARY:-$(dirname "$0")/../target/release/omnigateway}" "$@"
