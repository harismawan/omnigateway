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

/** Comments removed, so a mention in prose never counts as a reference. */
const code = (raw: string): string =>
  raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

const EXPORT = /^export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z_$][\w$]*)/gm;

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
const touched = new Set(
  git("diff", "--name-only", `${base}..HEAD`)
    .split("\n")
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx")),
);

const files = git("ls-files", "*.ts", "*.tsx").split("\n").filter(Boolean);
const sources = new Map(files.map((f) => [f, code(readFileSync(join(ROOT, f), "utf8"))]));

const dead: string[] = [];
for (const [file, source] of sources) {
  // A test's exports are its own business, and this script is not a subject.
  if (file.includes("/test") || file.includes(".test.") || file.startsWith("scripts/")) continue;
  if (!touched.has(file)) continue;

  for (const [, name] of source.matchAll(EXPORT)) {
    if (name === undefined) continue;
    const word = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    const elsewhere = [...sources].some(([other, text]) => other !== file && word.test(text));
    // More than one occurrence in its own file means the declaration plus a use.
    const ownUses = source.match(new RegExp(word.source, "g"))?.length ?? 0;
    if (!elsewhere && ownUses <= 1) {
      dead.push(`${file}: \`${name}\` is exported and referenced nowhere`);
    }
  }
}

if (dead.length === 0) {
  console.log(`no dead exports (${touched.size} changed files checked)`);
  process.exit(0);
}
console.error(`${dead.length} export(s) this branch added or changed have no reference:\n`);
for (const line of dead) console.error(`  ${line}`);
console.error("\nDelete it, or say in its docblock why it is kept.");
process.exit(1);
