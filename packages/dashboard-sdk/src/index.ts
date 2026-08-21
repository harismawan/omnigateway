/**
 * `@omnigateway/dashboard-sdk` — what a plugin's UI bundle builds against.
 *
 * Five things and no more: a way to declare a UI, a way to call your own
 * backend, the palette names you may use, the console's LIVE switch, and the
 * version the host will check you against.
 *
 * ## React, styled-components and react-query are peer dependencies
 *
 * They are declared in `peerDependencies` and must never move into
 * `dependencies`. This is the single failure the whole federation design exists
 * to prevent: a plugin that resolves its own copy of React ends up with two
 * React instances on one page, and every hook in that plugin throws "invalid
 * hook call" — an error whose message points at the plugin's own code and never
 * at the duplicated dependency that caused it. `apps/dashboard/shared/manifest.ts`
 * documents the same trap from the host's side, where the console externalises
 * these four specifiers and serves them through an import map.
 *
 * The peer declarations here are a contract statement rather than a resolution
 * mechanism: installing this SDK is how a plugin author learns which four
 * packages the host owns, and their bundler must mark as external. A test reads
 * this package's `package.json` and asserts they are peers and nothing else,
 * because the mistake is one character in a JSON file and its symptom appears
 * nowhere near it.
 *
 * ## This package is itself shared, and that is newer than the rest of this file
 *
 * It used to import React only as types, on the reasoning that the SDK is the
 * one dependency every plugin has and therefore the worst possible place to be
 * wrong about which React instance is in use. That reasoning was right and it
 * is why `live.ts` — the one module here that imports React at runtime —
 * arrived in the same change that added this package to the console's
 * `SHARED_IMPORTS`.
 *
 * Shared, the argument inverts: there is one copy of this package on the page,
 * served by the host, importing the host's one React. What that buys is not
 * just instance identity but **context identity**, which a duplicated copy
 * breaks in total silence — see `live.tsx`. So the list a plugin's bundler must
 * mark external is five specifiers now, not four, and the fifth is this one.
 */

/**
 * The dashboard SDK version, re-exported from the host's manifest module.
 *
 * Not a second copy of the literal. The gateway checks a plugin's `sdk` semver
 * range against `DASHBOARD_SDK_VERSION`, so if this file declared its own
 * string the two would drift and produce the worst-shaped failure available: a
 * plugin that verifies clean at load, gets a live nav entry, and then refuses
 * to mount — or the reverse, a plugin disabled with a version reason that its
 * own SDK insists is satisfied. One source, imported.
 */
export { DASHBOARD_SDK_VERSION as SDK_VERSION } from "@omnigateway/plugin-api/version";

export {
  createPluginApi,
  type PluginApi,
  PluginApiError,
  pluginApiPath,
  usePluginApi,
} from "./api.ts";
export { type Cadence, type LiveContextValue, LiveProvider, useLive } from "./live.ts";
export { CSS_VARIABLES, type CssVariable } from "./theme.ts";
export { definePluginUI, type PluginUiDefinition, type PluginUiProps } from "./ui.ts";
