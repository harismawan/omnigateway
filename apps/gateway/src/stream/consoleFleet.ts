import type { ConsoleQuery, ConsoleRead } from "@omni/control";
import type { Coord } from "@omni/coord";
import { GatewayError } from "@omni/ir";

export type ConsoleFleet = {
  /** One process's console: read locally when it is this one, over the coordinator otherwise. */
  read(nodeId: string, query: ConsoleQuery): Promise<ConsoleRead>;
  stop(): void;
};

export type ConsoleFleetDeps = {
  coord: Coord;
  nodeId: string;
  /** This process's own read; `undefined` where it captures nothing. */
  local: ((query: ConsoleQuery) => Promise<ConsoleRead>) | undefined;
  timeoutMs?: number;
};

type Ask = { id: string; nodeId: string; query: ConsoleQuery };

const ASK = "console:read";
const ANSWER = "console:answer:";

/** How long a read of another process may take before it is reported as unreachable. */
const TIMEOUT_MS = 3_000;

/**
 * Reads another process's console over the coordinator's fan-out.
 *
 * Each process has one stdout, so a console that shows the log of "the
 * gateway" shows the log of whichever process the balancer chose. This is the
 * request half of showing a chosen one: an ask published to every process,
 * answered by the one it names, on a topic minted for that one ask. A process
 * that captures nothing answers `none`, which is what its own `/api/console`
 * would say; a process that is gone answers nothing and the ask times out
 * into `TIMEOUT`, distinct from an empty log.
 */
export function createConsoleFleet(deps: ConsoleFleetDeps): ConsoleFleet {
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;

  const unsubscribe = deps.coord.pubsub.subscribe(ASK, (_topic, raw) => {
    const ask = JSON.parse(raw) as Ask;
    if (ask.nodeId !== deps.nodeId) return;
    void (
      deps.local === undefined
        ? Promise.resolve<ConsoleRead>({ source: "none", lines: [] })
        : deps.local(ask.query)
    ).then((read) => deps.coord.pubsub.publish(ANSWER + ask.id, JSON.stringify(read)));
  });

  return {
    async read(nodeId, query) {
      if (nodeId === deps.nodeId) {
        return deps.local === undefined ? { source: "none", lines: [] } : deps.local(query);
      }
      const id = crypto.randomUUID();
      return new Promise<ConsoleRead>((resolve, reject) => {
        let off = () => {};
        const timer = setTimeout(() => {
          off();
          reject(new GatewayError("TIMEOUT", "that gateway process did not answer"));
        }, timeoutMs);
        off = deps.coord.pubsub.subscribe(ANSWER + id, (_topic, raw) => {
          clearTimeout(timer);
          off();
          resolve(JSON.parse(raw) as ConsoleRead);
        });
        void deps.coord.pubsub.publish(ASK, JSON.stringify({ id, nodeId, query } satisfies Ask));
      });
    },
    stop: unsubscribe,
  };
}
