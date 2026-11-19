# Rust quota runtime (B10)

The single-node gateway probes OAuth usage for OpenAI, Anthropic and Antigravity.
Custom/API-key credentials remain unsupported for usage probes. Deferred providers
and plugins are not enabled by this work. No live provider validation is claimed.

`quotaPollIntervalMs` is captured at boot; zero disables the initial pass and timer.
Otherwise polling begins without delaying listen, with at most four accounts in
flight and no overlapping passes. The same quota instance services operator refresh
and the timer. Per-account probes coalesce; 429 puts only usage probing into a
three-minute cooldown. Empty/failed probes retain the old snapshot. They do not
disable the credential. OAuth refresh uses the existing versioned CAS refresher.

Worker capacity counts active attempts, not completed out-of-order results; final
outcomes are reordered by account index. Admitted refresh/list/reset operations
have completion owners independent of HTTP waiters. Reset ownership retains the
account lock across list/spend/reread, without adding retries. Shutdown drains
these operations within the existing grace. Gateway-injected completion notification
runs after persistence/publication, even if a manual caller disconnects; scheduled
passes keep their existing single unconditional notification.

Provider quotas remain observations, not gateway counters. Snapshot and deduplicated
history writes use the existing control transaction. Every persistence operation
enters the A10 registered owner/access barrier; no SQLite connection or owner guard
crosses an upstream await. Shutdown stops the timer and drains admitted probes
within the shared shutdown grace. Quota invalidation is emitted after writes/pass.

## Public API inventory

- `omni_control::quota_runtime::{Host,Task,Quota}`: injected host, typed credential
  reads/token retrieval/transport/save/clock. `Quota::new`, `refresh`, `credits`,
  `redeem`, `drain` are the caller-independent orchestration boundary. JSON results
  contain only quota outcomes/credits, never secrets or upstream error text.
  `poll` suppresses manual notification because its scheduler owns that event;
  `Host::completed` is an injected completion callback, with no transport in control.
- `omni_control::quota_ops::history`: bounded operator history plus gateway rates,
  retained-span clamp and optional account filter applied before the sample cap.
- `omni_gateway::quota::{GatewayHost,start,route,serve}`: runtime adapter, timer,
  route table/HTTP handler; admin-only network mutations, reader history.
- Existing E3 `QuotaRequest` and provider parsers are reused unchanged; no new
  provider assembly API. CLI quota commands use an injected control host too;
  command flags, confirmation and output remain CLI-owned and unchanged.

Cluster coordination remains D4: in-process account locks/cooldowns are not a
distributed quota lease. No PostgreSQL gateway integration or multi-node guarantee
is added here. Frozen cross-process successful-reading suppression is not claimed
for this single-node implementation.

Tests: `quota_runtime::tests` covers shared probes, cancellation/drain and quota-only
cooldown; `quota::tests::quota_host_uses_registered_owner_after_restore` covers owner
re-entry. `conformance/e2e/quota-gateway-ns.sh` pairs supported HTTP flows against the
frozen gateway with private TLS stubs, including token-refresh reuse and boot ticks.
