import type { ComponentType, ReactNode } from "react";
import { createContext, lazy, useContext } from "react";
import type { PluginApi } from "./api.ts";
import { pluginApi } from "./api.ts";

/**
 * What the host hands a plugin's UI when it mounts it.
 *
 * Mirrored from `packages/dashboard-sdk/src/ui.ts` for the reason given in
 * `api.ts`: the console does not depend on the SDK. It does not need to. The
 * bundle arrives at runtime as an opaque module and is checked structurally, so
 * the shared type is the shape, and the shape is what the manifest's `sdk`
 * semver range is a promise about.
 */
export type PluginUiProps = {
  /** The plugin's manifest id: its API prefix, its table prefix, its log value. */
  pluginId: string;
  /** Bound to `/api/plugins/<pluginId>`. Identical to the SDK's `usePluginApi`. */
  api: PluginApi;
};

/** A plugin's default export: an object with a `mount`, never a bare component. */
export type PluginUiDefinition = {
  mount(props: PluginUiProps): ReactNode;
};

/**
 * How a plugin bundle is fetched.
 *
 * A seam rather than a bare `import()` at the call site, and it earns its place
 * twice. The entry is a URL the gateway chose at runtime, so nothing at build
 * time may try to resolve it; and a test that wants to prove the error boundary
 * catches a broken plugin needs a broken plugin, which means supplying the
 * module rather than serving one.
 */
export type PluginModuleLoader = (entry: string) => Promise<unknown>;

/**
 * The real loader.
 *
 * `@vite-ignore` is required, not decorative: without it the bundler treats the
 * argument as a build-time specifier, fails to resolve `/plugin-assets/…`, and
 * the failure lands at build rather than where the URL is actually known.
 */
const importModule: PluginModuleLoader = (entry) => import(/* @vite-ignore */ entry);

const LoaderContext = createContext<PluginModuleLoader>(importModule);

/**
 * Overrides how bundles are fetched, for tests.
 *
 * The default is the real dynamic import, so production mounts nothing and
 * needs no provider around the tree.
 */
export const PluginModuleLoaderProvider = LoaderContext.Provider;

export function usePluginModuleLoader(): PluginModuleLoader {
  return useContext(LoaderContext);
}

/**
 * Reads a loaded module's default export, or says what is wrong with it.
 *
 * Checked rather than cast, because the alternative failure is unhelpful in a
 * specific way: a module whose default export is a bare function reaches the
 * renderer and throws "Element type is invalid", which names nothing an
 * operator or the plugin's author can act on. This throws inside the boundary
 * with the plugin's id in the message.
 */
function readDefinition(module: unknown, pluginId: string): PluginUiDefinition {
  const exported: unknown = (module as { default?: unknown } | null)?.default;
  if (exported === undefined || exported === null) {
    throw new Error(`plugin ${pluginId} has no default export from definePluginUI`);
  }
  // Read off a function as readily as off an object: a bare component default
  // is the mistake this exists to name, and it is a function.
  const mount: unknown = (exported as { mount?: unknown }).mount;
  if (typeof mount !== "function") {
    throw new Error(`plugin ${pluginId} exported a default without a mount function`);
  }
  return exported as PluginUiDefinition;
}

/**
 * The plugin's panel as an ordinary lazy component.
 *
 * `mount` is called in render position, so it *is* a function component: hooks
 * inside it behave exactly as they do anywhere else, reached through a named
 * property instead of a default export.
 */
export function pluginComponent(
  pluginId: string,
  entry: string,
  loader: PluginModuleLoader,
): ComponentType {
  return lazy(async () => {
    const definition = readDefinition(await loader(entry), pluginId);
    return {
      default: () => definition.mount({ pluginId, api: pluginApi(pluginId) }),
    };
  });
}
