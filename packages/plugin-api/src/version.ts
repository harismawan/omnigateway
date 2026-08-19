/**
 * The two version numbers, alone in a module with no dependencies.
 *
 * Split out because `manifest.ts` imports zod, and anything that reaches for a
 * version number through it drags a validator along. The dashboard SDK re-exports
 * `DASHBOARD_SDK_VERSION`, and every plugin UI bundle imports the SDK — so with
 * these living beside the schema, half a megabyte of zod ended up in a bundle
 * whose only crime was wanting a string.
 */

/**
 * The plugin API major the host implements.
 *
 * A manifest declares the major it was built against and is skipped on
 * mismatch. Bump this whenever `PluginContext`, an event payload, or the
 * manifest schema changes in a way an existing plugin would not survive.
 */
export const PLUGIN_API_VERSION = 1;

/**
 * The dashboard SDK version the shipped console provides.
 *
 * A plugin's manifest declares an `sdk` semver range and the host checks it
 * against this. Separate from `PLUGIN_API_VERSION` on purpose: a backend-only
 * plugin should not stop loading because the console's React moved, and a UI
 * incompatibility should disable only the UI.
 */
export const DASHBOARD_SDK_VERSION = "1.0.0";
