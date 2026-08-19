# @omnigateway/plugin-api

The server half of an [OmniGateway](https://github.com/harismawan/omnigateway)
plugin: the manifest schema, the capability context your `setup` receives, and
the event payloads it can subscribe to.

```bash
bun add @omnigateway/plugin-api
```

## Before anything else

A plugin is `import`ed into the gateway process. That process holds the
encryption key, decrypted provider tokens, and admin session state. Bun has no
in-process sandbox.

The capability context is **a guardrail, not a sandbox**. It makes accidental
overreach impossible and makes a plugin's intent auditable from its manifest. It
does not contain hostile code, which can import whatever it likes regardless of
what the host hands it. Install plugins you wrote or audited, and say the same
thing in your own README if you publish one.

## Use

```js
import { definePlugin } from "@omnigateway/plugin-api/define";

export default definePlugin({
  migrations: [
    { version: 1, sql: "CREATE TABLE {{notes}} (id TEXT PRIMARY KEY, body TEXT)" },
  ],
  setup(ctx) {
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

`{{name}}` expands to `plugin_<your id>_<name>`. You never write the prefix and
cannot address another plugin's tables or a core one. Routes mount under
`/api/plugins/<your id>/` and the host wraps them in the admin check — you cannot
opt out and you do not write the guard.

## Entry points

| Import | Holds | Carries zod |
| --- | --- | --- |
| `@omnigateway/plugin-api/define` | `definePlugin`, context types | no |
| `@omnigateway/plugin-api/events` | event payload types, `WINDOW_MS`, the limit unions | no |
| `@omnigateway/plugin-api/version` | `PLUGIN_API_VERSION`, `DASHBOARD_SDK_VERSION` | no |
| `@omnigateway/plugin-api/manifest` | the manifest schema and its parser | **yes** |
| `@omnigateway/plugin-api` | all of the above | **yes** |

Import from the narrow entries. The manifest schema is built at module scope, so
reaching it pulls a validator into your bundle — and the manifest is parsed by
the *host*, before your code is imported at all, so a plugin has no runtime use
for it.

## Versioning

The major is `PLUGIN_API_VERSION`, the number your manifest declares as `api`. A
host implementing a different major skips your plugin at boot rather than
loading it and failing later.

## Requirements

Published as TypeScript sources — Bun imports them directly, so there is no build
step and no dual-package hazard. If you typecheck with `tsc`, use
`"moduleResolution": "bundler"`.

Full guide: [writing a plugin](https://github.com/harismawan/omnigateway/blob/main/docs/writing-a-plugin.md).

MIT.
