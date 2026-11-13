# CLI migration differences

The registry and help mirror the frozen TypeScript CLI, including commands whose
handlers have not yet been ported. Those commands exit 1 with
`<command> is not yet available in the Rust CLI`, before opening an installation.
Implemented handlers currently cover keys, settings, and models except dry-run.

Help intentionally retains TypeScript grouping: setup, logs export, and quota
subcommands have individual help but are absent from the top-level groups.
