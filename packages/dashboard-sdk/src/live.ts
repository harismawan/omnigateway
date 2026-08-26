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

/**
 * How this tab is currently being kept up to date.
 *
 * `push` is a healthy socket, `poll` is the permanent fallback — a proxy that
 * strips `Upgrade`, or a socket that dropped often enough to stop being worth
 * retrying — and `offline` is neither working.
 *
 * A plain snapshot rather than a hook, so a panel can render the state without
 * importing anything from the transport.
 */
export type LiveConnection = {
  status: "push" | "poll" | "offline";
  /** Whether this exact topic is being pushed right now. */
  pushed: (topic: string) => boolean;
};

/** What a panel with no transport above it sees: polling, as before. */
const POLLING_ONLY: LiveConnection = { status: "poll", pushed: () => false };

export type LiveContextValue = {
  live: boolean;
  toggle: () => void;
  /**
   * Feed straight into a query's `refetchInterval`.
   *
   * `topic` is optional, and its absence means "poll on this interval" exactly
   * as it always has. That is what keeps this an additive change: a panel built
   * against an earlier SDK calls `cadence(ms)` and behaves identically, rather
   * than going dark until its author republishes.
   */
  cadence: (ms: number, topic?: string) => Cadence;
  connection: LiveConnection;
};

const LiveContext = createContext<LiveContextValue | null>(null);

/**
 * The chassis LIVE switch. It is one deliberate control rather than a setting
 * hidden per screen, because "am I refreshing" is a single question however the
 * refreshing happens to be done.
 *
 * ## What the switch means now that there is a socket
 *
 * It means "am I refreshing", and it always did. Push and poll are two ways of
 * answering the same question, so the switch sits above both: paused is paused
 * whether the data would have arrived on a socket or on an interval.
 *
 * `cadence` therefore checks the switch *first* and the transport second. A
 * pushed topic returns `false` because nothing needs to poll it, and an
 * unpushed one returns its interval — never `0`, which react-query reads as
 * "as fast as possible" and which would turn a fallback into a hammer.
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
export function LiveProvider({
  children,
  connection = POLLING_ONLY,
}: {
  children: ReactNode;
  /**
   * Supplied by the console, which owns the socket.
   *
   * A prop rather than a second context in this package. One context object is
   * already the property this file depends on, and a second one would be a
   * second thing that has to be the same instance everywhere — with the same
   * silent failure when it is not.
   */
  connection?: LiveConnection;
}) {
  const [live, setLive] = useState(true);
  const toggle = useCallback(() => setLive((value) => !value), []);
  const value = useMemo<LiveContextValue>(
    () => ({
      live,
      toggle,
      connection,
      cadence: (ms: number, topic?: string) => {
        // The switch wins over everything: paused is paused however the data
        // would have arrived.
        if (!live) return false;
        // No topic means a caller that predates push, or one watching something
        // nothing emits for. Both poll, exactly as before.
        if (topic === undefined) return ms;
        return connection.pushed(topic) ? false : ms;
      },
    }),
    [live, toggle, connection],
  );
  return createElement(LiveContext, { value }, children);
}

export function useLive(): LiveContextValue {
  const value = use(LiveContext);
  // Outside the shell (login, tests of a bare feature, a panel rendered by its
  // own harness) polling is simply off. Not an error: a component that cannot
  // find the switch has no business deciding the answer is "poll anyway".
  return (
    value ?? {
      live: false,
      toggle: () => {},
      cadence: () => false,
      connection: { status: "offline", pushed: () => false },
    }
  );
}
