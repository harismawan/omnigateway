export {
  CAPABILITIES,
  type Capability,
  isApiCompatible,
  parseManifest,
  PLUGIN_API_VERSION,
  type PluginManifest,
  safeParseManifest,
} from "./manifest.ts";
export type {
  LimitReached,
  PluginEventMap,
  PluginEventName,
  PluginEvents,
  RequestCompleted,
} from "./events.ts";
