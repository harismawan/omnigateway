import type { ReactNode } from "react";
import type { PluginApi } from "./api.ts";

/**
 * What the host hands a plugin's UI when it mounts it.
 *
 * Kept to the two things a panel cannot derive for itself. The id is what every
 * other surface is keyed on — the API prefix, the storage table prefix, the log
 * field — so a plugin that needs to name itself should read it here rather than
 * hard-code a string that will disagree with its directory the day someone
 * renames the install. The `api` is passed as well as being available from
 * `usePluginApi` so that the common case — a panel with one data source, at the
 * root — needs no hook at all.
 *
 * Nothing about the session, the operator, or the store is in here. A plugin UI
 * that wants any of that asks its own backend for it, over its own prefix,
 * where the host has already authenticated the request.
 */
export type PluginUiProps = {
  /** The plugin's manifest id: its API prefix, its table prefix, its log value. */
  pluginId: string;
  /** Bound to `/api/plugins/<pluginId>`. Identical to `usePluginApi(pluginId)`. */
  api: PluginApi;
};

/**
 * A plugin's UI entry point.
 *
 * An object with a named `mount`, rather than a bare component, for three
 * reasons — and the shape matters more than it looks, because it is the one
 * thing the `sdk` semver range in the manifest is a promise about.
 *
 * 1. The host can *check* it. A default export that is an object with a
 *    function at `mount` is a shape `typeof` can confirm before React is
 *    involved, so a plugin that exported the wrong thing gets the disabled nav
 *    entry with a reason — the same treatment as a version mismatch. A bare
 *    function is indistinguishable from any other function export, so the same
 *    mistake would instead reach the renderer and surface inside the error
 *    boundary as "Element type is invalid", which names nothing an operator or
 *    the author can act on.
 * 2. It has somewhere to grow. A title, an icon, a per-plugin error fallback:
 *    each is a field added to an object without changing what a plugin's
 *    default export *is*. Going from `export default MyPanel` to
 *    `export default { mount: MyPanel, icon }` is a breaking change to every
 *    plugin at once, and `sdk` is a semver range precisely so that does not
 *    have to happen.
 * 3. It stays lazy. `mount` is an ordinary function called during render, so
 *    the host wraps it once — `React.lazy(() => import(url).then((m) => ({
 *    default: (p: PluginUiProps) => m.default.mount(p) })))` — and the plugin's
 *    bundle is not fetched until its route is. Because `mount` is called in
 *    render position it *is* a function component: hooks inside it work exactly
 *    as they do anywhere else, reached through a named property instead of a
 *    default export.
 */
export type PluginUiDefinition = {
  mount(props: PluginUiProps): ReactNode;
};

/**
 * Declare a plugin's UI. Returns its argument unchanged.
 *
 * The identity function earns its place by being the one symbol on both sides
 * of the contract: an author looks up `definePluginUI` and gets the definition
 * typed and completed by their editor, and the host has exactly one shape to
 * look for. `definePlugin` in `@omnigateway/plugin-api` is the same function for the same
 * reason on the server half, and the pair reads as one idea.
 *
 * It does not, and cannot, validate at runtime — it runs inside the plugin's
 * own bundle, so a plugin that never calls it is a plugin this never sees. The
 * host validates what it loads; this makes the right shape the easy one to
 * write.
 */
export function definePluginUI(definition: PluginUiDefinition): PluginUiDefinition {
  return definition;
}
