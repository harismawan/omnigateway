# Writing a plugin

The procedure for adding a plugin, and the reasons several of its steps exist at
all. Kept out of [CLAUDE.md](../CLAUDE.md) for the reason the provider checklist
is: you need it on the day you write a plugin and never otherwise, and that file
is loaded into every session.

For the boundary that governs plugin code — what the capability context hands
over and what it never does — see [CLAUDE.md](../CLAUDE.md#architectural-boundaries)
rule 15. [ARCHITECTURE.md](../ARCHITECTURE.md#plugins) has the trust posture, the
storage track, the event guarantees and why the console shares one React, and
[the host design](superpowers/specs/2026-08-19-plugin-host-design.md) records the
decisions behind all of it.

## Before anything else: what a plugin can reach

A plugin is `import`ed into the gateway process. That process holds
`OMNI_ENCRYPTION_KEY`, decrypted provider OAuth tokens and API keys, admin
session state, and API-key hashes. Bun has no in-process sandbox.

The capability context is **a guardrail, not a sandbox**. It makes accidental
overreach impossible and makes a plugin's intent auditable from one file. It
does not contain hostile code, which can `import` from `@omni/store` and read
`process.env` regardless of what the host hands it.

There is **one deliberate exception** to the list of things the context never
carries, and it is stated here rather than buried: a plugin supplying a provider
receives the decrypted credential for **its own** provider, because a codec that
cannot authenticate cannot build a request. See §6.

Install plugins you wrote or audited. If you are packaging one for other people,
say the same thing in your own README.

## What to install

```bash
bun add @omnigateway/plugin-api                    # the server half
bun add --peer @omnigateway/dashboard-sdk          # only if you ship a console panel
bun add --dev  @omnigateway/dashboard-sdk          # …and again, to typecheck against it
```

The SDK is a **peer** dependency, not a regular one. The console supplies it at
runtime through its import map, the same way it supplies React — a copy in your
own `dependencies` is a second copy on the page, and for this package that means
a second `LiveContext` and a panel that silently stops polling. The dev entry is
so `tsc` can see the types; it is not what gets loaded.

Both publish TypeScript sources — Bun imports them directly, so there is no build
step on their side and no dual-package hazard. If you typecheck with `tsc`, use
`"moduleResolution": "bundler"`.

Nothing else from this repository is available to you. The `@omni/*` packages are
internal and unpublished; an import of one resolves inside this repo and nowhere
else, which is a failure that waits until someone other than you tries to build
your plugin.

## Layout

```
<root>/plugins/<id>/
  omni-plugin.json          manifest
  server/index.js           ESM, default-exports definePlugin({...})
  ui/index.js               ESM, default-exports definePluginUI({...})
  data/                     yours, created on demand, excluded from snapshots
```

`<root>` is the installation directory — the one holding `omnigateway.db`.
`omni plugin install` puts things here for you.

## 1. The manifest

```json
{
  "id": "pokemon",
  "name": "Pokémon Companion",
  "version": "1.0.0",
  "api": 2,
  "sdk": "^0.1.0",
  "server": "server/index.js",
  "ui": "ui/index.js",
  "nav": { "label": "Companion" },
  "capabilities": ["storage", "files", "net:outbound", "events:request", "channels"],
  "origins": ["https://pokeapi.co"]
}
```

`id` must equal the directory name and match `^[a-z][a-z0-9-]{0,31}$`. It becomes
a URL segment, a SQL table prefix and a log field value, so it is validated once
here and never escaped anywhere downstream.

`api` is the host's plugin-API **generation** — a counter that only goes up, not
the npm major of `@omnigateway/plugin-api`. It is `2` today while that package is
`0.1.x`, and the two are independent on purpose: semver resets a stabilising
package to `1.0.0`, and a compatibility generation may never go backwards. A
mismatch skips the plugin at boot, server half included.

`sdk` is a semver range over `@omnigateway/dashboard-sdk`, matched against the
exact version the console ships. A mismatch disables **only** the UI — the server
half keeps running, so a plugin that collects data does not go dark because the
console's React moved.

Note the range shape while the SDK is pre-1.0: `^0.1.0` means `>=0.1.0 <0.2.0`.
Every minor is a breaking change until it reaches `1.0.0`, which is the correct
promise for a contract that has not settled.

`capabilities` is the whole list of what you get, with **one exception named
below**. Anything you did not declare is absent from the context, so reaching for
it is a type error rather than a runtime surprise. `origins` is required with
`net:outbound` and forbidden without it. `channels` is the push socket, covered
in §4.

The exception is `provider`, which is a permission rather than a context member.
Declaring it lets your plugin supply a provider through the `providers` field on
the object you export — see §6 — and omitting it makes that field a load failure.
It is the one capability you cannot reach through `ctx`, because a descriptor the
host can only obtain by running your `setup` is one the CLI cannot read at all.

`server` and `ui` are both optional; declare at least one.

## 2. The server half

```js
import { definePlugin } from "@omnigateway/plugin-api/define";

export default definePlugin({
  migrations: [
    { version: 1, sql: "CREATE TABLE {{notes}} (id TEXT PRIMARY KEY, body TEXT)" },
  ],
  setup(ctx) {
    ctx.storage.run("INSERT INTO {{notes}} (id, body) VALUES (?, ?)", ["a", "hi"]);
    return {
      routes: [
        {
          method: "GET",
          path: "/notes",
          handler: () => ({ json: { notes: ctx.storage.all("SELECT * FROM {{notes}}") } }),
        },
      ],
    };
  },
});
```

Import from `@omnigateway/plugin-api/define`, not from the package root. The root
re-exports the manifest schema and with it zod, which your bundle never needs at
runtime — it is half a megabyte of validator attached to an identity function
and some types.

Routes mount under `/api/plugins/<id>/` and the **host** wraps them in the admin
check. You cannot opt out, and you do not write the guard.

`{{name}}` expands to `plugin_<id>_<name>`. You never write the prefix, and you
cannot address another plugin's tables or a core one.

Migrations apply in order, each in its own transaction, recorded as they commit.
A failure stops there and skips the plugin; what already committed stays applied.

Throwing from `setup` skips your plugin and is reported. It does not stop the
gateway.

## 3. Events

```js
ctx.events.onRequestCompleted((event) => {
  // event.apiKeyId, event.tokens, event.costUsd, …
});
```

Two things to design around:

- Delivery is **at-most-once and not durable**. An event queued when the process
  dies is gone, and a full queue drops rather than grows. If you need exact
  accounting, reconcile from your own storage — never treat this as a ledger.
- Handlers run off the request path. Yours throwing costs you that event and
  nothing else.

`onLimitReached` hands you a `dimension` and a `window`, and
`@omnigateway/plugin-api/events` is where you get the vocabulary to interpret
them — the two unions, and `WINDOW_MS` for how long a window actually is:

```js
import { WINDOW_MS } from "@omnigateway/plugin-api/events";

ctx.events.onLimitReached((event) => {
  if (Date.now() - lastSeen < WINDOW_MS[event.window]) return;
});
```

Import it from `/events`, not from the package root, for the reason `/define`
exists — the root carries the manifest schema and with it zod.

Treat `dimension` and `window` together as the limit's identity. Nothing volatile
is in the payload on purpose: a window's reset instant is recomputed on every
evaluation, so keying on one turns "tell me when this fills" into "tell me
forever once it has".

## 4. Channels

```js
const session = ctx.channels.open("session");

session.onMessage(({ connectionId, payload }) => {
  session.send(connectionId, { echo: payload });
});
session.onClose((connectionId) => {
  // The connection is gone. Anything you were holding for it can go too.
});
```

Four things to design around:

- **The host owns the namespace.** `open("session")` becomes the wire topic
  `plugin:<your-id>:session`, with the `<your-id>` half taken from the manifest
  the host validated against your directory name. You never write the prefix and
  you cannot name another plugin's topic — the same rule `{{name}}` follows for
  your tables. Interior colons are fine, so `open("session:" + id)` is the way to
  run a topic per thing rather than one topic with a discriminator inside it.
- **Delivery is best-effort and bounded.** Each subscriber has a queue that
  **drops rather than grows**: a client that cannot keep up loses its oldest
  frames, and the drop is counted rather than reported to you. There is no retry
  and no replay. Design for a stream of current state, not a stream of
  instructions that must each arrive.
- **A throwing handler costs you your message and nothing else.** It is caught,
  counted against your plugin, and reported as one batched line — not one per
  failure. The connection stays open, the other handlers on that channel still
  run, and no other plugin notices.
- **There is no storage and no durability here.** Nothing survives a restart:
  not a channel, not a subscription, not a frame in flight. A `connectionId` is
  an opaque handle valid until `onClose` names it, and it is not an identity —
  two tabs belonging to the same operator share nothing. Anything that must
  outlive the conversation goes in your own tables.

You never touch a socket, an upgrade request, a header or the connection's
principal. Who is allowed to hold your topic is the host's decision, made
against the credential it verified at upgrade, and opening a channel does not
widen your own reach — it makes a topic available to be authorised.

One caveat with teeth: a client must **subscribe** before it sends. Your only
way to answer is `send(connectionId, …)`, which publishes on that same topic, so
a frame from an unsubscribed connection is a question whose answer has nowhere
to land — the host refuses it rather than handing you one you cannot reply to.

## 5. Logging

```js
ctx.logger.info("hatched", { event: "egg.hatched", count: 1 });
```

You get `event`, `count` and `durationMs`, and nothing else. `plugin` is bound
by the host to your validated id and cannot be set. `event` is capped and
reduced to a conservative character set.

This is not stinginess. The gateway's log field list is a closed allowlist and a
redaction boundary — it is what makes "prompts never reach stdout" enforced by
the compiler rather than by review. Handing plugins a wider one would give that
away.

## 6. Supplying a provider

A plugin can add a whole upstream — a provider the gateway routes to, prices, and
shows in the console beside the built-in ones. Declare `provider` in the
manifest, then export the descriptor and codec from your server entry:

```js
export default {
  providers: [{ descriptor, codec }],
  setup(ctx) {
    // ...
  },
};
```

**A field, not a `ctx` capability, and the reason is worth knowing before you
write one.** The gateway is not the only reader. `omni setup` writes a model's
context window into your agent's own configuration file, and `omni models
dry-run` reports what would route — and neither may run your `setup`, because
`setup` opens channels, applies migrations and mounts routes, which is a
diagnostic with side effects. A descriptor that only exists after your `setup`
has run is one only the gateway can see, so those commands answered from the
built-in providers and silently said nothing about yours.

Reading the field still imports your module, so its **top-level** code runs in
the CLI. Keep it cheap and side-effect free: open sockets and read files in
`setup`, not beside your imports. A module that never finishes evaluating is
abandoned after five seconds and reported, rather than hanging the command.

The descriptor is the same shape a built-in has, and every field is required —
there are no defaults, because `writeOverInput` defaulting to zero would
underprice cache writes silently and permanently:

```js
const descriptor = {
  id: "acme-ai",                       // must equal your plugin id
  capabilities: { tools: true, images: false, reasoning: true },
  writeOverInput: { fiveMinute: 1.25, oneHour: 2 },
  catalog: {
    defaultModel: "acme-1",
    authTypes: ["apiKey"],
    models: [
      {
        id: "acme-1",
        label: "Acme One",
        pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
        limits: { contextWindow: 200_000, maxOutputTokens: 8_192 },
      },
    ],
  },
  modelPrefixes: ["acme-"],            // infer this provider from a bare model name
  presentation: {
    label: "Acme",
    order: 90,
    tone: "cyan",
    colour: { light: "oklch(0.5 0.03 258)", dark: "oklch(0.72 0.03 258)" },
  },
};
```

The codec is two functions and an optional third:

```js
const codec = {
  buildRequest({ request, model, credentials }) {
    return {
      request: {
        url: "https://acme.example/v1/chat",
        method: "POST",
        headers: [["authorization", `Bearer ${credentials.apiKey}`]],
        body: JSON.stringify(toAcmeWire(request, model)),
      },
    };
  },
  async *decode({ body, headers, decodeState }) {
    // `body` is the upstream response stream; `decodeState` is whatever your own
    // `buildRequest` returned under that key, which is how a decoder learns what
    // the request it is decoding did. Yield StreamEvents.
  },
  classifyError({ status, body, headers, degradations, fallback }) {
    // Optional: return a GatewayError, or undefined to accept the host's default.
    //
    // `fallback` is that default, already built. Relabel from it rather than
    // re-deriving a message from `body`: the host has pulled `error.message`
    // out of the document (falling back to `detail`) and truncated it to 500
    // characters, and a codec redoing those three rules slightly differently
    // answers differently from the host for the same response, silently.
    // Matching `body` also matches a document that merely quotes a phrase
    // somewhere other than in its message.
    //
    // It is frozen. Build a new GatewayError; do not edit this one.
    //
    // `degradations` is what your `buildRequest` reported for this request —
    // attach them when the refusal is explained by what the request gave up.
  },
};
```

`buildRequest` receives the **decrypted credential for your own provider**, and
that is the one documented exception to everything the opening section says about
what a plugin is handed. A codec that cannot authenticate cannot build a request. It is bounded
two ways: routing only produces candidates for your own provider id, so you see
your provider's secrets and no other; and the codec never holds the HTTP client
or the store, so it cannot send them anywhere the host did not ask for.

Some rules the host enforces, so you find out at load rather than in production:

- Your `descriptor.id` must equal your plugin id. You cannot supply a provider
  under another plugin's name, for the same reason you cannot open its channel
  topic or name its tables.
- You cannot take a built-in's name. A plugin directory called `anthropic` is
  refused rather than allowed to win.
- Every descriptor field is checked structurally, not just for presence — a
  `catalog` that is not a catalog is a load failure, not a crash at the first
  request that reaches it.
- Declaring `providers` without the `provider` capability is a load failure. The
  manifest is the audit trail.

Your account is added with `omni credentials add-key <your-plugin-id>`. There is
no `connect` flow for a plugin provider: `connect` covers OAuth flows the
built-ins declare, and a plugin declares none.

## 7. The UI half

```js
import { definePluginUI } from "@omnigateway/dashboard-sdk";

export default definePluginUI({
  mount({ pluginId, api }) {
    const { data } = useQuery({
      queryKey: ["notes"],
      queryFn: () => api.get("notes"),
    });
    return <div style={{ color: "var(--ink)" }}>{data?.notes?.length ?? 0} notes</div>;
  },
});
```

Build it as ESM with `react`, `react-dom`, `styled-components`,
`@tanstack/react-query` and `@omnigateway/dashboard-sdk` as **externals and peer
dependencies**. The console resolves them through an import map so that it and
every plugin share one React instance. Bundling your own is the one mistake this
whole design exists to prevent: two React instances make every hook throw
"invalid hook call".

Externalising the SDK is the entry authors leave off, because it is the one
package that is obviously *theirs* to bundle. It holds `useLive`, which is a
React context, and a bundled copy is a second context object — the panel finds
no provider, takes the "polling is off" default, and stops refreshing without
throwing anything. Unlike the React case there is no error to search for.

### Polling, and the switch that pauses it

The console has one LIVE control in its chassis bar, and it governs every screen
at once — there is no per-panel refresh setting, because polling is the
gateway's only push mechanism and pausing it should be one deliberate act. A
panel joins that by taking its interval from `cadence`:

```tsx
import { useLive } from "@omnigateway/dashboard-sdk";

const { cadence } = useLive();
const thing = useQuery({
  queryKey: ["thing"],
  queryFn: () => api.get("thing"),
  refetchInterval: cadence(10_000),
});
```

`cadence(ms)` returns `ms` while the console is live and `false` while it is
paused, which is exactly what react-query's `refetchInterval` wants. Outside the
console — your own test harness, a panel rendered bare — there is no provider
and `cadence` returns `false`, so nothing polls. That is deliberate: a component
that cannot find the switch should not decide the answer is "poll anyway". Wrap
`LiveProvider` yourself in tests that need the polling path.

Style with the console's CSS custom properties (`var(--accent)`, `var(--panel)`,
`var(--ink)` …). `CSS_VARIABLES` in the SDK lists them. They are the real
contract; the light and dark palettes swap underneath without your component
re-rendering.

Your mount sits inside an error boundary. A render failure shows an inline panel
naming your plugin and leaves the rest of the console working.

## 8. Install and verify

```bash
omni plugin install ./my-plugin           # or a tarball; runs nothing from it
omni plugin verify my-plugin              # every load-time check, without loading
omni plugin list
omni restart
```

`verify` is what to run before restarting a production gateway — it reaches the
same verdict the next boot will, from the same validator, without importing your
entry.

Plugins load once at boot. There is no hot reload: `install` writes files and
tells you to restart.

## 9. Shipping it

`omni plugin install` takes a directory, a `.tgz`, an `https://` URL, or an npm
package name. Publishing to npm is the least work for whoever installs it:

```bash
npm publish                           # your plugin, built
omni plugin install your-plugin       # or your-plugin@1.2.3, or @scope/your-plugin
```

Ship the built bundles and the manifest through `files`, nothing else. An
`npm pack` archive is rooted at `package/` rather than at your plugin's name, and
the host falls back to the manifest's `id` when the archive root does not name
one — so a normal npm package works without you arranging anything.

Two constraints worth knowing before you pick a registry. The tarball must be
served from the registry's own host, which is true of npm and of a mirror but not
of a registry that proxies another's tarballs by URL. And the registry must
advertise `dist.integrity` or `dist.shasum`; a package with neither is refused
rather than installed unchecked. Only an exact version or `latest` resolves —
`omni` has no semver resolver and will not guess at a range.

If you would rather not publish, a tarball at a URL or handed over directly works
the same way:

```bash
# wherever you build — a workstation, CI
bun run build                                      # your plugin's own build
tar -czf my-plugin.tgz -C dist my-plugin

# on the host
scp my-plugin.tgz gateway-host:/tmp/
ssh gateway-host 'omni plugin install /tmp/my-plugin.tgz && omni plugin verify my-plugin && omni restart'
```

Ship the built bundles and the manifest, nothing else. Your sources, tests and
`node_modules` are not needed at runtime and every one of them is another file an
operator has to trust.

Whatever you pack, the manifest must sit at the **root** of the archive once one
wrapping directory is stripped. A build that nests it — `dist/my-plugin/
omni-plugin.json` inside a tarball made from the repository root — is refused
with "has no omni-plugin.json at its root", and that is the most common way a
plugin that builds fine turns out not to install.

A URL over plaintext `http://` is refused outright and always will be: what
arrives over that fetch is code the gateway process will `import`, so anyone
between you and the host would be choosing what the gateway runs. Silently
upgrading to `https://` would be worse — it would install *something* from a URL
the operator did not type.

**In Docker**, mount the plugin at `<root>/plugins/<id>` — the same layout
`install` writes — read-write, and restart the container. Read-write is not a
stylistic choice if your plugin declares `files`: its cache lives inside its own
directory at `<root>/plugins/<id>/data/`, the capability creates that directory
on every call, so a read-only mount fails *reads* as well as writes, with an
`EACCES` on `mkdir` rather than anything that names the mount. Keeping code
immutable while its cache stays writable is not expressible today.

To remove:

```bash
omni plugin remove my-plugin              # keeps your tables, deletes your data/
omni plugin remove my-plugin --purge      # drops the tables too, after confirming
```

## Things that will bite

- **`data/` is a cache and nothing else.** It is excluded from snapshots, so it
  has no restore path, and `omni plugin remove` deletes it along with your
  directory. Anything you cannot rebuild belongs in a table, not there. After a
  restore your tables and your files disagree until the cache refills — treat a
  missing file as normal, never as corruption, because after a restore every
  file is missing.
- **Your growth counters cannot be recomputed from `request_logs`.** Retention
  prunes it, so anything derived from it runs backwards after a sweep. Accumulate
  instead.
- **`omni plugin remove` does not drop your tables**, and a restore onto an
  install without your plugin leaves them orphaned. `omni doctor` reports them
  and nothing deletes them for you.
- **A route path is refused, not rewritten.** `/../keys` costs you that route
  with a logged reason; it does not become something the host guesses at.
