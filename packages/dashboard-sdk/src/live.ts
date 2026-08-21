import {
  createContext,
  createElement,
  type ReactNode,
  use,
  useCallback,
  useMemo,
  useState,
} from "react";

/**
 * How often a query refetches, or `false` for not at all.
 *
 * Shaped to be fed straight into a react-query `refetchInterval`, which is the
 * only thing it is for. It lives beside `cadence` rather than in the console's
 * `api/queries.ts`, where it started, because a type and the one function that
 * produces it drifting apart is a way for `false` to stop meaning "paused".
 */
export type Cadence = number | false;

export type LiveContextValue = {
  live: boolean;
  toggle: () => void;
  /** Feed straight into a query's `refetchInterval`. */
  cadence: (ms: number) => Cadence;
};

const LiveContext = createContext<LiveContextValue | null>(null);

/**
 * The chassis LIVE switch. Polling is the gateway's only push mechanism — there
 * is no log socket — so pausing it has to be one deliberate control rather than
 * a setting hidden per screen.
 *
 * ## Why this is in the SDK and not in the console
 *
 * "Which control pauses polling" is a rule, and this package is where the
 * console and a plugin panel agree on rules rather than on shapes — the same
 * reason `pluginApiPath` is imported by the host instead of copied into it. A
 * panel that polled through a pause would be the switch being true in one place
 * and not the other, which is exactly the failure that argument is about.
 *
 * ## Why it is safe for this file to import React
 *
 * It is the one runtime React import in this package, and it is only sound
 * because `@omnigateway/dashboard-sdk` is externalised by the console and
 * resolved through its import map — see `apps/dashboard/shared/manifest.ts`.
 * That buys the property this file actually depends on, which is stronger than
 * one React instance: **one `LiveContext` object**. A second copy of this
 * module would call `createContext` again, and a panel reading that second
 * context would find no provider above it and fall through to the default in
 * `useLive` — polling silently off, forever, with nothing thrown and nothing
 * logged. A plugin bundle must therefore mark this package external exactly as
 * it marks React.
 *
 * ## Why `createElement` rather than JSX
 *
 * This package's sources are typechecked by the repository root `tsconfig.json`
 * along with every other `packages/*`, and that is a Bun/server configuration
 * with neither `jsx` nor the DOM lib set. Turning JSX on for the whole core
 * typecheck to spell one provider more prettily is a worse trade than one
 * `createElement`, which needs nothing. React 19 takes the context object
 * itself as the provider — `LiveContext.Provider === LiveContext` — so
 * reaching through `.Provider` would be spelling the same value longer.
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const [live, setLive] = useState(true);
  const toggle = useCallback(() => setLive((value) => !value), []);
  const value = useMemo<LiveContextValue>(
    () => ({ live, toggle, cadence: (ms: number) => (live ? ms : false) }),
    [live, toggle],
  );
  return createElement(LiveContext, { value }, children);
}

export function useLive(): LiveContextValue {
  const value = use(LiveContext);
  // Outside the shell (login, tests of a bare feature, a panel rendered by its
  // own harness) polling is simply off. Not an error: a component that cannot
  // find the switch has no business deciding the answer is "poll anyway".
  return value ?? { live: false, toggle: () => {}, cadence: () => false };
}
