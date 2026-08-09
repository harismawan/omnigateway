# Agent Client Context and Setup Design

**Date:** 2026-08-09
**Status:** Implemented, except section 6 (`/v1/responses`), which is deferred

## Goal

Make the three coding agents an operator actually points at this gateway — Claude Code,
opencode, and the Codex CLI — size their context correctly against a virtual model, and
have the gateway generate the configuration each one needs.

Every one of them decides when to compact from a context window it learned locally. None
of them learns it from `GET /v1/models`. A window that is wrong in either direction is a
silent failure: too small and the agent compacts away work it still needed, too large and
it fills past the upstream's cap and the request is rejected mid-session.

Codex is a different case from the other two. It cannot talk to this gateway at all.

## What was measured

All against the real binaries on Linux, driving a stub server that logged every request
path, the `model` field, and headers. Claude Code runs used a fresh `CLAUDE_CONFIG_DIR`
each time so no cached state carried over.

### Claude Code 2.1.226

1. `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` gates the *fetch* only. Unset, the client
   issues no models request; set, it issues exactly one `GET /v1/models?limit=1000`.
2. The response does not reach model resolution. With the stub advertising
   `{"id": "opus", "display_name": "Claude Opus 5"}`, `--model opus` still put
   `claude-opus-5` on the wire — the built-in alias table won.
3. The response does not reach context sizing. With the stub advertising
   `{"id": "gpt-5.6-sol", "max_input_tokens": 272000}`, the client printed *"gpt-5.6-sol"
   is not a model this version of Claude Code recognizes, so auto-compact will keep this
   session within 200k tokens* — while holding that listing in hand.
4. `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is consulted only for a model the built-in table does
   not know, and only when the resolved id does not begin with `claude-`.
   `--model claude-mypool` with the variable set still reported 200K; `--model sol-pool`
   with the same variable set reported no warning.
5. `[1m]` is a client-side assumption plus a header. `--model 'gpt-5.6-sol[1m]'` sent
   `model=gpt-5.6-sol` with `context-1m-2025-08-07` added to `anthropic-beta`. The suffix
   never reaches the wire; the beta always does.
6. `modelOverrides` is keyed by the canonical first-party id.
   `{"claude-opus-5": "gpt-5.6-sol"}` with `--model opus` sent `model=gpt-5.6-sol` and
   silenced the unknown-model warning. `{"sonnet": "..."}` did nothing.

### opencode 1.17.20

7. Works against this gateway today, unchanged. Given a provider entry using
   `@ai-sdk/openai-compatible` with `options.baseURL` ending in `/v1`, it drove
   `POST /v1/chat/completions` with the pool id as `model`. The context window is
   whatever `models.<id>.limit.context` in the config says; nothing is fetched.

### Codex CLI 0.147.0

8. `wire_api = "chat"` is refused at startup, not at request time:

   ```
   Error loading config.toml: `wire_api = "chat"` is no longer supported.
   How to fix: set `wire_api = "responses"` in your provider config.
   ```

9. With `wire_api = "responses"` it sends every request to `POST /v1/responses`, ~49 KB
   for a one-line prompt, and retries five times against a failure. It never touches
   `/v1/chat/completions`.

**This gateway does not serve `/v1/responses`.** `apps/gateway/src/routes/proxy.ts`
registers `/v1/messages`, `/v1/chat/completions` and `/v1/models`. So Codex CLI cannot use
OmniGateway at all — the setup file is not the missing piece, the endpoint is.

### The references

CLIProxyAPI's Claude dialect emits the same `display_name` / `max_input_tokens` /
`max_tokens` this gateway already emits (`internal/registry/model_registry.go`), and gets
correct windows only because its ids are real Anthropic ids. OmniRoute says it outright in
`docs/guides/CLAUDE-CODE-CONFIGURATION.md`: Claude Code "can't read a real window from
`/v1/models`", and its answer is a generated profile per model carrying the window in an
environment variable. Its opencode plugin carries the same lesson from the other side — a
`limit.context` of zero silently disables opencode's compaction, so its tests assert the
value is positive rather than merely present.

The conclusion this design rests on: **a gateway cannot push a context window to any of
these clients.** It can only be written into configuration they read at startup. What the
gateway can fix is everything around that — which pools are visible, whether an id
survives to the router, whether a 1M request is honest, whether token accounting has an
endpoint to ask, and whether Codex can connect at all.

## Scope

1. Correct the `/v1/models` claim in `CLAUDE.md`.
2. Optional Claude Code discovery mirrors, so pools appear in its model picker.
3. `[1m]` suffix handling and capability-gated forwarding of the 1M beta.
4. `POST /v1/messages/count_tokens`, answered from a local estimate.
5. `omni setup claude`, `omni setup opencode`, `omni setup codex`, and a dashboard snippet
   per client.
6. `POST /v1/responses` ingress, without which item 5's Codex half is a file describing a
   connection that cannot be made.

Not in scope: the Claude Code *gateway protocol* (RFC 8414 discovery, RFC 8628 device
flow, TLS pinning, `/managed/settings`) — the mode in which a model list is genuinely
consumed, large enough for its own spec. Also not in scope: enforcing context limits at the
gateway. `Target.contextWindow` stays advertised, never enforced.

Item 6 is the largest piece here and could reasonably be split into its own spec. It is
kept together because the Codex setup command is meaningless without it, and because
deciding the two separately risks a config writer that emits a `base_url` nothing answers.

## 1. The documentation claim

`CLAUDE.md` says `GET /v1/models` "is the only place the gateway states how much context a
model holds, and a client told nothing falls back to its own default — 200K in Claude
Code's case". The first half stays true. The second implies the field prevents that
fallback, and measurement 3 shows it does not.

The bullet is rewritten to say what the field is for — OpenAI-dialect clients that do read
it — and to record that Claude Code ignores it, naming the version measured. A reader
without this will debug the gateway for a client-side rule.

## 2. Discovery mirrors (Claude Code)

Per OmniRoute's `ccDiscoveryAliases.ts`, Claude Code's picker lists only ids beginning with
`claude` or `anthropic`. Pools named `opus`, `sonnet`, `gpt-5.6-sol` all fail that filter,
so turning discovery on today yields an empty custom list.

`modelListBody` gains derived mirror entries. For each virtual model whose id does not
already begin with `claude` or `anthropic` — a plain prefix match, because the picker's own
filter is one, so `claude-opus-5` is already visible and needs no second name — it appends:

```jsonc
{
  "id": "claude/gpt-5.6-sol",
  "root": "gpt-5.6-sol",
  "display_name": "GPT 5.6 Sol (OmniGateway)",
  // every other field copied from the real entry, limits included
}
```

The prefix is `claude/`, not `claude-`, and that is load-bearing: measurement 4 shows the
client ignores `CLAUDE_CODE_MAX_CONTEXT_TOKENS` for ids starting with `claude-`. A mirror
named `claude-gpt-5.6-sol` would be visible in the picker and permanently stuck at 200K.
`claude/gpt-5.6-sol` is visible *and* still overridable.

Mirrors are derived at listing time, never stored, and skipped when the id would collide
with a real pool, so a pool can never be shadowed by a synthetic entry.

**Ingress strips the prefix before the key policy is applied.** This is the security
constraint of the feature: allowlists are enforced against the real id, and a key denied
`gpt-5.6-sol` must be equally denied `claude/gpt-5.6-sol`. Stripping after the check turns
the mirror into a bypass. The listing is filtered by the same rule, so a mirror appears
only when its real pool does.

Off by default, behind `OMNI_EXPOSE_CLAUDE_CODE_ALIASES` (`1`/`true`/`yes`/`on`), read once at
boot like the rest of the gateway's startup configuration. An installation whose clients are
not Claude Code should not have its catalog doubled; OmniRoute reached the same default
independently.

*As built:* the gate is that environment variable rather than a stored setting. A stored
one would have meant a `Settings` field, a control schema change, a console form that types
its limits as numbers, and a CLI `settings set` that parses only numbers — four edits to
express a boot-time toggle. `claude/` is also reserved at the point a model is named:
`modelSchema` refuses a pool id in that namespace, because such a pool would be shadowed by
its own mirror rule and become unaddressable.

## 3. `[1m]` and the 1M beta (Claude Code)

The client sends `context-1m-2025-08-07` whenever the operator typed `[1m]`, and the
gateway forwards `anthropic-beta` unchanged — so a target without 1M context takes an
upstream 400 on an unsupported beta. Meanwhile the OpenAI and Kimi encoders have no
`anthropic-beta` at all, so the beta vanishes silently while the client goes on filling a
megabyte against a 272,000-token Codex cap.

The beta is a claim about the target, so the target decides:

- Ingress accepts an `<id>[1m]` suffix, strips it before resolution, and treats it as
  equivalent to the beta being present. The client already strips it; this covers a caller
  passing the raw string through.
- The Anthropic encoder forwards `context-1m-2025-08-07` only when the resolved target's
  catalog entry declares 1M support, recording `anthropic:context-1m-dropped` otherwise.

*As built:* no new flag was needed. The catalog already records `contextWindow`, and
Anthropic's 1M window is the default on the models that have it rather than an opt-in tier,
so support is `contextWindow >= 1_000_000`. The beta is dropped only where the catalog
positively reports something smaller — a model the catalog does not list is an operator's
own id, about which nothing is known, and guessing "no" there would break a custom 1M target
that works today.

## 4. `POST /v1/messages/count_tokens`

The route does not exist, so the client gets a 404. CLIProxyAPI serves it
(`internal/api/server_routes.go:76`). Claude Code's own bundled gateway document says a
backend that cannot count should answer `501 not_supported`, after which the client falls
back to a Haiku `max_tokens: 1` probe — a real request against the operator's pool for
every count.

The gateway answers from a local estimate. No upstream call, no credential, no round trip,
and one answer for all three providers — an Anthropic-only implementation would have
nothing to say about a Kimi target, which is when a client most needs the number.

The estimate must count every block class. OmniRoute's `#6221` is the cautionary tale:
counting only `text` returned near-zero for real agentic conversations, because roughly 95%
of their tokens live inside tool results, and Claude Code's auto-compaction quietly stopped
firing until the upstream rejected the request. The estimator walks the whole canonical
request — text, image placeholders, tool-use input JSON, tool-result content, thinking
text, the system prompt, mid-conversation system turns, and tool definitions including
their schemas.

It lives in `packages/ir` as a pure function over `ChatRequest`: provider-independent and
side-effect-free, as the boundary rules require, and testable without a gateway.

The response is `{"input_tokens": <n>}`. The route authenticates exactly as `/v1/messages`
does, applies the same model allowlist, and is rate limited. It writes no request-log row:
nothing was dispatched, no tokens were spent, and a row would corrupt usage aggregation.

The number is an estimate and the spec says so out loud. It paces compaction; it does not
bill.

## 5. Generated client configuration

Since the window cannot be pushed, the gateway generates the configuration that carries it.
Every writer reads the same figures the `/v1/models` listing resolves, so a pool cannot be
described one way to a client and another way to the operator.

Three commands share one shape: resolve the installation root, read the virtual models and
their limits through `@omni/control`, and write files through an injected filesystem seam.
`--dry-run` prints what would be written. No command writes a live credential unless
`--key` is passed; the default is a placeholder, because a generated file that quietly
contains a key is a file that ends up in a screenshot.

### `omni setup claude`

One profile per virtual model under `~/.claude/profiles/<slug>/settings.json`
(`--dir` overrides), `<slug>` being the pool id percent-encoded into one collision-free path segment:

```jsonc
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:9000",
    "ANTHROPIC_AUTH_TOKEN": "<your OmniGateway key>",
    "ANTHROPIC_MODEL": "claude/gpt-5.6-sol",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "272000"
  }
}
```

Rules, each from a measurement above:

- `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is written only when the window is known *and* the id
  the client resolves does not begin with `claude-`. Writing it otherwise produces a file
  that silently does nothing.
- `ANTHROPIC_MODEL` names the mirror id when aliases are on, the real id otherwise.
- One profile per model, because the variable is process-global. That is the entire reason
  profiles exist rather than one settings file.

### `omni setup opencode`

One provider entry covering every pool, written to `opencode.json` (`--dir` overrides,
default the current project). opencode needs no per-model profile: its config names a
window per model, so one file describes the whole catalog.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "omnigateway": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OmniGateway",
      "options": { "baseURL": "http://localhost:9000/v1", "apiKey": "<your key>" },
      "models": {
        "gpt-5.6-sol": {
          "name": "GPT 5.6 Sol",
          "limit": { "context": 272000, "output": 128000 }
        }
      }
    }
  }
}
```

`baseURL` is normalised to end in exactly one `/v1`, accepting a root or a `/v1` form —
OmniRoute's helper does the same, having presumably been given `/v1/v1` more than once. A
model whose window is unknown is written **without** a `limit` key rather than with a zero:
per OmniRoute's plugin tests, `limit.context: 0` disables opencode's compaction outright,
which is worse than the default.

### `omni setup codex`

One `~/.codex/config.toml` fragment (`--dir` overrides). Codex holds a single active model
with a single window, so per-model files are per-*profile* here:

```toml
model                          = "gpt-5.6-sol"
model_provider                 = "omnigateway"
model_context_window           = 272000
model_auto_compact_token_limit = 240000
tool_output_token_limit        = 32768

[model_providers.omnigateway]
name                 = "OmniGateway"
base_url             = "http://localhost:9000/v1"
env_key              = "OMNIGATEWAY_API_KEY"
requires_openai_auth = false
wire_api             = "responses"
```

`wire_api` is `responses` unconditionally — measurement 8 shows any other value refuses to
start. `env_key` names an environment variable rather than holding the key, which is
Codex's own design and removes the question of whether to write a credential.
`model_auto_compact_token_limit` is set below the window; OmniRoute's guide reports that
Codex silently ignores a value above 90% of `model_context_window`, so the writer clamps
there. That 90% figure is from their documentation and has not been verified here.

### Dashboard

A copyable block per client on the settings surface, rendering the same content, key always a
placeholder so a screenshot cannot leak one. It calls `/api/*` only.

*As built:* the files are generated server-side and served by `GET /api/agent-setup?client=`,
not built in the browser. The console cannot import `@omni/control`, and a console deriving
each window from the catalog itself would eventually disagree with the gateway about what a
pool holds. The path is `/api/agent-setup` rather than `/api/setup` because the latter is
already the first-run admin-password route.

## 6. `POST /v1/responses`

Measurements 8 and 9 make this a prerequisite rather than an enhancement: Codex CLI speaks
only the OpenAI Responses API, and this gateway has no such route.

The work is an ingress and an egress, not a new provider. The canonical IR already carries
everything a Responses request expresses, and `packages/providers/src/openai/decode.ts`
already parses Responses *upstream* events — `response.output_item.added`,
`response.reasoning_summary_text.delta`, `response.completed` and the rest — because the
OpenAI adapter routes OAuth credentials to Codex. What is missing is the mirror image:

- `apps/gateway/src/ingress/responses.ts` — parse a Responses request body into
  `ChatRequest`: `input` items to messages, `instructions` to the system prompt,
  `tools`/`tool_choice`, `reasoning.effort`, `max_output_tokens`, `store` and
  `previous_response_id` rejected explicitly rather than ignored, since this gateway keeps
  no server-side conversation state.
- `apps/gateway/src/egress/responses.ts` — render IR back out as `response.created`,
  `response.output_item.added`, the delta events, and `response.completed` with usage, plus
  the buffered form for a non-streaming caller.
- The route in `proxy.ts`, authenticated and allowlisted exactly as the other two client
  surfaces are.

Usage mapping is the subtle part and is already documented in `CLAUDE.md`: the Responses
API names its cached share `input_tokens_details.cached_tokens`, not the
chat-completions spelling, and `Usage.inputTokens` in this codebase is the uncached
remainder. The egress must add the parts back for the surface, exactly as
`promptTokens()` does elsewhere, or every Codex session under-reports its prompt.

A Responses request routed to an Anthropic or Kimi target is translated like any other:
the ingress produces IR, and the existing encoders decide what survives, recording
degradations for what does not. That is the property that makes this worth doing at all —
it is not a Codex-to-OpenAI passthrough, it is a third dialect over the same core.

## Testing

- Listing: mirrors appear only when the setting is on; are skipped on collision and on
  already-prefixed ids; carry the real entry's limits; and are filtered by key allowlist
  exactly as their real pool is.
- Ingress: `claude/<id>` resolves to `<id>`; a key denied `<id>` is denied `claude/<id>`
  with the same status and error shape; `<id>[1m]` resolves to `<id>`.
- Encoder: the 1M beta survives to a target that supports it, is dropped with a degradation
  for one that does not, on both the Anthropic and non-Anthropic paths.
- Estimator: a conversation whose tokens are almost entirely inside `tool_result` blocks
  returns a count of the right order, not near-zero. This is the `#6221` regression guard
  and the single most important test in the change.
- `count_tokens`: requires auth, honours the allowlist, rejects a malformed body with the
  Anthropic error envelope, writes no request-log row.
- Responses surface: streaming and buffered, tool calls, reasoning, and the cached-token
  field name; a request naming `previous_response_id` is refused with a clear error rather
  than silently losing history; an unsupported feature routed to a Kimi target records a
  degradation instead of vanishing.
- CLI: each writer produces the documented file; Claude's context variable is omitted for a
  `claude-` id and for an unknown window; opencode omits `limit` rather than writing zero;
  codex always writes `wire_api = "responses"` and clamps auto-compact to 90%; `--dry-run`
  writes nothing; no real key is written without `--key`.
- Dashboard: each snippet renders the chosen model's window and never the real key.

## Open questions

- The token-per-character ratio for the estimator. Claude Code's own fallback uses 4
  characters per token. Starting there is defensible; tuning against `/v1/messages` usage
  reports afterwards is a follow-up, not a blocker.
- Whether `count_tokens` should be reachable unauthenticated for parity with `/health`. It
  should not — it accepts a full prompt body, and an unauthenticated echo of prompt size is
  an information leak. Recorded because the question will be asked.
- Whether the mirror prefix should be configurable. It should not, until something breaks:
  one prefix is one rule to strip, and the value is chosen for a specific client behaviour
  rather than taste.
- Whether section 6 ships as its own spec and plan. It is roughly the size of sections 1–5
  combined, and nothing else here depends on it — only `omni setup codex` does.
