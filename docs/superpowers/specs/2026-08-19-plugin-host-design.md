# Plugin Host — Design

Date: 2026-08-19
Status: approved

## Problem

OmniGateway has no extension mechanism. Every feature it has is compiled into
the monorepo: a route module in `apps/gateway`, a rule in `packages/control`, a
table in `packages/store`, a board in `apps/dashboard`. Adding anything means
editing all four and shipping a new gateway.

That is the right cost for features every install wants — a provider adapter, a
rate limiter, the usage board. It is the wrong cost for features only some
installs want, and it means the project has no answer at all for a feature that
should not be in the core at first place.

The immediate driver is a Pokémon companion: a gamified token-usage tracker
ported from PokeTokenBar, where each API key raises a Pokémon that grows on the
tokens that key spends. It is a well-specified, self-contained feature that
almost nobody deploying an AI gateway needs, that carries third-party IP, and
that depends on two external origins. Everything about it argues for living
outside the core — and there is currently nowhere outside the core to live.

This design specifies that place. The companion is the driving example
throughout, and the surface is judged sufficient exactly when the companion can
be built on it without a core change. The companion itself is specified
separately.

## Solution

A plugin host: a boot-time scan of `<root>/plugins/`, a capability-scoped
context handed to each plugin's server entry, a namespaced storage track, a
bounded event stream, and runtime ESM federation for dashboard UI.

Four decisions shape everything below, and each was a fork with real
alternatives:

1. **Plugins run in-process with a capability-scoped context.** They receive a
   narrow `PluginContext`, never `Store`, `HttpClient`, or credentials.
2. **UI is federated at runtime and rendered inline.** Plugins ship an ESM
   bundle against a published SDK; the dashboard imports it lazily.
3. **Plugins are installed by directory drop** under the install root, not as
   npm dependencies of the gateway.
4. **Plugin storage lives in the gateway's own SQLite file**, namespaced, on a
   migration track independent of core's.

### Trust posture, stated plainly

A plugin is loaded with `import` into the gateway process. That process holds
`OMNI_ENCRYPTION_KEY`, decrypted provider OAuth tokens and API keys, admin
session state, and API-key hashes. Bun offers no in-process sandbox.

The capability context is therefore **a guardrail, not a sandbox**. It makes
accidental overreach impossible and makes a plugin's intent auditable from its
manifest. It does not stop hostile code, which can `import` from `@omni/store`
and read `process.env` directly regardless of what the host hands it.

Operators install plugins they wrote or audited. This sentence belongs in
`README.md` and `CLAUDE.md`, not only here.

The alternative that would be a real boundary — a supervised subprocess with an
IPC protocol — was considered and rejected for this iteration on cost: process
supervision, protocol versioning, restart semantics, and a UI story that ends up
separate anyway. If the project ever accepts third-party plugins it does not
control, that decision must be revisited before, not after.

## Plugin shape

```
<root>/plugins/pokemon/
  omni-plugin.json          manifest
  server/index.js           ESM, default-exports definePlugin({...})
  ui/index.js               ESM, default-exports the React mount
  ui/assets/…
```

```json
{
  "id": "pokemon",
  "name": "Pokémon Companion",
  "version": "1.0.0",
  "api": 1,
  "sdk": "^1.0.0",
  "server": "server/index.js",
  "ui": "ui/index.js",
  "nav": { "label": "Companion" },
  "capabilities": ["storage", "files", "net:outbound", "events:request", "events:limit"],
  "origins": ["https://pokeapi.co", "https://raw.githubusercontent.com"]
}
```

`id` must equal the containing directory's name and match
`^[a-z][a-z0-9-]{0,31}$`. This is not cosmetic validation. That string becomes a
URL path segment, a SQL table name prefix, and a log field value; a plugin whose
id fails the pattern is rejected at load and never reaches any of the three.

`api` is the host API major the plugin was built against. `sdk` is a semver
range over the dashboard SDK. Both are checked at load; see *Versioning*.

`capabilities` is declared up front and the context is constructed to exactly
that set. The event capabilities are per-event, not a single switch: a plugin
declaring only `events:limit` receives an `events` object whose
`onRequestCompleted` is absent, so subscribing to an undeclared event is a type
error rather than a silent no-op. Its value is that an operator can read one
file and know what a plugin asked for, and that a plugin cannot reach a surface
it did not declare by accident.

`origins` is required when `net:outbound` is declared and forbidden otherwise.
Each entry is a scheme-and-host origin with no path; the host rejects a manifest
whose entries are not parseable origins rather than coercing them, since a
sloppy allowlist is worse than none.

`server` and `ui` are both optional. A backend-only plugin omits `ui`; a
presentation-only plugin omits `server`.

## Lifecycle

At boot the host scans `<root>/plugins/*/omni-plugin.json` and loads in
lexicographic id order, so load order is deterministic and does not depend on
filesystem enumeration.

A plugin is **skipped and reported, never fatal**, when:

- the manifest is missing, unparseable, or fails schema validation
- `id` does not match the directory or the pattern
- `api` disagrees with the host's major
- the server entry fails to import or throws during `definePlugin`
- a declared migration fails to apply

Each skip logs one startup line through existing `LogFields` keys and is
reported by `omni doctor`. The gateway starts.

This asymmetry is deliberate and follows the posture the codebase already takes
toward optional broken things. A gateway that refuses to boot because a Pokémon
plugin has a syntax error has converted a cosmetic failure into an outage. The
proxy path does not depend on any plugin and must not become able to.

Plugins are loaded once, at boot. There is no hot reload and no runtime install
that takes effect without a restart — `omni plugin install` writes files and
tells the operator to restart. Live-loading arbitrary code into a running
gateway holding decrypted credentials is a larger decision than this design
wants to make implicitly.

## Capability surface

```ts
export type PluginContext = {
  id: string;
  now: () => number;
  logger: PluginLogger;                  // pre-bound, closed field set
  storage?: PluginStorage;               // only if declared
  files?: PluginFiles;                   // only if declared
  net?: PluginFetch;                     // only if declared
  events?: PluginEvents;                 // only if declared
  config: Record<string, unknown>;
};
```

Never handed over: `Store`, `HttpClient`, `AdminAuth`, decrypted credentials,
`process.env`.

`Dimension` and `Window` in the event payloads below are the existing unions
from `@omni/ratelimit/catalog`; the host re-exports them through the plugin API
so a plugin does not import a core package to name them.

`config` is the plugin's own settings, and it is **not** the gateway's settings
table: a plugin can neither read nor write core configuration.

As shipped it carries the manifest's `defaults` block and nothing else. The
per-plugin stored, operator-editable form this section originally described is
deferred, because nothing in the first plugin needs it and an editing surface
with no consumer is a schema plus a panel plus a migration to guess at. The
shape is chosen so adding it later is additive: a plugin already reads
`ctx.config` and does not know where a value came from.

### Logging

`LogFields` is a closed allowlist and a redaction boundary, and `CLAUDE.md`
forbids adding an index signature to it. `PluginLogger` therefore cannot be
`Logger`.

Plugins get a message plus a fixed, closed set — `{ plugin, event?, count?,
durationMs? }` — with `plugin` pre-bound to the id and not settable. The
consequence is the point: a plugin has nowhere to put a token, a prompt, or an
arbitrary header, so it cannot log one. Treat any request to widen this set as a
security change, on the same terms as widening `LogFields` itself.

### Routes

A plugin returns route handlers; it does not compose its own guard. The host
mounts them under `/api/plugins/<id>/*` wrapped in `requireAdmin`. A plugin
cannot opt out of authentication.

That is what keeps "admin sessions are preserved on every `/api/*` route except
the documented setup, status, and login flows" a property of the gateway rather
than a convention each plugin author is trusted to remember.

Plugin routes mount after `connectRoutes` and before the `/*` static fallback in
`createApp`. Mounting after the catch-all would make every plugin route a 404;
mounting before the core route modules would let a plugin shadow `/api/keys`.

### Files

A plugin declaring `files` receives read and write confined to
`<root>/plugins/<id>/data/`. Paths are resolved and checked against that root by
the host, reusing the same realpath-and-prefix guard the static server uses, so
a symlink cannot escape it.

That directory is **excluded from database snapshots**, exactly as
`request_bodies/` is, and for the same reason: a snapshot is the database alone,
and its size must not track how much a plugin has cached. After a restore, a
plugin's rows and its cached files disagree until the cache refills. That is
expected and must be self-healing — a plugin caching derived data has to treat
a cache miss as normal, never as corruption.

### Outbound network

A plugin declaring `net:outbound` must also declare `origins`, and receives a
`fetch` bound to that allowlist. A request to any other origin is refused by the
host.

The value is auditability. A self-hosted gateway whose premise is that prompts
do not leave the operator's machine should be able to state, from one readable
file, exactly which outside hosts each installed plugin contacts. As with every
capability here it constrains honest code and not hostile code — a plugin
sharing the process can call global `fetch` — and it is worth having anyway.

Note the interaction with boundary rule 8: all outbound *provider* HTTP goes
through `HttpClient`. This is not provider traffic and does not route through
it. The bound fetch applies a request timeout of its own, so a third-party host
that accepts a connection and never answers cannot hold a plugin's promise for
the life of the process.

It does **not** retry, and deliberately: `HttpClient`'s retry policy is built
around provider semantics — rate-limit headers, idempotency, failover to another
credential — none of which mean anything for an arbitrary third-party GET. A
plugin that wants a retry knows what it is fetching and can write one.

## Storage and migrations

Plugin tables live in the gateway's own SQLite file, so plugin data rides
snapshots and restores with everything else. They are namespaced and tracked
separately:

- Table names are constructed by the host as `plugin_<id>_<name>`. The plugin
  supplies only `<name>`, validated `^[a-z][a-z0-9_]{0,31}$`.
- `plugin_migrations(plugin_id, version, applied_at)` tracks each plugin's
  numbered migrations independently of core's `001..010`. Core's next migration
  is `011` regardless of what any plugin does.
- A plugin ships migrations as an ordered array in its server entry. The host
  applies unapplied ones in order, **each in its own transaction**, recording
  each as it commits. On failure it stops at that migration and skips the
  plugin; migrations that already committed stay applied. One transaction
  around the whole batch would be tidier, but it would make a plugin that fails
  on migration 5 silently revert 1 through 4 on every subsequent boot, which
  turns one bad migration into repeated data loss.

Three consequences, each stated because the alternative is discovering it during
an incident:

1. **Restoring a snapshot from an install that had a plugin, onto one that does
   not, leaves orphan `plugin_*` tables.** They stay. `omni doctor` reports
   them. Nothing auto-drops them: dropping a table because a plugin is currently
   absent destroys data irreversibly, and a restore is precisely when a plugin
   may not be installed yet.
2. For the same reason `omni plugin remove` does not drop tables. `omni plugin
   remove --purge` does, and confirms first.
3. `vacuum()` and `rebuildRollup` are unaffected. Plugin tables are outside the
   rollup, and `request_logs` remains the sole source of truth for usage.

## Events

Two events, both with closed, pre-redacted payloads:

```ts
type RequestCompleted = {
  requestId: string; apiKeyId: string;
  provider: ProviderId; model: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number; durationMs: number; ok: boolean; at: number;
};

type LimitReached = { apiKeyId: string; dimension: Dimension; window: Window; at: number };
```

`RequestCompleted` is emitted from `finishLog` — the site `CLAUDE.md` already
designates for the token and spend debit, precisely because it "already runs at
most once per request id." Any plugin accumulating per-request quantities needs
that exact guarantee, so it gets that exact site rather than a second one with
weaker properties. The payload deliberately carries no credential id, no
bodies, no headers, and no prompt text.

`LimitReached` keys on `dimension:window`, which is stable. Not `resets_at`: a
volatile field in an edge-trigger key is a regression both this codebase and
PokeTokenBar have already shipped once.

### Delivery discipline

- Handlers run **after** the store write, never inside its transaction.
  `bun:sqlite` is synchronous, so a slow handler inside that transaction blocks
  the whole event loop — the same hazard that motivated removing the unbounded
  `SELECT SUM`.
- Handlers are **never awaited on the request path**. Events go to a bounded
  queue drained off it.
- The queue is **bounded**. A slow handler behind an unbounded queue is a memory
  leak that only appears under load, which is when it hurts most. Queue-full
  drops are counted and logged.
- A throwing handler is caught, counted, and logged. The request is unaffected.

### The durability promise

The host promises **at-most-once delivery, not durability.** An event queued
when the process dies is gone.

For a growth meter that is acceptable, and the corollary must be documented
rather than assumed: a plugin needing exact accounting must reconcile from its
own storage and must never treat the event stream as a ledger. Any plugin doing
billing on these events is misusing them.

## Dashboard UI federation

A new `packages/dashboard-sdk` publishes the theme tokens, the shared
`styled-components` instance, a `usePluginApi()` bound to `/api/plugins/<id>/*`,
and `definePluginUI`.

The host externalizes `react`, `react-dom`, `styled-components`, and
`@tanstack/react-query`, publishing them through an import map in the
dashboard's `index.html`. Plugin bundles build against them as externals. That
import map is the versioned public contract this approach buys and pays for:
inline rendering with the real theme, at the cost of those four packages
becoming API surface.

Three failure paths are designed rather than left to chance:

- **Version mismatch.** The manifest's `sdk` range is checked against the
  shipped SDK version. On mismatch the plugin's nav entry renders *disabled,
  with the reason*. Never a blank page.
- **Render throw.** Every plugin mount sits in a React error boundary that shows
  an inline "plugin failed" panel. This is non-negotiable: `apps/gateway/src/app.ts`
  already argues that the console must not black out at the moment an operator
  needs it, and a plugin render bug during an incident is exactly that case.
- **Static serving.** Plugin `ui/` is served from `<root>/plugins/<id>/ui/` at
  `/plugins/<id>/…` by **reusing the existing realpath-and-prefix guard in
  `createApp`**, not a second copy of it. That check is what stops a symlink
  escaping the served root, and a second implementation is a second chance to
  get it wrong.

Plugin nav entries sort after core entries, by id.

If a Content-Security-Policy is added later, plugin scripts are same-origin, so
`script-src 'self'` suffices; the import map should be emitted with a nonce or
hash rather than requiring `unsafe-inline`.

## Versioning

- `api` is a single integer, the host's plugin-API major. A mismatch skips the
  plugin at load with a reported reason. It is bumped whenever `PluginContext`,
  the event payloads, or the manifest schema change incompatibly.
- `sdk` is a semver range over `packages/dashboard-sdk`. A mismatch disables
  only the UI; a plugin whose server half still loads keeps working headless.

Splitting the two matters: a backend-only plugin should not break because the
dashboard's React version moved, and a UI-only incompatibility should not take
down a plugin's data collection.

## CLI and distribution

`omni plugin list | install <spec> | remove <id> [--purge] | verify <id>`.

Per boundary rule 11 the CLI administers through `@omni/control`, never
`/api/*`, so the logic lives in `packages/control/src/plugins.ts` with the
filesystem and the fetcher injected. Tests never touch a real network or write
outside a temp directory.

`install` unpacks an npm tarball or a local path into `<root>/plugins/<id>/`,
validates the manifest, refuses an id that disagrees with its directory, and
**does not run install scripts**. It reports that a restart is required.

`verify <id>` runs every load-time check without loading the plugin: manifest
schema, id pattern and directory agreement, `api` and `sdk` compatibility, and
the presence of the declared entry files. It is what an operator runs before
restarting a production gateway, and what `doctor` calls per plugin.

Docker ships a gateway-only image, so there plugins arrive by mounting a volume
at `<root>/plugins`. That is documented rather than tooled around.

`omni doctor` gains: plugins found and their versions, `api`/`sdk`
compatibility, load failures with reasons, and orphan `plugin_*` tables.

## Testing

Host tests use fixture plugins in temp directories: a well-formed one, one with
a bad manifest, one that throws at load, one that throws inside a handler, one
with an `api` mismatch, and one with an `sdk` mismatch. Every case asserts the
**gateway still boots** and that the failure is reported.

Event tests assert the properties, not the happy path: that handlers run outside
the store transaction, that a throwing handler does not affect its request, that
the queue drops rather than grows when full, and that `RequestCompleted` fires
exactly once per request id across both streaming and non-streaming paths.

Storage tests assert namespacing is enforced against a hostile `<name>`, that
plugin migrations are independent of core's numbering, that a mid-batch
migration failure leaves earlier ones applied, and that `remove` without
`--purge` leaves tables intact.

Capability tests assert the two escapes are actually closed: a `files` path
containing `..` or reached through a symlink is refused, and a `net:outbound`
fetch to an origin outside the manifest allowlist is refused. Both are checked
against the host, not against plugin good behaviour.

Dashboard tests run under happy-dom with a stub plugin module, covering the
error boundary and the disabled-nav mismatch path.

## Documentation

- `CLAUDE.md`: architectural boundary #15, stating what a plugin may touch and
  including the explicit "guardrail, not a sandbox" sentence.
- `ARCHITECTURE.md`: a section on the host, the event stream's at-most-once
  promise, and why plugin storage shares the database.
- `README.md`: an operator section on installing plugins and the trust posture.
- `docs/writing-a-plugin.md`: the procedure, mirroring
  `docs/adding-a-provider.md`.

## Out of scope

- Hot reload and runtime loading without restart.
- Subprocess isolation and an IPC protocol.
- A plugin registry, signing, or provenance verification.
- Plugins extending the `/v1/*` client surface. This design covers `/api/*`
  only; letting a plugin sit in the proxy path is a much larger decision about
  the request hot path and the client contract.
- The Pokémon companion itself, which gets its own spec and is the first
  consumer.

## Non-technical note

The companion plugin's sprites, names, and evolution data are Nintendo and Game
Freak intellectual property. PokeTokenBar is a personal menu-bar application; a
plugin installer shipped with infrastructure that other people deploy is a
different exposure profile. Keeping the companion a separately-installed plugin
that an operator chooses to fetch is the better posture for this, and is part of
why this host exists. It is recorded here so the decision is a knowing one.
