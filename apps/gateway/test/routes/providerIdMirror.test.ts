/**
 * The console's provider-id pattern, pinned to the providers package's.
 *
 * `apps/dashboard/src/theme/tokens.ts` declares `SAFE_PROVIDER_ID` itself rather
 * than importing `PROVIDER_ID_PATTERN`. It has to: boundary rule 12 forbids the
 * console importing `@omni/providers` at all, not even the leaf subpaths, because
 * a provider loaded from `<root>/plugins/` exists only at runtime and a console
 * that imports its providers can route to one while showing it nowhere. The copy
 * is deliberate. This file is what keeps it honest.
 *
 * It lives in `apps/gateway` because this is the only place that may import both,
 * the same reason and the same shape as
 * `apps/gateway/test/plugins/limitVocabulary.test.ts`.
 *
 * Direction matters. `PROVIDER_ID_PATTERN` is the source of truth — it decides
 * what may be stored, what `packages/control` will serve, and what may become a
 * `plugin_<id>_` table prefix. A failure here means the console's mirror is
 * stale, and the fix is to update the mirror, never to widen the pattern to
 * match it.
 *
 * CLAUDE.md records that four other restatements of this expression exist with
 * nothing pinning any of them. This is the first that is pinned, and it is the
 * one whose drift is a security question rather than a compatibility one: the
 * console's copy decides whether a stored string reaches a stylesheet.
 */

import { describe, expect, test } from "bun:test";
import { PROVIDER_ID_PATTERN } from "@omni/providers/descriptors";
import { providerColor, SAFE_PROVIDER_ID } from "../../../dashboard/src/theme/tokens.ts";

describe("the console's provider-id pattern", () => {
  test("is the same expression the providers package validates with", () => {
    // `source` and not behaviour alone: two patterns can agree on every input a
    // test thinks to try and disagree on the one an attacker does.
    expect(SAFE_PROVIDER_ID.source).toBe(PROVIDER_ID_PATTERN.source);
    expect(SAFE_PROVIDER_ID.flags).toBe(PROVIDER_ID_PATTERN.flags);
  });

  test("agrees with it on the ids that decide whether CSS is written", () => {
    // The behavioural half, over the shapes that matter rather than the shapes
    // the pattern happens to be written from. `constructor` is here because
    // `PROVIDER_ID_PATTERN` accepts it — it is a valid id and a prototype key,
    // which is a different trap in the same string, guarded elsewhere.
    const cases = [
      "anthropic",
      "acme-ai",
      "a",
      "constructor",
      "a".repeat(32),
      "a".repeat(33),
      "",
      "Anthropic",
      "1acme",
      "-acme",
      "acme_ai",
      "acme ai",
      "acme;color:red",
      "a); } body { background: red; } .x {",
      "a}",
      "a/*",
      "a\\",
      "a\nb",
    ];
    for (const id of cases) {
      expect([id, SAFE_PROVIDER_ID.test(id)]).toEqual([id, PROVIDER_ID_PATTERN.test(id)]);
    }
  });

  test("nothing the pattern refuses reaches the stylesheet", () => {
    // The consequence, asserted at the function rather than at the regex: a
    // mirror that matches and a `providerColor` that does not consult it would
    // pass the two tests above and still write the string into CSS.
    for (const hostile of [
      "a); } body { background: red; } .x {",
      "acme;color:red",
      "a}",
      "a/*",
      "",
      "Anthropic",
    ]) {
      expect(providerColor(hostile)).toBe("var(--ink-faint)");
    }
  });

  test("an ordinary id still gets its own hue, with a neutral fallback", () => {
    // The positive control. A `providerColor` that refused everything would
    // satisfy the test above while painting the whole console grey.
    expect(providerColor("anthropic")).toBe("var(--p-anthropic, var(--ink-faint))");
    expect(providerColor("acme-ai")).toBe("var(--p-acme-ai, var(--ink-faint))");
  });
});
