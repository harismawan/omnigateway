# CLI migration differences

The registry and help mirror the frozen TypeScript CLI, including commands whose
handlers have not yet been ported. Those commands exit 1 with
`<command> is not yet available in the Rust CLI`, before opening an installation.
Implemented handlers currently cover keys, settings, and models except dry-run.
Setup Claude and opencode also implement file generation and five-question model
mapping. Interactive multi-prompt commands complete in Rust where frozen TS
aborts after the first answer on Bun 1.4.4. Setup conformance replaces only the
TS prompt adapter via `run`'s injection seam; single-prompt and non-TTY errors
still use the real TS CLI. Plugin code is never imported and pluginFailures is
always empty.

`admin set-password` accepts piped secrets and hidden terminal confirmation.
Terminal input requires the platform `stty` utility. Password changes use the
shared Argon2id implementation; existing gateway sessions remain alive until
restart, matching TS. Multi-question terminal flow uses the authorized divergence
above. `status` and database commands remain unavailable.

All five plugin commands exit 1 with `plugins are not supported in this release`
on stderr, also under `--json` (the TS runner has no JSON error envelope).
Refusal precedes argument parsing and installation access. Help/version retain
their normal early-exit precedence. No plugin code, filesystem writes, or network
requests are performed.

Help intentionally retains TypeScript grouping: setup, logs export, and quota
subcommands have individual help but are absent from the top-level groups.
