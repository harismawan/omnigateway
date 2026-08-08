import { expect, test } from "bun:test";
import { type OAuthProvider, resetQuotaCooldowns } from "@omni/control";
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
  // Cooldowns are process-local and shared with every other suite in this run,
  // so a credential parked by someone else's rate-limit test would silently be
  // skipped here.
  resetQuotaCooldowns();
  const store = await memoryStore();
  await seedCredential(store, { id: "startup-poll" });

  let probes = 0;
  const stop = await startQuotaPoller({
    store,
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

test("an interval of zero arms no timer at all", async () => {
  const store = await memoryStore();
  await store.config.putSettings({ quotaPollIntervalMs: 0 });

  const stop = await startQuotaPoller({
    store,
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
