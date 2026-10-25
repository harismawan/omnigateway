import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { MAX_EXPORT_DESTINATIONS, type Store } from "@omni/store";
import { memoryStore } from "@omni/testkit";
import {
  createDestination,
  DEFAULT_MAX_REQUEST_BYTES,
  destinationIdSchema,
  elasticsearchConfigSchema,
  elasticsearchSecretSchemas,
  exportFilterSchema,
  getDestination,
  listDestinations,
  otlpConfigSchema,
  otlpSecretSchema,
  removeDestination,
  setDestinationBodies,
  updateDestination,
  webhookConfigSchema,
  webhookSecretSchema,
} from "../src/export.ts";
import { DEFAULT_INDEX_PATTERN, expandIndexPattern, indexNameProblem } from "../src/exportIndex.ts";

const ok = <T>(schema: { safeParse(v: unknown): { success: boolean; data?: T } }, v: unknown) =>
  schema.safeParse(v).success;

const es = (overrides: Record<string, unknown> = {}) => ({
  id: "es-main",
  type: "elasticsearch",
  startFrom: "now",
  config: { url: "http://es.internal:9200", auth: "apiKey" },
  secret: { apiKey: "es-api-key-secret" },
  ...overrides,
});

const webhook = (overrides: Record<string, unknown> = {}) => ({
  id: "hook",
  type: "webhook",
  startFrom: "oldest",
  config: { url: "https://hooks.example.com/omni/" },
  ...overrides,
});

const otlp = (overrides: Record<string, unknown> = {}) => ({
  id: "langfuse",
  type: "otlp",
  startFrom: "now",
  config: { endpoint: "https://cloud.langfuse.com/api/public/otel", signal: "logs" },
  ...overrides,
});

async function refusal(promise: Promise<unknown>): Promise<GatewayError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GatewayError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

// ── index names (moved from the gateway's encoder) ──────────────────────────

test("indexNameProblem names every name Elasticsearch refuses and passes good ones", () => {
  for (const bad of ["", ".", "..", "-x", "_x", "+x", "a b", "a,b", "a#b", "a*", "a/b", "a\\b"]) {
    expect(indexNameProblem(bad)).not.toBeNull();
  }
  expect(indexNameProblem("Omni")).toMatch(/lowercase/);
  expect(indexNameProblem("a:b")).not.toBeNull();
  expect(indexNameProblem("a".repeat(256))).not.toBeNull();
  expect(indexNameProblem("é".repeat(128))).not.toBeNull();
  expect(indexNameProblem("a".repeat(255))).toBeNull();
  expect(indexNameProblem("omni-logs-2026.01.05")).toBeNull();
  expect(indexNameProblem(".hidden-but-allowed")).toBeNull();
});

test("expandIndexPattern substitutes every date token in UTC and keeps the rest", () => {
  const at = Date.UTC(2026, 0, 5, 23, 59, 59);
  expect(DEFAULT_INDEX_PATTERN).toBe("omni-logs-{yyyy.MM.dd}");
  expect(expandIndexPattern(DEFAULT_INDEX_PATTERN, at)).toBe("omni-logs-2026.01.05");
  expect(expandIndexPattern("{yyyy.MM.dd}-{yyyy.MM.dd}", at)).toBe("2026.01.05-2026.01.05");
  expect(expandIndexPattern("logs-{yyyy}", at)).toBe("logs-{yyyy}");
});

test("exportIndex stays a leaf, so the gateway's pure encoder can import it alone", async () => {
  const source = await Bun.file(new URL("../src/exportIndex.ts", import.meta.url)).text();
  expect(source).not.toMatch(/^\s*(import|export)\s[^;]*\sfrom\s/m);
  expect(source).not.toMatch(/\bimport\s*\(/);
});

// ── schemas ─────────────────────────────────────────────────────────────────

test("destination ids are 1–40 of [a-z0-9-]", () => {
  for (const id of ["a", "es-main", "0", "a".repeat(40), "-x-"]) {
    expect(ok(destinationIdSchema, id)).toBe(true);
  }
  for (const id of ["", "a".repeat(41), "ES", "a_b", "a b", "a.b", "é"]) {
    expect(ok(destinationIdSchema, id)).toBe(false);
  }
});

test("the filter is strict and bounded", () => {
  expect(exportFilterSchema.parse({})).toEqual({});
  expect(
    exportFilterSchema.parse({
      apiKeyIds: ["k1"],
      models: ["claude-sonnet-4-5"],
      failedOnly: true,
    }),
  ).toEqual({ apiKeyIds: ["k1"], models: ["claude-sonnet-4-5"], failedOnly: true });
  // An empty list is a legitimate "select nothing" and is kept as itself.
  expect(exportFilterSchema.parse({ apiKeyIds: [] })).toEqual({ apiKeyIds: [] });
  const refused = [
    { apiKeyId: ["k1"] },
    { apiKeyIds: "k1" },
    { apiKeyIds: [""] },
    { apiKeyIds: ["k".repeat(129)] },
    { apiKeyIds: Array.from({ length: 101 }, (_, i) => `k${i}`) },
    { models: ["m".repeat(257)] },
    { models: Array.from({ length: 101 }, (_, i) => `m${i}`) },
    { failedOnly: "yes" },
  ];
  for (const filter of refused) expect(ok(exportFilterSchema, filter)).toBe(false);
  expect(ok(exportFilterSchema, { apiKeyIds: ["k".repeat(128)], models: ["m".repeat(256)] })).toBe(
    true,
  );
});

test("elasticsearch config defaults index and flavor, and refuses a bad index pattern", () => {
  expect(elasticsearchConfigSchema.parse({ url: "https://es.example.com/", auth: "none" })).toEqual(
    {
      url: "https://es.example.com",
      index: DEFAULT_INDEX_PATTERN,
      auth: "none",
      flavor: "elasticsearch",
    },
  );
  expect(
    elasticsearchConfigSchema.parse({
      url: "http://10.0.0.5:9200/proxy/",
      index: "team-a-{yyyy.MM.dd}",
      auth: "basic",
      flavor: "opensearch",
    }),
  ).toEqual({
    url: "http://10.0.0.5:9200/proxy",
    index: "team-a-{yyyy.MM.dd}",
    auth: "basic",
    flavor: "opensearch",
  });
  for (const index of ["Logs-{yyyy.MM.dd}", "-x", "a b", "logs:x", ""]) {
    expect(ok(elasticsearchConfigSchema, { url: "http://es:9200", auth: "none", index })).toBe(
      false,
    );
  }
  // The token expands to ten characters, so a pattern is judged on its expansion.
  expect(
    ok(elasticsearchConfigSchema, {
      url: "http://es:9200",
      auth: "none",
      index: `${"a".repeat(245)}{yyyy.MM.dd}`,
    }),
  ).toBe(true);
  expect(
    ok(elasticsearchConfigSchema, {
      url: "http://es:9200",
      auth: "none",
      index: `${"a".repeat(246)}{yyyy.MM.dd}`,
    }),
  ).toBe(false);
  expect(ok(elasticsearchConfigSchema, { url: "http://es:9200", auth: "token" })).toBe(false);
  expect(ok(elasticsearchConfigSchema, { url: "http://es:9200" })).toBe(false);
  expect(ok(elasticsearchConfigSchema, { url: "http://es:9200", auth: "none", x: 1 })).toBe(false);
});

test("outbound URLs: http(s), no credentials, query or fragment; private hosts allowed", () => {
  for (const url of [
    "ftp://es.example.com",
    "https://user:pass@es.example.com",
    "https://es.example.com?x=1",
    "https://es.example.com#x",
    "not a url",
    "",
  ]) {
    expect(ok(elasticsearchConfigSchema, { url, auth: "none" })).toBe(false);
    expect(ok(webhookConfigSchema, { url })).toBe(false);
    expect(ok(otlpConfigSchema, { endpoint: url, signal: "logs" })).toBe(false);
  }
  for (const url of ["http://localhost:9200", "http://127.0.0.1", "http://192.168.1.4/es"]) {
    expect(ok(elasticsearchConfigSchema, { url, auth: "none" })).toBe(true);
  }
  expect(otlpConfigSchema.parse({ endpoint: "http://collector:4318/", signal: "traces" })).toEqual({
    endpoint: "http://collector:4318",
    signal: "traces",
  });
});

test("a webhook URL keeps its path exactly, trailing slash included", () => {
  expect(webhookConfigSchema.parse({ url: "https://hooks.example.com/omni/" })).toEqual({
    url: "https://hooks.example.com/omni/",
    headers: {},
  });
});

test("headers are validated: token names, no CR/LF, no duplicates, no reserved names", () => {
  // A bare origin's canonical form carries its root path.
  expect(
    webhookConfigSchema.parse({ url: "https://h.example.com", headers: { "X-Team": "a" } }),
  ).toEqual({ url: "https://h.example.com/", headers: { "X-Team": "a" } });
  for (const headers of [
    { "bad name": "x" },
    { "": "x" },
    { "x-a": "line\r\nbreak" },
    { "x-a": "nul\u0000" },
    { "X-A": "1", "x-a": "2" },
    { "Content-Length": "1" },
    { host: "x" },
    { "x-omni-signature": "sha256=forged" },
    { "x-a": "v".repeat(8193) },
    Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`x-${i}`, "v"])),
  ]) {
    expect(ok(webhookConfigSchema, { url: "https://h.example.com", headers })).toBe(false);
    expect(ok(webhookSecretSchema, { headers })).toBe(false);
    expect(ok(otlpSecretSchema, { headers })).toBe(false);
  }
});

test("secret schemas are strict per type", () => {
  expect(ok(elasticsearchSecretSchemas.apiKey, { apiKey: "k" })).toBe(true);
  expect(ok(elasticsearchSecretSchemas.apiKey, { apiKey: "" })).toBe(false);
  expect(ok(elasticsearchSecretSchemas.apiKey, { apiKey: "k", extra: 1 })).toBe(false);
  expect(ok(elasticsearchSecretSchemas.basic, { username: "u", password: "p" })).toBe(true);
  expect(ok(elasticsearchSecretSchemas.basic, { username: "u:x", password: "p" })).toBe(false);
  expect(ok(elasticsearchSecretSchemas.basic, { username: "u" })).toBe(false);

  expect(ok(webhookSecretSchema, { signingSecret: "s" })).toBe(true);
  expect(ok(webhookSecretSchema, { headers: { authorization: "Bearer t" } })).toBe(true);
  expect(ok(webhookSecretSchema, {})).toBe(false);
  expect(ok(webhookSecretSchema, { headers: {} })).toBe(false);
  expect(ok(webhookSecretSchema, { signingSecret: "" })).toBe(false);
  expect(ok(webhookSecretSchema, { signingSecret: "s", other: 1 })).toBe(false);

  expect(ok(otlpSecretSchema, { headers: { authorization: "Basic abc" } })).toBe(true);
  expect(ok(otlpSecretSchema, { headers: {} })).toBe(false);
  expect(ok(otlpSecretSchema, {})).toBe(false);
});

test("type default request limits match the spec", () => {
  expect(DEFAULT_MAX_REQUEST_BYTES).toEqual({
    elasticsearch: 94_371_840,
    webhook: 52_428_800,
    otlp: 4_194_304,
  });
});

// ── operations ──────────────────────────────────────────────────────────────

test("createDestination stores the validated config and returns a summary without the secret", async () => {
  const store = await memoryStore();
  const created = await createDestination(store, es());
  expect(created).toMatchObject({
    id: "es-main",
    type: "elasticsearch",
    enabled: true,
    includeBodies: false,
    hasSecret: true,
    maxRequestBytes: null,
    filter: {},
    config: {
      url: "http://es.internal:9200",
      index: DEFAULT_INDEX_PATTERN,
      auth: "apiKey",
      flavor: "elasticsearch",
    },
  });
  expect(JSON.stringify(created)).not.toContain("es-api-key-secret");
  expect(created).not.toHaveProperty("secret");
  expect(JSON.parse((await store.exportDestinations.openSecret("es-main")) ?? "null")).toEqual({
    apiKey: "es-api-key-secret",
  });
  expect(await listDestinations(store)).toEqual([created]);
  expect(await getDestination(store, "es-main")).toEqual(created);
});

test("startFrom: oldest starts at 0, now at the creation clock; afterExisting is not offered", async () => {
  const store = await memoryStore();
  const before = Date.now();
  expect((await createDestination(store, webhook())).startAt).toBe(0);
  expect((await createDestination(store, otlp())).startAt).toBeGreaterThanOrEqual(before);
  const error = await refusal(createDestination(store, es({ startFrom: "afterExisting" })));
  expect(error.code).toBe("BAD_REQUEST");
  expect((await refusal(createDestination(store, es({ startFrom: undefined })))).code).toBe(
    "BAD_REQUEST",
  );
});

test("createDestination carries filter, enabled and maxRequestBytes", async () => {
  const store = await memoryStore();
  const created = await createDestination(
    store,
    webhook({
      enabled: false,
      filter: { apiKeyIds: ["k1"], failedOnly: true },
      maxRequestBytes: 1_000_000,
      secret: { signingSecret: "whsec", headers: { authorization: "Bearer t" } },
    }),
  );
  expect(created).toMatchObject({
    enabled: false,
    filter: { apiKeyIds: ["k1"], failedOnly: true },
    maxRequestBytes: 1_000_000,
    hasSecret: true,
  });
  for (const maxRequestBytes of [0, -1, 1.5, "10"]) {
    const error = await refusal(createDestination(store, webhook({ id: "w2", maxRequestBytes })));
    expect(error.code).toBe("BAD_REQUEST");
  }
});

test("createDestination refuses bad ids, unknown types, unknown fields and includeBodies", async () => {
  const store = await memoryStore();
  for (const input of [
    es({ id: "Bad_Id" }),
    es({ type: "kafka" }),
    es({ extra: true }),
    es({ includeBodies: true }),
    es({ config: { url: "http://es:9200", auth: "none", extra: 1 } }),
    webhook({ secret: "plain-string" }),
  ]) {
    const error = await refusal(createDestination(store, input));
    expect(error.code).toBe("BAD_REQUEST");
  }
  expect(await store.exportDestinations.list()).toEqual([]);
});

test("elasticsearch auth and secret must agree", async () => {
  const store = await memoryStore();
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [es({ secret: undefined }), /secret/],
    [es({ secret: { username: "u", password: "p" } }), /secret/],
    [es({ config: { url: "http://es:9200", auth: "basic" } }), /secret/],
    [es({ config: { url: "http://es:9200", auth: "none" } }), /secret/],
  ];
  for (const [input, message] of cases) {
    const error = await refusal(createDestination(store, input));
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.message).toMatch(message);
  }
  const none = await createDestination(
    store,
    es({ id: "es-open", config: { url: "http://es:9200", auth: "none" }, secret: undefined }),
  );
  expect(none.hasSecret).toBe(false);
  const basic = await createDestination(
    store,
    es({
      id: "es-basic",
      config: { url: "http://es:9200", auth: "basic" },
      secret: { username: "elastic", password: "changeme" },
    }),
  );
  expect(basic.hasSecret).toBe(true);
});

test("webhook secret headers may not repeat a plain header", async () => {
  const store = await memoryStore();
  const error = await refusal(
    createDestination(
      store,
      webhook({
        config: { url: "https://h.example.com", headers: { "X-Team": "a" } },
        secret: { headers: { "x-team": "b" } },
      }),
    ),
  );
  expect(error.code).toBe("BAD_REQUEST");
  expect(error.message).toMatch(/x-team/i);
});

test("a duplicate id is a CONFLICT and the limit maps to CONFLICT", async () => {
  const store = await memoryStore();
  await createDestination(store, webhook({ id: "d0" }));
  const dup = await refusal(createDestination(store, webhook({ id: "d0" })));
  expect(dup.code).toBe("CONFLICT");
  for (let i = 1; i < MAX_EXPORT_DESTINATIONS; i++) {
    await createDestination(store, webhook({ id: `d${i}` }));
  }
  const limit = await refusal(createDestination(store, webhook({ id: "one-too-many" })));
  expect(limit.code).toBe("CONFLICT");
  expect(limit.message).toBe("at most 10 export destinations");
});

test("unknown ids are refused by every per-destination operation", async () => {
  const store = await memoryStore();
  for (const promise of [
    getDestination(store, "missing"),
    updateDestination(store, "missing", { enabled: false }),
    setDestinationBodies(store, "missing", { include: false }),
    removeDestination(store, "missing"),
  ]) {
    const error = await refusal(promise);
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.message).toBe("no such export destination");
  }
});

test("updateDestination: secret absent keeps, object replaces, null clears", async () => {
  const store = await memoryStore();
  await createDestination(store, webhook({ secret: { signingSecret: "first" } }));

  const kept = await updateDestination(store, "hook", { enabled: false });
  expect(kept).toMatchObject({ enabled: false, hasSecret: true });
  expect(await store.exportDestinations.openSecret("hook")).toBe('{"signingSecret":"first"}');

  const replaced = await updateDestination(store, "hook", { secret: { signingSecret: "second" } });
  expect(replaced.hasSecret).toBe(true);
  expect(JSON.stringify(replaced)).not.toContain("second");
  expect(await store.exportDestinations.openSecret("hook")).toBe('{"signingSecret":"second"}');

  const cleared = await updateDestination(store, "hook", { secret: null });
  expect(cleared.hasSecret).toBe(false);
  expect(await store.exportDestinations.openSecret("hook")).toBeNull();
});

test("updateDestination validates config whole against the stored type", async () => {
  const store = await memoryStore();
  await createDestination(store, otlp());
  const updated = await updateDestination(store, "langfuse", {
    config: { endpoint: "http://collector:4318/", signal: "traces" },
    filter: { models: ["m"] },
    maxRequestBytes: 2_000_000,
  });
  expect(updated).toMatchObject({
    config: { endpoint: "http://collector:4318", signal: "traces" },
    filter: { models: ["m"] },
    maxRequestBytes: 2_000_000,
  });
  // null returns the limit to the type default.
  expect(
    (await updateDestination(store, "langfuse", { maxRequestBytes: null })).maxRequestBytes,
  ).toBe(null);
  for (const patch of [
    { config: { url: "http://collector:4318", signal: "logs" } },
    { config: { endpoint: "http://collector:4318" } },
    { type: "webhook" },
    { includeBodies: true },
    { startFrom: "oldest" },
    { secret: { signingSecret: "x" } },
  ]) {
    const error = await refusal(updateDestination(store, "langfuse", patch));
    expect(error.code).toBe("BAD_REQUEST");
  }
});

test("updateDestination keeps elasticsearch auth and secret in agreement", async () => {
  const store = await memoryStore();
  await createDestination(store, es());
  const url = "http://es.internal:9200";

  // Same auth, secret kept: fine.
  await updateDestination(store, "es-main", { config: { url, auth: "apiKey", index: "x-logs" } });
  // Switching auth without a new secret leaves a credential of the wrong shape.
  for (const patch of [
    { config: { url, auth: "basic" } },
    { config: { url, auth: "none" } },
    { secret: null },
    { secret: { username: "u", password: "p" } },
    { config: { url, auth: "basic" }, secret: { apiKey: "k" } },
  ]) {
    const error = await refusal(updateDestination(store, "es-main", patch));
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.message).toMatch(/secret/);
  }
  const basic = await updateDestination(store, "es-main", {
    config: { url, auth: "basic" },
    secret: { username: "elastic", password: "pw" },
  });
  expect(basic).toMatchObject({ config: { auth: "basic" }, hasSecret: true });
  const none = await updateDestination(store, "es-main", {
    config: { url, auth: "none" },
    secret: null,
  });
  expect(none).toMatchObject({ config: { auth: "none" }, hasSecret: false });
  // auth none with a secret is refused too.
  const error = await refusal(updateDestination(store, "es-main", { secret: { apiKey: "k" } }));
  expect(error.code).toBe("BAD_REQUEST");
});

test("setDestinationBodies: false is allowed, true is not available yet", async () => {
  const store = await memoryStore();
  await createDestination(store, webhook());
  const off = await setDestinationBodies(store, "hook", { include: false });
  expect(off.includeBodies).toBe(false);
  const on = await refusal(setDestinationBodies(store, "hook", { include: true }));
  expect(on.code).toBe("BAD_REQUEST");
  expect(on.message).toBe("body export is not available yet");
  for (const input of [{}, { include: "yes" }, { include: true, extra: 1 }]) {
    expect((await refusal(setDestinationBodies(store, "hook", input))).code).toBe("BAD_REQUEST");
  }
});

test("OTLP traces destinations cannot export bodies, checked before availability", async () => {
  const store = await memoryStore();
  await createDestination(
    store,
    otlp({ config: { endpoint: "http://collector:4318", signal: "traces" } }),
  );
  const error = await refusal(setDestinationBodies(store, "langfuse", { include: true }));
  expect(error.code).toBe("BAD_REQUEST");
  expect(error.message).toBe("OTLP traces destinations cannot export bodies");
  expect((await setDestinationBodies(store, "langfuse", { include: false })).includeBodies).toBe(
    false,
  );
});

test("an OTLP destination exporting bodies cannot switch to traces", async () => {
  const store = await memoryStore();
  await createDestination(store, otlp());
  // Part 1 cannot turn bodies on through control, so plant the flag as a
  // part-2 row (or a restored snapshot) would hold it.
  await store.exportDestinations.update("langfuse", { includeBodies: true });
  const error = await refusal(
    updateDestination(store, "langfuse", {
      config: { endpoint: "http://collector:4318", signal: "traces" },
    }),
  );
  expect(error.code).toBe("BAD_REQUEST");
  expect(error.message).toBe("OTLP traces destinations cannot export bodies");
  await updateDestination(store, "langfuse", {
    config: { endpoint: "http://collector:4318", signal: "logs" },
  });
});

test("removeDestination deletes the row", async () => {
  const store: Store = await memoryStore();
  await createDestination(store, webhook());
  await removeDestination(store, "hook");
  expect(await listDestinations(store)).toEqual([]);
});
