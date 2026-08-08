import { createContext, type ReactNode, use, useCallback, useMemo, useState } from "react";
import type { Cadence } from "../api/queries.ts";

type LiveContextValue = {
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
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const [live, setLive] = useState(true);
  const toggle = useCallback(() => setLive((value) => !value), []);
  const value = useMemo<LiveContextValue>(
    () => ({ live, toggle, cadence: (ms: number) => (live ? ms : false) }),
    [live, toggle],
  );
  return <LiveContext value={value}>{children}</LiveContext>;
}

export function useLive(): LiveContextValue {
  const value = use(LiveContext);
  // Outside the shell (login, tests of a bare feature) polling is simply off.
  return value ?? { live: false, toggle: () => {}, cadence: () => false };
}
