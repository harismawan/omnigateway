# Rust packaging and launch policy

Release archives contain the stripped `omnigateway` binary, an `omni` symlink,
and the Bun-built dashboard in `public/`. Keep that directory beside the binary,
or set `OMNI_STATIC_DIR`. Verify archives against the release's `SHA256SUMS`.
Linux builds use native musl toolchains on amd64 and arm64; macOS builds use
native runners. The Docker image retains its name, port, user, data volume and
healthcheck, with `omni` also available on PATH.

## Allocator launch policy

The accepted benchmark policy is `MIMALLOC_PURGE_DELAY=1`, set **before** process
startup. Docker sets this default; Kubernetes inherits it from the image.
Operators may override it explicitly. For a checkout, use
`scripts/run-rust-gateway.sh`. For an installed binary's systemd unit, include:

```ini
[Service]
Environment=MIMALLOC_PURGE_DELAY=1
ExecStart=/usr/local/bin/omnigateway
```

The Rust service installer is not implemented in this migration slice. Until it
is, install/update the unit manually and run `systemctl daemon-reload` before
restarting. Preserve the existing environment/root settings. F3 must carry the
same allocator default into generated units and the final TS npm notice.

For a shell launch of a release archive, use
`MIMALLOC_PURGE_DELAY=${MIMALLOC_PURGE_DELAY:-1} ./omnigateway`.

## First Rust promotion (operator action)

Before tagging the first Rust release, set the repository Actions variable
`FIRST_RUST_RELEASE=true`. The promotion job opens its normal PR but leaves it
unmerged. Complete the conformance/performance and production-copy gates first.
Include the `strategy: {type: Recreate}` deployment change in that promotion PR
(the separate `feat/rust-first-rollout` branch carries this change)
(remove `rollingUpdate`), inspect the image tag, then merge **by hand**. Do not
deploy the strategy change independently in advance. Expect brief downtime:
all TS pods must stop before Rust starts against the same Postgres/Redis/root.

After the first successful rollout, restore `RollingUpdate` with `maxSurge: 1`
and `maxUnavailable: 0` for subsequent Rust-to-Rust releases, and remove/set
false `FIRST_RUST_RELEASE` to resume normal auto-promotion. Rollback to TS also
requires Recreate: stop Rust, then start the previous TS image, with no data
conversion. The first Rust release must introduce no new migrations.
