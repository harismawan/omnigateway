import { expect, test } from "bun:test";
import type { ConnectFlows, ConnectPoll, ConnectStart } from "@omni/control";
import { GatewayError } from "@omni/ir";
import { cli, makeRoot } from "./helpers/harness.ts";

/** A flow that answers exactly as a provider would, without one being there. */
function stubFlows(input: {
  start: Partial<ConnectStart>;
  polls?: ConnectPoll[];
  finish?: (flowId: unknown, code: unknown) => Promise<{ id: string }>;
}): { flows: ConnectFlows; finished: Array<{ flowId: unknown; code: unknown }>; polls: number } {
  const finished: Array<{ flowId: unknown; code: unknown }> = [];
  const remaining = [...(input.polls ?? [])];
  const record = { polls: 0 };

  const flows = {
    async start(): Promise<ConnectStart> {
      return {
        flowId: "flow-1",
        authorizeUrl: "https://provider.example/authorize?x=1",
        userCode: null,
        kind: "pkce",
        supportsManualPaste: true,
        pollIntervalMs: 1,
        ...input.start,
      };
    },
    async finish(flowId: unknown, code: unknown) {
      finished.push({ flowId, code });
      return input.finish === undefined ? { id: "cred-1" } : input.finish(flowId, code);
    },
    async poll(): Promise<ConnectPoll> {
      record.polls += 1;
      const next = remaining.shift();
      if (next === undefined) throw new GatewayError("INTERNAL", "polled too many times");
      return next;
    },
  } as unknown as ConnectFlows;

  return {
    flows,
    finished,
    get polls() {
      return record.polls;
    },
  };
}

async function installation(): Promise<string> {
  const root = makeRoot();
  await cli(["db", "migrate"], { root });
  return root;
}

test("a redirect flow prints the URL and completes with what the operator pasted", async () => {
  const root = await installation();
  const stub = stubFlows({ start: { kind: "pkce" } });

  const result = await cli(["connect", "anthropic", "--label", "work", "--json"], {
    root,
    connect: () => stub.flows,
    prompt: {
      isTty: true,
      secret: async () => "https://localhost:1455/auth/callback?code=abc&state=xyz",
      confirm: async () => true,
    },
  });

  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).toMatchObject({ id: "cred-1", provider: "anthropic" });
  // The URL goes to stderr, so `--json` on stdout stays parseable.
  expect(result.err).toContain("https://provider.example/authorize?x=1");
  expect(stub.finished[0]?.code).toBe("https://localhost:1455/auth/callback?code=abc&state=xyz");
});

test("a device flow shows the user code and polls until the operator approves", async () => {
  const root = await installation();
  const stub = stubFlows({
    start: { kind: "device", userCode: "WXYZ-1234", pollIntervalMs: 1 },
    polls: [{ status: "pending" }, { status: "pending" }, { status: "complete", id: "cred-9" }],
  });

  const result = await cli(["connect", "kimi", "--json"], {
    root,
    connect: () => stub.flows,
  });

  expect(result.code).toBe(0);
  expect(result.err).toContain("WXYZ-1234");
  expect(JSON.parse(result.out)).toMatchObject({ id: "cred-9" });
  expect(stub.polls).toBe(3);
});

test("a device flow never asks the operator to paste anything", async () => {
  const root = await installation();
  const stub = stubFlows({
    start: { kind: "device", userCode: "CODE", pollIntervalMs: 1 },
    polls: [{ status: "complete", id: "cred-2" }],
  });

  let asked = false;
  const result = await cli(["connect", "kimi"], {
    root,
    connect: () => stub.flows,
    prompt: {
      isTty: true,
      secret: async () => {
        asked = true;
        return "";
      },
      confirm: async () => true,
    },
  });

  expect(result.code).toBe(0);
  expect(asked).toBe(false);
});

test("an unknown provider is refused before a flow is started", async () => {
  const root = await installation();
  let started = false;
  const stub = stubFlows({ start: {} });

  const result = await cli(["connect", "notaprovider"], {
    root,
    connect: () => {
      started = true;
      return stub.flows;
    },
  });

  expect(result.code).toBe(2);
  expect(result.err).toContain("anthropic, openai, kimi");
  expect(started).toBe(false);
});

test("a provider that repudiates the code fails the command rather than half-connecting", async () => {
  const root = await installation();
  const stub = stubFlows({
    start: { kind: "pkce" },
    finish: async () => {
      throw new GatewayError("AUTH", "authorization state mismatch");
    },
  });

  const result = await cli(["connect", "openai"], {
    root,
    connect: () => stub.flows,
    prompt: { isTty: true, secret: async () => "pasted", confirm: async () => true },
  });

  expect(result.code).toBe(1);
  expect(result.err).toContain("state mismatch");

  const listed = await cli(["credentials", "list", "--json"], { root });
  expect(JSON.parse(listed.out)).toEqual({ credentials: [] });
});
