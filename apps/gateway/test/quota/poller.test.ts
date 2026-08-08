import { expect, test } from "bun:test";
import type { OAuthProvider } from "@omni/control";
import { nodeHttpClient } from "@omni/providers";
import type { CredentialSecrets } from "@omni/store";
import { memoryStore } from "@omni/testkit";
import { startQuotaPoller } from "../../src/quota/poller.ts";

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
