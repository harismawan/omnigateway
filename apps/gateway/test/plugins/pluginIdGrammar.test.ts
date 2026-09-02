/**
 * The four restatements of the provider-id grammar, pinned to the one that owns it.
 *
 * `PROVIDER_ID_PATTERN` lives in `@omni/providers` and decides what may name a
 * provider. Four other modules write the same expression out by hand to decide
 * what may name a *plugin*:
 *
 * - `packages/plugin-api/src/manifest.ts` — published, so it may not import an
 *   `@omni/*` package at all; a single one puts an unresolvable `workspace:*`
 *   into a stranger's dependency tree.
 * - `packages/store/src/sqlite/plugins.ts` — the id becomes a SQL identifier
 *   here, and a validation living only in the caller is one a future caller
 *   forgets.
 * - `apps/gateway/src/plugins/routes.ts` — the id becomes a URL path segment by
 *   concatenation, one unvalidated call site away from `/api/plugins/../keys`.
 * - `packages/control/src/plugins.ts` — judges path segments that never went
 *   through the manifest schema and never will.
 *
 * **The copies are not a mistake and merging them would be one.** A plugin id and
 * a provider id are different things that happen to share a grammar: a plugin
 * without the `provider` capability names no provider, and three of the four
 * sites above validate ids that have no provider anywhere near them. Importing
 * `PROVIDER_ID_PATTERN` for those would assert an equivalence that is false.
 *
 * What is *not* allowed any more is drift, and that changed when a plugin gained
 * the `provider` capability. **A plugin-supplied provider's id is a plugin id and
 * a provider id at once** — `validateRegistration` requires `descriptor.id` to
 * equal the manifest id — so the two grammars now describe one string. Were the
 * plugin grammar wider, a plugin would install and its provider would be refused,
 * with the refusal naming a pattern the operator never wrote. Were it narrower,
 * provider ids would exist that no plugin could ever claim.
 *
 * The design that deferred this
 * (`docs/superpowers/specs/2026-08-28-plugin-provider-capability-design.md`)
 * listed it as the one gap of its three still open, asking that at least one copy
 * be pinned. All four are, because a list of three unpinned copies has exactly
 * the property the thing it describes lacks.
 *
 * It lives in `apps/gateway` for the reason `limitVocabulary.test.ts` and
 * `providerIdMirror.test.ts` do: this is the only place that may import every one
 * of them.
 *
 * **Behaviour rather than source equality, and that is a real weakening.**
 * `providerIdMirror.test.ts` compares `.source` because two patterns can agree on
 * every input a test thinks to try and disagree on the one an attacker does. It
 * can, because the console exports its copy. These four do not, and exporting a
 * module-private constant so a test may read it would widen a published package's
 * surface to hold a test's hand. So this file drives each copy through the public
 * function that consults it and compares verdicts over a shared corpus — which is
 * also the stronger question in one direction: it fails if a site stops consulting
 * its pattern at all, which source equality would not notice.
 *
 * Direction matters. `PROVIDER_ID_PATTERN` is the source of truth. A failure here
 * means a mirror is stale, and the fix is the mirror — never widening the pattern
 * to match it.
 */

import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginDeps, PluginFs } from "@omni/control";
import { verifyPlugin } from "@omni/control";
import { PROVIDER_ID_PATTERN } from "@omni/providers/descriptors";
import { createPluginRepo, openDb } from "@omni/store";
import { safeParseManifest } from "@omnigateway/plugin-api";
import { mountPath } from "../../src/plugins/routes.ts";

/**
 * The ids every copy is asked about.
 *
 * Written from the shapes that decide something rather than from the pattern —
 * a corpus derived from the expression under test can only confirm it. The
 * boundary lengths are here because `{0,31}` is the clause a hand-copied regex
 * gets wrong silently, and `constructor` because the pattern accepts it: it is a
 * valid id and a prototype key, which is a different trap in the same string,
 * guarded elsewhere.
 */
const CORPUS = [
  "anthropic",
  "acme-ai",
  "poke-dex",
  "a",
  "a1",
  "constructor",
  "__proto__",
  "a".repeat(32),
  "a".repeat(33),
  "",
  "Anthropic",
  "1acme",
  "-acme",
  "acme_ai",
  "acme ai",
  "acme.ai",
  "acme/ai",
  "..",
  ".",
  "acme..ai",
  "acme%2e%2e",
  'acme"ai',
  "acme'ai",
  "acme;drop",
  "acme\nai",
  "acme\u0000ai",
] as const;

/** A directory that always exists, so `verifyPlugin`'s only other refusal cannot fire. */
const presentFs: PluginFs = {
  readdir: () => [],
  readText: () => null,
  readBytes: () => null,
  writeBytes: () => {},
  isDirectory: () => true,
  isFile: () => false,
  mkdir: () => {},
  rm: () => {},
  rename: () => {},
};

const controlDeps: PluginDeps = { fs: presentFs };

const roots: string[] = [];

function tempDb(): Database {
  const root = mkdtempSync(join(tmpdir(), "omni-plugin-id-"));
  roots.push(root);
  return openDb(join(root, "omnigateway.db"));
}

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const db = tempDb();
const pluginRepo = createPluginRepo(db);

/**
 * Each copy, asked the only question this file cares about: is this id allowed?
 *
 * Every judge drives the *public* function that consults the pattern, so a site
 * that stopped consulting it fails here rather than passing a comparison of two
 * regexes neither of which is read.
 */
const JUDGES: Readonly<Record<string, (id: string) => boolean | Promise<boolean>>> = {
  "plugin-api manifest": (id) =>
    safeParseManifest({ id, name: "n", version: "1.0.0", api: 1, server: "index.ts" }).ok,

  "gateway route mount": (id) => mountPath(id, "/") !== null,

  "store table prefix": async (id) => {
    try {
      await pluginRepo.migrate(id, []);
      return true;
    } catch {
      // `assertPluginId` is the only thing an empty migration list can throw
      // over: there is no SQL to expand, no table to name and no statement to run.
      return false;
    }
  },

  "control path segment": (id) => {
    try {
      verifyPlugin(controlDeps, "/root", id);
      return true;
    } catch (error) {
      // Narrowed to the refusal this file is about. `reportFor` runs on every id
      // the pattern admits and is allowed to fail its own way; swallowing that
      // would report a broken `verifyPlugin` as a stale mirror.
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith("no plugin ")) throw error;
      return false;
    }
  },
};

describe("the plugin-id grammar mirrors the provider-id grammar", () => {
  test("the corpus decides something in both directions", () => {
    // The control, first, because a corpus every copy refuses satisfies every
    // assertion below while testing nothing. Same reason `changed.test.ts` opens
    // with a no-edit case.
    const accepted = CORPUS.filter((id) => PROVIDER_ID_PATTERN.test(id));
    expect(accepted.length).toBeGreaterThan(0);
    expect(accepted.length).toBeLessThan(CORPUS.length);
  });

  for (const [site, judge] of Object.entries(JUDGES)) {
    test(`${site} admits exactly the ids a provider may be named`, async () => {
      for (const id of CORPUS) {
        // The id is carried into the assertion so a failure names the string
        // rather than reporting that `false` was not `true`.
        expect([id, await judge(id)]).toEqual([id, PROVIDER_ID_PATTERN.test(id)]);
      }
    });
  }
});
