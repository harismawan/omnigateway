import { fileURLToPath, URL } from "node:url";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { SHARED_IMPORTS } from "./shared/manifest.ts";

/**
 * Writes the import map into `index.html`, ahead of the module script.
 *
 * It must be prepended: an import map has to appear before the first module
 * import it governs, and a browser rejects one that arrives late. `head-prepend`
 * also keeps it ahead of the theme script, which is inline and does not import.
 */
function importMap(): Plugin {
  return {
    name: "omni-import-map",
    transformIndexHtml: {
      order: "pre",
      handler() {
        return [
          {
            tag: "script",
            attrs: { type: "importmap" },
            children: JSON.stringify({ imports: SHARED_IMPORTS }),
            injectTo: "head-prepend",
          },
        ];
      },
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [
    // Must precede react(): it writes routeTree.gen.ts, which react() then compiles.
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react({
      // Readable class names and reliable hot reload for styled-components.
      babel: { plugins: [["babel-plugin-styled-components", { displayName: true, ssr: false }]] },
    }),
    // Build only. The dev server resolves these from node_modules as usual, so
    // `vite dev` keeps working without a shared bundle having been built first.
    ...(command === "build" ? [importMap()] : []),
  ],
  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
      // `use-sync-external-store` is CommonJS, requires React, and React is
      // external — three facts a bundle cannot hold at once. Rolldown emits a
      // `require` stub that throws on load, which took the console down in 0.4.0
      // and 0.4.1. Aliased to ESM equivalents in `src/shims/`, where the import
      // of React is an ordinary external and resolves through the import map.
      //
      // Matched by pattern and not by exact specifier because six different
      // spellings reach this package from `recharts`, `react-redux`,
      // `@reduxjs/toolkit` and `@tanstack/react-store` — with and without
      // `/shim`, with and without `.js`. Any one of them left unaliased brings
      // the CommonJS back. `with-selector` is listed first: `shim` is a prefix
      // of `shim/with-selector`, so the looser pattern would otherwise win.
      {
        find: /^use-sync-external-store\/(?:shim\/)?with-selector(?:\.js)?$/,
        replacement: fileURLToPath(
          new URL("./src/shims/use-sync-external-store-with-selector.ts", import.meta.url),
        ),
      },
      {
        find: /^use-sync-external-store(?:\/shim)?(?:\/index)?(?:\.js)?$/,
        replacement: fileURLToPath(
          new URL("./src/shims/use-sync-external-store.ts", import.meta.url),
        ),
      },
    ],
  },
  build: {
    // The gateway serves this directory as static files in production.
    outDir: "dist",
    // This build runs FIRST and clears dist, then `build:shared` writes
    // dist/shared into it. The reverse order would need emptyOutDir off here,
    // which leaves every previous build's hashed assets behind forever.
    emptyOutDir: true,
    rollupOptions: {
      external: Object.keys(SHARED_IMPORTS),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Dev-only. In production the gateway serves the bundle from the same
      // origin, so these paths resolve without a proxy.
      "/api": { target: "http://127.0.0.1:9000", changeOrigin: false },
      "/oauth": { target: "http://127.0.0.1:9000", changeOrigin: false },
    },
  },
}));
