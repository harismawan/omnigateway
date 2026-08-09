# Gateway Structured Logging — Design

Date: 2026-08-09
Status: approved

## Problem

The gateway records what happened to a *request* — `request_logs` in SQLite,
read back by the console and the CLI. It records almost nothing about what
happened to the *process*. There are eight `console.*` calls in the whole
system, each with its own ad-hoc shape, and nothing else:

```
apps/gateway/src/index.ts:42          console.log   sweep count
apps/gateway/src/index.ts:81          console.log   listening
apps/gateway/src/logging.ts:58        console.error store write failed
apps/gateway/src/maintenance.ts:31    console.error prune failed
apps/gateway/src/oauth/scheduler.ts   console.warn/error refresh failed
apps/gateway/src/quota/poller.ts:23   console.error quota poll failed
packages/control/src/quota.ts:128     console.warn  quota probe failed
```

Three consequences:

1. **No live view.** A request that fails is a row in a table the operator has
   to go looking for. `tail -f` shows nothing.
2. **No detail on the paths that are hardest to reason about.** Routing chose
   this credential over that one; an attempt failed and failover picked the
   next; a token refreshed mid-request. None of it is observable, and none of
   it is reconstructable from the finished row.
3. **No level.** Everything either always prints or never does. There is no way
   to ask for more when debugging, and no way to ask for less in production.

## Goals

- One line on stdout per completed request, plus lifecycle and every error
  surface, at a level the operator chooses.
- Detail on routing, failover, and refresh available on demand at `debug`.
- Structurally impossible to log a prompt body, a token, an API key, or an
  admin password.
- No test starts writing to stdout, and no existing test needs changing to keep
  compiling.

## Non-goals

File sinks, rotation, log shipping, sampling, per-module levels, changing the
level without a restart, request-body dumps, OpenTelemetry. Each is a separate
decision, and none is needed to debug a single-node gateway.

## Approach

A pure logger in `packages/ir`, a sink supplied by the bootstrap, and an
optional `logger` on every deps object that defaults to a no-op.

### Why `packages/ir`

The logger is consumed by the gateway, control, providers, and store. It has to
live somewhere all four already depend on, and `packages/ir` is that place —
`ProviderId` and `ErrorCode`, which the field allowlist is written in terms of,
are already there.

Rule 1 of the architectural boundaries says `packages/ir` stays
side-effect-free. This design keeps that: `createLogger` takes its sink and its
clock as arguments. Level filtering and line rendering are functions of their
input. Nothing in `packages/ir` touches `process`, `console`, or a timer. The
one call that writes to stdout is in `apps/gateway/src/index.ts`.

Two alternatives were rejected. Putting `createStdoutLogger()` in
`packages/ir` is smaller but breaks rule 1 and makes the module untestable
without capturing stdout. A separate `packages/logging` workspace is cleaner on
paper, but it would still have to import `ProviderId` and `ErrorCode` from
`packages/ir` — so the dependency edge exists either way — in exchange for a
seventh workspace, another `build-npm.ts` inlining entry, and another
`tsconfig` reference, for roughly 120 lines of code.

## The logger

`packages/ir/src/logger.ts`, re-exported from `@omni/ir`.

```ts
export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

export type Logger = {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Guard for the few paths where building `fields` is not free. */
  enabled(level: LogLevel): boolean;
};

export function createLogger(opts: {
  level: LogLevel;
  write: (line: string) => void;
  now?: () => number;
  color?: boolean;
}): Logger;

/** The default on every deps object. */
export const noopLogger: Logger;

/** Exported so the render contract has its own tests. */
export function formatLine(
  level: LogLevel,
  at: number,
  msg: string,
  fields: LogFields | undefined,
  color: boolean,
): string;

export function parseLogLevel(value: string | undefined): LogLevel | null;
```

### The field allowlist is the security mechanism

`LogFields` is a closed object type with no index signature. A body, a header
map, a token, or a credential secret does not typecheck as an argument.

```ts
export type LogFields = {
  requestId?: string | undefined;
  surface?: "anthropic" | "openai" | undefined;
  status?: number | undefined;
  provider?: ProviderId | undefined;
  model?: string | undefined;
  requestedModel?: string | undefined;
  credentialId?: string | undefined;
  apiKeyId?: string | undefined;
  attempt?: number | undefined;
  attempts?: number | undefined;
  code?: ErrorCode | "INTERNAL" | undefined;
  retryable?: boolean | undefined;
  stream?: boolean | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  costUsd?: number | undefined;
  ttftMs?: number | null | undefined;
  durationMs?: number | undefined;
  retryAfterMs?: number | undefined;
  count?: number | undefined;
  rawCount?: number | undefined;
  dailyCount?: number | undefined;
  host?: string | undefined;
  port?: number | undefined;
  path?: string | undefined;
  reason?: string | undefined;
};
```

Every value carries `| undefined` explicitly. Without it,
`exactOptionalPropertyTypes` forces the
`...(x === undefined ? {} : { x })` spread at every call site that passes a
nullable value, which is most of them.

This type is a security boundary, not a convenience. Widening it — and
particularly adding any field that can hold free text — deserves the same care
as the redaction rules in `CLAUDE.md`.

### Rendering

One rule for the whole line. Level padded to five characters, the message, two
spaces, then `key=value` pairs in the **declaration order of `LogFields`**:

```
2026-08-09T04:12:03.114Z ERROR attempt failed  requestId=req_9f2 provider=anthropic model=claude-opus-5 credentialId=cred_31 attempt=2 code=UPSTREAM durationMs=812
```

- A key whose value is `undefined` is omitted; `null` renders as `null`.
- A value containing a space, an `=`, or a quote is rendered with
  `JSON.stringify`.
- Field order is fixed rather than insertion-ordered, so tests assert exact
  strings and `grep code=UPSTREAM` finds every occurrence.
- `reason` is **truncated to 200 characters**. It is the only free-text field,
  and it carries `error.message` — which `httpError` fills with up to 500
  characters of an upstream error body, and an upstream error body can echo
  prompt fragments on `context_length_exceeded`. Truncation caps that. It
  renders last so the truncation never hides a structured field.
- ANSI colour wraps the level token only, and only when the sink was built with
  `color: true` — which the bootstrap sets from `process.stdout.isTTY`. Same
  text either way, so a redirected file stays clean.

The timestamp is a full ISO 8601 instant, not a wall clock. "Pretty always"
means these lines get redirected into a file, and a time with no date is
useless there.

### Configuration

`OMNI_LOG_LEVEL` is read by `loadConfig` in `packages/control/src/config.ts`
and added to `Config` as `logLevel: LogLevel`. Default `info`.

An unrecognised value does **not** throw. Unlike `OMNI_PORT`, a typo'd log
level is not a reason to refuse to serve traffic: it falls back to `info`, and
the boot line reports that it did. The level is read once at boot, like
`quotaPollIntervalMs`.

## Threading

`logger?: Logger` is added to deps objects that already exist, defaulting to
`noopLogger`. No new plumbing shape, and every existing test keeps compiling
untouched.

| Consumer | Deps object | Supplied by |
| --- | --- | --- |
| `createApp` | `AppDeps` | `apps/gateway/src/index.ts` |
| `dispatch` | `DispatchDeps` | `app.ts` via `proxyRoutes` |
| `proxyRoutes`, `adminRoutes`, `connectRoutes` | route deps | `app.ts` |
| `startMaintenance`, `startRefreshScheduler`, `startQuotaPoller` | loop deps | `index.ts` |
| `createRefresher`, `poll`/`probe`, `connect` | control deps | gateway |
| `nodeHttpClient` | factory argument | `index.ts` |
| `createStore` | store options | `index.ts` |

`packages/control` gains a `logger` on its deps and stays caller-agnostic: it
never constructs one, and its existing `console.warn` in `quota.ts` is replaced
by `deps.logger.warn`.

The CLI passes `noopLogger`. It has its own output seam for human-facing text,
and a levelled server log printing underneath it would fight that. The CLI's
own verbosity is a separate decision, out of scope here.

## Call sites

Levels are chosen so that `info` is what an operator actually wants running:
one line per request, nothing per event.

**INFO** — boot (`host`, `port`), listening, static directory resolved or
absent, shutdown signal received, pending-request sweep (`count`), **request
done**, admin login succeeded or failed, credential added / enabled / disabled,
OAuth connect completed.

**DEBUG** — routing decision (`requestedModel` → `model`, candidate `count`,
chosen `credentialId`), each excluded candidate (`credentialId`, `reason`),
attempt start, commit point reached (`ttftMs`), refresh triggered
(dispatch-lead versus preemptive), snapshot cache miss, prune counts, quota
probe written, upstream HTTP call. Keepalives are not logged.

**WARN** — attempt failed but retrying (`attempt`, `code`, `retryAfterMs`),
auth-refresh retry, credential auto-disabled by the refresher, quota probe
failed, quota 429 cooldown, scheduled refresh failed, rate limit rejected
(`apiKeyId`), authentication rejected (`reason` is a category, never any part
of the key), request-log store write failed.

The last is a demotion: `logging.ts` currently uses `console.error` for a
failed row write, but it deliberately does not fail the request, and an error
level should mean something went wrong for the client.

**ERROR** — request failed terminally (`code`, `attempts`, `durationMs`),
`ALL_CANDIDATES_FAILED`, refresh sweep crashed, prune crashed, quota poll
crashed, unhandled route error, boot failure before listen.

### Two rules that keep this from becoming noise

**One terminal line per request, ever.** It is emitted where `finishLog` is
already called — the three sites in `routes/proxy.ts`: `sseResponse`'s
`onDone`, the non-streaming path, and the catch. INFO when `status < 400`,
ERROR otherwise. `sseResponse` already latches `onDone` to run exactly once, so
a client that disconnects mid-stream produces one line, not two.

**Client cancellation is DEBUG, not ERROR.** A client hanging up mid-stream is
normal, and logging it at ERROR teaches operators to ignore ERROR. It is
distinguished by the same `signal.aborted` check `dispatch` already uses to
separate a downstream cancel from a gateway `TIMEOUT`; a real timeout stays at
ERROR.

### Upstream HTTP

`HttpClient` logs at DEBUG only, with `provider`, `path` (the URL path with the
query string stripped, because a query string can carry a key), `status`, and
`durationMs`. Never headers, never bodies — and `LogFields` has no field
capable of holding either.

## Testing

`packages/testkit` gains:

```ts
export function captureLogger(level: LogLevel = "debug"): Logger & {
  lines: string[];
  records: Array<{ level: LogLevel; msg: string; fields: LogFields }>;
};
```

Both views exist on purpose. `lines` pins the render contract in one place;
`records` lets a behaviour test assert `{ level: "warn", msg: "attempt failed" }`
without coupling to the format.

`packages/ir/test/logger.test.ts` covers level filtering at each threshold,
fixed key ordering, `null` versus `undefined`, quoting, `reason` truncation at
200 characters, `enabled()` agreeing with what is actually written, and a
deterministic timestamp from an injected `now`.

Gateway coverage goes into the existing dispatch, proxy, scheduler, and poller
suites rather than new files: exactly one terminal line per request across
streaming, non-streaming, error, and mid-stream client disconnect; failover
emitting WARN then a terminal line; a cancel logging at DEBUG while a TIMEOUT
logs at ERROR.

**The leak test.** One test drives a full request through a stub `HttpClient`
whose request and response bodies contain a known sentinel string, alongside a
synthetic OAuth token and a synthetic API key, then asserts that no captured
line contains any of the three. This is what catches the case the type system
cannot: a `reason` that happens to carry an upstream body through.

## Failure modes

- **Logging must never fail a request.** Every level method wraps its `write`
  in try/catch and swallows. A full pipe or a closed stdout under systemd is
  precisely the moment an operator least wants the gateway to start throwing.
- **Back-pressure** is ignored: `process.stdout.write`'s return value is
  discarded. Dropping a line under pressure beats blocking dispatch on a pipe.
- **Ordering** is guaranteed by a single synchronous write per line. No
  batching and no async flush, so lines never interleave.

## Documentation

`README.md` gains `OMNI_LOG_LEVEL` in configuration, a sample line, and what
the fields mean — it is operator-facing.

`CLAUDE.md` gains a repository-map entry for `packages/ir/src/logger.ts`, a
clause on boundary rule 1 recording why the logger may live in `packages/ir`
(the sink is injected), and a known-constraints entry: the level is read once
at boot, and `LogFields` is a closed allowlist that is the redaction mechanism
rather than a convenience.
