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
 * The chassis LIVE switch.
 *
 * One deliberate control rather than a setting hidden per screen, because "am I
 * refreshing" is a single question however the refreshing happens to be done.
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
 * Still `.tsx` despite holding no JSX: renaming it would churn the extension in
 * every importer for no gain.
 */

/**
 * How often a query refetches, or `false` for not at all.
 *
 * Shaped to be fed straight into a react-query `refetchInterval`. It lives
 * beside `cadence` because a type and the one function that produces it
 * drifting apart is a way for `false` to stop meaning "paused".
 */
export type Cadence = number | false;

/**
 * How this tab is currently being kept up to date.
 *
 * `push` is a healthy socket, `poll` is the permanent fallback — a proxy that
 * strips `Upgrade`, or a socket that dropped often enough to stop being worth
 * retrying — and `offline` is neither working.
 */
export type LiveConnection = {
  status: "push" | "poll" | "offline";
  /** Whether this exact topic is being pushed right now. */
  pushed: (topic: string) => boolean;
};

/** What a board with no transport above it sees: polling, as before. */
const POLLING_ONLY: LiveConnection = { status: "poll", pushed: () => false };

export type LiveContextValue = {
  live: boolean;
  toggle: () => void;
  /**
   * Feed straight into a query's `refetchInterval`. `topic` is optional, and
   * its absence means "poll on this interval" exactly as it always has.
   */
  cadence: (ms: number, topic?: string) => Cadence;
  connection: LiveConnection;
};

const LiveContext = createContext<LiveContextValue | null>(null);

export function LiveProvider({
  children,
  connection = POLLING_ONLY,
}: {
  children: ReactNode;
  /** Supplied by the console's socket. Absent means no socket: polling. */
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
        // No topic means a caller watching something nothing emits for. It
        // polls, exactly as before.
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
  // Outside the shell (login, tests of a bare feature) polling is simply off.
  // Not an error: a component that cannot find the switch has no business
  // deciding the answer is "poll anyway".
  return (
    value ?? {
      live: false,
      toggle: () => {},
      cadence: () => false,
      connection: { status: "offline", pushed: () => false },
    }
  );
}
