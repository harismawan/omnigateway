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

## Provider quota operations

Run `bash conformance/cli/quota-operations-ns.sh CLI_BINARY SCRATCH` for
private TLS provider-stub pairs. OpenAI, Anthropic and Antigravity usage
probes persist snapshots and changed history; OpenAI and Anthropic support
reset-credit listing and confirmed redemption. Expiring credentials reuse
the existing E2 OAuth refresh/CAS path. No scheduler or gateway quota routes
are introduced. Stub coverage includes JSON/human, explicit all/credit,
confirmation/cancel/refusal, provider failures and failed post-reset reads.
