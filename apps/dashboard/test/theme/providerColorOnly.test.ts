/**
 * `providerColor` is the only place a provider id becomes a custom-property
 * reference, and this is what makes that true rather than aspirational.
 *
 * The function carries a long comment about being the one path from a stored
 * string into the stylesheet, and it was not: `ModelTraffic.tsx` wrote
 * `` `var(--p-${provider})` `` into a styled-components interpolation,
 * `ActivityTail.tsx` wrote the same shape into an inline `style`, and
 * `ModelsBoard.tsx`'s `Pip` wrote it into a `background`. All three are read
 * paths — `target.provider` comes back through `sqlite/config.ts`'s bare
 * `JSON.parse` and `log.resolvedProvider` off a request row — so none meets
 * `providerIdSchema`, and styled-components does not escape what it is handed.
 * An id closing the declaration and opening its own puts attacker-authored rules
 * in the console's sheet.
 *
 * Written as a source read rather than a behavioural test on purpose. The defect
 * is not that a particular component renders the wrong colour — all three
 * rendered correctly for every id anyone would type — it is that the guard was
 * bypassable by not calling it, and nothing that renders a component can see
 * that. This can: a fourth site written next month fails here on the day it is
 * written.
 *
 * The third one is why this is a test and not a `grep` anybody could re-run.
 * `ModelsBoard.tsx` holds a NUL byte — the sentinel `"\0new"` standing in for
 * the compose-a-new-model slot, an id no model can have — and grep classifies a
 * file containing one as binary and reports nothing for it, without saying so
 * under `-n`. Two separate sweeps for `var(--p-` had already missed that site.
 * `Bun.Transpiler` has no such rule.
 *
 * Comments are stripped before matching rather than exempted by path.
 * `GlobalStyle.ts` mentions `var(--p-unknown)` in prose explaining why the
 * palette must mount before the first provider-coloured element, and an
 * allowlist wide enough to forgive that sentence is one that would also forgive
 * a real construction site in the same file.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sourceFiles } from "../../../../scripts/lib/imports.ts";

const SRC = resolve(import.meta.dir, "../../src");
const TOKENS = resolve(SRC, "theme/tokens.ts");

/**
 * `source` with comments removed and everything else intact.
 *
 * The transpiler rather than a regex: a hand-rolled stripper has to know what a
 * string, a template literal and a regex literal look like, and one that gets
 * any of those wrong deletes real code — which here means a construction site
 * disappearing from the very check meant to find it. Strings and templates
 * survive this, verified below.
 */
function withoutComments(file: string): string {
  const loader = file.endsWith(".tsx") ? "tsx" : "ts";
  return new Bun.Transpiler({ loader }).transformSync(readFileSync(file, "utf8"));
}

describe("references to a provider custom property", () => {
  const files = sourceFiles(SRC);

  test("the walk found the console", () => {
    // The control. Every assertion below is "this list is empty", and an empty
    // glob satisfies all of them without reading a line of the console.
    expect(files.length).toBeGreaterThan(30);
    expect(files).toContain(TOKENS);
  });

  test("only tokens.ts builds one", () => {
    const built = files
      .filter((file) => file !== TOKENS)
      .filter((file) => withoutComments(file).includes("var(--p-"))
      .map((file) => file.slice(SRC.length + 1));
    expect(built).toEqual([]);
  });

  test("tokens.ts still builds one, so the match is not simply never hit", () => {
    // The other control, and the one that catches a stripper that ate too much:
    // a `withoutComments` returning "" would report no violations anywhere.
    expect(withoutComments(TOKENS)).toContain("var(--p-");
  });

  test("a mention in prose is stripped and a value in a template is not", () => {
    // Pins the decision the docstring argues for. `GlobalStyle.ts` is the file
    // that made it necessary: it names the property in a comment and writes the
    // *declaration* — `--p-${id}` — which is a different string and guarded on
    // the server, by `packages/control/src/catalog.ts`.
    const globalStyle = resolve(SRC, "theme/GlobalStyle.ts");
    expect(readFileSync(globalStyle, "utf8")).toContain("var(--p-");
    expect(withoutComments(globalStyle)).not.toContain("var(--p-");
    expect(withoutComments(globalStyle)).toContain("--p-${");
  });
});
