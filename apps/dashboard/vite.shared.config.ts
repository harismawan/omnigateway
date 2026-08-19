import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import { SHARED_IMPORTS, sharedEntryName } from "./shared/manifest.ts";

/**
 * The shared runtime the console and every plugin import through an import map.
 *
 * One Rollup graph with several entries, deliberately. React and react-dom must
 * be the *same* instance for both halves or hooks throw "invalid hook call" the
 * moment a plugin renders — so these cannot be independent builds. Code
 * splitting hoists the real packages into common chunks that every entry
 * imports, which is what makes one instance rather than six copies.
 *
 * Entry filenames are stable because they are the import map's targets. The
 * chunks behind them stay hashed: nothing outside this build names them.
 */
export default defineConfig({
  build: {
    outDir: "dist/shared",
    emptyOutDir: true,
    // Otherwise `public/` is copied in here too, and the favicon ends up served
    // at both `/favicon.svg` and `/shared/favicon.svg`.
    copyPublicDir: false,
    // A library-style build with no HTML entry. `modulePreload` is off because
    // the import map, not a preload tag, is what resolves these.
    modulePreload: false,
    rollupOptions: {
      // Without this every entry is tree-shaken to nothing: these modules only
      // re-export, and nothing inside the build consumes them, so the bundler is
      // entitled to conclude the exports are dead. They are the whole point.
      preserveEntrySignatures: "strict",
      input: Object.fromEntries(
        Object.entries(SHARED_IMPORTS).map(([, url]) => [
          sharedEntryName(url),
          fileURLToPath(new URL(`./shared/${sharedEntryName(url)}.ts`, import.meta.url)),
        ]),
      ),
      output: {
        format: "es",
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
      },
    },
  },
});
