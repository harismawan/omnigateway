# Using the gateway from a client

What a client sees on `/v1/*`: the endpoints, how to authenticate, the rate-limit
headers a response carries, how confidential routing shows, and how tools decide where a request can go. Operator
setup is in the [README](../README.md); compatibility rules and measured client
behaviour are in the specs under `superpowers/specs/`.

## Endpoints

| Method | Path | Compatible with |
| --- | --- | --- |
| `POST` | `/v1/messages` | Anthropic Messages API |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions API |
| `POST` | `/v1/responses` | OpenAI Responses API (stateless: no stored responses, no `previous_response_id`) |
| `POST` | `/v1/messages/count_tokens` | Anthropic-compatible local token estimation (authenticated) |
| `GET` | `/v1/models` | Listing in both dialects, filtered by your key's allowlist |
| `GET` | `/health` | Unauthenticated liveness check |

Authenticate with either header — sending both is an error:

```http
Authorization: Bearer <gateway-key>
x-api-key: <gateway-key>
```

Ask for one of your virtual models by name. A bare provider model
(`claude-sonnet-5`, `gpt-5`) also works if an account can serve it.

`GET /v1/models` answers both client families from one listing: each entry
carries the OpenAI keys (`object`, `created`, `owned_by`) and the Anthropic ones
(`type`, `display_name`, `created_at`, `max_input_tokens`, `max_tokens`) at
once.

Most tools that accept a custom base URL work unchanged: set it to
`http://127.0.0.1:9000` and use a gateway key where the provider key goes.

## Rate-limit headers

Every response carries the limit headers of the surface you asked on, so an SDK
backs off using the code it already ships — the Anthropic dialect on
`/v1/messages`, the OpenAI one on `/v1/chat/completions` and `/v1/responses`:

```http
anthropic-ratelimit-requests-limit: 2000        x-ratelimit-limit-requests: 2000
anthropic-ratelimit-requests-remaining: 1841    x-ratelimit-remaining-requests: 1841
anthropic-ratelimit-requests-reset: 2026-08-19T14:32:07Z   x-ratelimit-reset-requests: 4h51m22s
```

`requests-remaining` counts the request being answered; `tokens-remaining` does
not and cannot — the response is still being written when the header goes out.
Where a key has several windows on one dimension, the headers report the one
**nearest exhaustion**, not the reassuring ones — and where the key holds the
model you named to a stricter override, that override's windows compete too, so
the header names whichever ceiling will deny first. `spend` and `concurrency`
render on neither dialect, because no vendor defines a header for them. A
refusal is `429` with `Retry-After` in seconds, computed from the oldest request
still inside the window that refused you.

## Confidential routing

If your key has confidential routing on (the client dashboard shows
"Confidential routing: on"), the gateway reads everything a request carries — the
whole conversation, tool results and tool definitions included, not only the last
message — before it is routed. Anything confidential is served by an in-house
model instead of the one you named; images and files are not read. What you can
observe:

- **`x-omni-route: local|external`** on a non-streaming response that was judged,
  saying where the request went (`local` also for a request that already named an
  in-house model). A key without the feature, and a refusal, carry
  no such header. A streaming response has already sent its head by the time the
  request is judged, so it carries none.
- **`model` names where it was served.** A rerouted response reports the
  in-house model's id as `model`, in streaming and non-streaming bodies alike,
  not the model you asked for. A request judged public, or already on an in-house
  model, reports the model it asked for.
- **Refusals.** If the check cannot be made the request is refused rather than
  sent anywhere: `UPSTREAM` (502, "confidentiality check unavailable") when the
  classifier times out or fails, and `INTERNAL` (500, "confidential routing is not
  configured") when the gateway is not set up to serve it. Streaming requests get
  the same as an in-stream `error` event on a 200. The messages are fixed. If the
  in-house model itself fails, you get its failure; the request is never retried
  on an external provider.

Every check is charged to your key as a request of its own, visible on the
dashboard. The check reduces leaks of ordinary confidential content; it is not a
security boundary.

## Tools and routing

Two kinds of tool behave differently, and the difference decides where a
request can go.

A **custom tool** — a name, a description, and a JSON Schema — is portable. It
translates to every provider, so a request using one routes across your whole
pool as usual.

An **Anthropic-defined tool** — web search, web fetch, code execution, Bash,
text editor, computer use, memory, tool search, advisor, or an MCP toolset —
has a schema Anthropic owns. No other provider can express it, so any request
declaring one, *or replaying the blocks a previous one produced*, is routed to
an Anthropic account only. If the virtual model you asked for has no Anthropic
target, the request fails at routing with the unsupported requirement named,
rather than quietly losing the tool.

The gateway forwards the tool version you send and never upgrades it. Betas
stay yours: send `anthropic-beta` yourself, as the tool requires — the gateway
carries the header through but does not add one on your behalf.
