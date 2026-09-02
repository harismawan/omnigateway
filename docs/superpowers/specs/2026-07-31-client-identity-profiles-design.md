# Per-Provider Client Identity Profiles

**Status:** approved
**Date:** 2026-07-31
**Amends:** `2026-07-31-omnigateway-design.md` § "Client identification"
**Affects:** `2026-07-31-omnigateway-core.md` Tasks 1, 8, 9, 10, 11, 15, 20, 21, 22, 23, 24, 26, 27

## Summary

The gateway sends, on every upstream request, the header set and header order of
the official CLI for that provider — `claude-cli` for Anthropic, `codex-cli` for
OpenAI, `kimi-code-cli` for Kimi — instead of a single `omnigateway/<version>`
User-Agent. Header values, header name casing, and header wire order are all
per-provider. JSON request bodies are serialized in the CLI's field order, and
Anthropic requests additionally carry the `x-anthropic-billing-header` system
block with a valid `cch=` body-integrity token. Operators can override the
version-bearing values and the header order through environment variables.

This reverses the previous "identify honestly" decision. See § Relationship to
the core design.

## Motivation

Provider edges fingerprint non-official clients. A request whose User-Agent
says `omnigateway/0.1.0` while carrying an OAuth token minted by the Claude CLI
is trivially separable from CLI traffic, and separable traffic is actionable
traffic. Matching the CLI's identity removes the cheapest of those signals.

It does not remove all of them. See § Limits.

## Relationship to the core design

`2026-07-31-omnigateway-design.md` § "Client identification" states the gateway
"does **not** send the telemetry and client-version headers the official CLIs
emit (`X-Stainless-*`, pinned CLI version strings, `X-App`)" because "those
headers serve only to make gateway traffic indistinguishable from a first-party
client, which is not a capability this project wants."

That paragraph is superseded. The operator-risk paragraph that follows it is
not: routing subscription OAuth credentials through a proxy may conflict with a
provider's consumer terms independently of how the client identifies itself,
and mimicking a first-party client does not make it permitted. What changes is
that the gateway no longer advertises itself at the point of the request. The
dashboard still states the risk at the point of connecting an account.

The corresponding bullet in the core plan's Global Constraints is rewritten to
match.

## Design

### Client profiles

A profile is an ordered, exactly-cased header set plus a canonical wire order.

```ts
export type HeaderPair = readonly [name: string, value: string];

export type ClientProfile = {
  /** Headers with the CLI's own name casing, in declaration order. */
  readonly headers: readonly HeaderPair[];
  /** Canonical wire order. Matched case-insensitively; unlisted headers append. */
  readonly order: readonly string[];
};
```

Lives in `packages/providers/src/profile.ts`. The package still imports nothing
outside `@omni/ir`, preserving the module boundary in the core plan.

Three pure functions, each testable without touching the environment:

- `stainlessHost(platform, arch)` — maps `process.platform` / `process.arch` to
  the Stainless SDK's spelling (`darwin`→`MacOS`, `linux`→`Linux`,
  `win32`→`Windows`; `arm64`/`x64` pass through). The runtime is reported as
  `node`, never `bun`: the Anthropic SDK the CLI ships has no Bun code path, so
  a truthful `bun` here would be a stronger signal than the one being removed.
- `orderHeaders(pairs, order)` — returns pairs sorted by position in `order`,
  matched case-insensitively but emitted with the pair's original casing;
  headers absent from `order` are appended in insertion order. Follows
  OmniRoute's `orderHeaders` in `open-sse/config/cliFingerprints.ts`.
- `resolveProfile(base, env)` — applies environment overrides to a base profile.

`PROFILES: Readonly<Record<ProviderId, ClientProfile>>` is these functions
applied to `Bun.env` once at module load. The `USER_AGENT` constant is deleted,
not retained as a fallback.

### Profile values

Captured from OmniRoute, which derives them from mitmproxy traces of the real
binaries. `${...}` marks an environment-substitutable value.

**Anthropic** — `open-sse/services/claudeCodeCompatible.ts`,
`src/shared/constants/claudeCodeClient.ts`:

| Header | Value |
| --- | --- |
| `User-Agent` | `claude-cli/${2.1.258} (external, cli)` |
| `x-app` | `cli` |
| `anthropic-dangerous-direct-browser-access` | `true` |
| `X-Stainless-Lang` | `js` |
| `X-Stainless-Package-Version` | `${0.94.0}` |
| `X-Stainless-OS` | from `stainlessHost` |
| `X-Stainless-Arch` | from `stainlessHost` |
| `X-Stainless-Runtime` | `node` |
| `X-Stainless-Runtime-Version` | `${v26.3.0}` |
| `X-Stainless-Retry-Count` | `0` |
| `X-Stainless-Timeout` | request timeout in whole seconds |

**OpenAI** — `open-sse/config/codexClient.ts`:

| Header | Value |
| --- | --- |
| `User-Agent` | `codex-cli/${0.144.1} (${Windows 10.0.26200}; ${x64})` |
| `originator` | `${codex_cli_rs}` |
| `Version` | `${0.144.1}` |
| `Openai-Beta` | `responses=experimental` |
| `X-Codex-Beta-Features` | `responses_websockets` |

**Kimi** — `open-sse/config/providers/registry/kimi/coding/runtime.ts`:

| Header | Value |
| --- | --- |
| `User-Agent` | `kimi-code-cli/${0.26.0}` |
| `X-Msh-Platform` | `kimi_code_cli` |
| `X-Msh-Version` | `${0.26.0}` |

Kimi's four `X-Msh-Device-*` headers are per-credential, not part of the static
profile; see § Kimi device identity.

`X-Stainless-Timeout` is derived from the configured upstream timeout rather
than pinned, matching OmniRoute's `getStainlessTimeoutSeconds`. A profile that
claims a timeout the client does not honour is itself a mismatch.

### Header order

Order arrays for Anthropic and OpenAI are taken from OmniRoute's
`CLI_FINGERPRINTS`, which documents them as mitmproxy captures of the real
binaries. Anthropic's order is Title-Case Stainless keys alphabetically, then
lowercase Anthropic keys alphabetically, then transport headers.

OmniRoute has **no captured fingerprint for Kimi**. Its order array is our own
construction — protocol headers, then identity headers, then transport — and is
marked as such in a comment. It should be replaced if a capture becomes
available.

Two headers in Anthropic's captured order have no counterpart here:
`X-Claude-Code-Session-Id` and `x-client-request-id`. The gateway has no session
concept to populate them with. They are omitted rather than fabricated, and
their absence is a residual signal.

### Transport

**Bun's `fetch` sorts request headers alphabetically before writing them.**
Verified by capturing raw bytes off a `Bun.listen` socket: headers supplied as
an object, a `Headers` instance, or an entry array all arrive in the same
alphabetical order, followed by transport headers. Insertion order is
discarded. Header order is therefore unreachable through `fetch` under Bun.

`node:http` / `node:https` under Bun preserve insertion order and name casing
exactly, including the position of `Host`, `Connection`, and `Content-Length`.
Verified against the same raw socket. Also verified under Bun 1.4.0: TLS
requests to a live endpoint, incremental SSE delivery through a
`ReadableStream` bridge (chunks observed at +67/128/189/260 ms rather than
buffered to completion), and `AbortSignal` producing an `AbortError`.

This is where OmniRoute's approach does not transfer. It runs on Node
(`engines: node >=22.22.2 <23 || >=24.0.0 <27`), where undici's `fetch`
preserves insertion order — verified — so it reorders a plain header record and
hands it to `fetch`. Under Bun that step is undone by the transport.

The adapters therefore move off `fetch` onto an injected client:

```ts
export type HttpRequest = {
  url: string;
  method: string;
  headers: readonly HeaderPair[];   // ordered; sent verbatim
  body: string;                     // already ordered and signed; sent verbatim
  signal: AbortSignal;
};

export type HttpResponse = {
  status: number;
  headers: Headers;                  // response side; order does not matter
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
};

export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

export function nodeHttpClient(): HttpClient;
```

`AdapterRequest` gains `http: HttpClient`. `httpError(res, provider)` retypes
from `Response` to `HttpResponse`. `OAuthDeps.fetch` becomes
`OAuthDeps.http: HttpClient`, so token exchange and refresh carry the same
ordered identity as inference — a token minted by a request that does not look
like the CLI, then used by one that does, is a mismatch a provider can join on.

### Merge precedence

Profile pairs are laid down first, then protocol, auth, and per-credential
headers merged case-insensitively with the later value and its casing winning.
`Authorization`, `x-api-key`, `anthropic-version`, `anthropic-beta`,
`chatgpt-account-id`, and `X-Msh-Device-*` can never be displaced by a profile
or by an environment override. The result is passed through `orderHeaders`
before transport.

The profile applies on both the OAuth and the API-key credential paths.

### Kimi device identity

Kimi rejects requests whose device identity changes between calls, so all four
values are minted once at connect time and persisted in the credential's
`providerData`:

```ts
{ deviceId, deviceName, deviceModel, osVersion }
```

Values are synthetic but stable. They are not read from the real host:
`os.hostname()` would ship the operator's machine name to Moonshot. The adapter
emits `X-Msh-Device-Id`, `-Device-Name`, `-Device-Model`, `-Os-Version` from
them, and token refresh sends the same block.

Existing credentials hold only `deviceId`. Missing values fall back to the same
defaults a fresh credential would generate, so a credential connected before
this change keeps working and keeps its device id.

### JSON body field order

The CLIs emit top-level body fields in a fixed order. `JSON.stringify` follows
object insertion order for string keys, so an ordering pass before serialization
is sufficient — verified under Bun. `orderFields(body, order)` rebuilds the
object with listed keys first and unlisted keys appended in their original
order, mirroring OmniRoute's function of the same name.

Field orders, from `CLI_FINGERPRINTS`:

- **Anthropic** — `model`, `messages`, `system`, `tools`, `tool_choice`,
  `metadata`, `max_tokens`, `temperature`, `thinking`, `context_management`,
  `output_config`, `stream`.
- **OpenAI** — `model`, `stream`, `input`, `instructions`, `store`, `reasoning`,
  `prompt_cache_key`, `tools`, `tool_choice`, `include`, `service_tier`,
  `client_metadata`, `parallel_tool_calls`, `metadata`.
- **Kimi** — no captured fingerprint. Ours: `model`, `messages`, `tools`,
  `tool_choice`, `max_tokens`, `temperature`, `stream`. Marked as
  non-capture-derived in a comment, same as its header order.

One V8 detail constrains this: integer-like string keys are always emitted
first regardless of insertion order (`{b, "2", a}` serializes as `{"2", b, a}`).
No field in any of these orders is integer-like, so the ordering holds — but a
provider that later adds a numeric field name would silently break it. The
ordering helper is documented accordingly.

Ordering happens after the adapter's `toWire` produces the body and before
serialization, so `toWire` stays free to build its object in whatever order
reads best.

### Anthropic body integrity (`cch=`)

Real Claude Code prepends a system block carrying a billing header and an
integrity token over the request body:

```
system[0] = "x-anthropic-billing-header: cc_version=2.1.258.<3 hex>; cc_entrypoint=cli; cch=<5 hex>;"
```

The token is `xxHash64(serialized_body, 0x6e52736ac806831e) & 0xFFFFF`, rendered
as 5 zero-padded lowercase hex characters, computed over the body that already
contains a `cch=00000` placeholder, then substituted back in. Substitution is
length-preserving — 5 hex characters replacing 5 — so the hash stays valid over
the bytes actually sent. Verified: a 204-byte body signs to 204 bytes.

`Bun.hash.xxHash64(bytes, seed)` is native and returns a `bigint`. Verified
against canonical XXH64 vectors: `""` → `ef46db3751d8e999`, `"a"` →
`d24ec4f1a98c6e5b`, `"abc"` → `44bc2cf5ad770999`. No wasm dependency is needed;
OmniRoute's `xxhash-wasm` import exists because Node has no built-in.

`cc_version` is the CLI version plus a three-hex-digit suffix that is **not** a
build revision. Read from the 2.1.258 bundle: the CLI takes the characters at
indices 4, 7 and 20 of the first user text (`"0"` where the text is shorter),
prepends the salt `59cf53e54c78`, appends the version string, SHA-256s that and
keeps the first three hex digits. So the suffix is one value per conversation.
`ccVersionSuffix` in `body.ts` reproduces it; the salt is pinned there beside
`ANTHROPIC_CLI_VERSION`, and a version bump that does not also re-read the salt
from the new bundle produces a wrong suffix that nothing rejects.

An earlier version of this section said the suffix was a static build revision
(`250`) and dismissed the 4/7/20 derivation as unverifiable. That was wrong in
both halves: `250` was one width-correct value the CLI happened to send in one
capture, and the derivation is readable from the bundle.

Two known divergences from the CLI's own value, both still one value per
conversation so the prompt cache is unaffected: the CLI skips its own meta
messages when picking the first user text, which the gateway cannot tell
apart, and Claude Code often puts a `<system-reminder>` block as the first
text block of the first user message, so the hashed characters come from the
reminder rather than the operator's prompt. A first user turn carrying no text
block at all (tool results only) hashes as the empty string.

`cc_entrypoint` is `cli`, matching the `(external, cli)` User-Agent.

**System block pipeline.** Because the billing block joins the caller's system
prompt, the caller's blocks are sanitized first so a third-party agent's
identity does not travel inside a request claiming to be Claude Code. In order:

1. Drop paragraphs containing third-party agent URLs:
   `github.com/anomalyco/opencode`, `opencode.ai/docs`, `github.com/cline/cline`,
   `github.com/getcursor/cursor`, `continue.dev`.
2. Drop paragraphs starting with `You are OpenCode`.
3. Replace `if OpenCode honestly` → `if the assistant honestly`, and
   `Here is some useful information about the environment you are running in:` →
   `Environment context you are running in:`. All occurrences.
4. Prepend `You are a Claude agent, built on Anthropic's Claude Agent SDK.`
5. Prepend the billing header block, which lands at index 0.

Steps 1–3 rewrite the operator's own prompt text. This is a real cost and is
stated plainly: a system prompt mentioning `continue.dev` in passing loses that
paragraph. The rules are narrow and literal — no regex over user content — and
the transformed body is what both the model and the `cch` token see.

The pipeline runs on every Anthropic request, on both the OAuth and API-key
paths, with no kill switch. Ordering within the adapter is: `toWire` → system
pipeline → `orderFields` → `JSON.stringify` → `cch` substitution → transport.

The pipeline is Anthropic-only. OpenAI and Kimi get field ordering and nothing
else.

### Environment overrides

Per-header variables, validated against `/^[\x20-\x7E]{1,200}$/` — OmniRoute's
`SAFE_HEADER_VALUE_PATTERN`. A value failing validation falls back to the
built-in default rather than being sent; a malformed override must not produce
a header no real client would emit.

```
OMNI_UA_ANTHROPIC=                          # replaces the whole User-Agent string
OMNI_ANTHROPIC_CLI_VERSION=2.1.258
OMNI_ANTHROPIC_STAINLESS_PACKAGE_VERSION=0.112.1
OMNI_ANTHROPIC_STAINLESS_RUNTIME_VERSION=v26.3.0
OMNI_ANTHROPIC_STAINLESS_OS=                # blank = derive from host
OMNI_ANTHROPIC_STAINLESS_ARCH=              # blank = derive from host
OMNI_ORDER_ANTHROPIC=                       # comma-separated; blank = built-in order

OMNI_UA_OPENAI=
OMNI_OPENAI_CLI_VERSION=0.144.1
OMNI_OPENAI_ORIGINATOR=codex_cli_rs
OMNI_OPENAI_UA_PLATFORM=Windows 10.0.26200
OMNI_OPENAI_UA_ARCH=x64
OMNI_ORDER_OPENAI=

OMNI_UA_KIMI=
OMNI_KIMI_CLI_VERSION=0.26.0
OMNI_ORDER_KIMI=

# cc_version suffix is derived per conversation (see `ccVersionSuffix`), not configurable
```

`OMNI_UA_*` replaces the User-Agent outright and so can drift from the version
embedded in `X-Msh-Version`, `Version`, and `X-Stainless-Package-Version`. The
`*_CLI_VERSION` variables exist to bump both together and are the documented
path; the raw `OMNI_UA_*` override is the escape hatch.

An `OMNI_ORDER_*` list is used only if it parses to at least one non-empty name;
otherwise the built-in order stands.

## Testing

Unit tests, `packages/providers/test/profile.test.ts`:

- `stainlessHost` maps each platform and arch pair, and reports `node`.
- `orderHeaders` places listed headers in order, appends unlisted ones, matches
  case-insensitively, and preserves the original casing on output.
- `resolveProfile` applies each override, rejects values failing the safety
  pattern, and falls back to the built-in order for a malformed order list.
- The merge helper cannot be made to drop or displace an auth header.

Body tests, `packages/providers/test/body.test.ts`:

- `orderFields` places listed fields first, appends unlisted ones, and survives
  a `JSON.stringify` round trip in the expected order.
- `computeCch` reproduces the canonical XXH64 vectors and masks to 5 hex
  characters.
- `signBody` substitutes the placeholder without changing the byte length, and
  is a no-op on a body with no placeholder.
- The system pipeline drops each anchor URL paragraph and the `You are OpenCode`
  prefix, applies both replacements at every occurrence, and produces the
  block layout `[billing, sdk-identity, ...caller]`.
- The pipeline is idempotent: running it twice does not stack two billing blocks
  or two identity blocks.

Transport test, `packages/providers/test/http-client.test.ts`: `nodeHttpClient`
writes headers to a raw `Bun.listen` socket in the exact order and casing given.
This is the only test that can catch a regression to `fetch`, since every
higher-level assertion reads through a `Headers` object that has already
normalised both.

End-to-end, Task 27: the stub upstream implements `HttpClient` rather than
`fetch`, and so receives the ordered pair list and the raw body string. Its
existing assertion that the User-Agent matches `/^omnigateway\//` and that no
`X-Stainless-*` header is present inverts: it now asserts the Anthropic profile
is present, in order, with `Authorization` unclobbered. Two assertions are
added: the serialized body's top-level keys are in fingerprint order, and
recomputing the `cch` token over the received body reproduces the value it
carries.

## Limits

Stated rather than solved.

- **TLS fingerprint.** JA3/JA4 identifies the Bun runtime regardless of headers.
  OmniRoute addresses this with `tls-client-node` and `wreq-js` impersonation
  for providers behind Cloudflare; that is a separate and much larger piece of
  work.
- **Nested field order.** Only top-level body fields are ordered. Key order
  inside `messages`, `tools`, and `system` blocks is whatever `toWire` produced.
- **Unverified `cch` algorithm.** The seed, mask, and placeholder convention come
  from OmniRoute's reading of the Claude Code binary. If the algorithm is wrong
  or changes, every Anthropic request carries a token that fails verification —
  which is a stronger signal than sending no token at all. There is no kill
  switch, by decision; disabling it means a release.
- **Prompt rewriting.** The system pipeline modifies the operator's own prompt
  text (§ Anthropic body integrity). Requests are not byte-faithful to what the
  client sent.
- **Missing session headers.** `X-Claude-Code-Session-Id` and
  `x-client-request-id` are absent, as described above.
- **Kimi has no capture.** Its header order, body field order, and device header
  block are constructed rather than observed.
- **Version drift.** Pinned versions age. The environment overrides exist so an
  operator can bump them without a release, but the defaults will go stale. The
  `cc_version` build revision is pinned to a single captured build.

Header and body mimicry raises the cost of separating this traffic. It does not
make it indistinguishable, and the design should not be read as claiming it does.
