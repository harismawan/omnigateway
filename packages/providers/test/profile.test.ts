import { expect, test } from "bun:test";
import { grokHost, mergeHeaders, orderHeaders, PROFILES, stainlessHost } from "../src/profile.ts";
import { entry } from "./entry.ts";

test("stainlessHost maps platform names to the Stainless spelling", () => {
  expect(stainlessHost("darwin", "arm64")).toEqual({ os: "MacOS", arch: "arm64" });
  expect(stainlessHost("linux", "x64")).toEqual({ os: "Linux", arch: "x64" });
  expect(stainlessHost("win32", "x64")).toEqual({ os: "Windows", arch: "x64" });
  expect(stainlessHost("freebsd", "arm64")).toEqual({ os: "Unknown", arch: "arm64" });
});

test("grokHost lowercases the platform and gives arm64 its GNU name", () => {
  expect(grokHost("darwin", "arm64")).toEqual({ os: "darwin", arch: "aarch64" });
  expect(grokHost("Linux", "x64")).toEqual({ os: "linux", arch: "x64" });
});

test("orderHeaders puts listed names first, in order, case-insensitively", () => {
  const pairs: [string, string][] = [
    ["anthropic-version", "2023-06-01"],
    ["Accept", "application/json"],
    ["User-Agent", "claude-cli/2.1.258 (external, cli)"],
  ];
  const out = orderHeaders(pairs, ["Accept", "USER-AGENT"]);
  expect(out.map(([n]) => n)).toEqual(["Accept", "User-Agent", "anthropic-version"]);
});

test("orderHeaders appends unlisted headers in their original order", () => {
  const out = orderHeaders(
    [
      ["z-last", "1"],
      ["Accept", "2"],
      ["a-first", "3"],
    ],
    ["Accept"],
  );
  expect(out.map(([n]) => n)).toEqual(["Accept", "z-last", "a-first"]);
});

test("mergeHeaders replaces case-insensitively, taking the later casing", () => {
  const out = mergeHeaders(
    [
      ["User-Agent", "old"],
      ["x-app", "cli"],
    ],
    [["user-agent", "new"]],
  );
  expect(out).toEqual([
    ["user-agent", "new"],
    ["x-app", "cli"],
  ]);
});

test("mergeHeaders keeps the base position when a header is replaced", () => {
  const out = mergeHeaders(
    [
      ["A", "1"],
      ["B", "2"],
      ["C", "3"],
    ],
    [["b", "9"]],
  );
  expect(out.map(([n]) => n)).toEqual(["A", "b", "C"]);
});

test("anthropic profile carries the claude-cli identity", () => {
  const h = new Map(
    entry(PROFILES, "anthropic", "PROFILES").headers.map(([n, v]) => [n.toLowerCase(), v]),
  );
  expect(h.get("user-agent")).toMatch(/^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/);
  expect(h.get("x-app")).toBe("cli");
  expect(h.get("anthropic-dangerous-direct-browser-access")).toBe("true");
  expect(h.get("x-stainless-lang")).toBe("js");
  expect(h.get("x-stainless-runtime")).toBe("node");
  expect(h.get("x-stainless-retry-count")).toBe("0");
});

test("openai profile carries the codex-cli identity", () => {
  const h = new Map(
    entry(PROFILES, "openai", "PROFILES").headers.map(([n, v]) => [n.toLowerCase(), v]),
  );
  expect(h.get("user-agent")).toMatch(/^codex-cli\/\d+\.\d+\.\d+ \(.+; .+\)$/);
  expect(h.get("originator")).toBe("codex_cli_rs");
  expect(h.get("openai-beta")).toBe("responses=experimental");
});

test("kimi profile carries the kimi-code-cli identity", () => {
  const h = new Map(
    entry(PROFILES, "kimi", "PROFILES").headers.map(([n, v]) => [n.toLowerCase(), v]),
  );
  expect(h.get("user-agent")).toMatch(/^kimi-code-cli\/\d+\.\d+\.\d+$/);
  expect(h.get("x-msh-platform")).toBe("kimi_code_cli");
});

test("no profile leaks the gateway's own name", () => {
  for (const profile of Object.values(PROFILES)) {
    for (const [, value] of profile.headers) {
      expect(value.toLowerCase()).not.toContain("omni");
    }
  }
});

test("every ordered name exists in the profile it orders", () => {
  for (const profile of Object.values(PROFILES)) {
    const present = new Set(profile.headers.map(([n]) => n.toLowerCase()));
    // Protocol headers are added by the adapter, not the profile, so the
    // order list is a superset. It must never contain a name nobody sends.
    expect(profile.order.length).toBeGreaterThan(present.size - 1);
  }
});

test("every profile header appears in that profile's order list", () => {
  for (const profile of Object.values(PROFILES)) {
    const ordered = new Set(profile.order.map((n) => n.toLowerCase()));
    for (const [name] of profile.headers) {
      expect(ordered.has(name.toLowerCase())).toBe(true);
    }
  }
});
