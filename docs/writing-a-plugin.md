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

Install plugins you wrote or audited. If you are packaging one for other people,
say the same thing in your own README.

## What to install

```bash
bun add @omnigateway/plugin-api        # the server half
bun add @omnigateway/dashboard-sdk     # only if you ship a console panel
```

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
  "api": 1,
  "sdk": "^1.0.0",
  "server": "server/index.js",
  "ui": "ui/index.js",
  "nav": { "label": "Companion" },
  "capabilities": ["storage", "files", "net:outbound", "events:request"],
  "origins": ["https://pokeapi.co"]
}
```

`id` must equal the directory name and match `^[a-z][a-z0-9-]{0,31}$`. It becomes
a URL segment, a SQL table prefix and a log field value, so it is validated once
here and never escaped anywhere downstream.

`api` is the host's plugin-API major. A mismatch skips the plugin at boot.

`sdk` is a semver range over `@omnigateway/dashboard-sdk`. A mismatch disables **only**
the UI — the server half keeps running, so a plugin that collects data does not
go dark because the console's React moved.

`capabilities` is the whole list of what you get. Anything you did not declare
is absent from the context, so reaching for it is a type error rather than a
runtime surprise. `origins` is required with `net:outbound` and forbidden
without it.

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

## 4. Logging

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

## 5. The UI half

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

Build it as ESM with `react`, `react-dom`, `styled-components` and
`@tanstack/react-query` as **externals and peer dependencies**. The console
resolves them through an import map so that it and every plugin share one React
instance. Bundling your own is the one mistake this whole design exists to
prevent: two React instances make every hook throw "invalid hook call".

Style with the console's CSS custom properties (`var(--accent)`, `var(--panel)`,
`var(--ink)` …). `CSS_VARIABLES` in the SDK lists them. They are the real
contract; the light and dark palettes swap underneath without your component
re-rendering.

Your mount sits inside an error boundary. A render failure shows an inline panel
naming your plugin and leaves the rest of the console working.

## 6. Install and verify

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

## 7. Shipping it

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
tar -czf your-plugin.tgz -C dist your-plugin
omni plugin install ./your-plugin.tgz
```

Ship the built bundles and the manifest, nothing else. Your sources, tests and
`node_modules` are not needed at runtime and every one of them is another file an
operator has to trust.

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
