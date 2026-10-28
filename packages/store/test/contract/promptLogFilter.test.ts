import { expect, test } from "bun:test";
import { exec, forEachStore, logRow } from "./harness.ts";

forEachStore((backend) => {
  test("prompt ID matches the exact case-sensitive boundary across pages and key scope", async () => {
    const store = await backend.fresh();
    for (const [id, prompt, apiKeyId] of [
      ["team-v1", "team@1", "mine"],
      ["team-extra", "team-extra@2", "mine"],
      ["other-team", "other-team@3", "mine"],
      ["team-v11", "team@11", "mine"],
      ["foreign", "team@1", "theirs"],
      ["uppercase", "TEAM@1", "mine"],
    ] as const) {
      await store.usage.append(logRow({ id, prompts: ["other@1", prompt], apiKeyId }));
    }
    const query = { limit: 1, cursor: null, promptId: "team", apiKeyId: "mine" };
    const first = await store.usage.page(query);
    const second = await store.usage.page({ ...query, cursor: first.next });
    const page = { logs: [...first.logs, ...second.logs] };
    expect(page.logs.map((log) => log.id).sort()).toEqual(["team-v1", "team-v11"]);
    expect(first.next).not.toBeNull();
    expect(second.next).toBeNull();
    expect(
      (await store.usage.page({ cursor: null, promptId: "team", limit: 20 })).logs,
    ).toHaveLength(3);
  });

  test("malformed stored applied IDs degrade to an empty list on every read", async () => {
    const store = await backend.fresh();
    await store.usage.append(logRow({ id: "corrupt", prompts: ["team@1"] }));
    for (const raw of ["not json", "{}", '["team text",7]']) {
      await exec(backend, store, `UPDATE request_logs SET prompts = '${raw}' WHERE id = 'corrupt'`);
      expect((await store.usage.get("corrupt"))?.prompts).toEqual([]);
      expect((await store.usage.page({ limit: 1, cursor: null })).logs[0]?.prompts).toEqual([]);
      expect(
        (
          await store.usage.exportPage({
            after: { completedAt: 0, id: "" },
            settledBefore: Number.MAX_SAFE_INTEGER,
            limit: 1,
          })
        )[0]?.prompts,
      ).toEqual([]);
    }
  });
});
