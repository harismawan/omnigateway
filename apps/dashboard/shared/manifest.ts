/**
 * The federation contract: what the console externalises, what the import map
 * resolves, and what `vite.shared.config.ts` must therefore build.
 *
 * One object because these three lists going out of step fails in three
 * different and equally unhelpful ways. A specifier externalised but missing
 * from the map is a bare import the browser cannot resolve. One in the map but
 * not built is a 404 at boot. One built but not externalised means the console
 * bundles its own copy while plugins import another — two React instances, and
 * every plugin hook throws "invalid hook call" with nothing pointing here.
 *
 * The SDK is here for a different reason than the other five, and a quieter
 * one. Those are about instance identity: two Reacts throw, two
 * styled-components render from different stylesheets, and both say so. The SDK
 * holds `LiveContext`, so a second copy is a second *context object* — a panel
 * reading it finds no provider, takes the "polling is off" default, and stops
 * polling for good without throwing. Nothing announces it. That is why it is on
 * this list rather than left to each plugin to bundle.
 */
export const SHARED_IMPORTS = {
  react: "/shared/react.js",
  "react/jsx-runtime": "/shared/jsx-runtime.js",
  "react-dom": "/shared/react-dom.js",
  "react-dom/client": "/shared/react-dom-client.js",
  "styled-components": "/shared/styled-components.js",
  "@tanstack/react-query": "/shared/react-query.js",
  "@omnigateway/dashboard-sdk": "/shared/dashboard-sdk.js",
} as const;

export type SharedSpecifier = keyof typeof SHARED_IMPORTS;

/** Entry name in the shared build, derived from the URL it is served at. */
export function sharedEntryName(url: string): string {
  const file = url.slice(url.lastIndexOf("/") + 1);
  return file.endsWith(".js") ? file.slice(0, -3) : file;
}
