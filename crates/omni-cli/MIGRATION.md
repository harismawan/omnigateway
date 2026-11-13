# CLI migration differences

The registry and help mirror the frozen TypeScript CLI, including commands whose
handlers have not yet been ported. Those commands exit 1 with
`<command> is not yet available in the Rust CLI`, before opening an installation.
Implemented handlers currently cover keys, settings, and models except dry-run.

All five plugin commands exit 1 with `plugins are not supported in this release`
on stderr, also under `--json` (the TS runner has no JSON error envelope).
Refusal precedes argument parsing and installation access. Help/version retain
their normal early-exit precedence. No plugin code, filesystem writes, or network
requests are performed.

Help intentionally retains TypeScript grouping: setup, logs export, and quota
subcommands have individual help but are absent from the top-level groups.
