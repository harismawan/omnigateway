# B3: the OpenAI / Codex provider (parallel track)

Project: migration of an LLM API gateway from TypeScript (Bun) to Rust. The frozen TypeScript is the behaviour reference and is never edited. The Rust gateway must send the same bytes upstream (headers in order and casing, body) and the same bytes to clients.

- Worktree: /home/homebrew/.local/share/opencode/worktree/1600a1/rust-providers
- Branch: feat/rust-provider-openai, based on 8f6f84f9 (main branch after the Anthropic/OAuth merge).
- Never modify another checkout, except writing b3-report.md in /home/homebrew/code/omnigateway/.superpowers/sdd/2026-11-07-rust-slice-1-benchmarkable/ ("the sdd directory").
- Other agents: the main checkout has an implementer on crates/omni-gateway/src/client_routes.rs, crates/omni-control, crates/omni-store read queries; the CLI worktree owns crates/omni-cli and crates/omni-control/src/database.rs. Keep your changes in crates/omni-providers (new module `openai/`), the provider registration/adapter-selection points, and conformance/e2e. If you must touch crates/omni-gateway/src/dispatch.rs or refresh.rs, keep the edit minimal and name it in the report.

## Authority (frozen TS, never edit)
packages/providers/src/openai/ (codec.ts, wire.ts, decode.ts, profile.ts, oauth.ts, models.ts, codexIdentity.ts, codexLite.ts, codexCatalog.ts, descriptor.ts — about 2,350 lines) and what they import from packages/providers/src (codecAdapter.ts, headers.ts, profile.ts, oauthFlow.ts, oauthRequests.ts, sse.ts, responseFormat.ts, system.ts). Tests with captured literals: packages/providers/test/openai*.test.ts. Spec: docs/superpowers/specs/2026-11-07-rust-gateway-migration-design.md (wire compatibility section).

## The pattern to follow (already in Rust, reviewed and merged)
crates/omni-providers/src/anthropic/ (codec.rs, wire.rs, body.rs, decode.rs, profile.rs, oauth.rs, vendor.rs, cloak.rs) and crates/omni-providers/src/{adapter.rs, codec.rs, oauth.rs, sse.rs}. The Anthropic track's report b1-b2-report.md is long; read only its first 60 lines (structure, how the real-TS differential and the e2e driver were built). Reuse the shared OAuth refresh framework (crates/omni-gateway/src/refresh.rs, the token_version compare-and-swap in omni-store) — do not write a second one.

## Rules that cost the previous provider six review rounds — apply them from the start
1. Deeply nested JSON. Request and response JSON may be nested about 40,000 levels by policy; releasing, cloning or walking such a value recursively exceeds a 2 MiB stack and stops the process. Use the helpers in crates/omni-ir/src/deep.rs (iterative release, insert, clone, the deep scope) for every arbitrary-JSON value you hold, replace or drop. Three source tripwires will fail on your code until you comply or record a justified exception: crates/omni-ir/tests/json_writes.rs (plain `.insert`/index writes on JSON), crates/omni-ir/tests/public_json_boundary.rs (+ .tsv: every public function in omni-providers/omni-dialects/omni-ir is inventoried with a reason; prefer `pub(crate)`), owner_reexports.tsv. Read the header comments of those tests first.
2. Add your provider to the small-stack lifecycle tests in crates/omni-gateway/tests/dispatch_depth.rs (success, failover, upstream error, cancellation, deep response buffered and streamed, gated disconnect) — same subprocess pattern; each case must be shown able to fail once.
3. No work added to the ordinary request path of other providers: no scans, clones or allocations for custom or Anthropic requests. Adapter selection must stay a cheap comparison.
4. Reports state only what was observed; anything by inspection is labelled so. A claim like "covers X" needs a run in which removing X's protection fails.

## Scope
- Request encoding from the IR for all three client dialects into the OpenAI/Codex upstream wire (Responses API as the frozen code does it), including tools, reasoning, images/files, prompt-cache key, the Codex identity/instructions handling and "lite" mode exactly as codexIdentity.ts / codexLite.ts decide; response decode (JSON and SSE) back to IR; error mapping and retry classification; profile headers (user agent, versions, originator, ordering, environment overrides); API-key and OAuth (ChatGPT/Codex account) modes, including account-id handling; OAuth refresh request/response exactly as oauth.ts; model list/catalog wiring as models.ts / codexCatalog.ts (generated descriptors already exist — check).
- Out of scope: /api/connect/* HTTP routes (roadmap A15 — implement only the provider-side start/finish/poll functions they will call); quota/usage polling (B10); websocket transport if the frozen provider has one (say so and stop there); dashboard.

## Verification
- Port the cases and captured literals of packages/providers/test/openai*.test.ts to Rust.
- A real-TS differential: run the frozen encoder/decoder in Bun over a generated corpus (all dialect pairs, tools, reasoning, images, cache key, lite/identity variants, malformed upstream SSE, errors) and compare bytes — the Anthropic track has this harness; extend it.
- Black-box: conformance/e2e with TS and Rust gateway binaries against a recording stub upstream, with an OpenAI API-key credential and an OAuth credential (stub token endpoint): upstream request bytes (headers in order and casing + body) and client response bytes equal after masking ids/timestamps; refresh on 401/expiry, refresh contention, token_version conflict. conformance/e2e/anthropic.ts and anthropic-ns.sh show how (TLS/hosts namespace); binaries must run from OUTSIDE any checkout.
- `cargo test --offline` and `cargo clippy --offline --all-targets -- -D warnings` for omni-ir, omni-dialects, omni-providers, omni-store, omni-gateway-core, omni-gateway, omni-router; `cargo fmt --all -- --check`; existing drivers still pass (anthropic 30, oauth 7, run.ts, surface.ts). CARGO_INCREMENTAL=0, CARGO_PROFILE_DEV_DEBUG=0, CARGO_PROFILE_TEST_DEBUG=0. A release binary with a manifest (commit, sha256) under /tmp/opencode/b3/bin/ at the end; do not run scripts/bench-gateway.ts (the controller benchmarks).
- Disk is tight (about 11 GB free): remove driver scratch directories once recorded; evidence under /tmp/opencode/b3/.

## Rules
Failing test or comparison first. No subagents, no `unsafe`, no new dependency without stating why, no edits to product TypeScript or bun.lock; no push, no merge. Append-only commits, one per green step. Keep reads small (grep first, sections of at most 200 lines).

Write b3-report.md in the sdd directory: status; scope item → commits → tests with counts; which comparisons failed first; every known difference from TS; what is out of scope and why; gate counts with log paths; binary commit and sha256. If you run short of context, commit what passes and put the precise next step at the top of the report — a finished request encoder with its differential is better than everything half done.
