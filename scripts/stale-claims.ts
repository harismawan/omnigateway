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

const declared = (source: string): Set<string> =>
  new Set([...source.matchAll(DECL)].map(([, name]) => name ?? ""));

const base = git("merge-base", "main", "HEAD").trim();
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
        "`" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:\\(\\))?(?:\\.\\w+)*`",
      );
      if (!exact.test(line)) continue;
      // Three lines either side. A docblock states its history in a sentence
      // that often wraps well past the line naming the symbol — narrower, and
      // "as it stood in … before the routing rule started reading" reads as a
      // live claim.
      const window = lines.slice(Math.max(0, index - 3), index + 4).join(" ");
      if (HISTORY.test(window)) continue;
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
