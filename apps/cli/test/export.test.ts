import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Prompt } from "../src/prompt.ts";
import { cli, fakeService, makeRoot, openStore } from "./helpers/harness.ts";

/**
 * `omni export`: destinations administered through `@omni/control` on the
 * store, secrets read from a file or stdin and never from argv, and the two
 * actions only the gateway's export worker can perform refused with a pointer
 * to the console.
 */

type Summary = {
  id: string;
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
  filter: Record<string, unknown>;
  hasSecret: boolean;
  maxRequestBytes: number | null;
  startAt: number;
};

const SIGNING = '{"signingSecret":"whsec-hunter2"}';

function secretFile(root: string, text: string, name = "secret.json"): string {
  const path = join(root, name);
  writeFileSync(path, text);
  return path;
}

/** A prompt that records whether a secret was asked for, and answers with `answer`. */
function stdinPrompt(answer: string): Prompt & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    isTty: false,
    secret: async (question) => {
      asked.push(question);
      return answer;
    },
    confirm: async () => true,
  };
}

async function addWebhook(root: string, id = "hook", extra: string[] = []) {
  return cli(
    ["export", "add", "webhook", id, "--url", "https://receiver.example/in", ...extra, "--json"],
    { root },
  );
}

async function storedSecret(root: string, id: string): Promise<string | null> {
  const store = await openStore(root);
  try {
    return await store.exportDestinations.openSecret(id);
  } finally {
    store.close();
  }
}

test("add webhook stores the config and a secret read from --secret-file, and never prints it", async () => {
  const root = makeRoot();
  const path = secretFile(root, `${SIGNING}\n`);
  const result = await addWebhook(root, "hook", [
    "--header",
    "x-team=gateway",
    "--secret-file",
    path,
  ]);

  expect(result.code).toBe(0);
  const created = JSON.parse(result.out) as Summary;
  expect(created).toMatchObject({
    id: "hook",
    type: "webhook",
    enabled: true,
    hasSecret: true,
    config: { url: "https://receiver.example/in", headers: { "x-team": "gateway" } },
  });
  expect(result.out).not.toContain("hunter2");
  expect(result.err).not.toContain("hunter2");
  expect(JSON.parse((await storedSecret(root, "hook")) ?? "null")).toEqual({
    signingSecret: "whsec-hunter2",
  });
});

test("--secret-file - reads the secret from stdin through the prompt", async () => {
  const root = makeRoot();
  const prompt = stdinPrompt(SIGNING);
  const result = await cli(
    [
      "export",
      "add",
      "webhook",
      "hook",
      "--url",
      "https://receiver.example/in",
      "--secret-file",
      "-",
    ],
    { root, prompt },
  );

  expect(result.code).toBe(0);
  expect(prompt.asked).toHaveLength(1);
  expect(result.out).not.toContain("hunter2");
  expect(await storedSecret(root, "hook")).toContain("whsec-hunter2");
});

test("a secret is never accepted as a flag value, and the refusal does not echo it", async () => {
  const root = makeRoot();
  for (const argv of [
    ["--secret", "hunter2"],
    ["--secret=hunter2"],
    ["--signing-secret", "hunter2"],
  ]) {
    const result = await cli(
      ["export", "add", "webhook", "hook", "--url", "https://receiver.example/in", ...argv],
      { root },
    );
    expect(result.code).toBe(2);
    expect(result.out).not.toContain("hunter2");
    expect(result.err).not.toContain("hunter2");
  }
  const listed = await cli(["export", "list", "--json"], { root });
  expect((JSON.parse(listed.out) as { destinations: Summary[] }).destinations).toHaveLength(0);
});

test("an unreadable, empty or malformed secret is refused without quoting it", async () => {
  const root = makeRoot();

  const missing = await addWebhook(root, "a", ["--secret-file", join(root, "nope.json")]);
  expect(missing.code).toBe(1);
  expect(missing.err).toContain("could not read");

  const empty = await addWebhook(root, "b", ["--secret-file", secretFile(root, "  \n", "e")]);
  expect(empty.code).toBe(1);
  expect(empty.err).toContain("empty");

  const garbage = await addWebhook(root, "c", [
    "--secret-file",
    secretFile(root, "hunter2-not-json", "g"),
  ]);
  expect(garbage.code).toBe(1);
  expect(garbage.err).toContain("must be a JSON object");
  expect(garbage.err).not.toContain("hunter2");

  const listed = await cli(["export", "list", "--json"], { root });
  expect((JSON.parse(listed.out) as { destinations: Summary[] }).destinations).toHaveLength(0);
});

test("add elasticsearch and otlp take their own flags, and a flag of another type is refused", async () => {
  const root = makeRoot();
  const es = await cli(
    [
      "export",
      "add",
      "elasticsearch",
      "es",
      "--url",
      "https://es.internal:9200/",
      "--auth",
      "apiKey",
      "--index",
      "gw-{yyyy.MM.dd}",
      "--start-from",
      "oldest",
      "--secret-file",
      secretFile(root, '{"apiKey":"abc"}'),
      "--json",
    ],
    { root },
  );
  expect(es.code).toBe(0);
  expect(JSON.parse(es.out)).toMatchObject({
    type: "elasticsearch",
    hasSecret: true,
    startAt: 0,
    config: {
      url: "https://es.internal:9200",
      auth: "apiKey",
      index: "gw-{yyyy.MM.dd}",
      flavor: "elasticsearch",
    },
  });

  const otlp = await cli(
    [
      "export",
      "add",
      "otlp",
      "lf",
      "--endpoint",
      "https://langfuse.example/api/public/otel",
      "--signal",
      "traces",
      "--disabled",
      "--json",
    ],
    { root },
  );
  expect(otlp.code).toBe(0);
  expect(JSON.parse(otlp.out)).toMatchObject({
    type: "otlp",
    enabled: false,
    hasSecret: false,
    config: { endpoint: "https://langfuse.example/api/public/otel", signal: "traces" },
  });

  const wrong = await cli(
    ["export", "add", "webhook", "w", "--url", "https://r.example/", "--index", "x"],
    { root },
  );
  expect(wrong.code).toBe(2);
  expect(wrong.err).toContain("--index");

  const unknownType = await cli(["export", "add", "kafka", "k"], { root });
  expect(unknownType.code).toBe(2);
  expect(unknownType.err).toContain("elasticsearch, webhook, otlp");

  const noUrl = await cli(["export", "add", "webhook", "w"], { root });
  expect(noUrl.code).toBe(2);
  expect(noUrl.err).toContain("--url");
});

test("control's refusals come back as they are, e.g. a duplicate id", async () => {
  const root = makeRoot();
  expect((await addWebhook(root)).code).toBe(0);
  const again = await addWebhook(root);
  expect(again.code).toBe(1);
  expect(again.err).toContain('export destination "hook" already exists');
});

test("list shows every destination without secrets, as a table or as JSON", async () => {
  const root = makeRoot();
  await addWebhook(root, "hook", ["--secret-file", secretFile(root, SIGNING)]);
  await cli(
    ["export", "add", "otlp", "lf", "--endpoint", "https://lf.example/otel", "--disabled"],
    { root },
  );

  const human = await cli(["export", "list"], { root });
  expect(human.code).toBe(0);
  expect(human.out).toContain("hook");
  expect(human.out).toContain("webhook");
  expect(human.out).toContain("https://receiver.example/in");
  expect(human.out).toContain("lf");
  expect(human.out).toContain("disabled");
  expect(human.out).not.toContain("hunter2");

  const json = JSON.parse((await cli(["export", "list", "--json"], { root })).out) as {
    destinations: Summary[];
  };
  expect(json.destinations.map((d) => d.id)).toEqual(["hook", "lf"]);
  expect(JSON.stringify(json)).not.toContain("hunter2");

  const none = await cli(["export", "list"], { root: makeRoot() });
  expect(none.out).toContain("no export destinations");
});

test("show prints one destination, its secret as set or not, and refuses an unknown id", async () => {
  const root = makeRoot();
  await addWebhook(root, "hook", [
    "--secret-file",
    secretFile(root, SIGNING),
    "--filter-model",
    "claude-sonnet",
    "--failed-only",
  ]);

  const shown = await cli(["export", "show", "hook"], { root });
  expect(shown.code).toBe(0);
  expect(shown.out).toContain("https://receiver.example/in");
  expect(shown.out).toMatch(/secret\s+set/);
  expect(shown.out).toContain("claude-sonnet");
  expect(shown.out).toContain("failed only");
  expect(shown.out).not.toContain("hunter2");

  const json = JSON.parse((await cli(["export", "show", "hook", "--json"], { root })).out);
  expect(json).toMatchObject({
    id: "hook",
    filter: { models: ["claude-sonnet"], failedOnly: true },
  });

  const missing = await cli(["export", "show", "nope"], { root });
  expect(missing.code).toBe(1);
  expect(missing.err).toContain("no such export destination");
});

test("set changes only what it is given: config merged onto the stored one, the secret kept", async () => {
  const root = makeRoot();
  await addWebhook(root, "hook", [
    "--header",
    "x-team=gateway",
    "--secret-file",
    secretFile(root, SIGNING),
  ]);

  const moved = await cli(
    ["export", "set", "hook", "--url", "https://other.example/hook", "--disable", "--json"],
    { root },
  );
  expect(moved.code).toBe(0);
  expect(JSON.parse(moved.out)).toMatchObject({
    enabled: false,
    hasSecret: true,
    config: { url: "https://other.example/hook", headers: { "x-team": "gateway" } },
  });
  expect(await storedSecret(root, "hook")).toContain("whsec-hunter2");

  const replaced = await cli(
    [
      "export",
      "set",
      "hook",
      "--secret-file",
      secretFile(root, '{"signingSecret":"rotated"}', "r"),
      "--max-request-bytes",
      "1048576",
      "--json",
    ],
    { root },
  );
  expect(replaced.code).toBe(0);
  expect(JSON.parse(replaced.out)).toMatchObject({ hasSecret: true, maxRequestBytes: 1_048_576 });
  expect(await storedSecret(root, "hook")).toContain("rotated");

  const cleared = await cli(
    ["export", "set", "hook", "--clear-secret", "--max-request-bytes", "default", "--json"],
    { root },
  );
  expect(cleared.code).toBe(0);
  expect(JSON.parse(cleared.out)).toMatchObject({ hasSecret: false, maxRequestBytes: null });
  expect(await storedSecret(root, "hook")).toBeNull();
});

test("set writes the filter whole, and --all-requests clears it", async () => {
  const root = makeRoot();
  await addWebhook(root, "hook", ["--filter-model", "a", "--filter-key", "key_1"]);

  const narrowed = await cli(
    ["export", "set", "hook", "--filter-model", "b", "--filter-model", "c", "--json"],
    { root },
  );
  expect(JSON.parse(narrowed.out).filter).toEqual({ models: ["b", "c"] });

  const all = await cli(["export", "set", "hook", "--all-requests", "--json"], { root });
  expect(JSON.parse(all.out).filter).toEqual({});

  const both = await cli(["export", "set", "hook", "--all-requests", "--failed-only"], { root });
  expect(both.code).toBe(2);
});

test("set refuses nothing to change, contradictory flags, and an unknown id", async () => {
  const root = makeRoot();
  await addWebhook(root);

  const nothing = await cli(["export", "set", "hook"], { root });
  expect(nothing.code).toBe(2);
  expect(nothing.err).toContain("nothing to change");

  const secretTwice = await cli(
    ["export", "set", "hook", "--clear-secret", "--secret-file", secretFile(root, SIGNING)],
    { root },
  );
  expect(secretTwice.code).toBe(2);

  const toggled = await cli(["export", "set", "hook", "--enable", "--disable"], { root });
  expect(toggled.code).toBe(2);

  const wrongType = await cli(["export", "set", "hook", "--signal", "logs"], { root });
  expect(wrongType.code).toBe(2);
  expect(wrongType.err).toContain("--signal");

  const missing = await cli(["export", "set", "nope", "--disable"], { root });
  expect(missing.code).toBe(1);
  expect(missing.err).toContain("no such export destination");
});

test("remove asks first, and a declined confirmation removes nothing", async () => {
  const root = makeRoot();
  await addWebhook(root);

  const declined = await cli(["export", "remove", "hook"], {
    root,
    prompt: { isTty: true, secret: async () => "", confirm: async () => false },
  });
  expect(declined.code).toBe(1);
  expect(declined.err).toContain("cancelled");
  expect((await cli(["export", "show", "hook"], { root })).code).toBe(0);

  const removed = await cli(["export", "remove", "hook", "--json"], { root });
  expect(removed.code).toBe(0);
  expect(JSON.parse(removed.out)).toEqual({ id: "hook", removed: true });
  expect((await cli(["export", "show", "hook"], { root })).code).toBe(1);

  const again = await cli(["export", "remove", "hook"], { root });
  expect(again.code).toBe(1);
  expect(again.err).toContain("no such export destination");
});

test("test and skip need the running gateway's worker: refused, pointing at the console", async () => {
  const root = makeRoot();
  await addWebhook(root);

  const stopped = fakeService({ root });
  for (const verb of ["test", "skip"]) {
    const result = await cli(["export", verb, "hook"], { root, service: stopped });
    expect(result.code).toBe(1);
    expect(result.err).toContain("requires the running gateway; use the console");
    expect(result.err).toContain("not running");
  }

  const running = fakeService({ root, alivePids: new Set([4242]) });
  await Bun.write(join(running.deps.stateDir, "gateway.pid"), "4242\n");
  for (const verb of ["test", "skip"]) {
    const result = await cli(["export", verb, "hook"], { root, service: running });
    expect(result.code).toBe(1);
    expect(result.err).toContain("requires the running gateway; use the console");
    expect(result.err).not.toContain("not running");
  }

  const unknown = await cli(["export", "test", "nope"], { root, service: stopped });
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain("no such export destination");
});

test("help lists the export commands and explains add's per-type flags", async () => {
  const root = makeRoot();
  const all = await cli(["--help"], { root });
  for (const verb of ["list", "show", "add", "set", "test", "skip", "remove"]) {
    expect(all.out).toContain(`export ${verb}`);
  }

  const add = await cli(["export", "add", "--help"], { root });
  expect(add.code).toBe(0);
  expect(add.out).toContain("--secret-file");
  expect(add.out).toContain("elasticsearch");
  expect(add.out).toContain('{"apiKey"');
  expect(add.out).toContain("signingSecret");
});

/**
 * The CLI opens SQLite only. On an installation configured for Postgres a
 * write would land in an unrelated local file the gateway never reads, so
 * every subcommand refuses before any store is opened — the doctor's own
 * detection, `clusterMode && databaseUrl`.
 */
test("every export subcommand refuses on a Postgres installation, touching no local database", async () => {
  const cluster = {
    OMNI_CLUSTER_MODE: "true",
    OMNI_DATABASE_URL: "postgres://nobody:x@127.0.0.1:1/none",
    OMNI_REDIS_URL: "redis://127.0.0.1:1",
  };
  const argvs = [
    ["export", "list"],
    ["export", "show", "decoy"],
    ["export", "add", "webhook", "hook", "--url", "https://receiver.example/in"],
    ["export", "set", "decoy", "--disable"],
    ["export", "remove", "decoy"],
    ["export", "test", "decoy"],
    ["export", "skip", "decoy"],
  ];

  // No database at all: none may be created.
  const bare = makeRoot(cluster);
  for (const argv of argvs) {
    const result = await cli(argv, { root: bare, service: fakeService({ root: bare }) });
    expect(result.code).toBe(1);
    expect(result.err).toContain("configured for Postgres");
    expect(result.err).toContain("use the console");
  }
  expect(await Bun.file(join(bare, "omnigateway.db")).exists()).toBe(false);

  // A SQLite decoy at the default path: never read, never written.
  const root = makeRoot(cluster);
  const sqlite = await openStore(root);
  await sqlite.exportDestinations.create({
    id: "decoy",
    type: "webhook",
    config: { url: "https://receiver.example/in", headers: {} },
    startFrom: "now",
  });
  const before = await sqlite.exportDestinations.list();
  sqlite.close();
  for (const argv of argvs) {
    const result = await cli(argv, { root, service: fakeService({ root }) });
    expect(result.code).toBe(1);
    expect(result.out).not.toContain("decoy");
  }
  const after = await openStore(root);
  expect(await after.exportDestinations.list()).toEqual(before);
  after.close();
});
