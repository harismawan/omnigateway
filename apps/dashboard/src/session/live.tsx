/**
 * The chassis LIVE switch, which now lives in the plugin SDK.
 *
 * Kept as a module of its own rather than deleted, because seven boards import
 * `useLive` from here and the switch is a console concept that happens to be
 * *implemented* somewhere shared — a reader looking for it should land on this
 * file and be told where it went, not grep the SDK on a hunch.
 *
 * Still `.tsx` despite holding no JSX: renaming it would churn the extension in
 * every importer for no gain.
 *
 * It moved because a plugin panel has to be able to honour the same switch, and
 * a panel may not import an app. `packages/dashboard-sdk/src/live.ts` carries
 * the reasoning, including why one copy of that module rather than two is the
 * whole point.
 */
export {
  type Cadence,
  type LiveConnection,
  type LiveContextValue,
  LiveProvider,
  useLive,
} from "@omnigateway/dashboard-sdk";
