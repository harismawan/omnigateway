import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatRequest, ContentBlock } from "@omni/ir";
import { requiredCapabilities, requiredProviders } from "../src/filters.ts";

/**
 * Every place a `ContentBlock` can sit, against every predicate that reads one.
 *
 * **This is a discovery instrument, not a list of cases.** It exists because
 * fixing a finding at the site a review named, and only there, is this branch's
 * most repeated defect: `requiredProviders` was taught to read `request.system`
 * while `requiredCapabilities` — eleven lines below it, edited in the same
 * commit, reading the same type — went on scanning `messages` alone. An image in
 * a system prompt therefore routed to an `images:false` target with an empty
 * exclusion list, and every encoder dropped it with no degradation recorded.
 *
 * A test per predicate would have had the same blind spot as the fix. So the
 * shape here is a *matrix*: positions × predicates, asserted exhaustively. A
 * predicate that reads one position and not another fails a cell rather than
 * going unnoticed until a review happens to look at the right pair.
 *
 * The position list is checked against the type's own source below, so a new
 * `ContentBlock`-bearing field on `ChatRequest` fails here rather than silently
 * adding a row nothing covers. CLAUDE.md's own note on this: "a list of what to
 * check have exactly the property the thing it check lack."
 */

const IR_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "../../ir/src/request.ts");

/**
 * The fields of `ChatRequest` through which a `ContentBlock` reaches the router.
 *
 * `system` holds them directly; `messages` holds them through `Message.content`.
 * Everything else on the type carries scalars, names, or an opaque bag that
 * belongs to a provider already identified by something else — see the
 * `vendor` note in `requiredProviders`.
 */
const POSITIONS = ["system", "messages"] as const;
type Position = (typeof POSITIONS)[number];

/** Puts one block in one position, on a request that is otherwise empty of them. */
function at(position: Position, block: ContentBlock): ChatRequest {
  const base: ChatRequest = {
    model: "fast",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    stream: true,
  };
  return position === "system"
    ? { ...base, system: [block] }
    : { ...base, messages: [{ role: "user", content: [block] }] };
}

const IMAGE: ContentBlock = { type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" };
const NATIVE: ContentBlock = {
  type: "providerNative",
  provider: "acme",
  blockType: "acme_lookup",
  data: { id: "srv_1" },
};

test("the position list matches what ChatRequest actually declares", () => {
  // Read from the type's own source, so adding a `ContentBlock[]` field to
  // `ChatRequest` fails here rather than quietly creating a position no
  // predicate is checked against. The alternative — a hand-kept list — is the
  // thing this file exists to stop being.
  const source = readFileSync(IR_SOURCE, "utf8");
  const body = source.slice(
    source.indexOf("export type ChatRequest = {"),
    source.indexOf("\n};", source.indexOf("export type ChatRequest = {")),
  );
  expect(body).not.toBe("");

  const declared = [...body.matchAll(/^\s{2}(\w+)\??:\s*(.+?);/gm)].map(([, name, type]) => ({
    name: name ?? "",
    type: type ?? "",
  }));
  expect(declared.length).toBeGreaterThan(5);

  // `Message[]` counts: `Message.content` is `ContentBlock[]`.
  const bearing = declared
    .filter(({ type }) => type.includes("ContentBlock") || type.includes("Message[]"))
    .map(({ name }) => name);

  expect(bearing.sort()).toEqual([...POSITIONS].sort());
});

test("every predicate that reads blocks reads every position", () => {
  // The matrix. Each cell is "predicate P notices block B in position X", and a
  // predicate that scans one position and not the other fails exactly one cell.
  const cells: { predicate: string; check: (r: ChatRequest) => boolean; block: ContentBlock }[] = [
    {
      predicate: "requiredProviders",
      block: NATIVE,
      check: (r) => requiredProviders(r).has("acme"),
    },
    {
      predicate: "requiredCapabilities.images",
      block: IMAGE,
      check: (r) => requiredCapabilities(r).images,
    },
  ];

  const missed: string[] = [];
  for (const { predicate, check, block } of cells) {
    for (const position of POSITIONS) {
      if (!check(at(position, block))) missed.push(`${predicate} does not read ${position}`);
    }
  }

  expect(missed).toEqual([]);
});

test("a request with no such block reads clean in every position", () => {
  // The positive control the matrix needs: a predicate that answered `true`
  // unconditionally would satisfy every cell above.
  const text: ContentBlock = { type: "text", text: "ordinary" };
  for (const position of POSITIONS) {
    expect(requiredProviders(at(position, text)).size).toBe(0);
    expect(requiredCapabilities(at(position, text)).images).toBe(false);
  }
});
