# npm release notice for 1.0.0

**Superseded draft.** The earlier plan, a final TS npm release that pointed
users at GitHub binaries, was replaced by the
[npm distribution design](superpowers/specs/2026-11-21-rust-npm-distribution-design.md):
`omnigateway@1.0.0` on npm is the Rust gateway, installed fresh. There is no
final TS release and no automatic migration; `0.15.5` stays published. The
user-facing text lives in the README section "Coming from 0.x"; the operator
procedure is in the [cutover runbook](rust-cutover-runbook.md).

## Release notes text for v1.0.0

```text
omnigateway 1.0.0 is the Rust gateway: a native binary for Linux x64/arm64 and
macOS x64/arm64, installed by npm. It is a fresh install and converts nothing.
It reads an existing 0.x SQLite database in place: stop the old service, back
up, then `omni service install --force --root <old root>` and start it. Keep
the same .env and OMNI_ENCRYPTION_KEY.

No longer served: plugins, and Grok/Kimi/Kilo/Muse/Qoder accounts.
Windows: no native build (npm refuses 1.x there).
Cluster (Postgres/Redis) installations: follow the cutover runbook.
```
