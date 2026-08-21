# @omnigateway/dashboard-sdk

Build a console panel for an [OmniGateway](https://github.com/harismawan/omnigateway)
plugin.

```bash
bun add @omnigateway/dashboard-sdk
```

## Use

```jsx
import { definePluginUI } from "@omnigateway/dashboard-sdk";

export default definePluginUI({
  mount({ pluginId, api }) {
    const { data } = useQuery({ queryKey: ["notes"], queryFn: () => api.get("notes") });
    return <div style={{ color: "var(--ink)" }}>{data?.notes?.length ?? 0} notes</div>;
  },
});
```

`api` is scoped to your own plugin's prefix — `api.get("notes")` reaches
`/api/plugins/<your id>/notes`, and there is no way to spell a path outside it.

## The one rule that matters

Build your bundle with `react`, `react-dom`, `styled-components`,
`@tanstack/react-query` **and this package** as externals:

```bash
bun build ui/index.tsx --outfile dist/ui/index.js --target browser --format esm \
  --external react --external react-dom --external 'react/jsx-runtime' \
  --external styled-components --external '@tanstack/react-query' \
  --external '@omnigateway/dashboard-sdk'
```

The console resolves them through an import map so that it and every plugin share
one React instance. Bundling your own is the single mistake this package exists
to prevent: two React copies make every hook throw `invalid hook call`, and the
error names none of this.

Since `0.1.1` that list includes `@omnigateway/dashboard-sdk` itself, and it is
the entry easiest to leave off — it is *your* SDK, so externalising it reads
like a mistake. It is not. `useLive` is a React context held in this package, so
a bundled copy is a second context object: your panel finds no provider above
it, takes the "polling is off" default, and never refreshes again. Nothing
throws. Nothing appears in the console. The panel simply stops updating, which
looks exactly like the operator having paused it.

Keep it in `peerDependencies` alongside the rest for the same reason.

## Styling

Use the console's CSS custom properties — `var(--accent)`, `var(--panel)`,
`var(--ink)`. `CSS_VARIABLES` lists them. They are the real contract: the light
and dark palettes swap underneath without your component re-rendering. Colour
means provider identity or state, never decoration.

Your mount sits inside an error boundary. A render failure shows an inline panel
naming your plugin and leaves the rest of the console working.

## Versioning

`SDK_VERSION` is what a manifest's `sdk` range is matched against, and it equals
this package's npm version. A mismatch disables **only** your UI — the server
half keeps running, so a plugin that collects data does not go dark because the
console's React moved.

## Requirements

Published as TypeScript sources. If you typecheck with `tsc`, use
`"moduleResolution": "bundler"`.

Full guide: [writing a plugin](https://github.com/harismawan/omnigateway/blob/main/docs/writing-a-plugin.md).

MIT.
