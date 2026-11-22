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

`omni service install` generates the unit. When installing or updating a unit
manually, run `systemctl daemon-reload` before restarting. Preserve the
existing environment/root settings and carry the same allocator default into
the unit.

For a shell launch of a release archive, use
`MIMALLOC_PURGE_DELAY=${MIMALLOC_PURGE_DELAY:-1} ./omnigateway`.

## Image promotion

Promotion is automated: the release's gitops job points
`k8s/kustomization.yaml` at the new image tag and merges its PR; Argo CD
deploys on merge. The deployment rolls (`RollingUpdate`, `maxSurge: 1`,
`maxUnavailable: 0`); the gateway drains on SIGTERM, so in-flight streams
finish on the old replica while the new one starts.
