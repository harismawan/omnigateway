import { expect, test } from "bun:test";
import { openDb } from "@omni/store";
import { health, requestLog, seedCredential } from "@omni/testkit";
import { serviceLogs } from "../src/service.ts";
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

/**
 * The opt-out is a promise to whoever holds the key, and it is made once: there
 * is no update path here, in the console, or in the store. So both halves matter
 * — that the flag takes, and that its absence does not silently opt a key out of
 * something the operator meant to capture.
 */
test("keys create --no-bodies opts the key out of capture, and only when asked", async () => {
  const root = await installation();

  await cli(["keys", "create", "--label", "private", "--no-bodies"], { root });
  await cli(["keys", "create", "--label", "ordinary"], { root });

  const listed = await cli(["keys", "list", "--json"], { root });
  const body = JSON.parse(listed.out) as {
    keys: Array<{ label: string; bodyLoggingOptOut: boolean }>;
  };
  expect(body.keys.find((k) => k.label === "private")?.bodyLoggingOptOut).toBe(true);
  expect(body.keys.find((k) => k.label === "ordinary")?.bodyLoggingOptOut).toBe(false);
});

/**
 * An auditor asking which client's payloads are exempt must be able to read the
 * answer off the table rather than out of the database.
 */
test("keys list shows both sides of the capture opt-out", async () => {
  const root = await installation();
  await cli(["keys", "create", "--label", "private", "--no-bodies"], { root });
  await cli(["keys", "create", "--label", "ordinary"], { root });

  const listed = await cli(["keys", "list"], { root });
  expect(listed.out).toContain("BODY CAPTURE");
  const rows = listed.out.split("\n");
  expect(rows.find((row) => row.includes("private"))).toContain("no bodies");
  expect(rows.find((row) => row.includes("ordinary"))).not.toContain("no bodies");
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

test("models show prices every token class, not just input and output", async () => {
  const root = await installation();
  await cli(["models", "put", "fast", "--from-catalog", "anthropic:claude-opus-5"], { root });

  const shown = await cli(["models", "show", "fast"], { root });
  expect(shown.code).toBe(0);
  // An operator reading a bill needs the cache rates too: a write costs more
  // than fresh input, not less, so a table that hides it reads as if caching
  // were free.
  expect(shown.out).toContain("CACHE R");
  expect(shown.out).toContain("CACHE W 5M");
  expect(shown.out).toContain("CACHE W 1H");
  expect(shown.out).toContain("0.50");
  expect(shown.out).toContain("6.25");
  expect(shown.out).toContain("10.00");
});

test("models show names the account a target is pinned to", async () => {
  const root = await installation();
  const store = await openStore(root);
  await store.config.putModel({
    id: "billed",
    strategy: "score",
    isAlias: false,
    targets: [
      {
        provider: "anthropic",
        model: "claude-opus-5",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 5, output: 25 },
        credentialId: "cred-finance",
        capabilities: { tools: true, images: true, reasoning: true },
      },
      {
        provider: "anthropic",
        model: "claude-sonnet-5",
        tier: 2,
        weight: 1,
        costPerMTok: { input: 3, output: 15 },
        capabilities: { tools: true, images: true, reasoning: true },
      },
    ],
  });

  const shown = await cli(["models", "show", "billed"], { root });
  expect(shown.code).toBe(0);

  // Asserted by column position, not by `toContain`. A cell that renders under
  // the wrong heading satisfies "the output contains cred-finance" while
  // telling the operator something false, and "any" is a common enough word to
  // match elsewhere in the output by accident.
  const lines = shown.out.split("\n");
  const header = lines.find((line) => line.includes("PROVIDER") && line.includes("MODEL"));
  if (header === undefined) throw new Error("no target table in output");
  const column = (line: string, name: string): string | undefined =>
    line.trim().split(/\s{2,}/)[
      header
        .trim()
        .split(/\s{2,}/)
        .indexOf(name)
    ];

  expect(header).toContain("ACCOUNT");
  const pinned = lines.find((line) => line.includes("claude-opus-5"));
  const unpinned = lines.find((line) => line.includes("claude-sonnet-5"));
  if (pinned === undefined || unpinned === undefined) throw new Error("target rows missing");

  // A pin sends every request for that target to one account and fails rather
  // than falling back, so "why is one account serving everything" has to be
  // answerable from here.
  expect(column(pinned, "ACCOUNT")).toBe("cred-finance");
  // The unpinned sibling says so rather than leaving a blank cell that reads
  // like a rendering fault.
  expect(column(unpinned, "ACCOUNT")).toBe("any");
});

test("models show leaves out the account column when nothing is pinned", async () => {
  const root = await installation();
  await cli(["models", "put", "fast", "--from-catalog", "anthropic:claude-opus-5"], { root });

  const shown = await cli(["models", "show", "fast"], { root });
  expect(shown.code).toBe(0);
  // The common case. A column of "any" on every row would widen an already
  // wide table to say nothing.
  expect(shown.out).not.toContain("ACCOUNT");
});

test("models show marks a price the target does not name", async () => {
  const root = await installation();
  const store = await openStore(root);
  await store.config.putModel({
    id: "legacy",
    strategy: "score",
    isAlias: false,
    targets: [
      {
        provider: "anthropic",
        model: "claude-opus-5",
        tier: 1,
        weight: 1,
        // A target saved before write pricing existed.
        costPerMTok: { input: 5, output: 25 },
        capabilities: { tools: true, images: true, reasoning: true },
      },
    ],
  });

  const shown = await cli(["models", "show", "legacy"], { root });
  expect(shown.code).toBe(0);
  // Not a zero: nothing is stored, and pricing falls back to a multiple of
  // input. Printing 0.00 would claim the writes are free.
  expect(shown.out).toContain("\u2014");
});

test("models catalog lists the cache prices a new target would start at", async () => {
  const root = await installation();
  const listed = await cli(["models", "catalog"], { root });
  expect(listed.code).toBe(0);
  expect(listed.out).toContain("CACHE R");
  expect(listed.out).toContain("CACHE W 5M");
  expect(listed.out).toContain("CACHE W 1H");
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

/** The stored value of one flattened setting path. */
async function setting(root: string, path: string): Promise<unknown> {
  const body = JSON.parse((await cli(["settings", "get", "--json"], { root })).out) as {
    settings: Record<string, unknown>;
  };
  const [head, tail] = path.split(".");
  const value = body.settings[head ?? ""];
  if (tail === undefined) return value;
  return (value as Record<string, unknown>)[tail];
}

test("a whitespace-only setting value is refused, not written as zero", async () => {
  const root = await installation();

  // `weights.*`, `requestDeadlineMs` and `quotaPollIntervalMs` all accept 0, so
  // `Number(" ")` would be stored as a real edit rather than caught downstream.
  const result = await cli(["settings", "set", "weights.cost", " "], { root });

  expect(result.code).toBe(2);
  expect(result.err).toContain("must be a number");
  expect(await setting(root, "weights.cost")).toBe(1);
});

test("a setting value of 0 is still a value, not a blank", async () => {
  const root = await installation();

  const result = await cli(["settings", "set", "weights.cost", "0"], { root });

  expect(result.code).toBe(0);
  expect(await setting(root, "weights.cost")).toBe(0);
});

/**
 * The regression this parse exists for.
 *
 * `rtkEnabled` shipped unreachable from the CLI: the value was read with
 * `Number(raw)` and every boolean therefore failed as "must be a number" before
 * it ever reached the schema. Nothing said so, because no test ever set one.
 */
test("settings set writes a boolean setting the old number-only parse could not reach", async () => {
  const root = await installation();

  const result = await cli(["settings", "set", "rtkEnabled", "true"], { root });

  expect(result.code).toBe(0);
  expect(await setting(root, "rtkEnabled")).toBe(true);
});

test("settings set turns body capture on and off again", async () => {
  const root = await installation();

  expect((await cli(["settings", "set", "bodyLoggingEnabled", "true"], { root })).code).toBe(0);
  expect(await setting(root, "bodyLoggingEnabled")).toBe(true);

  expect((await cli(["settings", "set", "bodyLoggingEnabled", "false"], { root })).code).toBe(0);
  expect(await setting(root, "bodyLoggingEnabled")).toBe(false);

  expect(
    (await cli(["settings", "set", "bodyLoggingCaptureStreamChunks", "true"], { root })).code,
  ).toBe(0);
  expect(await setting(root, "bodyLoggingCaptureStreamChunks")).toBe(true);
});

/**
 * `1` is the tempting alias and it is refused on purpose: a capture switch read
 * as the opposite of what was typed fails silently, and two words are cheap.
 */
test("a non-boolean value for a boolean setting is refused, not coerced", async () => {
  const root = await installation();

  const result = await cli(["settings", "set", "bodyLoggingEnabled", "1"], { root });

  expect(result.code).toBe(2);
  expect(result.err).toContain("must be true or false");
  expect(await setting(root, "bodyLoggingEnabled")).toBe(false);
});

/** The type of the stored value picks the parse, so a number setting is untouched. */
test("a boolean value for a numeric setting is still refused as not a number", async () => {
  const root = await installation();

  const result = await cli(["settings", "set", "maxAttempts", "true"], { root });

  expect(result.code).toBe(2);
  expect(result.err).toContain("must be a number");
  expect(await setting(root, "maxAttempts")).toBe(3);
});

/**
 * A name off `Object.prototype` is not a setting.
 *
 * `head in current` walks the prototype chain, so `toString` and `constructor`
 * both passed the existence check. The schema then stripped the unknown key on
 * the way to the store, and the command exited 0 printing `toString = 5` over a
 * write that never happened — the one failure mode worse than an error, because
 * an operator has no reason to check.
 */
test("a prototype property is not a setting path", async () => {
  const root = await installation();
  const before = (await cli(["settings", "get", "--json"], { root })).out;

  for (const name of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
    const result = await cli(["settings", "set", name, "5"], { root });
    expect(`${name}: ${result.code}`).toBe(`${name}: 2`);
    expect(result.err).toContain(`no setting "${name}"`);
  }

  expect((await cli(["settings", "get", "--json"], { root })).out).toBe(before);
});

test("settings get prints booleans as words, not as 0 and 1", async () => {
  const root = await installation();
  await cli(["settings", "set", "rtkEnabled", "true"], { root });

  const shown = await cli(["settings", "get"], { root });
  expect(shown.code).toBe(0);
  expect(shown.out).toContain("rtkEnabled");
  expect(shown.out).toContain("true");
  expect(shown.out).toContain("bodyLoggingEnabled");
  expect(shown.out).toContain("false");
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

test("credentials add-key stores custom endpoint metadata from flags", async () => {
  const root = await installation();

  const result = await cli(
    [
      "credentials",
      "add-key",
      "custom",
      "--endpoint-id",
      "local-vllm",
      "--endpoint-label",
      "Local vLLM",
      "--origin",
      "http://localhost:8000",
      "--protocol",
      "chat-completions",
    ],
    {
      root,
      prompt: { isTty: false, secret: async () => "test-key", confirm: async () => true },
    },
  );
  expect(result.code).toBe(0);
  expect(result.out).not.toContain("test-key");

  const listed = JSON.parse((await cli(["credentials", "list", "--json"], { root })).out) as {
    credentials: Array<{ providerData: Record<string, unknown> }>;
  };
  expect(listed.credentials[0]?.providerData).toEqual({
    endpointId: "local-vllm",
    endpointLabel: "Local vLLM",
    origin: "http://localhost:8000",
    basePath: "",
    protocol: "chat_completions",
  });
});

test("credentials add-key reuses metadata for an existing custom endpoint", async () => {
  const root = await installation();
  const prompt = { isTty: false, secret: async () => "test-key", confirm: async () => true };
  await cli(
    [
      "credentials",
      "add-key",
      "custom",
      "--endpoint-id",
      "local-vllm",
      "--endpoint-label",
      "Local vLLM",
      "--origin",
      "http://localhost:8000",
      "--protocol",
      "responses",
    ],
    { root, prompt },
  );

  const result = await cli(["credentials", "add-key", "custom", "--endpoint-id", "local-vllm"], {
    root,
    prompt,
  });
  expect(result.code).toBe(0);

  const listed = JSON.parse((await cli(["credentials", "list", "--json"], { root })).out) as {
    credentials: Array<{ providerData: Record<string, unknown> }>;
  };
  expect(listed.credentials).toHaveLength(2);
  expect(listed.credentials[1]?.providerData).toEqual(listed.credentials[0]?.providerData);
});

test("credentials add-key rejoins base paths when reusing metadata", async () => {
  const root = await installation();
  const prompt = { isTty: false, secret: async () => "test-key", confirm: async () => true };
  await cli(
    [
      "credentials",
      "add-key",
      "custom",
      "--endpoint-id",
      "proxied-vllm",
      "--endpoint-label",
      "Proxied vLLM",
      "--origin",
      "http://localhost:8000/api",
      "--protocol",
      "chat-completions",
    ],
    { root, prompt },
  );

  // Reuse must resolve origin together with its stored base path, not the
  // origin alone, or the second key silently targets a different server.
  const result = await cli(["credentials", "add-key", "custom", "--endpoint-id", "proxied-vllm"], {
    root,
    prompt,
  });
  expect(result.code).toBe(0);

  const listed = JSON.parse((await cli(["credentials", "list", "--json"], { root })).out) as {
    credentials: Array<{ providerData: Record<string, unknown> }>;
  };
  const rows = listed.credentials.filter(
    (c) => String(c.providerData.endpointId) === "proxied-vllm",
  );
  expect(rows).toHaveLength(2);
  expect(rows[0]?.providerData).toEqual(rows[1]?.providerData);
  expect(rows[0]?.providerData).toMatchObject({
    origin: "http://localhost:8000",
    basePath: "/api",
  });
});

test("credentials add-key names custom among the providers connect does not", async () => {
  const root = await installation();

  const result = await cli(["credentials", "add-key", "notaprovider"], {
    root,
    prompt: { isTty: false, secret: async () => "test-key", confirm: async () => true },
  });

  expect(result.code).toBe(2);
  // Matched whole, not by `toContain`, so the line fails when a provider is
  // added and when one is dropped. The two lists are meant to differ: `connect`
  // omits `custom` because there is nothing to authorize, and this one carries
  // it because a custom endpoint is reached by key alone.
  expect(result.err.split("\n")[0]).toBe(
    "provider must be one of anthropic, openai, kimi, kilo, grok, custom",
  );
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

test("a command run under --root says so when it refuses an ambient OMNI_DB_PATH", async () => {
  const root = await installation();
  const ambient = "/home/operator/.config/omnigateway/omnigateway.db";

  // `--json` keeps stdout parseable, so the warning has to reach stderr or it
  // reaches nobody: this is the operator's only sign that the database they
  // exported is not the one being read.
  const result = await cli(["keys", "list", "--json"], {
    root,
    env: { OMNI_ENCRYPTION_KEY: TEST_KEY, OMNI_DB_PATH: ambient },
  });

  expect(result.code).toBe(0);
  expect(result.err).toContain(ambient);
  expect(result.err).toContain(`${root}/omnigateway.db`);
  expect(result.out).not.toContain(ambient);
});

/**
 * The rollup is derived, so a disagreement with `request_logs` is repairable —
 * but only by someone who knows about it, and nothing else on the installation
 * would ever say. Long-window rate limits are enforced from these buckets.
 */
test("doctor reports a target pinned to an account that is gone", async () => {
  const root = await installation();
  const service = fakeService({ root });
  const store = await openStore(root);
  await seedCredential(store, { id: "live-account", provider: "anthropic" });
  const live = (await store.credentials.list())[0];
  if (live === undefined) throw new Error("the seeded credential is not there");
  await store.config.putModel({
    id: "billed",
    strategy: "score",
    isAlias: false,
    targets: [
      {
        provider: "anthropic",
        model: "claude-opus-5",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 5, output: 25 },
        credentialId: "removed-account",
        capabilities: { tools: true, images: true, reasoning: true },
      },
      {
        provider: "anthropic",
        model: "claude-sonnet-5",
        tier: 2,
        weight: 1,
        costPerMTok: { input: 3, output: 15 },
        credentialId: live.id,
        capabilities: { tools: true, images: true, reasoning: true },
      },
    ],
  });
  store.close();

  const result = await cli(["doctor", "--json"], { root, service });
  const checks = JSON.parse(result.out) as { danglingPins: string[] };
  // A pin is deliberately not validated at save time, so nothing else in the
  // system would tell an operator this target hard-fails every request. The
  // resolvable pin beside it must not be reported — a check that flags healthy
  // configuration is one operators learn to ignore.
  expect(checks.danglingPins).toEqual(["billed/claude-opus-5 → removed-account"]);
});

test("doctor reports a pin the router cannot resolve, model by model", async () => {
  const root = await installation();
  const service = fakeService({ root });
  const store = await openStore(root);
  await seedCredential(store, { id: "anthropic-live", provider: "anthropic" });
  await seedCredential(store, { id: "kimi-live", provider: "kimi" });
  await seedCredential(store, {
    id: "custom-local",
    provider: "custom",
    providerData: { endpointId: "local" },
  });
  await seedCredential(store, {
    id: "custom-remote",
    provider: "custom",
    providerData: { endpointId: "remote" },
  });
  // A pin at another provider's account. It exists, so a check that looked the
  // id up would call it healthy; the router checks provider before pin and
  // reports `pin:missing`, and doctor is the only compensating control for the
  // deliberate absence of write-time validation.
  await store.config.putModel({
    id: "alpha",
    strategy: "score",
    isAlias: false,
    targets: [
      {
        provider: "anthropic",
        model: "claude-opus-5",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 5, output: 25 },
        credentialId: "kimi-live",
        capabilities: { tools: true, images: true, reasoning: true },
      },
    ],
  });
  // And a custom account on another endpoint, which fails the same way one step
  // further in.
  await store.config.putModel({
    id: "billed",
    strategy: "score",
    isAlias: false,
    targets: [
      {
        provider: "custom",
        endpointId: "local",
        model: "llama",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 0, output: 0 },
        credentialId: "custom-remote",
        capabilities: { tools: true, images: true, reasoning: true },
      },
    ],
  });
  store.close();

  const result = await cli(["doctor", "--json"], { root, service });
  const checks = JSON.parse(result.out) as { danglingPins: string[] };
  // Both models, not just the first: a check that stopped at one would print a
  // clean-looking report for an installation with two broken targets in it.
  expect(checks.danglingPins).toEqual([
    "alpha/claude-opus-5 → kimi-live",
    "billed/llama → custom-remote",
  ]);
});

test("doctor prints the dangling pins in its own table, not only under --json", async () => {
  const root = await installation();
  const service = fakeService({ root });
  const store = await openStore(root);
  await store.config.putModel({
    id: "billed",
    strategy: "score",
    isAlias: false,
    targets: [
      {
        provider: "anthropic",
        model: "claude-opus-5",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 5, output: 25 },
        credentialId: "removed-account",
        capabilities: { tools: true, images: true, reasoning: true },
      },
    ],
  });
  store.close();

  // `--json` is read by scripts; the table is what the operator running the
  // command actually sees, and a row that is absent there is a finding nobody
  // is told about.
  const broken = await cli(["doctor"], { root, service });
  const row = (out: string): string | undefined =>
    out
      .split("\n")
      .find((line) => line.startsWith("dangling pins"))
      ?.trim()
      .split(/\s{2,}/)[1];

  expect(row(broken.out)).toBe("1: billed/claude-opus-5 → removed-account");

  // And the row is still there when there is nothing to say, so "none" means
  // checked rather than a heading that only appears once it is too late.
  const clean = await installation();
  const healthy = await cli(["doctor"], { root: clean, service: fakeService({ root: clean }) });
  expect(row(healthy.out)).toBe("none");
});

test("doctor reports a target naming a provider this installation does not have", async () => {
  const root = await installation();
  const service = fakeService({ root });
  const store = await openStore(root);
  // A provider id is a validated string, and `virtual_models.targets` is read
  // back with `JSON.parse` and no validation — so a plugin removed, a database
  // restored onto a different install, or a hand-edited row all produce this.
  // `putModel` accepts it on purpose, for the reason it accepts a dangling pin,
  // which makes doctor the only compensating control.
  await store.config.putModel({
    id: "billed",
    strategy: "score",
    isAlias: false,
    targets: [
      {
        provider: "acme",
        model: "acme-1",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 5, output: 25 },
        capabilities: { tools: true, images: true, reasoning: true },
      },
      // The healthy sibling. A check that flagged this too is one operators
      // learn to ignore.
      {
        provider: "anthropic",
        model: "claude-opus-5",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 5, output: 25 },
        capabilities: { tools: true, images: true, reasoning: true },
      },
    ],
  });
  store.close();

  const result = await cli(["doctor", "--json"], { root, service });
  const checks = JSON.parse(result.out) as { missingProviders: string[] };
  expect(checks.missingProviders).toEqual(["billed/acme-1 → acme"]);

  // And in the table, which is what the operator running the command sees. A
  // finding that exists only under `--json` is a finding nobody is told about.
  const printed = await cli(["doctor"], { root, service });
  const row = printed.out
    .split("\n")
    .find((line) => line.startsWith("missing providers"))
    ?.trim()
    .split(/\s{2,}/)[1];
  expect(row).toBe("1: billed/acme-1 → acme");
});

test("doctor says none rather than nothing when every provider is installed", async () => {
  const root = await installation();
  const result = await cli(["doctor", "--json"], { root, service: fakeService({ root }) });
  // `[]` is "checked, nothing wrong". Null would mean the question could not be
  // asked, and the two must not read alike.
  expect(
    (JSON.parse(result.out) as { missingProviders: string[] | null }).missingProviders,
  ).toEqual([]);
});

test("doctor says none rather than nothing when every pin resolves", async () => {
  const root = await installation();
  const service = fakeService({ root });
  const result = await cli(["doctor", "--json"], { root, service });
  // `[]` is "checked, nothing wrong". Null would mean the question could not be
  // asked, and the two must not read alike.
  expect((JSON.parse(result.out) as { danglingPins: string[] | null }).danglingPins).toEqual([]);
});

test("doctor checks the usage rollup against the rows it summarizes", async () => {
  const root = await installation();
  const service = fakeService({ root });
  const store = await openStore(root);
  await store.usage.append(requestLog({ id: "r1", apiKeyId: "k1", at: 1_000_000 }));
  store.close();

  const healthy = await cli(["doctor", "--json"], { root, service });
  expect((JSON.parse(healthy.out) as { usageRollup: string }).usageRollup).toBe(
    "ok (1 hourly buckets)",
  );

  // A bucket for an hour that has no rows, which is what a restored file or a
  // prune that forgot the rollup leaves behind.
  const damaged = await openStore(root);
  await damaged.usage.append(requestLog({ id: "r2", apiKeyId: "k1", at: 5_000_000 }));
  damaged.close();
  const withoutRows = await openStore(root);
  await withoutRows.usage.prune(4_000_000);
  withoutRows.close();
  const restored = await openStore(root);
  await restored.usage.append(requestLog({ id: "r3", apiKeyId: "k1", at: 9_000_000 }));
  restored.close();

  const stillOk = await cli(["doctor", "--json"], { root, service });
  expect((JSON.parse(stillOk.out) as { usageRollup: string }).usageRollup).toMatch(/^ok /);
});

test("doctor reports a rollup that disagrees with request_logs", async () => {
  const root = await installation();
  const service = fakeService({ root });
  const store = await openStore(root);
  await store.usage.append(requestLog({ id: "r1", apiKeyId: "k1", at: 1_000_000 }));
  store.close();

  // Rows removed without their bucket, exactly as a hand-edited or foreign
  // database can arrive.
  const meddled = await openStore(root);
  await meddled.usage.recent(1);
  meddled.close();
  const db = openDb(`${root}/omnigateway.db`);
  db.run("DELETE FROM request_logs");
  db.close();

  const result = await cli(["doctor", "--json"], { root, service });
  const body = JSON.parse(result.out) as { usageRollup: string };
  expect(result.code).toBe(0);
  expect(body.usageRollup).toBe("1 of 0 hourly buckets disagree with request_logs");
});

test("doctor reports the ambient database path it refused", async () => {
  const root = await installation();
  const ambient = "/home/operator/.config/omnigateway/omnigateway.db";
  const service = fakeService({ root });

  const result = await cli(["doctor", "--json"], {
    root,
    service,
    env: { OMNI_ENCRYPTION_KEY: TEST_KEY, OMNI_DB_PATH: ambient },
  });
  const body = JSON.parse(result.out) as { databasePath: string; warnings: string[] };

  expect(body.databasePath).toBe(`${root}/omnigateway.db`);
  expect(body.warnings).toHaveLength(1);
  expect(body.warnings[0]).toContain(ambient);
});

test("doctor reports no warnings when nothing was refused", async () => {
  const root = await installation();
  const service = fakeService({ root });

  const result = await cli(["doctor", "--json"], { root, service });

  expect((JSON.parse(result.out) as { warnings: string[] }).warnings).toEqual([]);
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
  // Nothing could be opened, so the rollup was not checked — which is a state
  // of its own and not a clean bill of health.
  expect(body.usageRollup).toBeNull();
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
      "journalctl --user-unit=omnigateway.service -n 5 --no-pager --output=cat": {
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

/** Three completed requests, so a page size shows up as a row count. */
async function seedLogs(root: string): Promise<void> {
  const store = await openStore(root);
  for (const id of ["r1", "r2", "r3"]) await store.usage.append(requestLog({ id }));
  store.close();
}

async function loggedRows(root: string, argv: string[]): Promise<number> {
  const result = await cli(["logs", ...argv, "--json"], { root, service: fakeService({ root }) });
  expect(result.code).toBe(0);
  return (JSON.parse(result.out) as { logs: unknown[] }).logs.length;
}

test("a blank -n reads as an absent flag, not as zero", async () => {
  const root = await installation();
  await seedLogs(root);

  // `Number("")` is 0, which the page size clamps to a single row: an operator
  // whose shell expanded an empty variable would be told there was one request.
  expect(await loggedRows(root, ["-n", ""])).toBe(3);
  expect(await loggedRows(root, ["-n", "   "])).toBe(3);
  expect(await loggedRows(root, [])).toBe(3);
});

test("-n 0 still means zero, which the page size clamps to one row", async () => {
  const root = await installation();
  await seedLogs(root);

  expect(await loggedRows(root, ["-n", "0"])).toBe(1);
  expect(await loggedRows(root, ["-n", "2"])).toBe(2);
});

test("a non-numeric -n is still refused rather than defaulted", async () => {
  const root = await installation();
  const result = await cli(["logs", "-n", "soon", "--json"], {
    root,
    service: fakeService({ root }),
  });

  expect(result.code).toBe(2);
  expect(result.err).toContain('--number must be a number, got "soon"');
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
      windowMs: null,
    },
    {
      credentialId: id,
      windowType: "fiveHour",
      startsAt: 1_000,
      used: 950,
      limit: 1_000,
      resetsAt: null,
      observedAt: 1_000,
      windowMs: null,
    },
  ]);
  store.close();

  const result = await cli(["status"], { root, service: fakeService({ root }) });

  expect(result.code).toBe(0);
  // Shortest window first, so the cell reads soonest-to-latest.
  expect(result.out).toMatch(/5h 95% · 7d 20%/);
});

const CONSOLE_LINES = [
  "2026-08-09T04:12:03.114Z INFO  omnigateway listening  port=9000",
  "2026-08-09T04:12:04.000Z ERROR quota poll failed  reason=boom",
].join("\n");

test("console reads the installation's log file and says which one", async () => {
  const root = await installation();
  const service = fakeService({ root });
  await Bun.write(`${service.deps.stateDir}/gateway.log`, `${CONSOLE_LINES}\n`);

  const result = await cli(["console"], { root, service });

  expect(result.code).toBe(0);
  expect(result.out).toContain("omnigateway listening");
  expect(result.out).toContain("quota poll failed");
  // The hint names the file, and how to point it somewhere else.
  expect(result.err).toContain("gateway.log");
  expect(result.err).toContain("OMNI_LOG_FILE");
});

test("console filters by level", async () => {
  const root = await installation();
  const service = fakeService({ root });
  await Bun.write(`${service.deps.stateDir}/gateway.log`, `${CONSOLE_LINES}\n`);

  const result = await cli(["console", "--level", "error"], { root, service });

  expect(result.code).toBe(0);
  expect(result.out).toContain("quota poll failed");
  expect(result.out).not.toContain("omnigateway listening");
});

test("console refuses a level it does not know rather than showing everything", async () => {
  const root = await installation();
  const service = fakeService({ root });

  const result = await cli(["console", "--level", "verbose"], { root, service });

  expect(result.code).toBe(2);
  expect(result.err).toContain("unknown level");
});

test("console explains an uncaptured gateway instead of looking broken", async () => {
  const root = await installation();
  const service = fakeService({ root });

  const result = await cli(["console"], { root, service });

  expect(result.code).toBe(0);
  expect(result.out).toContain("not being captured");
  expect(result.out).toContain("OMNI_LOG_FILE");
});

test("console --json emits the structure, with no hint mixed into it", async () => {
  const root = await installation();
  const service = fakeService({ root });
  await Bun.write(`${service.deps.stateDir}/gateway.log`, `${CONSOLE_LINES}\n`);

  const result = await cli(["console", "--json"], { root, service });

  expect(result.code).toBe(0);
  const body = JSON.parse(result.out) as {
    source: string;
    path: string;
    lines: Array<{ level: string | null; msg: string | null }>;
  };
  expect(body.source).toBe("file");
  expect(body.lines.map((l) => l.level)).toEqual(["info", "error"]);
  expect(result.err).toBe("");
});

test("doctor reports which log the console will read", async () => {
  const root = await installation();
  const service = fakeService({ root });

  const result = await cli(["doctor"], { root, service });

  expect(result.code).toBe(0);
  expect(result.out).toContain("console log");
});

test("console reads the file OMNI_LOG_FILE names, not the supervisor's default", async () => {
  const root = await installation();
  const service = fakeService({ root });
  const configured = `${root}/elsewhere.log`;
  await Bun.write(configured, `${CONSOLE_LINES}\n`);
  // The default path also exists, with different content: if the CLI ignored
  // OMNI_LOG_FILE it would read this and the gateway would read the other.
  await Bun.write(`${service.deps.stateDir}/gateway.log`, "2026-08-09T04:12:03.114Z INFO  wrong\n");
  service.deps.logFile = configured;

  const result = await cli(["console"], { root, service });

  expect(result.code).toBe(0);
  expect(result.out).toContain("quota poll failed");
  expect(result.out).not.toContain("wrong");
  expect(result.err).toContain("elsewhere.log");
});

test("console accepts --system rather than refusing the flag", async () => {
  const root = await installation();
  const service = fakeService({ root });

  const result = await cli(["console", "--system"], { root, service });

  // Strict parsing rejects an undeclared flag with exit 2 before the command
  // ever runs, which is what made `omni console --system` unusable. The scope
  // it selects is resolved in run.ts and exercised by the service tests; here
  // the contract is only that the flag is accepted.
  expect(result.code).toBe(0);
  expect(result.err).not.toContain("usage:");
});

test("a system-scope installation reads the system journal, without --user", async () => {
  const root = makeRoot();
  const unitPath = `${root}/systemd/omnigateway.service`;
  await Bun.write(unitPath, "[Unit]\n");
  const service = fakeService({ root, unitPath });
  service.deps.scope = "system";

  await serviceLogs(service.deps, 5);

  // Asking the wrong journal returns another service's output, or nothing.
  expect(service.commands.some((c) => c.includes("--user"))).toBe(false);
  expect(service.commands[0]).toContain("--output=cat");
});

test("console clamps -n 0 instead of printing the whole log", async () => {
  const root = await installation();
  const service = fakeService({ root });
  await Bun.write(`${service.deps.stateDir}/gateway.log`, `${CONSOLE_LINES}\n`);

  const result = await cli(["console", "-n", "0", "--json"], { root, service });

  expect(result.code).toBe(0);
  expect((JSON.parse(result.out) as { lines: unknown[] }).lines).toHaveLength(1);
});
