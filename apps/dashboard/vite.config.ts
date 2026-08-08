import { fileURLToPath, URL } from "node:url";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    // Must precede react(): it writes routeTree.gen.ts, which react() then compiles.
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react({
      // Readable class names and reliable hot reload for styled-components.
      babel: { plugins: [["babel-plugin-styled-components", { displayName: true, ssr: false }]] },
    }),
  ],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    // The gateway serves this directory as static files in production.
    outDir: "dist",
    emptyOutDir: true,
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
});
