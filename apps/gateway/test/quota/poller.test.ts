import { expect, test } from "bun:test";
import type { OAuthProvider } from "@omni/control";
import { memoryCoord } from "@omni/coord";
import { nodeHttpClient } from "@omni/providers";
import type { CredentialSecrets } from "@omni/store";
import { memoryStore, seedCredential } from "@omni/testkit";
import { startQuotaPoller } from "../../src/quota/poller.ts";

/** A provider set whose anthropic entry reports usage through `usage`. */
function probingProviders(
  usage: () => {
    windows: Array<{
      windowType: "fiveHour" | "daily" | "weekly";
      used: number;
      limit: number | null;
      resetsAt: number | null;
    }>;
  },
): Readonly<Record<"anthropic" | "openai" | "kimi", OAuthProvider>> {
  const base = { usage: async () => usage() } as unknown as OAuthProvider;
  return { anthropic: base, openai: base, kimi: base };
}

/** A provider set that would throw if the loop ever reached it. */
const providers = new Proxy(
  {},
  {
    get: () =>
      ({
        usage: () => {
          throw new Error("the poller must not probe with polling disabled");
        },
      }) as unknown as OAuthProvider,
  },
) as Readonly<Record<"anthropic" | "openai" | "kimi", OAuthProvider>>;

test("a pass runs at startup, not only after the first interval", async () => {
  // A gateway that restarts more often than the interval — a watched dev
  // server, a container that cycles, a unit with Restart=on-failure — would
  // otherwise never poll at all, and its quota would read permanently stale.
  const store = await memoryStore();
  await seedCredential(store, { id: "startup-poll" });

  let probes = 0;
  const stop = await startQuotaPoller({
    store,
    coord: memoryCoord(),
    providers: probingProviders(() => {
      probes += 1;
      return { windows: [{ windowType: "weekly", used: 10, limit: 100, resetsAt: null }] };
    }),
    http: nodeHttpClient(),
    refresh: async (): Promise<CredentialSecrets> => {
      throw new Error("refresh not expected");
    },
    now: () => 1_000_000,
  });

  // The pass is started, not awaited, so let it settle before reading.
  await Bun.sleep(20);
  stop();

  expect(probes).toBe(1);
  expect(await store.credentials.listQuota()).toHaveLength(1);
});

test("a pass announces its readings when it finishes, not when it starts", async () => {
  // The distinction is the whole point of the placement. A `res:quota` sent at
  // the top of a pass has the console refetch readings the probes have not
  // written yet — it would render the previous pass's numbers and then go quiet
  // until the next interval, leaving every chart a full poll interval behind.
  const store = await memoryStore();
  await seedCredential(store, { id: "completion-poll" });

  const topics: string[] = [];
  /** What had been announced at the instant of each probe. Each must be nothing. */
  const atProbe: string[][] = [];

  const stop = await startQuotaPoller({
    store,
    coord: memoryCoord(),
    providers: probingProviders(() => {
      atProbe.push([...topics]);
      return { windows: [{ windowType: "weekly", used: 10, limit: 100, resetsAt: null }] };
    }),
    http: nodeHttpClient(),
    refresh: async (): Promise<CredentialSecrets> => {
      throw new Error("refresh not expected");
    },
    now: () => 1_000_000,
    broadcaster: { invalidate: (topic) => void topics.push(topic) },
  });

  await Bun.sleep(20);
  stop();

  expect(atProbe).toEqual([[]]);
  expect(topics).toEqual(["res:quota"]);
});

test("an interval of zero arms no timer at all", async () => {
  const store = await memoryStore();
  await store.config.putSettings({ quotaPollIntervalMs: 0 });

  const stop = await startQuotaPoller({
    store,
    coord: memoryCoord(),
    providers,
    http: nodeHttpClient(),
    refresh: async (): Promise<CredentialSecrets> => {
      throw new Error("refresh not expected");
    },
    now: () => 1_000_000,
  });
  stop();

  expect(await store.credentials.listQuota()).toHaveLength(0);
});
