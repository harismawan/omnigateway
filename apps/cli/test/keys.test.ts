import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import type { LimitConfig } from "@omni/store";
import { cli, makeRoot, openStore } from "./helpers/harness.ts";

type ListedKey = { id: string; label: string; limits: LimitConfig | null };

async function limitsOf(root: string, label: string): Promise<LimitConfig | null> {
  const listed = await cli(["keys", "list", "--json"], { root });
  const body = JSON.parse(listed.out) as { keys: ListedKey[] };
  const key = body.keys.find((entry) => entry.label === label);
  if (key === undefined) throw new Error(`no key labelled ${label}`);
  return key.limits;
}

test("--limit sets one pair, and the flag repeats to build the matrix", async () => {
  const root = makeRoot();
  const created = await cli(
    [
      "keys",
      "create",
      "--label",
      "ci",
      "--limit",
      "requests:1m=60",
      "--limit",
      "tokens:1w=50000000",
      "--limit",
      "spend:1w=25.5",
      "--limit",
      "concurrency=8",
      "--json",
    ],
    { root },
  );
  expect(created.code).toBe(0);
  expect(await limitsOf(root, "ci")).toEqual({
    requests: { "1m": 60 },
    tokens: { "1w": 50_000_000 },
    spend: { "1w": 25.5 },
    concurrency: 8,
  });
  (await openStore(root)).close();
});

test("a key created with no --limit is unlimited, and minting stays a one-flag operation", async () => {
  const root = makeRoot();
  expect((await cli(["keys", "create", "--label", "plain", "--json"], { root })).code).toBe(0);
  expect(await limitsOf(root, "plain")).toEqual({});
  (await openStore(root)).close();
});

test("--rate-limit is removed outright rather than aliased", async () => {
  // A script passing it fails immediately with an unknown flag rather than
  // silently taking a deprecated path. One syntax for limits, no second
  // spelling to keep working, document, and test.
  const root = makeRoot();
  const result = await cli(["keys", "create", "--label", "old", "--rate-limit", "60"], { root });
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("rate-limit");
});

test("a misspelled dimension or window is refused rather than dropped", async () => {
  const root = makeRoot();
  for (const bad of ["request:1m=60", "requests:2m=60", "spend:1m=5"]) {
    const result = await cli(["keys", "create", "--label", "bad", "--limit", bad], { root });
    expect(result.code).not.toBe(0);
  }
  // Nothing was minted on the way past the refusals.
  const listed = await cli(["keys", "list", "--json"], { root });
  expect((JSON.parse(listed.out) as { keys: ListedKey[] }).keys).toHaveLength(0);
});

test("a malformed --limit names the flag rather than failing somewhere downstream", async () => {
  const root = makeRoot();
  for (const bad of ["requests:1m", "requests=60", "requests:1m=lots", "=60"]) {
    const result = await cli(["keys", "create", "--label", "bad", "--limit", bad], { root });
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("--limit");
  }
});

test("concurrency takes no window, and a windowed dimension requires one", async () => {
  const root = makeRoot();
  expect(
    (await cli(["keys", "create", "--label", "a", "--limit", "concurrency:1m=8"], { root })).code,
  ).not.toBe(0);
  expect(
    (await cli(["keys", "create", "--label", "b", "--limit", "requests=8"], { root })).code,
  ).not.toBe(0);
});

test("keys list prints limits in the syntax the flag accepts", async () => {
  const root = makeRoot();
  await cli(["keys", "create", "--label", "ci", "--limit", "requests:1m=60", "--json"], { root });
  await cli(["keys", "create", "--label", "plain", "--json"], { root });

  const listed = await cli(["keys", "list"], { root });
  expect(listed.out).toContain("requests:1m=60");
  // A key with no limits reads as a dash, not as a blank cell.
  expect(listed.out).toContain("—");
});

/**
 * The listing is how an operator finds the row to fix, so it has to survive it.
 *
 * A dash is already spoken for — it means "no limits configured" in this column
 * and "defers to the installation setting" in the next — so an unreadable row
 * gets a word rather than a glyph that reads as unlimited.
 */
test("an unreadable limits column is named, and costs no other key its row", async () => {
  const root = makeRoot();
  await cli(["keys", "create", "--label", "ci", "--limit", "requests:1m=60", "--json"], { root });
  await cli(["keys", "create", "--label", "meddled", "--json"], { root });

  // Hand-edited, because that is the only way the row exists: `keys create`
  // validates on the way in and refuses a shape no reader could parse.
  const db = new Database(join(root, "omnigateway.db"));
  db.run(`UPDATE api_keys SET limits = '{"bandwidth":{"1m":5}}' WHERE label = 'meddled'`);
  db.close();

  const listed = await cli(["keys", "list"], { root });
  expect(listed.code).toBe(0);
  expect(listed.out).toContain("unreadable");
  expect(listed.out).toContain("ci");
  expect(listed.out).toContain("requests:1m=60");

  // And the same through `--json`, which is what a script reads.
  expect(await limitsOf(root, "meddled")).toBeNull();
  expect(await limitsOf(root, "ci")).toEqual({ requests: { "1m": 60 } });
});
