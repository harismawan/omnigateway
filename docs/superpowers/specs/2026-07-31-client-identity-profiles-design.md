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
per-provider. Operators can override the version-bearing values and the order
through environment variables.

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
| `User-Agent` | `claude-cli/${2.1.219} (external, cli)` |
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
  body: string;
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

### Environment overrides

Per-header variables, validated against `/^[\x20-\x7E]{1,200}$/` — OmniRoute's
`SAFE_HEADER_VALUE_PATTERN`. A value failing validation falls back to the
built-in default rather than being sent; a malformed override must not produce
a header no real client would emit.

```
OMNI_UA_ANTHROPIC=                          # replaces the whole User-Agent string
OMNI_ANTHROPIC_CLI_VERSION=2.1.219
OMNI_ANTHROPIC_STAINLESS_PACKAGE_VERSION=0.94.0
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

Transport test, `packages/providers/test/http-client.test.ts`: `nodeHttpClient`
writes headers to a raw `Bun.listen` socket in the exact order and casing given.
This is the only test that can catch a regression to `fetch`, since every
higher-level assertion reads through a `Headers` object that has already
normalised both.

End-to-end, Task 27: the stub upstream implements `HttpClient` rather than
`fetch`, and so receives the ordered pair list. Its existing assertion that the
User-Agent matches `/^omnigateway\//` and that no `X-Stainless-*` header is
present inverts: it now asserts the Anthropic profile is present, in order,
with `Authorization` unclobbered.

## Limits

Stated rather than solved.

- **TLS fingerprint.** JA3/JA4 identifies the Bun runtime regardless of headers.
  OmniRoute addresses this with `tls-client-node` and `wreq-js` impersonation
  for providers behind Cloudflare; that is a separate and much larger piece of
  work.
- **Body field order.** OmniRoute pins JSON top-level field order per provider
  (`bodyFieldOrder`). Not implemented here.
- **Anthropic body integrity token.** Real Claude Code embeds a `cch=` xxHash64
  token over the serialized body, which the server can verify. Not implemented
  here; requests are separable from genuine CLI traffic on this alone.
- **Missing session headers.** `X-Claude-Code-Session-Id` and
  `x-client-request-id` are absent, as described above.
- **Version drift.** Pinned versions age. The environment overrides exist so an
  operator can bump them without a release, but the defaults will go stale.

Header mimicry raises the cost of separating this traffic. It does not make it
indistinguishable, and the design should not be read as claiming it does.
