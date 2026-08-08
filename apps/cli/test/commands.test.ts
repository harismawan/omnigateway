import { expect, test } from "bun:test";
import { health, seedCredential } from "@omni/testkit";
import { cli, fakeService, makeRoot, openStore, TEST_KEY } from "./helpers/harness.ts";

/** Every test starts from a migrated, empty installation. */
async function installation(): Promise<string> {
  const root = makeRoot();
  const result = await cli(["db", "migrate"], { root });
  expect(result.code).toBe(0);
  return root;
}

test("an unknown command is a usage error, not a crash", async () => {
  const root = await installation();
  const result = await cli(["credentials", "explode"], { root });

  expect(result.code).toBe(2);
  expect(result.err).toContain("unknown command");
});

test("a misspelled flag is refused rather than ignored", async () => {
  const root = await installation();
  const result = await cli(["credentials", "list", "--tierr", "2"], { root });

  expect(result.code).toBe(2);
  expect(result.err).toContain("usage: omni credentials list");
});

test("--help works before anything is opened", async () => {
  const result = await cli(["--help"], { root: makeRoot() });

  expect(result.code).toBe(0);
  expect(result.out).toContain("omni <command>");
});

test("db migrate creates the database the gateway would open", async () => {
  const root = makeRoot();
  const result = await cli(["db", "migrate", "--json"], { root });

  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).toMatchObject({ created: true });
});

test("keys create prints the raw key once, and never again", async () => {
  const root = await installation();

  const created = await cli(["keys", "create", "--label", "ci", "--json"], { root });
  expect(created.code).toBe(0);
  const key = JSON.parse(created.out) as { key: string; id: string; prefix: string };
  expect(key.key).toStartWith("sk-omni-");

  const listed = await cli(["keys", "list", "--json"], { root });
  const body = JSON.parse(listed.out) as { keys: Array<Record<string, unknown>> };
  expect(body.keys).toHaveLength(1);
  // The raw key exists nowhere but the creation output; the list must carry
  // neither it nor the hash.
  expect(listed.out).not.toContain(key.key);
  expect(body.keys[0]).not.toHaveProperty("hash");
  expect(body.keys[0]).toMatchObject({ id: key.id, prefix: key.prefix, label: "ci" });
});

test("an absent --allow means every model, not none", async () => {
  const root = await installation();
  await cli(["keys", "create", "--json"], { root });

  const listed = await cli(["keys", "list", "--json"], { root });
  const body = JSON.parse(listed.out) as { keys: Array<{ modelAllowlist: unknown }> };
  expect(body.keys[0]?.modelAllowlist).toBeNull();
});

test("keys revoke keeps the key listed, so usage keeps its attribution", async () => {
  const root = await installation();
  const created = await cli(["keys", "create", "--json"], { root });
  const { id } = JSON.parse(created.out) as { id: string };

  const revoked = await cli(["keys", "revoke", id, "--yes"], { root });
  expect(revoked.code).toBe(0);

  const listed = await cli(["keys", "list", "--json"], { root });
  const body = JSON.parse(listed.out) as { keys: Array<{ revokedAt: number | null }> };
  expect(body.keys).toHaveLength(1);
  expect(body.keys[0]?.revokedAt).not.toBeNull();
});

test("models put seeds a target from the catalog, with its list pricing", async () => {
  const root = await installation();

  const put = await cli(["models", "put", "fast", "--from-catalog", "anthropic:claude-opus-5"], {
    root,
  });
  expect(put.code).toBe(0);

  const shown = await cli(["models", "show", "fast", "--json"], { root });
  const body = JSON.parse(shown.out) as {
    model: { targets: Array<{ provider: string; model: string; costPerMTok: { input: number } }> };
  };
  expect(body.model.targets).toHaveLength(1);
  expect(body.model.targets[0]).toMatchObject({ provider: "anthropic", model: "claude-opus-5" });
  expect(body.model.targets[0]?.costPerMTok.input).toBeGreaterThan(0);
});

test("a model that is not in the catalog is refused before anything is written", async () => {
  const root = await installation();

  const put = await cli(["models", "put", "fast", "--from-catalog", "anthropic:not-a-model"], {
    root,
  });
  expect(put.code).toBe(2);

  const listed = await cli(["models", "list", "--json"], { root });
  expect(JSON.parse(listed.out)).toEqual({ models: [] });
});

test("dry-run explains an empty pool instead of pretending to route", async () => {
  const root = await installation();
  await cli(["models", "put", "fast", "--from-catalog", "anthropic:claude-opus-5"], { root });

  const result = await cli(["models", "dry-run", "fast", "--json"], { root });
  const body = JSON.parse(result.out) as { candidates: unknown[]; deterministic: boolean };

  expect(result.code).toBe(0);
  expect(body.candidates).toHaveLength(0);
  expect(body.deterministic).toBe(true);
});

test("dry-run on an unconfigured model exits as an operator error", async () => {
  const root = await installation();
  const result = await cli(["models", "dry-run", "missing"], { root });

  expect(result.code).toBe(1);
  expect(result.err).toContain("MODEL_UNAVAILABLE");
});

test("settings set changes one value and leaves the rest alone", async () => {
  const root = await installation();
  const before = JSON.parse((await cli(["settings", "get", "--json"], { root })).out) as {
    settings: { weights: Record<string, number>; maxAttempts: number };
  };

  const result = await cli(["settings", "set", "weights.cost", "4"], { root });
  expect(result.code).toBe(0);

  const after = JSON.parse((await cli(["settings", "get", "--json"], { root })).out) as {
    settings: { weights: Record<string, number>; maxAttempts: number };
  };
  expect(after.settings.weights.cost).toBe(4);
  expect(after.settings.weights.tier).toBe(before.settings.weights.tier);
  expect(after.settings.maxAttempts).toBe(before.settings.maxAttempts);
});

test("a setting the schema rejects leaves the stored value unchanged", async () => {
  const root = await installation();

  const result = await cli(["settings", "set", "maxAttempts", "99"], { root });
  expect(result.code).toBe(1);

  const after = JSON.parse((await cli(["settings", "get", "--json"], { root })).out) as {
    settings: { maxAttempts: number };
  };
  expect(after.settings.maxAttempts).toBeLessThan(99);
});

test("credentials add-key stores a key read from a prompt, never from argv", async () => {
  const root = await installation();

  const result = await cli(["credentials", "add-key", "anthropic", "--label", "work"], {
    root,
    prompt: { isTty: false, secret: async () => "sk-ant-secret", confirm: async () => true },
  });
  expect(result.code).toBe(0);

  const listed = await cli(["credentials", "list", "--json"], { root });
  const body = JSON.parse(listed.out) as { credentials: Array<Record<string, unknown>> };
  expect(body.credentials[0]).toMatchObject({ provider: "anthropic", authType: "apiKey" });
  // The secret is not part of any credential projection, in any format.
  expect(listed.out).not.toContain("sk-ant-secret");
});

test("credentials add-key treats a blank label as the provider default", async () => {
  const root = await installation();

  await cli(["credentials", "add-key", "kimi", "--label", "   "], {
    root,
    prompt: { isTty: false, secret: async () => "test-key", confirm: async () => true },
  });

  const listed = JSON.parse((await cli(["credentials", "list", "--json"], { root })).out) as {
    credentials: Array<{ label: string }>;
  };
  expect(listed.credentials[0]?.label).toBe("kimi api key");
});

test("credentials set changes only what was named", async () => {
  const root = await installation();
  await cli(["credentials", "add-key", "kimi"], {
    root,
    prompt: { isTty: false, secret: async () => "key", confirm: async () => true },
  });
  const first = JSON.parse((await cli(["credentials", "list", "--json"], { root })).out) as {
    credentials: Array<{ id: string; label: string; weight: number }>;
  };
  const id = first.credentials[0]?.id ?? "";

  const result = await cli(["credentials", "set", id, "--tier", "3"], { root });
  expect(result.code).toBe(0);

  const after = JSON.parse((await cli(["credentials", "list", "--json"], { root })).out) as {
    credentials: Array<{ tier: number; label: string; weight: number }>;
  };
  expect(after.credentials[0]).toMatchObject({
    tier: 3,
    label: first.credentials[0]?.label ?? "",
    weight: first.credentials[0]?.weight ?? 1,
  });
});

test("credentials show returns one secret-free projection", async () => {
  const root = await installation();
  await cli(["credentials", "add-key", "anthropic", "--label", "work"], {
    root,
    prompt: { isTty: false, secret: async () => "test-secret", confirm: async () => true },
  });
  const listed = JSON.parse((await cli(["credentials", "list", "--json"], { root })).out) as {
    credentials: Array<{ id: string }>;
  };

  const shown = await cli(["credentials", "show", listed.credentials[0]?.id ?? "", "--json"], {
    root,
  });
  const credential = JSON.parse(shown.out) as Record<string, unknown>;

  expect(credential).toMatchObject({ provider: "anthropic", label: "work", authType: "apiKey" });
  expect(shown.out).not.toContain("test-secret");
});

test("credentials health emits all rows in JSON mode", async () => {
  const root = await installation();
  const store = await openStore(root);
  await seedCredential(store, { id: "c1", label: "work" });
  await store.credentials.saveHealth([
    health({ credentialId: "c1", model: "model-1", consecutiveFailures: 1 }),
  ]);
  store.close();

  const result = await cli(["credentials", "health", "--json"], { root });
  const body = JSON.parse(result.out) as { health: Array<{ credentialId: string }> };

  expect(body.health).toEqual([
    expect.objectContaining({ credentialId: "c1", model: "model-1", consecutiveFailures: 1 }),
  ]);
});

test("credentials set with nothing to change is a usage error", async () => {
  const root = await installation();
  const result = await cli(["credentials", "set", "whatever"], { root });

  expect(result.code).toBe(2);
  expect(result.err).toContain("nothing to change");
});

test("disabling a credential records that the operator did it", async () => {
  const root = await installation();
  await cli(["credentials", "add-key", "openai"], {
    root,
    prompt: { isTty: false, secret: async () => "key", confirm: async () => true },
  });
  const listed = JSON.parse((await cli(["credentials", "list", "--json"], { root })).out) as {
    credentials: Array<{ id: string }>;
  };
  const id = listed.credentials[0]?.id ?? "";

  await cli(["credentials", "disable", id], { root });

  const after = JSON.parse((await cli(["credentials", "list", "--json"], { root })).out) as {
    credentials: Array<{ enabled: boolean; disabledReason: string | null }>;
  };
  expect(after.credentials[0]).toMatchObject({ enabled: false, disabledReason: "manual" });
});

test("a delete refuses to proceed on a declined confirmation", async () => {
  const root = await installation();
  await cli(["credentials", "add-key", "kimi"], {
    root,
    prompt: { isTty: false, secret: async () => "key", confirm: async () => true },
  });
  const listed = JSON.parse((await cli(["credentials", "list", "--json"], { root })).out) as {
    credentials: Array<{ id: string }>;
  };
  const id = listed.credentials[0]?.id ?? "";

  const refused = await cli(["credentials", "rm", id], {
    root,
    prompt: { isTty: false, secret: async () => "", confirm: async () => false },
  });
  expect(refused.code).toBe(1);

  const still = JSON.parse((await cli(["credentials", "list", "--json"], { root })).out) as {
    credentials: unknown[];
  };
  expect(still.credentials).toHaveLength(1);
});

test("usage reports an empty window rather than failing", async () => {
  const root = await installation();
  const result = await cli(["usage", "--grain", "daily", "--by", "provider", "--json"], { root });

  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).toEqual({ rows: [] });
});

test("a grain that cannot answer the question is refused", async () => {
  const root = await installation();
  const result = await cli(["usage", "--grain", "daily", "--by", "hour"], { root });

  expect(result.code).toBe(1);
  expect(result.err).toContain("cannot group by");
});

test("doctor reports the encryption key's presence, never the key", async () => {
  const root = await installation();
  const service = fakeService({ root });

  const result = await cli(["doctor", "--json"], { root, service });
  const body = JSON.parse(result.out) as Record<string, unknown>;

  expect(result.code).toBe(0);
  expect(body.encryptionKey).toBe(`present (${TEST_KEY.length} chars)`);
  expect(result.out).not.toContain("test-encryption-key");
  expect(body).toMatchObject({ rootSource: "flag", databaseExists: true, running: false });
});

test("doctor still works when the installation has no encryption key", async () => {
  const root = makeRoot();
  await Bun.write(`${root}/.env`, "OMNI_PORT=8787\n");
  const service = fakeService({ root });

  const result = await cli(["doctor", "--json"], { root, service });
  const body = JSON.parse(result.out) as Record<string, unknown>;

  expect(result.code).toBe(0);
  expect(body.encryptionKey).toBe("missing");
  expect(body.configError).toMatch(/OMNI_ENCRYPTION_KEY/);
});

test("start runs the gateway that belongs to this root", async () => {
  const root = await installation();
  await Bun.write(`${root}/apps/gateway/src/index.ts`, "// gateway\n");
  const service = fakeService({ root, pid: 555 });

  const result = await cli(["start", "--json"], { root, service });

  expect(result.code).toBe(0);
  expect(service.spawned[0]?.argv[1]).toBe(`${root}/apps/gateway/src/index.ts`);
  expect(service.spawned[0]?.cwd).toBe(root);
});

test("a root with no gateway to run says so instead of spawning nothing", async () => {
  const root = await installation();
  const service = fakeService({ root });

  const result = await cli(["start"], { root, service });

  expect(result.code).toBe(1);
  expect(result.err).toContain("no gateway to run");
  expect(service.spawned).toHaveLength(0);
});

test("a gateway that starts but never answers /health exits 3", async () => {
  const root = await installation();
  await Bun.write(`${root}/apps/gateway/src/index.ts`, "// gateway\n");
  const service = fakeService({ root, healthy: false });

  const result = await cli(["start"], { root, service });

  expect(result.code).toBe(3);
  expect(result.err).toContain("did not become healthy");
});

test("status reports the process and its accounts together", async () => {
  const root = await installation();
  await cli(["credentials", "add-key", "anthropic", "--label", "work"], {
    root,
    prompt: { isTty: false, secret: async () => "key", confirm: async () => true },
  });
  const service = fakeService({ root });

  const result = await cli(["status", "--json"], { root, service });
  const body = JSON.parse(result.out) as {
    process: { running: boolean };
    adminConfigured: boolean;
    credentials: Array<{ label: string }>;
  };

  expect(result.code).toBe(0);
  expect(body.process.running).toBe(false);
  expect(body.adminConfigured).toBe(false);
  expect(body.credentials[0]?.label).toBe("work");
});

test("admin set-password refuses a password the gateway would refuse", async () => {
  const root = await installation();

  const result = await cli(["admin", "set-password"], {
    root,
    prompt: { isTty: false, secret: async () => "short", confirm: async () => true },
  });

  expect(result.code).toBe(1);
  expect(result.err).toContain("at least 12");
});

test("admin set-password stores a hash the console can verify", async () => {
  const root = await installation();

  const set = await cli(["admin", "set-password"], {
    root,
    prompt: {
      isTty: false,
      secret: async () => "a-long-enough-password",
      confirm: async () => true,
    },
  });
  expect(set.code).toBe(0);

  const service = fakeService({ root });
  const status = JSON.parse((await cli(["status", "--json"], { root, service })).out) as {
    adminConfigured: boolean;
  };
  expect(status.adminConfigured).toBe(true);
});

test("start --foreground attaches to the terminal instead of supervising", async () => {
  const root = await installation();
  await Bun.write(`${root}/apps/gateway/src/index.ts`, "// gateway\n");
  const service = fakeService({ root });
  const ran: Array<{ cwd: string; argv: readonly string[] }> = [];

  const result = await cli(["start", "--foreground"], {
    root,
    service,
    foreground: async (input) => {
      ran.push({ cwd: input.cwd, argv: input.argv });
      return 0;
    },
  });

  expect(result.code).toBe(0);
  expect(ran[0]?.argv[1]).toBe(`${root}/apps/gateway/src/index.ts`);
  // Nothing is supervised and nothing is recorded: the shell owns it.
  expect(service.spawned).toHaveLength(0);
  expect(service.commands).toHaveLength(0);
});

test("a foreground gateway that exits non-zero is reported as the gateway's failure", async () => {
  const root = await installation();
  await Bun.write(`${root}/apps/gateway/src/index.ts`, "// gateway\n");
  const service = fakeService({ root });

  const result = await cli(["start", "--foreground"], {
    root,
    service,
    foreground: async () => 1,
  });

  expect(result.code).toBe(3);
  expect(result.err).toContain("exited with code 1");
});

test("logs --service reads the process's own output, not the request log", async () => {
  const root = await installation();
  const service = fakeService({
    root,
    unitPath: `${root}/unit/omnigateway.service`,
    runResults: {
      "journalctl --user -u omnigateway.service -n 5 --no-pager": {
        code: 0,
        stdout: "omnigateway listening on http://127.0.0.1:8787\n",
        stderr: "",
      },
    },
  });
  await Bun.write(`${root}/unit/omnigateway.service`, "[Unit]\n");

  const result = await cli(["logs", "--service", "-n", "5"], { root, service });

  expect(result.code).toBe(0);
  expect(result.out).toContain("omnigateway listening");
});

test("logs without --service reads the request log", async () => {
  const root = await installation();
  const service = fakeService({ root });

  const result = await cli(["logs", "--json"], { root, service });

  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).toEqual({ logs: [] });
});

test("status reports every quota window an account has, not just the tightest", async () => {
  const root = await installation();
  await cli(["credentials", "add-key", "anthropic", "--label", "work"], {
    root,
    prompt: { isTty: false, secret: async () => "key", confirm: async () => true },
  });

  const listed = JSON.parse((await cli(["credentials", "list", "--json"], { root })).out) as {
    credentials: Array<{ id: string }>;
  };
  const id = listed.credentials[0]?.id ?? "";

  // Written the way the poller writes them: one probe, two windows.
  const store = await openStore(root);
  await store.credentials.saveQuota([
    {
      credentialId: id,
      windowType: "weekly",
      startsAt: 1_000,
      used: 200,
      limit: 1_000,
      resetsAt: null,
      observedAt: 1_000,
    },
    {
      credentialId: id,
      windowType: "fiveHour",
      startsAt: 1_000,
      used: 950,
      limit: 1_000,
      resetsAt: null,
      observedAt: 1_000,
    },
  ]);
  store.close();

  const result = await cli(["status"], { root, service: fakeService({ root }) });

  expect(result.code).toBe(0);
  // Shortest window first, so the cell reads soonest-to-latest.
  expect(result.out).toMatch(/5h 95% · 7d 20%/);
});
