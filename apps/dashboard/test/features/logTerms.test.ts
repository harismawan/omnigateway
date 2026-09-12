/**
 * The one filter box, read back as three exact parameters.
 *
 * The box replaced three inputs, so the parse is now the only thing standing
 * between what an operator types and which column the gateway compares. The
 * cases that matter are the ones where "a colon means a prefix" is wrong:
 * `llama3:8b` is a model name, and `model:` half-typed is a filter in progress
 * rather than a filter for the empty string.
 */

import { describe, expect, test } from "bun:test";
import { formatTerms, parseTerms } from "../../src/features/logs/LogFilterBar.tsx";

describe("parseTerms", () => {
  test("a bare word is the resolved model, the common case", () => {
    expect(parseTerms("claude-opus-4")).toEqual({ resolvedModel: "claude-opus-4" });
  });

  test("each prefix names its own field, and all three coexist", () => {
    expect(parseTerms("model:opus requested:fast error:UPSTREAM")).toEqual({
      resolvedModel: "opus",
      requestedModel: "fast",
      errorCode: "UPSTREAM",
    });
  });

  test("`resolved` is an alias for `model`, since the bare form already means resolved", () => {
    expect(parseTerms("resolved:opus")).toEqual({ resolvedModel: "opus" });
  });

  test("prefixes are recognised whatever their case", () => {
    expect(parseTerms("Error:UPSTREAM")).toEqual({ errorCode: "UPSTREAM" });
  });

  test("a model name carrying a colon stays a model name", () => {
    // Ollama spells sizes this way. Read as a prefix, `llama3:8b` would filter
    // on nothing and the box would disagree with the filters it produced.
    expect(parseTerms("llama3:8b")).toEqual({ resolvedModel: "llama3:8b" });
  });

  test("a prefix with nothing after it filters on nothing", () => {
    // Mid-typing. Filtering on the empty string here would empty the board
    // between the colon and the first character of the value.
    expect(parseTerms("requested:")).toEqual({});
    expect(parseTerms("")).toEqual({});
    expect(parseTerms("   ")).toEqual({});
  });

  test("the last word of a field wins rather than being concatenated", () => {
    expect(parseTerms("opus sonnet")).toEqual({ resolvedModel: "sonnet" });
  });
});

describe("formatTerms", () => {
  test("round-trips all three, resolved model bare", () => {
    const filters = { resolvedModel: "opus", requestedModel: "fast", errorCode: "UPSTREAM" };
    expect(formatTerms(filters)).toBe("opus requested:fast error:UPSTREAM");
    expect(parseTerms(formatTerms(filters))).toEqual(filters);
  });

  test("writes nothing for filters that name no term", () => {
    expect(formatTerms({ provider: "anthropic" })).toBe("");
  });
});
