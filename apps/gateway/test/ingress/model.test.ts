import { expect, test } from "bun:test";
import { CONTEXT_1M_BETA } from "@omni/ir";
import { parseAnthropicRequest } from "../../src/ingress/anthropic.ts";
import { normalizeClientModel } from "../../src/ingress/model.ts";

const body = (model: string) => ({
  model,
  max_tokens: 16,
  messages: [{ role: "user", content: "hi" }],
});

// `claude/` was a discovery-mirror prefix that ingress unwound. Both are gone,
// so every spelling of it is now an ordinary model name carried through intact.
test("leaves a claude-prefixed id alone", () => {
  expect(normalizeClientModel("claude-opus-5").model).toBe("claude-opus-5");
  expect(normalizeClientModel("claude/").model).toBe("claude/");
  expect(normalizeClientModel("claude/gpt-5.6-sol").model).toBe("claude/gpt-5.6-sol");
});

test("strips the 1m suffix and turns it into the beta it stands for", () => {
  const named = normalizeClientModel("gpt-5.6-sol[1m]");
  expect(named.model).toBe("gpt-5.6-sol");
  expect(named.betas).toEqual([CONTEXT_1M_BETA]);
});

test("strips the suffix from a slash-bearing id without touching the rest", () => {
  const named = normalizeClientModel("claude/gpt-5.6-sol[1m]");
  expect(named.model).toBe("claude/gpt-5.6-sol");
  expect(named.betas).toEqual([CONTEXT_1M_BETA]);
});

test("does not duplicate a beta the client already sent", () => {
  const named = normalizeClientModel("opus[1m]", [CONTEXT_1M_BETA, "other-beta"]);
  expect(named.betas).toEqual([CONTEXT_1M_BETA, "other-beta"]);
});

test("a name that is only the suffix is left for resolution to reject", () => {
  expect(normalizeClientModel("[1m]").model).toBe("[1m]");
});

test("ingress carries a claude-prefixed id through unchanged", () => {
  const request = parseAnthropicRequest(body("claude/opus"));
  expect(request.model).toBe("claude/opus");
});

test("ingress merges the suffix into the betas carried on the request", () => {
  const request = parseAnthropicRequest(
    body("opus[1m]"),
    new Headers({ "anthropic-beta": "claude-code-20250219" }),
  );
  expect(request.model).toBe("opus");
  expect(request.betas).toEqual(["claude-code-20250219", CONTEXT_1M_BETA]);
});
