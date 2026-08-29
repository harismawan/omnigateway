# Client dashboard surface

A read-only console for two principals who are not the operator: the holder of a
gateway API key, who sees their own traffic, and a read-only administrator, who
sees the whole installation but cannot change it.

Today the gateway has exactly one authenticated human surface. `/api/*` is
guarded by `requireAdmin`, the session cookie means "the operator", and every
read the console performs is installation-wide because there has never been a
caller who should see less. That is the assumption this design removes.

## What exists now

Facts the design is built on, each verified against the tree at
`f49c6a1`:

- `createAdminAuth` (`packages/control/src/adminAuth.ts:39`) holds sessions in an
  in-memory `Map<string, number>` — token to expiry. `verify` returns a boolean.
  Nothing in the map records *who* the token belongs to, because until now there
  was only one answer.
- `requireAdmin` (`apps/gateway/src/routes/http.ts:28`) reads the `omni_admin`
  cookie and calls `verify`. Every `/api/*` route except `/api/status`,
  `/api/setup` and `/api/login` goes through it.
- `Principal` in `apps/gateway/src/stream/registry.ts` is already a union —
  `{ kind: "admin" }` or `{ kind: "machine"; tokenId; pluginId }` — and
  `authorised` in `apps/gateway/src/routes/stream.ts:37` already dispatches on
  it. The socket has the shape this design needs; the HTTP surface does not.
- `usage_daily` (`packages/store/src/sqlite/migrations/002_usage_daily.sql:29`)
  has a primary key of `(day, provider, credential_id, requested_model,
  resolved_model, api_key_id)`.
- `idx_request_logs_key_at (api_key_id, at DESC)`
  (`packages/store/src/sqlite/migrations/009_key_limits.sql:58`) exists, added so
  `sumSince` could read one key's sliding window without a scan.
- `settings` is a key/value table. `getAdminPasswordHash` is a read of one row in
  it (`packages/store/src/sqlite/config.ts:133`).

The last three matter more than they look. Per-key usage and per-key logs are
index reads against tables that already carry `api_key_id`, and a second password
hash is a second row in a kv table. **This feature needs no migration.**

## Principals

```ts
type Principal =
  | { kind: "admin" }
  | { kind: "viewer" }
  | { kind: "client"; apiKeyId: string }
  | { kind: "machine"; tokenId: string; pluginId: string }
```

`admin` and `machine` keep their current meaning exactly. `viewer` is an
installation-wide reader. `client` is one API key looking at itself.

### Sessions

One cookie, `omni_admin`, unchanged. Renaming it would log every operator out for
no gain, and the sessions are in-memory anyway.

`AdminAuth.verify` changes signature:

```ts
verify(token: string): Promise<Principal | null>
```

and the session map's value becomes `{ expiresAt: number; principal: Principal }`.
Returning the principal rather than a boolean is what makes default-deny
expressible: a caller that does not check the kind gets a value it cannot
accidentally treat as "yes".

Three ways in:

| Route | Credential | Principal |
|---|---|---|
| `POST /api/login` | admin password | `{ kind: "admin" }` |
| `POST /api/login` with `mode: "viewer"` | viewer password | `{ kind: "viewer" }` |
| `POST /api/client/login` | raw gateway API key | `{ kind: "client", apiKeyId }` |

`mode` is an explicit field defaulting to `"admin"`, never inferred by trying one
password and falling back to the other. A fallback would make a mistyped admin
password silently mint a viewer session on the day the two passwords collide,
and it doubles the Argon2 cost of every failed login.

The viewer password is Argon2id under the same OWASP parameters as the admin
password, stored under a new `settings` key, set by the admin from the settings
board. It is independent of the admin password: an operator hands it to someone
else, which is the entire point, and so changing one must not disturb the other.

Client login resolves the raw key through `store.keys.findByHash()` — the same
path `/v1/*` uses — and stores only the resulting key id. The raw key never
reaches the session map and never returns to the browser after the login POST.

### Revocation

**A client session re-reads its key row on every `verify`, and refuses when
`revokedAt` is set.**

This is the one place the session map is not sufficient on its own. Checking only
at login would let a revoked key keep a live dashboard until the session TTL
expired or the process restarted, which is a revocation that did not revoke. The
read is by primary key against a table already in page cache; it costs less than
the Argon2 verify the admin path already pays per upgrade.

### Invalidation

`invalidateSessions()` clears everything, as now. Two refinements:

- Changing the viewer password clears **viewer** sessions only. Changing the
  admin password keeps clearing everything, because an operator changing their
  own password is a "log everyone out" event and always was.
- Restore compares **both** hashes across the swap and invalidates per hash that
  differs. Nothing may sit between the swap and that comparison — the existing
  rule, now with two comparisons instead of one.

## Authorization

### Guards

`requireAdmin` keeps its name and now asserts `kind === "admin"`. Every existing
call site therefore keeps its exact current meaning, and the diff at those sites
is zero. Two new guards are opt-in:

```ts
requireReader(request, auth): Promise<Principal>   // admin | viewer
requireClient(request, auth): Promise<string>      // returns apiKeyId
```

Widening a route is an explicit edit at that route. A GET nobody remembers to
widen stays admin-only — the viewer cannot see it, which is the harmless
direction. There is no wrapper that widens a group, because a wrapper is a thing
a later route joins by accident.

### Scope

One type, in `@omni/control`:

```ts
type Scope = { kind: "all" } | { kind: "key"; apiKeyId: string }

function scopeOf(principal: Principal): Scope
```

`queryUsage`, `recentLogs`, the key-limit readings and the quota reads all take a
`Scope`. `scopeOf` is the **only** place a principal becomes a filter, and it is
called at the route boundary.

Control still knows nothing about its caller. `Scope` is data — a filter over
rows — not an HTTP or session concept, so boundary rule 6 holds unchanged.

Two alternatives were considered and rejected:

- **Filter in the route, after the control call.** The unfiltered result set has
  already been built by then, so the guard is a `.filter()` someone can forget,
  and forgetting it leaks silently rather than failing.
- **A parallel `clientUsage()` / `clientLogs()` family.** This is the repository's
  own "one rule, one place" trap stated exactly: two copies of *what may this
  principal see*, which diverge, and where the safety net turns out to be one of
  the copies. `servesTarget` is in the codebase because that already happened
  once.

## Data layer

`packages/store`:

- `UsageQuery` gains `apiKeyId?: string`.
- `UsageRepo.recent(limit)` becomes `recent(limit, apiKeyId?)`. An options object
  would read better in isolation and was the first draft, but `recent` has around
  fifty call sites in the existing suites and none of them are about scoping;
  churning all of them buys nothing this design needs.
- `packages/store/src/sqlite/usage.ts` adds the corresponding `WHERE` clauses.
- The swap-forwarding layer in `packages/store/src/sqlite/store.ts` must pass the
  new argument on. It hand-writes one arrow per repo method with the parameters
  spelled out, and an arrow of lower arity still satisfies the interface — so a
  dropped optional parameter is not a type error, it is a value that silently
  becomes `undefined`. This happened during implementation: `recent` forwarded
  only `limit`, and a scoped read returned every key's rows with nothing raised.
  `packages/store/test/swap.test.ts` now reads the forwarder source and asserts no
  arrow drops an argument, because a behavioural test covers the method it names
  and says nothing about the next one added.

Both reads stay index reads. The aggregate rides `usage_daily`'s primary key; the
log listing rides `idx_request_logs_key_at`. Nothing added here scans, which
matters because `bun:sqlite` is synchronous and a scan blocks the event loop for
every other request — the reason `usage_rollup` exists at all.

`usage_rollup` is untouched. It is keyed `(api_key_id, hour)` and carries no
model or provider dimension, so it answers the limiter's question and not this
surface's; the per-key breakdown comes from `usage_daily`.

No new tables. No migration.

## What each principal sees

| | client | viewer |
|---|---|---|
| Usage and spend | own key, by day / model / provider | installation-wide |
| Request logs | own key's rows, metadata only | all rows, bodies included |
| Rate limits | own `limits` and `limitUsage` | every key |
| Provider quota | per-provider headroom, credential ids and account labels stripped | full panel |
| Everything else | — | every admin GET; no mutations, no snapshot download, no credential secrets |

### Bodies

`/api/client/*` has no body route. Not a filtered one — an absent one. A route
that exists and refuses is a route someone later makes conditional.

### Redaction

Provider quota reaches the client as per-provider headroom: a window type, a
consumption ratio, a reset time. Credential ids, account labels and
per-credential figures are removed in `@omni/control` before the response is
constructed, so they are not in the payload the browser receives and cannot be
recovered from the network tab.

The field is `usedRatio` in `0..1`, not a percentage. `formatPercent` on the
console side multiplies by 100, and a field already scaled to 0..100 rendered as
`4200%` the first time it was wired up. One convention per repository, and this
is the one that was already here.

This exists because the client asked *why am I being throttled* and the honest
answer is upstream headroom, while the credential ids answering it are the
operator's infrastructure and not the client's business.

## Routes

New, under `apps/gateway/src/routes/client.ts`:

```
POST /api/client/login      raw key -> client session
POST /api/client/logout
GET  /api/client/summary    own key: label, prefix, model allowlist, limits, limitUsage
GET  /api/client/usage      scoped queryUsage
GET  /api/client/logs       scoped recentLogs, metadata only
GET  /api/client/quota      redacted provider headroom
GET  /api/client/quota/history  the same headroom, per retained reading
```

`quota/history` was added later, when the client screen took the console's own
quota chart.

**Both quota routes were widened after this design shipped, by the operator's
decision.** They first reported one folded row per provider — the best account's
headroom, with the account unnamed — and that could answer "am I about to be
throttled" but not "which account is the one filling up". They now report one row
per account carrying the operator's own label, so a key holder learns the fleet
size and the account names.

`used`, `limit` and units-per-hour stay in `@omni/control`, and every figure on
the wire is a fraction of the window it belongs to — but that is the shape the
surfaces render, not a secret kept. **The ceiling is derivable from what is
published**, twice over: `usedRatio` is the exact quotient of two provider
integers and comes back in lowest terms through continued fractions, and
`exhaustsAt` reduces to `(limit - used) / used` against the other instants on the
same row. A rounding step was added to close that and did not — it left
`exhaustsAt` alone, and rounding to a thousandth is the identity whenever the
ceiling divides 1000. The operator's decision is that this is acceptable: the
account is already named, and knowing roughly how large a named account is adds
no category of disclosure. It is written down here so nobody re-adds the rounding
believing it does something.

The gateway rate on the operator's history route is still absent here, because it
is an aggregate over every key on the installation and so answers a question
about the operator's traffic. The redaction test above now covers `logs`, `usage`
and `summary`, with a second test pinning the *shape* of both quota routes.

Existing admin GETs gain `requireReader`, with three exceptions that stay
`requireAdmin`:

- `GET /api/database/snapshot` — a snapshot carries encrypted credentials and
  API-key hashes, and is inert only because `OMNI_ENCRYPTION_KEY` is not in it.
  A reader who cannot change the installation should not be able to walk out
  with it.
- Any route returning credential material or an OAuth flow's state, under
  `/api/connect/*`.
- `GET /api/plugins` — the catalog is admin-gated today because what is gated is
  data, and nothing in this design changes who that data is for.

Every mutating route keeps `requireAdmin` untouched, and the diff at those call
sites is zero.

`/api/status` grows a `principal` field so the dashboard gate knows which branch
to land on.

Route composition order in `apps/gateway/src/app.ts` is load-bearing: the client
routes mount with the other `/api/*` groups, before `pluginRoutes` and well
before the `/*` static catch-all.

## Live socket

`authorised` (`apps/gateway/src/routes/stream.ts:37`) gains two arms:

- `viewer` — every `res:*`; no `stream:*`, because the console log tail is
  operator output; no plugin channels.
- `client` — `res:usage` and `res:logs`, nothing else.

This is safe for a reason specific to the frame format: a `res:*` frame carries
`{ keys }` and nothing else. It is an invalidation signal, so the client refetches
against its own scoped endpoint and no row data crosses on the socket. A future
frame that carried a payload would break this and must not be added without
revisiting the arm.

`beforeHandle` keeps its current shape — a single function, idempotent, throwing
on refusal — for the Elysia double-call reason documented there. The change is
that the resolved `Credential` carries the principal `verify` returned rather
than a hardcoded `{ kind: "admin" }`.

## Dashboard

Same SPA. A flat `/client` route beside `_app`, with its own gate reading
`principal` from `/api/status`. A client session that lands on `/app/*` is
redirected to `/client`, and a viewer or admin session on `/client` is redirected
out — a wrong-branch session should not render an empty shell built from 401s.

Both guards read one `homeFor`, in `src/routes/-gate.ts`, so a session's
destination is decided in one place. Split across the two route files, the pair
would eventually disagree and bounce a session between them forever. The leading
`-` keeps TanStack's file-based router from generating it as a route.

A flat route rather than a `_client` layout with children, because there is one
screen. The client has one key; a rail over four panels would be scaffolding for
pages that do not exist, and the next reader would go looking for them. It gets
its own shell (`ClientShell`) rather than `Rack` for the same reason.

The branch reuses `ui/`, the theme, the query client and the LIVE socket. Nothing
new is imported that the dashboard could not already import.

**The refactor of `UsageBoard.tsx` and `LogsBoard.tsx` did not happen, and should
not.** The plan was to lift fetching out so both branches could share the panels.
Once the client board existed it was clear the two want different things: the
console's panels are built around comparing keys, credentials and providers,
which is exactly the axis a client has no access to. Sharing them would have
meant a `scope` prop threaded through a dozen components, each with a branch for
a dimension the client cannot use. The client board is ~380 lines of its own and
duplicates a table style and a totals reducer; that is the cheaper of the two
duplications, and it is the one that cannot leak another key's data through a
mis-threaded prop.

## Testing

- **Auth matrix.** Each principal against each route class, asserting the
  refusals and not only the grants. A guard that grants correctly and refuses
  nothing passes a grant-only suite.
- **Scope isolation.** Two keys with traffic; key A's session sees zero of key
  B's rows in usage, in logs, and in limit readings. Assert zero, not "fewer".
- **Revocation.** A live client session stops working on the next request after
  its key is revoked, without a restart.
- **Password independence.** Changing the viewer password invalidates viewer
  sessions and leaves admin sessions alive; changing the admin password clears
  both; restore invalidates per hash that differs.
- **Redaction.** Credential ids are absent from the client quota response
  *body*. Asserting they are not rendered would pass while they sat in the
  payload.
- **Socket.** `authorised` refusals per topic class per principal, including the
  `stream:*` refusal for viewer and the plugin-channel refusal for both.
- **Dashboard.** Gate routing per principal under happy-dom, and the client
  branch's boards against a scoped fetch stub.

## Out of scope

- Multiple named viewer accounts. One viewer password. Named, individually
  revocable viewer identities are a table and a management UI, and nothing here
  needs them yet.
- Client-visible request bodies.
- Any mutation by a client or viewer, including revoking their own key.
- CLI access to these surfaces. `omni` administers through `@omni/control` as the
  operator and has no reason to hold a reduced principal.
