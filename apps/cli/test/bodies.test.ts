import { expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BodyArtifact, Store } from "@omni/store";
import { cli, makeRoot, openStore } from "./helpers/harness.ts";

const AT = Date.UTC(2026, 7, 17, 14, 32, 6);
const REQUEST_ID = "req_550e8400-e29b-41d4-a716-446655440000";

/**
 * Where the artifact for `AT` lands, spelled out rather than derived.
 *
 * The shard layout is UTC and is what an operator relies on to purge a day by
 * hand, so a test that reached through the store's own helper would agree with
 * whatever layout it happened to produce.
 */
const REL_PATH = `2026/08/17/${REQUEST_ID}.json.enc`;

/**
 * A string that exists in the stored artifact and nowhere else.
 *
 * Short and prefix-free on purpose: the store masks bodies before writing them,
 * and a marker that tripped the length rule or a vendor prefix would vanish for
 * a reason that has nothing to do with what these tests are about.
 */
const MARKER = "CANARY-cf19-in-the-prompt";

/** Every test starts from a migrated, empty installation. */
async function installation(): Promise<string> {
  const root = makeRoot();
  expect((await cli(["db", "migrate"], { root })).code).toBe(0);
  return root;
}

function artifact(overrides: Partial<BodyArtifact> = {}): BodyArtifact {
  return {
    schemaVersion: 1,
    requestId: REQUEST_ID,
    at: AT,
    client: {
      request: { model: "fast", messages: [{ role: "user", content: MARKER }] },
      response: { id: "msg_1", content: "answered" },
      truncated: false,
    },
    attempts: [
      {
        attempt: 1,
        provider: "anthropic",
        request: { model: "claude-haiku-4-5", messages: [{ role: "user", content: "compressed" }] },
        response: { id: "msg_1" },
        streamChunks: null,
        truncated: false,
      },
    ],
    error: null,
    ...overrides,
  };
}

/** Seeds one captured request, closing the store so the CLI opens its own. */
async function capture(root: string, input: BodyArtifact = artifact()): Promise<void> {
  const store: Store = await openStore(root);
  try {
    await store.bodies.put(input);
  } finally {
    store.close();
  }
}

/** The rendered line whose first word matches, so a swap between rows is visible. */
function line(out: string, startsWith: string): string {
  const found = out.split("\n").find((row) => row.startsWith(startsWith));
  expect(found).toBeDefined();
  return found ?? "";
}

/**
 * The load-bearing default, asserted in both directions at once.
 *
 * An absence test alone passes for the wrong reason — against an empty artifact,
 * a broken reader, or a marker that masking ate — so the same marker is proved
 * present under `--full` before its absence from the bare run means anything.
 */
test("the bare command withholds the bodies that --full prints", async () => {
  const root = await installation();
  await capture(root);

  const full = await cli(["bodies", REQUEST_ID, "--full"], { root });
  expect(full.code).toBe(0);
  expect(full.out).toContain(MARKER);

  const bare = await cli(["bodies", REQUEST_ID], { root });
  expect(bare.code).toBe(0);
  expect(bare.out).not.toContain(MARKER);
  // The frame is still there: withholding the payloads is not withholding the
  // fact that there are payloads to ask for.
  expect(bare.out).toContain("ready");
  expect(bare.out).toContain("--full");
});

test("the frame reports when it was captured, its size, and whether anything was cut", async () => {
  const root = await installation();
  await capture(root);

  const result = await cli(["bodies", REQUEST_ID], { root });
  expect(result.code).toBe(0);
  expect(line(result.out, "STATE")).toContain("ready");
  expect(line(result.out, "CAPTURED")).toContain("2026-08-17 14:32:06");
  expect(line(result.out, "SIZE")).toContain("on disk");
  expect(line(result.out, "TRUNCATED")).toContain("no");
});

test("a truncated artifact says so rather than reading as complete", async () => {
  const root = await installation();
  await capture(
    root,
    artifact({ client: { request: { model: "fast" }, response: null, truncated: true } }),
  );

  const result = await cli(["bodies", REQUEST_ID], { root });
  expect(line(result.out, "TRUNCATED")).toContain("yes");
  expect(line(result.out, "CLIENT")).toContain("(truncated)");
});

/**
 * The two requests in an artifact are different payloads whenever a filter
 * fired, and a reader comparing them who does not know which is which will read
 * a compressed tool result as what their client sent.
 */
test("the summary names which side of RTK each request sits on", async () => {
  const root = await installation();
  await capture(root);

  const result = await cli(["bodies", REQUEST_ID], { root });
  expect(line(result.out, "CLIENT")).toContain("pre-RTK");
  expect(line(result.out, "ATTEMPT 1")).toContain("post-RTK");
  expect(line(result.out, "ATTEMPT 1")).toContain("anthropic");
});

test("--full names which side of RTK each payload it prints sits on", async () => {
  const root = await installation();
  await capture(root);

  const result = await cli(["bodies", REQUEST_ID, "--full"], { root });
  expect(result.out).toContain("CLIENT REQUEST (pre-RTK)");
  expect(result.out).toContain("ATTEMPT 1 anthropic REQUEST (post-RTK)");
});

test("--json emits the artifact", async () => {
  const root = await installation();
  await capture(root);

  const result = await cli(["bodies", REQUEST_ID, "--json"], { root });
  expect(result.code).toBe(0);
  const body = JSON.parse(result.out) as {
    detailState: string;
    artifact: BodyArtifact | null;
  };
  expect(body.detailState).toBe("ready");
  expect(body.artifact?.schemaVersion).toBe(1);
  expect(body.artifact?.attempts[0]?.provider).toBe("anthropic");
  // The whole artifact, not a summary of it: `--json` is the scripting contract
  // and a script asked for the bodies.
  expect(result.out).toContain(MARKER);
});

/**
 * The three absences are three different answers, and an operator acts on each
 * differently. None of them is a crash.
 */
test("a request that was never captured reads as not captured", async () => {
  const root = await installation();

  const result = await cli(["bodies", "req_never-happened"], { root });
  expect(result.code).toBe(0);
  expect(line(result.out, "STATE")).toContain("none");
  expect(result.out).toContain("not captured");
  expect(result.out).toContain("OMNI_BODY_LOGGING_ALLOWED");
});

test("a row whose artifact was pruned underneath it reads as captured, then lost", async () => {
  const root = await installation();
  await capture(root);
  await rm(join(root, "request_bodies", REL_PATH));

  const result = await cli(["bodies", REQUEST_ID], { root });
  expect(result.code).toBe(0);
  expect(line(result.out, "STATE")).toContain("missing");
  expect(result.out).toContain("captured, then lost");
  // The metadata outlives the artifact, so an operator still learns the request
  // was captured at all — which is what tells them to look at retention.
  expect(line(result.out, "CAPTURED")).toContain("2026-08-17");
});

test("a row whose artifact will not decrypt reads as captured, but unreadable", async () => {
  const root = await installation();
  await capture(root);
  await writeFile(join(root, "request_bodies", REL_PATH), "not the ciphertext that was written");

  const result = await cli(["bodies", REQUEST_ID], { root });
  expect(result.code).toBe(0);
  expect(line(result.out, "STATE")).toContain("corrupt");
  expect(result.out).toContain("captured, but unreadable");
  expect(result.out).toContain("OMNI_ENCRYPTION_KEY");
});

test("stream frames are counted in the summary and printed only with --full", async () => {
  const root = await installation();
  await capture(
    root,
    artifact({
      attempts: [
        {
          attempt: 1,
          provider: "openai",
          request: { model: "gpt-5" },
          response: { id: "resp_1" },
          streamChunks: ["event: one", `data: ${MARKER}`],
          truncated: false,
        },
      ],
    }),
  );

  const bare = await cli(["bodies", REQUEST_ID], { root });
  expect(bare.out).toContain("FRAMES");
  expect(line(bare.out, "ATTEMPT 1")).toContain("2");
  expect(bare.out).not.toContain("event: one");

  const full = await cli(["bodies", REQUEST_ID, "--full"], { root });
  expect(full.out).toContain("ATTEMPT 1 openai STREAM FRAMES (2)");
  expect(full.out).toContain("event: one");
});

/**
 * A provider error frequently quotes the payload back, so it sits under the same
 * withholding rule as a body: named in the frame, printed only when asked.
 */
test("a recorded error is named in the frame and printed only with --full", async () => {
  const root = await installation();
  await capture(root, artifact({ error: { type: "overloaded_error", message: MARKER } }));

  const bare = await cli(["bodies", REQUEST_ID], { root });
  expect(bare.out).toContain("an error was recorded");
  expect(bare.out).not.toContain(MARKER);

  const full = await cli(["bodies", REQUEST_ID, "--full"], { root });
  expect(full.out).toContain("overloaded_error");
});

test("a missing request id is a usage error, not a crash", async () => {
  const root = await installation();

  const result = await cli(["bodies"], { root });
  expect(result.code).toBe(2);
  expect(result.err).toContain("request id is required");
  expect(result.err).toContain("usage: omni bodies");
});
