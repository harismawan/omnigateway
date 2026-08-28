import { expect, test } from "bun:test";
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
 * The position list is checked by the **compiler** below, so a new
 * `ContentBlock`-bearing field on `ChatRequest` is a typecheck failure rather
 * than a silently uncovered row. CLAUDE.md's own note on this: "a list of what
 * to check have exactly the property the thing it check lack."
 */

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

/**
 * The position list is checked **by the compiler**, not by reading the type's
 * source text.
 *
 * A first version sliced `request.ts` between two string literals and matched
 * `/^\s{2}(\w+)\??:\s*(.+?);/gm` — a parser written in regex, and it lost to
 * two ordinary spellings. A field long enough for Biome to wrap puts the `;` on
 * a later line, so `bun run fmt` could make a new position invisible; and a
 * field typed through an alias (`preamble?: Preamble` where
 * `Preamble = ContentBlock[]`) never mentions `ContentBlock` at all. Both
 * measured: the one-line and `readonly` forms were caught, those two were not.
 *
 * So the question goes to the thing that already knows the answer.
 * `BlockBearing` maps over `ChatRequest` and keeps the keys a `ContentBlock`
 * can reach, and the assignment below fails `bun run typecheck` — before any
 * test runs — when that set stops being `POSITIONS`. Formatting cannot affect
 * it, aliases resolve, and a new field is a compile error rather than a silent
 * extra row.
 */
type BearsBlocks<V> = [ContentBlock[]] extends [NonNullable<V>]
  ? true
  : NonNullable<V> extends readonly { content: ContentBlock[] }[]
    ? true
    : false;

type BlockBearing = {
  [K in keyof ChatRequest]-?: BearsBlocks<ChatRequest[K]> extends true ? K : never;
}[keyof ChatRequest];

/**
 * Both directions, so neither a new field nor a removed one passes silently.
 * A one-way assignment would accept `POSITIONS` naming a field the type no
 * longer has.
 */
const _positionsCoverTheType: BlockBearing extends Position ? true : false = true;
const _typeCoversThePositions: Position extends BlockBearing ? true : false = true;

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

test("the compiler agrees the position list is complete", () => {
  // The assignments above are the assertion; this makes the failure legible in
  // a test report as well as in `tsc` output, and keeps the constants from
  // reading as unused.
  expect(_positionsCoverTheType).toBe(true);
  expect(_typeCoversThePositions).toBe(true);
  expect([...POSITIONS].sort()).toEqual(["messages", "system"]);
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
