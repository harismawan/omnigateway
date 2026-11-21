# GPT-6.2 and Codex refresh implementation plan

**Goal:** Add GPT-6.2 Sol and Astra and align the OAuth request fingerprint with Codex 0.170.0.

**Approved scope:** User approved the two models, verified pricing/limits, local capture, and regression tests in chat.

**Scope steering:** Implement TypeScript first; no Rust port changes in this deliverable.

**Architecture:** Keep model data and request encoding in `packages/providers/src/openai`. Derive the fingerprint from a synthetic-login local capture following `scripts/codex-capture/README.md`; preserve API-key behavior and credential-salted IDs.

**Global constraints:** No live provider requests or real credentials. Never commit raw captures or local paths. Version and shape move together. Keep existing model default unless explicitly requested. Verify prices from official model pages rather than inferring from previous generations.

## Task 1: Catalog and captured fingerprint

- [x] Read existing fingerprint and client-identity specs, code and tests.
- [x] Capture pinned Codex 0.170.0 TUI and tool-history replay using scratch installation and synthetic login.
- [x] Verify official GPT-6.2 pricing and limits and release model metadata.
- [x] Add failing regression assertions for both models and the sanitized new capture.
- [x] Implement catalog entries and measured fingerprint changes; preserve existing auth-leg and replay behavior.
- [x] Run focused provider/catalog/routing tests, update current documentation and record capture evidence.
- [x] Independent review of correctness, sanitization, auth separation and test coverage.
- [x] Run CI checks and report unavailable infrastructure or existing failures explicitly.

## Review focus

API-key requests retain their existing encoding; OAuth model limits remain narrower than API limits; unknown model fallback stays usable; native reasoning replay and credential-salted IDs survive; captures contain synthetic identities only.
