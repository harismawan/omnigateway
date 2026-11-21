# OpenAI migration checkpoint

The TypeScript contract is `packages/providers/src/openai/`. The detailed handoff is
`b3-report.md` in the controller's `2026-11-07-rust-slice-1-benchmarkable` SDD directory.

The API-key endpoint uses Responses and always requests SSE; buffered clients
collect that stream. Its cache-affinity headers require the unkeyed thread-ID
derivation even before the OAuth/lite increment. OAuth additionally requires
Codex 0.170.0 lite history, salted identity, account selection and zstd.

Reuse the shared IR ownership/JSON, SSE, HTTP and OAuth host contracts. Keep
provider selection isolated so other providers acquire no new request work.
Do not add an upstream JSON-response mode absent from the TypeScript codec.
