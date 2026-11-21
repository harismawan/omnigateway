# npm release notice for 1.0.0

**Superseded draft.** The earlier plan, a final TS npm release that pointed
users at GitHub binaries, was replaced by the
[npm distribution design](superpowers/specs/2026-11-21-rust-npm-distribution-design.md):
`omnigateway@1.0.0` on npm is the Rust gateway, and `npm update -g` migrates a
single-node service. There is no final TS release. `0.15.5` stays published as
the rollback and Windows version. The user-facing text lives in the README
section "Upgrading from 0.x"; the operator procedure is in the
[cutover runbook](rust-cutover-runbook.md).

## Release notes text for v1.0.0

```text
omnigateway 1.0.0 is the Rust gateway. `npm update -g omnigateway` installs a
native binary (Linux x64/arm64, macOS x64/arm64) and moves a single-node
systemd service onto it: the old gateway is stopped, the database is backed up
to snapshots/db_<time>_preRust.sqlite, the unit's ExecStart is rewritten and
the service is checked on /health. Run the update with
--allow-scripts=omnigateway --foreground-scripts to migrate during the update
and watch it; otherwise the service migrates on its next restart.

Not migrated automatically: cluster (Postgres/Redis) installations, customised
units, and system units updated without root. See the cutover runbook.
No longer served: plugins, and Grok/Kimi/Kilo/Muse/Qoder accounts.
Windows: stay on omnigateway@0.15.5 (npm refuses 1.x there).
Rollback: npm i -g omnigateway@0.15.5, omni db restore <preRust id>,
omni service install --force, start the service.
```
