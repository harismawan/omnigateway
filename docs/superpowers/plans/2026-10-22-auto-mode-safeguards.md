# Auto-mode Safeguards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve genuine Anthropic server-side classifier results through streaming and buffered OmniGateway responses.

**Architecture:** Carry opaque provider metadata through IR rather than adding Anthropic-specific logic to dispatch. Preserve protocol headers and avoid tool-name/system rewriting on safeguard requests; restore results only on the matching Anthropic client surface.

**Tech Stack:** Bun, TypeScript, Elysia, existing provider codecs and `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-22-auto-mode-safeguards-design.md`

## Global Constraints

- Never fabricate a verdict or promise free classification; Anthropic decides eligibility.
- IR remains provider-independent; outbound HTTP uses the existing injected HttpClient.
- Preserve absent versus explicit null results and opaque nested values.
- No live provider calls or deployment changes.
- Ordinary OAuth behavior remains unchanged.

## Review Focus

- Unsupported/unavailable/null/empty results survive unchanged, rather than turning into allow verdicts.
- Multiple tool IDs retain their exact association with flagged and unflagged results.
- Missing results and non-Anthropic responses never acquire Anthropic metadata.
- Client protocol headers survive without forwarding gateway authorization credentials.
- Safeguard requests do not change tool names/inputs or system attribution blocks; ordinary requests keep prior behavior.

---

### Task 1: Preserve response metadata end to end

**Files:**
- Modify: `packages/ir/src/stream.ts`
- Modify: `packages/providers/src/anthropic/decode.ts`
- Modify: `apps/gateway/src/egress/anthropic.ts`
- Test: `apps/gateway/test/routes/autoModeSafeguards.test.ts` (new)

**Interfaces:**
- Consumes: existing `decodeAnthropic`, `collect`, `anthropicStream`, `anthropicResponse`.
- Produces: optional `vendor?: Record<string, Record<string, unknown>>` on terminal StreamEvent and CollectedResponse; `vendor.anthropic.safeguard_results` holds the original value.

- [x] Write synthetic HTTP regression tests using the real Anthropic adapter and proxy routes. For streaming and buffered calls assert exact safeguard results, including two original tool IDs, unknown nested fields, flagged/not-flagged, unsupported/unavailable, null/empty/absent cases. Assert no leakage on OpenAI egress.
- [x] Run `bun test apps/gateway/test/routes/autoModeSafeguards.test.ts`; confirm missing-result assertions fail for the intended reason.
- [x] Add provider-keyed terminal metadata, decode the actual upstream results, preserve it in `collect()`, and restore it on Anthropic streaming/buffered egress. Keep absence distinct from null.
- [x] Run the new suite and `bun test packages/ir/test packages/providers/test/anthropic.test.ts apps/gateway/test/egress/anthropic.test.ts`; expect passing assertions and no regressions.

### Task 2: Preserve classifier request identity and headers

**Files:**
- Modify: `packages/ir/src/request.ts`
- Modify: `apps/gateway/src/ingress/anthropic.ts`
- Modify: `packages/providers/src/anthropic/codec.ts`
- Test: `apps/gateway/test/routes/autoModeSafeguards.test.ts`
- Test: `packages/providers/test/anthropicCodec.test.ts`

**Interfaces:**
- Consumes: existing unknown-field passthrough and client beta parsing.
- Produces: optional `providerHeaders?: Record<string, Record<string, string>>` on ChatRequest, populated with incoming `anthropic-*` headers. Codec-owned authentication is never derived from it.

- [x] Add failing assertions for upstream safeguards, version/workspace/custom capability headers, OAuth beta preservation, unchanged tool name/input/history IDs, and unchanged client system blocks. Add an ordinary OAuth control test retaining current cloak/system behavior.
- [x] Run focused tests and confirm the expected header/system/tool regressions.
- [x] Forward only the protocol header namespace; preserve incoming beta values while adding required OAuth values. Detect a non-empty safeguards list in the provider codec, disable its tool cloak and system/attribution rewriting for that request, and keep unrelated requests unchanged. Ensure wire construction does not add an OAuth system prefix to protected requests.
- [x] Run focused tests plus `bun test packages/providers/test/anthropicCodec.test.ts packages/providers/test/anthropicCloak.test.ts apps/gateway/test/ingress/anthropic.test.ts`; expect pass.

### Task 3: Document and verify compatibility

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `CLAUDE.md` only if a new contributor invariant needs a durable pointer.

**Interfaces:**
- Consumes: behavior and tests from Tasks 1–2.
- Produces: operator guidance explaining upstream eligibility, deployment/new-session requirements, `/status` verification, and the separately billed `CLAUDE_CODE_AUTO_MODE_SERVER=0` fallback.

- [x] Update operator and architectural documentation without claiming universal gateway transparency or guaranteed free classification.
- [x] Review the complete diff for dropped metadata, tool identity changes, auth leakage, cross-provider leakage, and absent-versus-null semantics. Independent review found a Ponytail snapshot override; real-route regressions failed first, then passed after preserving current IR additions/cache placement.
- [x] Run `bun run test:all`, `bun run typecheck`, `bun run lint`, `bun run check:claims`, and `bun run check:dead`. Record actual output and external-service skips; fix only task-related failures.
- [x] Report implementation/tests and remaining need for deployment and an upstream-backed Claude Code session check. Do not deploy or commit without user authorization.

## Verification outcome

- Independent review's important Ponytail override regression fixed with two RED→GREEN real-route tests.
- `bun run test:all`: core 4644 pass, 15 external-service skips, 0 fail; dashboard 726 pass, 0 fail.
- Typecheck, lint, stale claims, dead exports, and diff whitespace checks passed.
- Deferred minor: non-Anthropic-upstream → Anthropic-egress metadata absence regression coverage.
- Live upstream eligibility/OAuth acceptance/no-charge status still needs deployment and a new Claude Code session.
- Work remains uncommitted in the isolated, externally managed detached worktree.
