import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import type { LimitConfig } from "@omni/store";
import { requestLog } from "@omni/testkit";
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

type LimitsOutput = {
  id: string;
  limits: LimitConfig | null;
  limitUsage: Array<{
    dimension: string;
    window: string | null;
    limit: number;
    used: number | null;
  }>;
};

async function idOf(root: string, label: string): Promise<string> {
  const listed = await cli(["keys", "list", "--json"], { root });
  const body = JSON.parse(listed.out) as { keys: ListedKey[] };
  const key = body.keys.find((entry) => entry.label === label);
  if (key === undefined) throw new Error(`no key labelled ${label}`);
  return key.id;
}

test("keys limits shows the configured matrix and what has gone against it", async () => {
  const root = makeRoot();
  await cli(
    [
      "keys",
      "create",
      "--label",
      "ci",
      "--limit",
      "requests:1w=100",
      "--limit",
      "spend:1w=25",
      "--limit",
      "concurrency=8",
      "--json",
    ],
    { root },
  );
  const id = await idOf(root, "ci");

  // Two completed requests inside the week, so the reading has something to
  // report other than zero — a matrix of zeros passes whether or not the sum
  // ever looked at the window.
  const store = await openStore(root);
  for (const [index, cost] of [2.5, 1.25].entries()) {
    await store.usage.append(
      requestLog({ id: `r${index}`, apiKeyId: id, at: Date.now() - 60_000, costUsd: cost }),
    );
  }
  store.close();

  const shown = await cli(["keys", "limits", id], { root });
  expect(shown.code).toBe(0);
  expect(shown.out).toContain("requests");
  expect(shown.out).toContain("100");
  expect(shown.out).toContain("$25.00");
  // A gauge held in the gateway process, which this one is not. Zero would tell
  // an operator beside a saturated gateway that nothing is in flight.
  expect(shown.out).toContain("concurrency");

  const json = JSON.parse(
    (await cli(["keys", "limits", id, "--json"], { root })).out,
  ) as LimitsOutput;
  expect(json.limitUsage).toEqual([
    { dimension: "requests", window: "1w", limit: 100, used: 2 },
    { dimension: "spend", window: "1w", limit: 25, used: 3.75 },
    { dimension: "concurrency", window: null, limit: 8, used: null },
  ]);
});

test("--set adds a pair and --unset removes one, leaving the rest alone", async () => {
  const root = makeRoot();
  await cli(
    [
      "keys",
      "create",
      "--label",
      "ci",
      "--limit",
      "requests:1m=60",
      "--limit",
      "spend:5h=5",
      "--json",
    ],
    { root },
  );
  const id = await idOf(root, "ci");

  const edited = await cli(
    ["keys", "limits", id, "--set", "tokens:1w=50000000", "--unset", "spend:5h", "--json"],
    { root },
  );
  expect(edited.code).toBe(0);
  expect(await limitsOf(root, "ci")).toEqual({
    requests: { "1m": 60 },
    tokens: { "1w": 50_000_000 },
  });
});

test("--set replaces an existing pair rather than adding a second spelling of it", async () => {
  const root = makeRoot();
  await cli(["keys", "create", "--label", "ci", "--limit", "requests:1m=60", "--json"], { root });
  const id = await idOf(root, "ci");

  await cli(["keys", "limits", id, "--set", "requests:1m=120", "--json"], { root });
  expect(await limitsOf(root, "ci")).toEqual({ requests: { "1m": 120 } });
});

/**
 * The last limit going away has to leave `{}` rather than a husk of the matrix
 * that was there. `{}` is a key with no ceilings; `null` is a key the gateway
 * refuses because it cannot read them, and the two must not be reachable from
 * one another by an edit.
 */
test("unsetting the last limit leaves the key unlimited rather than broken", async () => {
  const root = makeRoot();
  await cli(["keys", "create", "--label", "ci", "--limit", "requests:1m=60", "--json"], { root });
  const id = await idOf(root, "ci");

  const cleared = await cli(["keys", "limits", id, "--unset", "requests:1m"], { root });
  expect(cleared.code).toBe(0);
  expect(cleared.out).toContain("no limits configured");
  expect(await limitsOf(root, "ci")).toEqual({});
});

test("--unset names a pair the key does not have rather than reporting a change it did not make", async () => {
  const root = makeRoot();
  await cli(["keys", "create", "--label", "ci", "--limit", "requests:1m=60", "--json"], { root });
  const id = await idOf(root, "ci");

  const missing = await cli(["keys", "limits", id, "--unset", "spend:5h"], { root });
  expect(missing.code).not.toBe(0);
  expect(missing.err).toContain("spend:5h");
  // A typo must not be a silent success either.
  const typo = await cli(["keys", "limits", id, "--unset", "requsts:1m"], { root });
  expect(typo.code).not.toBe(0);
  expect(await limitsOf(root, "ci")).toEqual({ requests: { "1m": 60 } });
});

test("a misspelled --set is refused by the same schema --limit answers to", async () => {
  const root = makeRoot();
  await cli(["keys", "create", "--label", "ci", "--limit", "requests:1m=60", "--json"], { root });
  const id = await idOf(root, "ci");

  for (const bad of ["request:1m=60", "requests:2m=60", "spend:1m=5", "requests:1m=0"]) {
    const result = await cli(["keys", "limits", id, "--set", bad], { root });
    expect(result.code).not.toBe(0);
  }
  expect(await limitsOf(root, "ci")).toEqual({ requests: { "1m": 60 } });
});

/**
 * An unreadable column is a key the gateway refuses at `/v1`. Merging onto a
 * value no reader can parse would drop whatever the operator meant without
 * saying so, so `--set` replaces it outright and `--unset` has nothing to work
 * from.
 */
test("an unreadable matrix can be replaced by --set but not edited by --unset", async () => {
  const root = makeRoot();
  await cli(["keys", "create", "--label", "meddled", "--json"], { root });
  const id = await idOf(root, "meddled");

  const db = new Database(join(root, "omnigateway.db"));
  db.run(`UPDATE api_keys SET limits = '{"bandwidth":{"1m":5}}' WHERE id = ?`, [id]);
  db.close();

  const shown = await cli(["keys", "limits", id], { root });
  expect(shown.out).toContain("unreadable");

  const refused = await cli(["keys", "limits", id, "--unset", "requests:1m"], { root });
  expect(refused.code).not.toBe(0);
  expect(await limitsOf(root, "meddled")).toBeNull();

  const repaired = await cli(["keys", "limits", id, "--set", "requests:1m=60"], { root });
  expect(repaired.code).toBe(0);
  expect(await limitsOf(root, "meddled")).toEqual({ requests: { "1m": 60 } });
});
