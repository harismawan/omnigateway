#!/usr/bin/env bun
/**
 * Source comments that name a symbol this branch removed.
 *
 * **Why this exists.** "A rule stated wrong is one a contributor preserve while
 * breaking the real thing" is the failure CLAUDE.md names more often than any
 * other, and it has been the single most repeated finding in review of this
 * branch: `parseCustomProviderData` in a docblock that never existed,
 * `ctx.provider.register` described in the present tense after its removal,
 * `PluginProviderRegistry` likewise, `install.ts` still stating a collision rule
 * it no longer owns. Each was found by a human reading the file. Each was fixed
 * one at a time, and the next round found another.
 *
 * A blanket "every backticked identifier must exist" check was tried first and
 * abandoned: 232 hits across the tree, led by `null`, `finally` and `TypeError`.
 * Filtering it would need an allowlist, which is the shape CLAUDE.md warns has
 * "exactly the property the thing it check lack".
 *
 * So this asks the narrower question that has signal: **what did this branch
 * remove, and what still talks about it as though it were there?** On the branch
 * it was written for it reports one line and no false positives.
 *
 * Three exclusions, each derived rather than listed:
 *
 * - `docs/` is skipped. Specs record past intent by design, and CLAUDE.md says
 *   to read them as history.
 * - A removed declaration whose name is a registered provider id is not a
 *   removed concept — `const kilo` moving does not stop `kilo` being a provider
 *   that comments may name. The ids come from `descriptors.ts`.
 * - A mention with a history marker near it ("was", "no longer", "replaced"…)
 *   is a deliberate record, which is the thing this repository asks for.
 *
 * Run: `bun run check:claims`. Exits non-zero with the lines to fix.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveBase } from "./lib/history.ts";

const ROOT = join(import.meta.dir, "..");
const git = (...args: string[]): string =>
  execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    // A path that exists at one end and not the other is ordinary here and the
    // caller handles it; git narrating each one would bury the report.
    stdio: ["ignore", "pipe", "ignore"],
  });

const DECL = /\b(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;
const HISTORY =
  /\b(was|were|used to|before|previously|replaced|no longer|until|outlived|started as|had been|once|old|former|removed|renamed|deleted|shipped)\b/i;

/**
 * Comments removed, so prose never counts as a declaration.
 *
 * This ran over raw source at all three sites — the merge-base blob, the HEAD
 * blob, and every tracked file when building `alive` — so any sentence
 * containing `const NAME`, `type NAME` or `function NAME` marked the symbol
 * alive and deleted it from the checked set. One incidental line anywhere in
 * 594 files silently shrank the population, and the report went on printing a
 * confident count. It was already live: `kilo` was alive solely because of a
 * comment, harmless only because it is separately excluded as a provider id.
 *
 * `dead-exports.ts` states this as a general rule — "a source-reading
 * instrument must strip comments before it counts anything" — and this file,
 * the one whose entire subject is comments making false claims about code, was
 * the one that did not follow it.
 */
const code = (raw: string): string =>
  raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

const declared = (source: string): Set<string> =>
  new Set([...code(source).matchAll(DECL)].map(([, name]) => name ?? ""));

const SCRIPT = "check:claims";

/**
 * The base is resolved in `scripts/lib/history.ts`, one copy for both checks.
 *
 * It was inline here and inline in the sibling, and the two drifted under
 * repair: the working-tree fix and the `readable()` guard each landed in one
 * of them. Two of the defects that found were the same sentence written twice.
 */
const resolved = resolveBase(ROOT, SCRIPT);
if (resolved.base === undefined) {
  console.error(resolved.message);
  process.exit(2);
}
const base = resolved.base;
const changed = git("diff", "--name-only", `${base}..HEAD`)
  .split("\n")
  .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));

// Declared at the merge base, gone at HEAD.
const removed = new Set<string>();
for (const file of changed) {
  let before = "";
  try {
    before = git("show", `${base}:${file}`);
  } catch {
    continue; // added on this branch; nothing was removed from it
  }
  let after = "";
  try {
    after = git("show", `HEAD:${file}`);
  } catch {
    after = ""; // deleted outright: everything in it is removed
  }
  const now = declared(after);
  for (const name of declared(before)) if (!now.has(name)) removed.add(name);
}

const tracked = git("ls-files", "*.ts", "*.tsx").split("\n").filter(Boolean);

// Redeclared anywhere else at HEAD means it moved, not that it went.
const alive = new Set<string>();
for (const file of tracked) {
  for (const name of declared(readFileSync(join(ROOT, file), "utf8"))) alive.add(name);
}

const descriptors = readFileSync(join(ROOT, "packages/providers/src/descriptors.ts"), "utf8");
const providerIds = new Set([...descriptors.matchAll(/^ {2}(\w+):\s/gm)].map(([, id]) => id ?? ""));

const gone = [...removed].filter((name) => !alive.has(name) && !providerIds.has(name));

/**
 * The sentence naming `symbol`, reassembled from the comment block it wraps
 * across.
 *
 * Walks out from the matching line while the lines are still comments, strips
 * the leaders, joins, then returns the sentences that mention the symbol. A
 * symbol named twice in one block gets both, joined — if either mention is
 * historical the block is a record, which is the reading that under-reports
 * rather than the one that cries wolf.
 */
function sentenceAround(lines: string[], index: number, symbol: string): string {
  const isComment = (line: string): boolean => {
    const t = line.trimStart();
    return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*");
  };
  let start = index;
  while (start > 0 && isComment(lines[start - 1] ?? "")) start--;
  let end = index;
  while (end < lines.length - 1 && isComment(lines[end + 1] ?? "")) end++;

  const prose = lines
    .slice(start, end + 1)
    .map((line) =>
      line
        .trimStart()
        .replace(/^\/\*+|^\*+\/?|^\/\//, "")
        .trim(),
    )
    .join(" ");

  // Split on sentence ends, keeping abbreviations and decimals intact enough:
  // a period followed by whitespace and a capital or a backtick.
  const sentences = prose.split(/(?<=[.!?])\s+(?=[A-Z`*_])/);
  const naming = sentences.filter((sentence) => sentence.includes(`\`${symbol}\``));
  // A symbol found by the line regex but not by the sentence split means the
  // reassembly lost it; fall back to the whole block rather than reporting a
  // claim whose context could not be read.
  return naming.length > 0 ? naming.join(" ") : prose;
}

const flagged: string[] = [];
for (const file of tracked) {
  if (file.startsWith("docs/")) continue;
  const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
  lines.forEach((line, index) => {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("*") && !trimmed.startsWith("//")) return;
    for (const name of gone) {
      // The backtick must hold the symbol and nothing else, optionally with a
      // call or a member access. `kilo-auto/*` is not a mention of `kilo`.
      const exact = new RegExp(
        `\`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\(\\))?(?:\\.\\w+)*\``,
      );
      if (!exact.test(line)) continue;
      // The **sentence** the symbol sits in, not three lines either side.
      //
      // A line window is the wrong unit in a file of dense historical prose.
      // Measured: over the 24,325 comment lines this check reads, a HISTORY
      // word appeared within +/-3 lines of 8,029 of them — a third of the
      // corpus suppressed, most of it by sentences with nothing to do with the
      // symbol. "`PROVIDER_TONE` is the table the console reads." two lines
      // below "Nothing here was ever cached." was silently dropped.
      //
      // A sentence is the unit the claim is actually made in. "`X` was the
      // table" is history; "`X` is the table. Nothing was cached." is a live
      // claim beside an unrelated past tense, and only the sentence scope tells
      // them apart. Docblocks wrap, so the block is rejoined before splitting.
      if (HISTORY.test(sentenceAround(lines, index, name))) continue;
      flagged.push(
        `${file}:${index + 1}  \`${name}\` was removed on this branch\n    ${trimmed.slice(0, 110)}`,
      );
    }
  });
}

if (flagged.length === 0) {
  console.log(`no stale claims (${gone.length} removed symbols checked)`);
  process.exit(0);
}
console.error(`${flagged.length} comment(s) name a symbol this branch removed:\n`);
for (const line of flagged) console.error(`${line}\n`);
console.error("Either restate it as history, or fix the claim.");
process.exit(1);
