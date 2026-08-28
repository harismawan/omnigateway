import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every command that reads the plugin registry must report what it could not
 * read — on stderr *and* in its payload.
 *
 * **A discovery instrument, not a list of three commands.** `pluginProviders`
 * imports each plugin's module, and a plugin that throws, hangs, or exports
 * nothing usable makes its provider absent. Absent is exactly the state that
 * produces the symptom an operator sees — a missing context limit, a
 * `provider:missing` row, a refused id — so a command that swallows the failure
 * reports the consequence with the cause deleted. That is the bug this area was
 * opened for, and it has been re-introduced twice: once by fixing only
 * `dry-run`'s stderr, and once by giving `dry-run` a `pluginFailures` payload
 * and not `setup` or `add-key` in the same commit.
 *
 * `note()` is the trap. It is `if (!ctx.json) writer.err(message)`, so a command
 * reporting only through it is silent under `--json` — the format a provisioning
 * script reads, and the one where a silent omission survives longest.
 *
 * So this reads the sources rather than exercising each command: it finds every
 * file that calls `pluginProviders` and asserts each one both prints the
 * failures and puts them in what it emits. A behavioural test per command has
 * the blind spot the fixes had — it covers the command it names and says nothing
 * about the next one. Same instrument as `packages/store/test/swap.test.ts`,
 * which reads the swap forwarder's source for the same reason.
 */

const COMMANDS = join(dirname(fileURLToPath(import.meta.url)), "../src/commands");

/**
 * The unit is the **file**, not the function.
 *
 * A first version scoped to the enclosing function and immediately flagged
 * `setup.ts`'s `described()`, which reads the registry and prints the failures
 * while `finish()` puts them in the payload — a correct split that a
 * function-scoped rule reads as a violation. Narrowing further would mean
 * teaching the instrument to follow a return value, which is a parser; the file
 * asks the question that actually matters, which is whether a command reading
 * the registry says anything at all about what it could not read.
 */
const FILES = ["models.ts", "setup.ts", "credentials.ts", "plugins.ts", "service.ts"];

test("every command reading the plugin registry reports what it could not read", () => {
  const reading = FILES.map((file) => ({
    file,
    source: readFileSync(join(COMMANDS, file), "utf8"),
  })).filter(({ source, file }) =>
    // `plugins.ts` defines `pluginProviders`; its callers are what this is about.
    file === "plugins.ts" ? false : /pluginProviders\(/.test(source),
  );

  // The instrument has to have found something, or "every caller reports" is
  // vacuously true — which is how a discovery test goes quiet. Stated as the
  // exact set so a *new* caller fails here rather than joining unchecked.
  expect(reading.map((r) => r.file).sort()).toEqual(["credentials.ts", "models.ts", "setup.ts"]);

  /**
   * Comments are stripped before matching, and the reason is this file's own
   * subject matter.
   *
   * A mutant deleting `pluginFailures` from `add-key`'s payload survived,
   * because the comment above that call still said the word. An instrument
   * written to catch "the code no longer does what a comment claims" was
   * reading a comment as evidence about the code.
   */
  const code = (raw: string): string =>
    raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

  const silent = reading.filter((entry) => {
    const source = code(entry.source);
    // Destructured at the call site — a caller that drops `failures` there
    // cannot report them however much it prints elsewhere.
    const takes = /\{\s*descriptors,\s*failures\s*\}\s*=\s*await pluginProviders\(/.test(source);
    // On stderr, for a person reading a terminal.
    const prints = /note\([\s\S]{0,200}?failure\.reason/.test(source);
    // And in the payload, for a script. Matched **inside an `emit(` call**, not
    // anywhere in the file: a file-wide grep was satisfied by `finish`'s own
    // parameter declaration, so removing the field from what is emitted
    // survived. The word existing is not the field shipping.
    const emits = /emit\([\s\S]{0,300}?pluginFailures/.test(source);
    return !takes || !prints || !emits;
  });

  expect(silent.map((entry) => entry.file)).toEqual([]);
});
