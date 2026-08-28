#!/usr/bin/env bun
/**
 * Runtime values this branch exported and nothing references.
 *
 * The sibling of `stale-claims.ts`, for the case that check cannot see: a symbol
 * that still *exists* but has no caller, with a docblock going on describing the
 * caller it lost. `providerLoadable` was exactly that — `add-key` moved to
 * reading the real registry, the strict manifest predicate it had used became
 * unreferenced, and three comments in two other files went on naming it as the
 * thing that guards writes. Nothing failed; the code simply said something that
 * was no longer true, which is the failure CLAUDE.md names most often.
 *
 * **Comments are stripped first, and that is the finding rather than a detail.**
 * A first version did not, and `providerLoadable` did not appear — its only three
 * references were the very comments that made it worth reporting. That is the
 * third instrument in this area to read comment text as evidence about code
 * (`pluginFailures.test.ts` and the publish-drift check were the others), so it
 * is worth stating as a rule: a source-reading instrument must strip comments
 * before it counts anything.
 *
 * Three narrowings, each of which removed real noise rather than inconvenient
 * truth. Measured on this branch: 146 hits unscoped, 28 after them, 1 real.
 *
 * - **Runtime values only** (`function`, `const`). Exported *types* are consumed
 *   structurally and dominate the noise — `ConfirmProps` has no importer and is
 *   not dead.
 * - **Used nowhere, including its own file.** `PLUGIN_IMPORT_TIMEOUT_MS` and
 *   `isFingerprintRefusal` are exported and used one line down; `export` on them
 *   is redundant, not dead.
 * - **Touched by this branch.** 28 pre-existing hits cannot be a failing check,
 *   and cleaning them is somebody's deliberate decision, not this script's.
 *
 * Run: `bun run check:dead`. Exits non-zero with what to delete.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/**
 * Comments removed, so a mention in prose never counts as a reference.
 *
 * **Trailing comments too**, and that was a real hole: `/^\s*\/\/.*$/gm` only
 * reaches a `//` at the start of a line, so `foo(); // \`providerLoadable\`
 * guards writes` counted as a reference. This script exists *because*
 * `providerLoadable`'s only three references were comments — respell any one of
 * them as trailing and the symbol it was written for goes invisible again.
 *
 * A `//` inside a string is left alone: the pattern requires whitespace or a
 * line start before it and no quote since. Imperfect and deliberately so —
 * over-stripping deletes code and produces a false *positive*, which is the
 * direction that gets a check deleted.
 */
const code = (raw: string): string =>
  raw
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

/**
 * Every declaration form that names a runtime value.
 *
 * `function` and `const` alone missed `class`, `let`, `var` and
 * `export default function` — four spellings of the same thing, each
 * unreportable. Types stay out on purpose: they are consumed structurally and
 * dominate the noise (146 hits unscoped, against 28 for values).
 */
const EXPORT =
  /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;

/**
 * Names too ordinary to search for by word.
 *
 * `\bname\b` over every file answers "is this English word written anywhere",
 * not "is this symbol referenced". An export called `reason`, `code` or `note`
 * is permanently unreportable, and reporting it on a coincidence would be
 * worse. Rather than guess, these are reported as **unknown** — named in the
 * output, excluded from the failure — so the gap is visible instead of silent.
 */
const COMMON = new Set([
  "base",
  "body",
  "code",
  "data",
  "entry",
  "error",
  "file",
  "id",
  "index",
  "input",
  "item",
  "key",
  "line",
  "list",
  "log",
  "name",
  "note",
  "output",
  "path",
  "reason",
  "result",
  "row",
  "state",
  "status",
  "text",
  "type",
  "url",
  "value",
]);

const SCRIPT = "check:dead";

/**
 * Both checks compare against `main`, so a repository without it cannot answer.
 *
 * Refuses rather than skipping, and says what to do. A silent skip is what the
 * publish-drift guard did, and the review found it inert in CI for exactly that
 * reason — a skipped check and a passing check produce the same green. Failing
 * with an instruction is recoverable in one command; failing with an uncaught
 * `git merge-base` stack, which is what this did, reads as "the new check is
 * broken" and is how a check gets deleted.
 */
function requireHistory(): void {
  const shallow = git("rev-parse", "--is-shallow-repository").trim() === "true";
  let hasMain = true;
  try {
    // `execFileSync` with stderr inherited would print git's own `fatal:` line
    // just above the explanation below, which is the noise this replaces.
    execFileSync("git", ["rev-parse", "--verify", "main"], {
      cwd: ROOT,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    hasMain = false;
  }
  if (shallow || !hasMain) {
    console.error(
      `${SCRIPT}: needs full history and a \`main\` ref, and this checkout has ` +
        `${shallow ? "a shallow clone" : "no `main`"}.\n` +
        "  locally:  git fetch --unshallow origin main\n" +
        "  in CI:    actions/checkout@v5 with fetch-depth: 0",
    );
    process.exit(2);
  }
}

requireHistory();

const base = git("merge-base", "main", "HEAD").trim();
// `base` alone, not `base..HEAD`: the two-dot form compares commits, so a file
// you have edited but not committed is absent from `touched` and never checked.
// That made the check answer "no dead exports" for work in progress — and made
// every probe of it silently vacuous, which is how this was found. Diffing the
// base against the working tree covers what you are about to commit as well as
// what you already did.
const touched = new Set(
  git("diff", "--name-only", base)
    .split("\n")
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx")),
);

const files = git("ls-files", "*.ts", "*.tsx").split("\n").filter(Boolean);
/**
 * A tracked file that is not on disk is skipped, not fatal.
 *
 * `git ls-files` lists the index, and the index outlives a deletion: mid-rebase,
 * after a manual `rm`, or with an intent-to-add entry whose file has gone, the
 * read throws and the whole check dies with a stack. Found by a probe that hit
 * exactly that state — and a check that crashes on an ordinary working-tree
 * condition is one that gets removed rather than fixed.
 */
const readable = (file: string): string | undefined => {
  try {
    return readFileSync(join(ROOT, file), "utf8");
  } catch {
    return undefined;
  }
};

const sources = new Map(
  files.flatMap((f) => {
    const raw = readable(f);
    return raw === undefined ? [] : [[f, code(raw)] as const];
  }),
);

const dead: string[] = [];
const unknown: string[] = [];
for (const [file, source] of sources) {
  // A test's exports are its own business, and this script is not a subject.
  if (file.includes("/test") || file.includes(".test.") || file.startsWith("scripts/")) continue;
  if (!touched.has(file)) continue;

  for (const [, name] of source.matchAll(EXPORT)) {
    if (name === undefined) continue;
    // Before the search, not after it. A common word is always "referenced"
    // somewhere by coincidence, so `elsewhere` is true and the branch below was
    // unreachable — a guard that read as coverage and could not fire. Asking
    // first is what makes the gap visible.
    if (COMMON.has(name)) {
      unknown.push(`${file}: \`${name}\` — too common a word to search by`);
      continue;
    }

    const word = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    const elsewhere = [...sources].some(([other, text]) => other !== file && word.test(text));
    // More than one occurrence in its own file means the declaration plus a use.
    const ownUses = source.match(new RegExp(word.source, "g"))?.length ?? 0;
    if (!elsewhere && ownUses <= 1) {
      dead.push(`${file}: \`${name}\` is exported and referenced nowhere`);
    }
  }
}

// Printed either way: an unreportable export is a thing to know about, and
// swallowing it is how the gap becomes invisible rather than merely open.
for (const line of unknown) console.log(`unchecked  ${line}`);

if (dead.length === 0) {
  console.log(`no dead exports (${touched.size} changed files checked)`);
  process.exit(0);
}
console.error(`${dead.length} export(s) this branch added or changed have no reference:\n`);
for (const line of dead) console.error(`  ${line}`);
console.error("\nDelete it, or say in its docblock why it is kept.");
process.exit(1);
