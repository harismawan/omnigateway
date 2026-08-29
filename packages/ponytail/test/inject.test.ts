import { describe, expect, test } from "bun:test";
import { type ChatRequest, type ContentBlock, cacheControlOf } from "@omni/ir";

/** `cacheControlOf` over a possibly-absent block, which is what indexing gives. */
const cacheControlOfMaybe = (block: ContentBlock | undefined) =>
  block === undefined ? undefined : cacheControlOf(block);

import { isPonytailMode, PONYTAIL_MODES } from "../src/catalog.ts";
import { injectPonytail, PONYTAIL_MARKER, ponytailNotes } from "../src/index.ts";

function request(system?: ContentBlock[]): ChatRequest {
  return {
    model: "fast",
    stream: false,
    ...(system === undefined ? {} : { system }),
    messages: [{ role: "user", content: [{ type: "text", text: "add a cache" }] }],
  };
}

const text = (block: ContentBlock | undefined): string =>
  block !== undefined && block.type === "text" ? block.text : "";

describe("ponytail catalog", () => {
  test("exports the four modes and validates only members", () => {
    expect(PONYTAIL_MODES).toEqual(["off", "lite", "full", "ultra"]);
    for (const mode of PONYTAIL_MODES) expect(isPonytailMode(mode)).toBe(true);
    expect(isPonytailMode("FULL")).toBe(false);
    expect(isPonytailMode(undefined)).toBe(false);
  });
});

describe("injectPonytail", () => {
  test("off returns the very same request object", () => {
    const req = request([{ type: "text", text: "you are a helpful assistant" }]);
    const result = injectPonytail(req, { mode: "off" });

    expect(result.request).toBe(req);
    expect(result.report.applied).toBe(false);
    expect(result.report.reason).toBe("disabled");
  });

  test("appends exactly one system block after the client's own", () => {
    const req = request([{ type: "text", text: "you are a helpful assistant" }]);
    const { request: out, report } = injectPonytail(req, { mode: "full" });

    expect(out.system).toHaveLength(2);
    expect(text(out.system?.[0])).toBe("you are a helpful assistant");
    expect(text(out.system?.[1])).toContain("You are a lazy senior developer.");
    // Exactly once: the assertion above passes on a doubled block too.
    expect(text(out.system?.[1]).split("You are a lazy senior developer.")).toHaveLength(2);
    expect(report.applied).toBe(true);
  });

  test("creates the system array when the request carries none", () => {
    const { request: out } = injectPonytail(request(), { mode: "full" });

    expect(out.system).toHaveLength(1);
    expect(text(out.system?.[0])).toContain("You are a lazy senior developer.");
  });

  test("each level ships its own directive and no other", () => {
    const lite = text(injectPonytail(request(), { mode: "lite" }).request.system?.[0]);
    const full = text(injectPonytail(request(), { mode: "full" }).request.system?.[0]);
    const ultra = text(injectPonytail(request(), { mode: "ultra" }).request.system?.[0]);

    expect(lite).toContain("Level: lite");
    expect(full).toContain("Level: full");
    expect(ultra).toContain("Level: ultra");
    expect(full).not.toContain("Level: lite");
    expect(full).not.toContain("Level: ultra");
  });

  test("every level carries the ladder, so the body is shared", () => {
    for (const mode of ["lite", "full", "ultra"] as const) {
      expect(text(injectPonytail(request(), { mode }).request.system?.[0])).toContain(
        "Does this need to exist at all?",
      );
    }
  });
});
describe("dedupe", () => {
  test("skips when a system block already carries the ruleset", () => {
    const req = request([{ type: "text", text: `prelude ${PONYTAIL_MARKER} ladder` }]);
    const { request: out, report } = injectPonytail(req, { mode: "full" });

    expect(out).toBe(req);
    expect(report.applied).toBe(false);
    expect(report.reason).toBe("already-present");
  });

  test("skips when a system-role turn carries the ruleset", () => {
    const req: ChatRequest = {
      model: "fast",
      stream: false,
      messages: [
        { role: "system", content: [{ type: "text", text: PONYTAIL_MARKER }] },
        { role: "user", content: [{ type: "text", text: "add a cache" }] },
      ],
    };

    expect(injectPonytail(req, { mode: "full" }).report.reason).toBe("already-present");
  });

  test("ignores a user turn that merely mentions the ruleset", () => {
    const req: ChatRequest = {
      model: "fast",
      stream: false,
      messages: [{ role: "user", content: [{ type: "text", text: PONYTAIL_MARKER }] }],
    };

    expect(injectPonytail(req, { mode: "full" }).report.applied).toBe(true);
  });

  test("is idempotent: a second pass adds nothing", () => {
    const once = injectPonytail(request(), { mode: "full" }).request;
    const twice = injectPonytail(once, { mode: "full" });

    expect(twice.request).toBe(once);
    expect(once.system).toHaveLength(1);
  });
});

describe("cache marker", () => {
  test("moves a marker on the last system block onto the appended block", () => {
    const req = request([
      { type: "text", text: "stable prefix", cacheControl: { type: "ephemeral", ttl: "1h" } },
    ]);
    const { request: out, report } = injectPonytail(req, { mode: "full" });

    expect(cacheControlOfMaybe(out.system?.[0])).toBeUndefined();
    expect(cacheControlOfMaybe(out.system?.[1])).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(report.cacheMarkerMoved).toBe(true);
  });

  test("keeps the breakpoint count unchanged", () => {
    const req = request([
      { type: "text", text: "tools", cacheControl: { type: "ephemeral" } },
      { type: "text", text: "prompt", cacheControl: { type: "ephemeral" } },
    ]);
    const marked = (r: ChatRequest) =>
      (r.system ?? []).filter((b) => cacheControlOfMaybe(b) !== undefined);

    expect(marked(injectPonytail(req, { mode: "full" }).request)).toHaveLength(marked(req).length);
  });

  test("leaves a marker that is not on the last block where it is", () => {
    const req = request([
      { type: "text", text: "marked", cacheControl: { type: "ephemeral" } },
      { type: "text", text: "unmarked" },
    ]);
    const { request: out, report } = injectPonytail(req, { mode: "full" });

    expect(cacheControlOfMaybe(out.system?.[0])).toEqual({ type: "ephemeral" });
    expect(cacheControlOfMaybe(out.system?.[2])).toBeUndefined();
    expect(report.cacheMarkerMoved).toBe(false);
  });

  test("invents no marker when the client placed none", () => {
    const { request: out, report } = injectPonytail(request(), { mode: "full" });

    expect(cacheControlOfMaybe(out.system?.[0])).toBeUndefined();
    expect(report.cacheMarkerMoved).toBe(false);
  });
});

describe("purity", () => {
  test("does not touch a deep-frozen request, blocks included", () => {
    const block: ContentBlock = Object.freeze({
      type: "text",
      text: "stable prefix",
      cacheControl: Object.freeze({ type: "ephemeral", ttl: "1h" }),
    }) as ContentBlock;
    const req: ChatRequest = Object.freeze({
      model: "fast",
      stream: false,
      system: Object.freeze([block]) as ContentBlock[],
      messages: Object.freeze([
        Object.freeze({ role: "user", content: Object.freeze([{ type: "text", text: "hi" }]) }),
      ]) as ChatRequest["messages"],
    }) as ChatRequest;

    const { request: out } = injectPonytail(req, { mode: "full" });

    expect(out).not.toBe(req);
    expect(req.system).toHaveLength(1);
    expect(cacheControlOfMaybe(req.system?.[0])).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(out.system?.[0]).not.toBe(block);
  });
});
describe("degradation notes", () => {
  const notesFor = (req: ChatRequest, mode: "off" | "lite" | "full" | "ultra") =>
    ponytailNotes(injectPonytail(req, { mode }).report);

  test("records nothing when the mode is off", () => {
    expect(notesFor(request(), "off")).toEqual([]);
  });

  test("records the level that was applied", () => {
    expect(notesFor(request(), "ultra")).toEqual(["ponytail:ultra"]);
  });

  test("records a dedupe skip instead of a level", () => {
    const req = request([{ type: "text", text: PONYTAIL_MARKER }]);

    expect(notesFor(req, "full")).toEqual(["ponytail:already-present"]);
  });

  test("records a moved marker alongside the level", () => {
    const req = request([{ type: "text", text: "prefix", cacheControl: { type: "ephemeral" } }]);

    expect(notesFor(req, "full")).toEqual(["ponytail:full", "ponytail:cache-marker-moved"]);
  });

  test("emits only constants, never request data", () => {
    const known = new Set([
      "ponytail:lite",
      "ponytail:full",
      "ponytail:ultra",
      "ponytail:already-present",
      "ponytail:cache-marker-moved",
      "ponytail:cache-marker-not-last",
    ]);
    const marked = request([
      { type: "text", text: "secret prompt", cacheControl: { type: "ephemeral" } },
    ]);

    for (const mode of PONYTAIL_MODES) {
      for (const note of [...notesFor(request(), mode), ...notesFor(marked, mode)]) {
        expect(known.has(note)).toBe(true);
      }
    }
  });
});
describe("a breakpoint that is not on the last system block", () => {
  const marked = (): ChatRequest =>
    request([
      { type: "text", text: "marked", cacheControl: { type: "ephemeral" } },
      { type: "text", text: "trailing" },
    ]);

  test("is left where the client put it", () => {
    const { request: out, report } = injectPonytail(marked(), { mode: "full" });

    expect(cacheControlOfMaybe(out.system?.[0])).toEqual({ type: "ephemeral" });
    expect(cacheControlOfMaybe(out.system?.[2])).toBeUndefined();
    expect(report.cacheMarkerMoved).toBe(false);
  });

  test("is reported, because the ruleset is then billed fresh every request", () => {
    const { report } = injectPonytail(marked(), { mode: "full" });

    expect(report.cacheMarkerNotLast).toBe(true);
    expect(ponytailNotes(report)).toEqual(["ponytail:full", "ponytail:cache-marker-not-last"]);
  });

  test("is not reported when the client marked nothing at all", () => {
    const { report } = injectPonytail(request([{ type: "text", text: "plain" }]), { mode: "full" });

    expect(report.cacheMarkerNotLast).toBe(false);
    expect(ponytailNotes(report)).toEqual(["ponytail:full"]);
  });
});
