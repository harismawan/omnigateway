import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MAX_MODEL_NAME_LENGTH, MAX_MODEL_OVERRIDES } from "../../src/features/keys/limits.ts";
import { MIN_PASSWORD_LENGTH } from "../../src/features/settings/policy.ts";
import {
  DEFAULT_SMART_ROUTER_POLICY,
  GUARDRAIL_HISTORY_TURNS_MAX,
  GUARDRAIL_POLICY_MAX_CHARS,
  GUARDRAIL_TIMEOUT_MAX_MS,
  LEVELS,
  SAME_WINDOW_TOLERANCE_MS,
  SMART_ROUTER_POLICY_MAX_CHARS,
  SMART_ROUTER_TIMEOUT_MAX_MS,
  WINDOW_DURATION_MS,
} from "../../src/lib/domain.ts";
import { SAFE_PROVIDER_ID } from "../../src/theme/tokens.ts";
import {
  ACCOUNT_QUOTA_KEYS,
  ACCOUNT_QUOTA_SAMPLE_KEYS,
  CLIENT_QUOTA_HISTORY_RESPONSE_KEYS,
  CLIENT_REQUEST_LOG_KEYS,
} from "./mirrorKeys.ts";

/**
 * The console's copies of server facts, held to the Rust source that owns them.
 *
 * The gateway is the Rust one in `crates/`, which the console cannot import, so
 * every bound, pattern and key list it restates exists twice. This file reads
 * the Rust text and compares. Reading Rust from a console test is allowed; the
 * reverse is not.
 *
 * Each fact is parsed **narrowly** — one regex per line that declares it — and
 * `owned` throws when the line is missing, so renaming or moving the Rust
 * constant fails here loudly instead of passing against nothing.
 *
 * Facts with no single named Rust constant are pinned to the literal the Rust
 * check uses, and say so: `GUARDRAIL_POLICY_MAX_CHARS` (the `> 4000` checks in
 * `keys.rs`), `SAME_WINDOW_TOLERANCE_MS` (the `<=60000` sample dedupe),
 * `LEVELS` (the `rank` match in the CLI's console reader) and the provider-id
 * pattern (a hand-written byte check, not a regex).
 */

const REPO = resolve(import.meta.dir, "../../../..");

function rust(path: string): string {
  return readFileSync(resolve(REPO, path), "utf8");
}

/** The first capture of `pattern` in `path`, or a failure naming both. */
function owned(path: string, pattern: RegExp): string {
  const found = pattern.exec(rust(path));
  if (found?.[1] === undefined) {
    throw new Error(`${path} no longer matches ${pattern} — the Rust owner moved; update the pin`);
  }
  return found[1];
}

/** A Rust numeric literal (`12`, `4_000`, `60_000.0`) as a number. */
const num = (literal: string): number => Number(literal.replaceAll("_", ""));

/** A `pub const NAME: <ty> = <number>;` line's value. */
const constant = (path: string, name: string): number =>
  num(owned(path, new RegExp(`^pub const ${name}: (?:usize|u\\d+|i\\d+|f64) = ([\\d_.]+);$`, "m")));

test("the minimum password length is the control crate's", () => {
  expect(MIN_PASSWORD_LENGTH).toBe(
    constant("crates/omni-control/src/admin_password.rs", "MIN_PASSWORD_LENGTH"),
  );
});

test("the per-model override bounds are the ratelimit crate's", () => {
  const path = "crates/omni-ratelimit/src/limits.rs";
  expect(MAX_MODEL_OVERRIDES).toBe(constant(path, "MAX_MODEL_OVERRIDES"));
  expect(MAX_MODEL_NAME_LENGTH).toBe(constant(path, "MAX_MODEL_NAME_LENGTH"));
});

test("the settings bounds and default policy are the store crate's", () => {
  const path = "crates/omni-store/src/settings.rs";
  expect(GUARDRAIL_TIMEOUT_MAX_MS).toBe(constant(path, "GUARDRAIL_TIMEOUT_MAX_MS"));
  expect(GUARDRAIL_HISTORY_TURNS_MAX).toBe(constant(path, "GUARDRAIL_HISTORY_TURNS_MAX"));
  expect(SMART_ROUTER_POLICY_MAX_CHARS).toBe(constant(path, "SMART_ROUTER_POLICY_MAX_CHARS"));
  expect(SMART_ROUTER_TIMEOUT_MAX_MS).toBe(constant(path, "SMART_ROUTER_TIMEOUT_MAX_MS"));

  // A Rust string literal continued with `\` + newline, which drops the
  // newline and the next line's leading whitespace.
  const literal = owned(
    path,
    /^pub const DEFAULT_SMART_ROUTER_POLICY: &str = "((?:[^"\\]|\\.)*)";$/ms,
  );
  expect(DEFAULT_SMART_ROUTER_POLICY).toBe(literal.replace(/\\\n\s*/g, ""));
});

test("the guardrail policy bound is the one both key checks enforce", () => {
  // No named Rust constant: `keys.rs` writes the literal at create and at edit.
  const path = "crates/omni-control/src/keys.rs";
  // Each check, then the refusal it raises, so a bound cannot be matched
  // against some other field's limit.
  const create = num(
    owned(
      path,
      /if p\.chars\(\)\.count\(\) > (\d+) \{\s*return Err\(\s*"BAD_REQUEST: guardrailPolicy:/,
    ),
  );
  const edit = num(
    owned(path, /if length > (\d+) \{\s*return Err\(\s*"BAD_REQUEST: policy: Too big/),
  );
  expect(GUARDRAIL_POLICY_MAX_CHARS).toBe(create);
  expect(GUARDRAIL_POLICY_MAX_CHARS).toBe(edit);
  // And the refusal text the operator sees names the same number.
  expect(rust(path)).toContain(
    `guardrailPolicy: Too big: expected string to have <=${GUARDRAIL_POLICY_MAX_CHARS} characters`,
  );
});

test("the same-window tolerance is the one the sample dedupe uses, on both backends", () => {
  // No named Rust constant: the dedupe writes it into SQL.
  const sqlite = num(
    owned("crates/omni-control/src/quota_ops.rs", /OR abs\(resets_at-\?\)<=(\d+)\)/),
  );
  const postgres = num(
    owned("crates/omni-store/src/pg/quota.rs", /OR abs\(resets_at::float8-\$6\)<=(\d+)\)/),
  );
  expect(SAME_WINDOW_TOLERANCE_MS).toBe(sqlite);
  expect(SAME_WINDOW_TOLERANCE_MS).toBe(postgres);
});

test("the nominal window lengths are the store crate's", () => {
  const path = "crates/omni-store/src/quota.rs";
  const ms = (variant: string) =>
    owned(path, new RegExp(`Self::${variant} => ([\\d. *]+),\\n`))
      .split("*")
      .map((factor) => Number(factor.trim()))
      .reduce((a, b) => a * b, 1);
  expect(WINDOW_DURATION_MS).toEqual({
    fiveHour: ms("FiveHour"),
    daily: ms("Daily"),
    weekly: ms("Weekly"),
  });
});

test("the log levels rank as the CLI's console reader ranks them", () => {
  // No named Rust constant: `rank` is a match on the level name.
  const body = owned("crates/omni-cli/src/console.rs", /fn rank\(s: &str\) -> usize \{([^}]*)\}/);
  const ranks = Object.fromEntries(
    [...body.matchAll(/"(\w+)" => (\d+),/g)].map((m) => [m[1] ?? "", Number(m[2])]),
  );
  expect(Object.entries(LEVELS) as [string, number][]).toEqual(Object.entries(ranks));
  // And the gateway's own filter, which compares positions in this list: the
  // console's ordering must be the same sequence.
  const order = owned(
    "crates/omni-gateway/src/console.rs",
    /fn level\(s: &str\) -> Option<usize> \{\s*\[([^\]]*)\]/,
  );
  const names = [...order.matchAll(/"(\w+)"/g)].map((m) => m[1] ?? "");
  expect(
    Object.entries(LEVELS)
      .sort(([, a], [, b]) => a - b)
      .map(([name]) => name),
  ).toEqual(names);
});

test("the provider-id pattern is the one credential creation enforces", () => {
  // The Rust check is bytes, not a regex: a lowercase first byte, every byte
  // lowercase/digit/`-`, at most 32. Each clause is pinned separately, and the
  // console regex is held to the same three facts by example.
  const path = "crates/omni-control/src/credentials.rs";
  const check = owned(
    path,
    /(if provider\.len\(\) > \d+[\s\S]*?\{\s*return Err\(Failure::bad\("\(root\): must be a lowercase provider id"\)\);)/,
  );
  const longest = num(owned(path, /if provider\.len\(\) > (\d+)/));
  expect(check).toContain(".is_some_and(|c| c.is_ascii_lowercase())");
  expect(check).toContain(".all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')");

  expect(SAFE_PROVIDER_ID.test("a".repeat(longest))).toBe(true);
  expect(SAFE_PROVIDER_ID.test("a".repeat(longest + 1))).toBe(false);
  expect(SAFE_PROVIDER_ID.test("a1-b")).toBe(true);
  for (const refused of ["", "1a", "-a", "Aa", "a_b", "a.b", "a b", "aé"]) {
    expect({ refused, accepted: SAFE_PROVIDER_ID.test(refused) }).toEqual({
      refused,
      accepted: false,
    });
  }
});

test("every provider the shipped catalog names passes the console's pattern", () => {
  const catalog: unknown = JSON.parse(rust("crates/omni-control/data/provider-catalog.json"));
  if (typeof catalog !== "object" || catalog === null) throw new Error("catalog is not an object");
  const ids = Object.keys(catalog);
  expect(ids.length).toBeGreaterThan(0);
  expect(ids.filter((id) => !SAFE_PROVIDER_ID.test(id))).toEqual([]);
});

test("the client request-log row has the keys the Rust projection emits", () => {
  const block = owned(
    "crates/omni-control/src/logs.rs",
    /fn client_projection[\s\S]*?for key in \[([\s\S]*?)\] \{/,
  );
  const keys = [...block.matchAll(/"(\w+)"/g)].map((m) => m[1] ?? "");
  expect(keys.length).toBeGreaterThan(10);
  expect([...CLIENT_REQUEST_LOG_KEYS].sort()).toEqual([...keys].sort());
});

test("the client quota rows have the keys the Rust readers emit", () => {
  const path = "crates/omni-control/src/client_quota.rs";
  const current = owned(path, /let fields = vec!\[([\s\S]*?)\];/);
  const currentKeys = [...current.matchAll(/^\s*\(?\s*"(\w+)",/gm)].map((m) => m[1] ?? "");
  expect([...ACCOUNT_QUOTA_KEYS].sort()).toEqual([...currentKeys].sort());

  const history = owned(
    path,
    /let mut out = String::from\("\{\\"samples\\":\["\);([\s\S]*?)out\.push\('\}'\);/,
  );
  const historyKeys = [...history.matchAll(/\\"(\w+)\\":/g)].map((m) => m[1] ?? "");
  expect([...ACCOUNT_QUOTA_SAMPLE_KEYS].sort()).toEqual([...historyKeys].sort());
});

test("the quota history envelope carries the two keys the Rust reader writes", () => {
  const source = rust("crates/omni-control/src/client_quota.rs");
  const keys = [
    owned("crates/omni-control/src/client_quota.rs", /String::from\("\{\\"(\w+)\\":\["\)/),
    owned("crates/omni-control/src/client_quota.rs", /"\],\\"(\w+)\\":true\}"/),
  ];
  // Both arms of the `truncated` branch, so neither can be dropped silently.
  expect(source).toContain('"],\\"truncated\\":false}"');
  expect([...CLIENT_QUOTA_HISTORY_RESPONSE_KEYS].sort()).toEqual(keys.sort());
});
