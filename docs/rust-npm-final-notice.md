# Final npm release notice — DRAFT

**Maintainer draft only.** This file does not publish, deprecate or change any npm
package, README, postinstall hook or release workflow. Do not announce a completed
Rust cutover from this draft. Before using it, the release owner must supply the
final TS npm version, approved Rust tag/assets and a tag-pinned runbook URL, and
close the release gates in the [cutover runbook](rust-cutover-runbook.md).
The current workflow still contains npm publication; changing its release policy
is separate work, not accomplished by writing this notice.

## Proposed final TS npm README/release notice

The final TypeScript/Bun release of `omnigateway` on npm is **[FINAL_TS_VERSION]**.
It remains published and requires Bun; installing it does not install or switch
your service to Rust. Future gateway releases move to native Rust binaries and
the container image, not a new npm runtime package.

When the approved Rust release is available, get its platform archive and
`SHA256SUMS` from [GitHub Releases](https://github.com/harismawan/omnigateway/releases).
Rust release targets are Linux x86_64/aarch64 and macOS x86_64/aarch64; there is no
Windows Rust binary. The archive includes `omnigateway`, its `omni` symlink and
the `public/` dashboard. Keep them together.

**This is a stop/start migration, not a rolling TS/Rust upgrade.** Back up the
database, captured body artifacts and existing service configuration, and retain
the unchanged `OMNI_ENCRYPTION_KEY` securely. Stop the old TS service before
starting Rust. Linux service users must reinstall the unit from the new release
with `omni service install --force` using the existing root and correct service
scope; the old Bun entrypoint is not automatically redirected. Cluster operators
must use the approved manual Recreate procedure and invalidate actual Redis
bucket/companion keys before Rust preseeding. Never run both implementations
against the same data.

The first Rust scope serves Anthropic, OpenAI/Codex, Antigravity and custom
endpoints. Grok, Kimi, Kilo, Muse and Qoder are deferred; retained accounts are not
served by Rust. Plugins are unsupported, although their stored data remains.
The plugin API and dashboard SDK packages remain published but frozen; that is
not Rust plugin compatibility. Ponytail is not carried into this release scope.
CLI administration is local SQLite only; use the admin HTTP surface for a fleet.
If your installation depends on those features or deferred providers, postpone
migration rather than assuming silent fallback.

Read the [cutover and rollback runbook](rust-cutover-runbook.md) before changing
an installation. It covers root/environment selection, backups, body preservation,
SQLite versus Postgres/Redis, service replacement, health/admin checks and
compatible rollback versions. Do not infer readiness, full data cross-read
compatibility or performance from this notice; use the approved Rust release's
recorded acceptance evidence. The runbook lists the Linux-only console validation,
measured boot and memory limits, and the Postgres overload behavior.

## Proposed short postinstall notice (text only)

```text
OmniGateway: this is the final TypeScript/Bun npm release [FINAL_TS_VERSION].
Future gateway releases use Rust binaries or the container image, not npm.
No service has been migrated by this installation.
Releases: https://github.com/harismawan/omnigateway/releases
Before upgrading, read the approved cutover/rollback runbook: [TAG_PINNED_RUNBOOK_URL]
Stop TS before Rust; preserve your database, body artifacts and encryption key.
Plugins and deferred providers are not supported by the first Rust scope.
```

Replace placeholders only after release approval; link the runbook shipped with
that release rather than relying on a moving branch. Delivery of either notice
through npm and any registry metadata change require separate authorization.
