# E3 operator reports

Run `bash conformance/cli/observability-ns.sh CLI_BINARY FROZEN_CHECKOUT SCRATCH`.
The oracle checkout must contain the frozen 1780bb39 CLI and packages with
existing dependency resolution. Every Bun invocation disables env-file loading.
The wrapper scrubs inherited environment, supplies private HOME/TMPDIR and
isolates networking. Evidence remains under `/tmp/opencode/e3/corpus-*`.

The corpus compares stdout/stderr/exit exactly (including ANSI under a PTY),
without ID/time/crypto normalization. Export spans multiple 500-row pages;
body fixtures are encrypted by the TS store and decrypted by both CLIs.
Follow checks require the same delta/output and SIGINT termination (-2 or 130).
Fixtures cover empty/populated reads, filters, cursor pagination, human/JSON,
file console filtering, export files, ordinary read failures, and absence states.

## Outstanding provider dependency

`quota refresh`, `quota resets`, and `quota reset` are registered and parse
their frozen options, but provider execution is **not migrated**. This tree's
Rust providers have no quota usage probe, reset-credit listing, or redemption
APIs. Supported-provider invocations fail explicitly rather than claiming a
refresh or spending a credit. Unknown account and unsupported reset-provider
refusals are covered. Provider success/failure stubs and reset confirmation
cannot be release gates until that shared provider operation seam exists.
This is a release blocker for claiming full E3, not an accepted parity difference.
