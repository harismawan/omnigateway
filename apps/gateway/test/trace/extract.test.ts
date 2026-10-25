import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { extractTrace, TRACE_INVALID } from "../../src/trace/extract.ts";

const base: ChatRequest = {
  model: "m",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: false,
};

function h(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

describe("explicit caller headers", () => {
  test("x-omni-session-id and x-omni-turn-id are stored verbatim", () => {
    const t = extractTrace(h({ "x-omni-session-id": "job-42", "x-omni-turn-id": "step-3" }), base);
    expect(t.sessionId).toBe("job-42");
    expect(t.turnId).toBe("step-3");
    expect(t.agent).toBeNull();
    expect(t.invalid).toBe(false);
  });

  test("explicit session wins over an agent's inferred one", () => {
    const t = extractTrace(
      h({ "x-omni-session-id": "mine", "x-claude-code-session-id": "cc-1" }),
      base,
    );
    expect(t.sessionId).toBe("mine");
    expect(t.agent).toBe("claude-code");
  });

  test("tags are trimmed, deduplicated and keep order", () => {
    const t = extractTrace(h({ "x-omni-tags": " a, b ,a,c " }), base);
    expect(t.tags).toEqual(["a", "b", "c"]);
  });

  test("metadata splits at the first colon and percent-decodes", () => {
    const t = extractTrace(
      h({ "x-omni-metadata": "team:search,note:hello%2C%20world,url:http://x" }),
      base,
    );
    expect(t.metadata).toEqual({ team: "search", note: "hello, world", url: "http://x" });
  });

  test("duplicate metadata keys keep the last", () => {
    expect(extractTrace(h({ "x-omni-metadata": "a:1,a:2" }), base).metadata).toEqual({ a: "2" });
  });

  test("x-request-id becomes the client request id", () => {
    expect(extractTrace(h({ "x-request-id": "abc-123" }), base).clientRequestId).toBe("abc-123");
  });

  test("no headers yields an empty context", () => {
    expect(extractTrace(h({}), base)).toEqual({
      sessionId: null,
      turnId: null,
      agent: null,
      tags: [],
      metadata: {},
      clientRequestId: null,
      invalid: false,
    });
  });
});

describe("agent inference", () => {
  test("Claude Code session header", () => {
    const t = extractTrace(h({ "x-claude-code-session-id": "3f1c" }), base);
    expect(t).toMatchObject({ agent: "claude-code", sessionId: "claude-code:3f1c", turnId: null });
  });

  test("OpenCode, identified by its own session-id header, with parent-free turn", () => {
    const t = extractTrace(
      h({
        "x-opencode-session-id": "ses_abc",
        "x-opencode-session": "ses_affinity",
        "x-session-affinity": "ses_affinity",
        "user-agent": "opencode/latest/1.18.40/opencode",
      }),
      base,
    );
    expect(t).toMatchObject({ agent: "opencode", sessionId: "opencode:ses_abc" });
  });

  test("OpenCode identified by user agent alone falls back to the generic affinity header", () => {
    const t = extractTrace(
      h({ "user-agent": "opencode/latest/1.0.0/opencode", "x-session-affinity": "aff-1" }),
      base,
    );
    expect(t).toMatchObject({ agent: "opencode", sessionId: "opencode:aff-1" });
  });

  test("OpenCode x-opencode-request becomes the turn", () => {
    const t = extractTrace(h({ "x-opencode-session": "s1", "x-opencode-request": "r9" }), base);
    expect(t).toMatchObject({ agent: "opencode", sessionId: "opencode:s1", turnId: "opencode:r9" });
  });

  test("Pi, identified by user agent, reads x-session-id", () => {
    const t = extractTrace(
      h({ "user-agent": "pi/0.70.0 (linux; bun/1.4.4; x64)", "x-session-id": "pi-s" }),
      base,
    );
    expect(t).toMatchObject({ agent: "pi", sessionId: "pi:pi-s" });
  });

  test("Pi with the short user agent", () => {
    const t = extractTrace(h({ "user-agent": "pi", session_id: "pi-2" }), base);
    expect(t).toMatchObject({ agent: "pi", sessionId: "pi:pi-2" });
  });

  test("Pi talking through an OpenCode-style header is still Pi", () => {
    const t = extractTrace(
      h({ "x-opencode-session": "s", "x-opencode-client": "pi", "user-agent": "pi/1.0 (x)" }),
      base,
    );
    expect(t).toMatchObject({ agent: "pi", sessionId: "pi:s" });
  });

  test("generic session headers from an unidentified caller are not stored", () => {
    const t = extractTrace(h({ "x-session-id": "s", "user-agent": "curl/8" }), base);
    expect(t.sessionId).toBeNull();
    expect(t.agent).toBeNull();
  });

  describe("Codex", () => {
    const snapshot = JSON.stringify({ thread_id: "th-1", turn_id: "tu-2", session_id: "th-1" });
    const withMeta = (cm: Record<string, unknown>): ChatRequest => ({
      ...base,
      vendor: { openai: { client_metadata: cm } },
    });

    test("body turn snapshot", () => {
      const t = extractTrace(h({}), withMeta({ "x-codex-turn-metadata": snapshot }));
      expect(t).toMatchObject({ agent: "codex", sessionId: "codex:th-1", turnId: "codex:tu-2" });
    });

    test("header snapshot when the body has none", () => {
      const t = extractTrace(h({ "x-codex-turn-metadata": snapshot }), base);
      expect(t).toMatchObject({ agent: "codex", sessionId: "codex:th-1", turnId: "codex:tu-2" });
    });

    test("flat client_metadata keys as the last resort", () => {
      const t = extractTrace(h({}), withMeta({ thread_id: "th-9", turn_id: "tu-9" }));
      expect(t).toMatchObject({ agent: "codex", sessionId: "codex:th-9", turnId: "codex:tu-9" });
    });

    test("body snapshot wins over header", () => {
      const other = JSON.stringify({ thread_id: "hdr", turn_id: "hdr" });
      const t = extractTrace(
        h({ "x-codex-turn-metadata": other }),
        withMeta({ "x-codex-turn-metadata": snapshot }),
      );
      expect(t.sessionId).toBe("codex:th-1");
    });

    test("a malformed snapshot is ignored and flagged", () => {
      const t = extractTrace(h({ "x-codex-turn-metadata": "{not json" }), base);
      expect(t.agent).toBeNull();
      expect(t.invalid).toBe(true);
    });
  });
});

describe("bounds", () => {
  test("an id over 256 characters is dropped and flagged", () => {
    const t = extractTrace(h({ "x-omni-session-id": "a".repeat(257) }), base);
    expect(t.sessionId).toBeNull();
    expect(t.invalid).toBe(true);
  });

  test("an id with a space inside is dropped", () => {
    const t = extractTrace(h({ "x-request-id": "a b" }), base);
    expect(t.clientRequestId).toBeNull();
    expect(t.invalid).toBe(true);
  });

  test("an inferred id is bounded too", () => {
    const t = extractTrace(h({ "x-claude-code-session-id": "x".repeat(300) }), base);
    expect(t.sessionId).toBeNull();
    expect(t.agent).toBe("claude-code");
    expect(t.invalid).toBe(true);
  });

  test("invalid tags are dropped individually, and only the first 16 are kept", () => {
    const many = Array.from({ length: 20 }, (_, i) => `t${i}`).join(",");
    const t = extractTrace(h({ "x-omni-tags": `ok,bad tag,${"x".repeat(65)},${many}` }), base);
    expect(t.tags[0]).toBe("ok");
    expect(t.tags).toHaveLength(16);
    expect(t.tags).not.toContain("bad tag");
    expect(t.invalid).toBe(true);
  });

  test("metadata entries are bounded", () => {
    const entries = Array.from({ length: 20 }, (_, i) => `k${i}:v`).join(",");
    const t = extractTrace(h({ "x-omni-metadata": `bad key:1,nocolon,${entries}` }), base);
    expect(Object.keys(t.metadata)).toHaveLength(16);
    expect(t.metadata["bad key"]).toBeUndefined();
    expect(t.invalid).toBe(true);
  });

  test("a metadata value over 256 characters is dropped", () => {
    const t = extractTrace(h({ "x-omni-metadata": `a:${"v".repeat(257)},b:1` }), base);
    expect(t.metadata).toEqual({ b: "1" });
    expect(t.invalid).toBe(true);
  });

  test("a header line over 4 KiB is ignored whole", () => {
    const t = extractTrace(h({ "x-omni-tags": `a,${"b,".repeat(2100)}` }), base);
    expect(t.tags).toEqual([]);
    expect(t.invalid).toBe(true);
  });

  test("a bad percent escape drops that entry", () => {
    const t = extractTrace(h({ "x-omni-metadata": "a:%E0%A4%A,b:2" }), base);
    expect(t.metadata).toEqual({ b: "2" });
    expect(t.invalid).toBe(true);
  });

  test("the degradation constant names no request data", () => {
    expect(TRACE_INVALID).toBe("trace:invalid");
  });
});

test("Anthropic metadata.user_id never reaches the context", () => {
  const userId = JSON.stringify({ account_uuid: "acct", device_id: "dev", session_id: "s" });
  const req: ChatRequest = { ...base, conversationId: userId };
  const t = extractTrace(h({}), req);
  expect(JSON.stringify(t)).not.toContain("acct");
  expect(t.sessionId).toBeNull();
});

describe("review fixes", () => {
  test("the bound applies to the stored, prefixed id, so it stays filterable", () => {
    // 256 is accepted for an explicit id; an inferred one gains `claude-code:`.
    const raw = "a".repeat(256);
    const explicit = extractTrace(h({ "x-omni-session-id": raw }), base);
    expect(explicit.sessionId).toBe(raw);
    const inferred = extractTrace(h({ "x-claude-code-session-id": raw }), base);
    expect(inferred.sessionId).toBeNull();
    expect(inferred.invalid).toBe(true);
    const fits = "b".repeat(256 - "claude-code:".length);
    expect(extractTrace(h({ "x-claude-code-session-id": fits }), base).sessionId).toBe(
      `claude-code:${fits}`,
    );
  });

  test("a present but invalid explicit id drops the field rather than falling back", () => {
    const t = extractTrace(
      h({ "x-omni-session-id": "has space", "x-claude-code-session-id": "cc-1" }),
      base,
    );
    expect(t.sessionId).toBeNull();
    expect(t.agent).toBe("claude-code");
    expect(t.invalid).toBe(true);
  });

  test("prototype-shaped metadata keys are ordinary keys and count toward the cap", () => {
    const t = extractTrace(h({ "x-omni-metadata": "__proto__:x,constructor:y" }), base);
    expect(Object.keys(t.metadata).sort()).toEqual(["__proto__", "constructor"]);
    expect(t.metadata["constructor"]).toBe("y");
    const many = Array.from({ length: 16 }, (_, i) => `k${i}:v`).join(",");
    const capped = extractTrace(h({ "x-omni-metadata": `${many},constructor:z` }), base);
    expect(Object.keys(capped.metadata)).toHaveLength(16);
    expect(capped.invalid).toBe(true);
  });
});
