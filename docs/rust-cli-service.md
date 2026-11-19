# Rust CLI service boundary

`omni start`, `stop`, `restart`, `service install`, `service uninstall`, and
`doctor` manage the local installation. The release archive contains
`omnigateway` and its `omni` symlink; service launch resolves the symlink to the
canonical server identity. A standalone CLI needs an existing adjacent
`omnigateway` companion. It never builds one, launches Bun, or guesses a global
installation path.

Foreground start inherits output and emits no CLI success document, including
with `--json`. Detached start captures output in the existing shared state/log
location. Both pass the selected root's resolved environment; `--db` remains a
CLI database override, not a child environment override. Systemd units retain a
required `<root>/.env`, `Restart=on-failure`, and explicit user/system scope.
`stop` and `restart` do not accept `--system`; restart is stop followed by start.

Doctor retains `gatewayEntrypoint` but reports the actual Rust executable. It
audits usage rollups without repairing them and checks pins, provider availability,
usage-policy and smart-routing readiness. Available providers are OpenAI,
Anthropic, Antigravity, and custom endpoints; deferred catalog entries are not
treated as executable providers.

Plugins remain unsupported. Doctor reads directory/manifest metadata only,
never executes plugin code, and marks each installed plugin non-loadable with
an explicit unsupported problem. Unavailable metadata is null; orphan plugin
table checks are null/not checked, never a fabricated clean result. No plugin
tables are removed. This is a deliberate migration boundary, not plugin runtime
compatibility. Native Darwin supervision has not been established by Linux tests.
Doctor may open/migrate a database through the ordinary store constructor; the
rollup audit itself only reads. Unavailable database diagnostics stay null.

## E4 public API boundary inventory

- `omni_control::diagnostics::report(&SqliteStore) -> Result<Value, String>`:
  database/operator input only; fixed-shape scalar readiness and diagnostic strings.
- `omni_control::plugins::doctor_metadata(&Path) -> Option<Value>`: local manifest
  metadata only, existing manifest validator; no plugin code execution. Returns
  owned operator report, not request-path JSON.
- `omni_store::diagnostics::audit_rollup(&Connection) -> Result<(i64,i64), StoreError>`:
  scalar bucket/mismatch counts only, no mutation or retained JSON.

The IR/dialects/providers signature tripwire does not cover control/store;
their E4 additions are inventoried here rather than incorrectly widening its TSV.
