#!/usr/bin/env bun
/**
 * Mutation check of the RTK differential: does `rtk.json.gz` catch a port
 * that diverges from TS in each of the ways the port was hardest to get right?
 *
 *   bun conformance/vectors/rtk-mutants.ts <log-dir>
 *
 * Each mutant replaces one exact snippet in `crates/omni-rtk`, runs
 * `cargo test -p omni-rtk --test differential`, and restores the file. Every
 * mutant must be killed (the differential fails on a parity assertion, not a
 * build error) unless it is listed as `equivalent` with the reason no RTK
 * input can observe it. Writes one full log per mutant plus `summary.json`
 * (source and corpus hashes, exit codes, verdicts); exits non-zero on any
 * surviving non-equivalent mutant, a snippet not found exactly once, or a
 * source file not restored byte-for-byte.
 *
 * Mutates the working tree: run it on a clean tree and commit nothing while
 * it runs. Uses `CARGO_TARGET_DIR=target`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Mutant = {
  name: string;
  file: string;
  from: string;
  to: string;
  /** Set when no RTK input can observe the change; the reason is recorded. */
  equivalent?: string;
};

const RTK = "crates/omni-rtk/src";

const MUTANTS: Mutant[] = [
  // JS regex semantics (jsre.rs).
  {
    name: "dot-matches-js-line-terminators",
    file: `${RTK}/jsre.rs`,
    from: 'const DOT: &str = r"[^\\n\\r\\x{2028}\\x{2029}]";',
    to: 'const DOT: &str = r"[^\\n]";',
  },
  {
    name: "astral-half-is-whitespace",
    file: `${RTK}/jsre.rs`,
    from: "const HALF: char = '\\u{E000}';",
    to: "const HALF: char = ' ';",
  },
  {
    name: "astral-transcoding-skipped",
    file: `${RTK}/jsre.rs`,
    from: "if !text.bytes().any(|b| b >= 0xF0) {",
    to: "if true {",
  },
  {
    name: "unicode-whitespace-class",
    file: `${RTK}/jsre.rs`,
    from: "                    's' => {\n                        out.push('[');\n                        out.push_str(WS);\n                        out.push(']');\n                    }",
    to: "                    's' => {\n                        out.push_str(r\"\\s\");\n                    }",
  },
  {
    name: "unicode-digit-class",
    file: `${RTK}/jsre.rs`,
    from: "'d' => out.push_str(\"[0-9]\"),\n                    'D'",
    to: "'d' => out.push_str(r\"\\d\"),\n                    'D'",
  },
  {
    name: "unicode-word-class",
    file: `${RTK}/jsre.rs`,
    from: "'w' => out.push_str(\"[A-Za-z0-9_]\"),\n                    'W'",
    to: "'w' => out.push_str(r\"\\w\"),\n                    'W'",
    equivalent: "no frozen RTK pattern uses \\w or \\W",
  },
  {
    name: "unicode-word-boundary",
    file: `${RTK}/jsre.rs`,
    from: "'b' => out.push_str(r\"(?-u:\\b)\"),",
    to: "'b' => out.push_str(r\"\\b\"),",
  },
  {
    name: "unicode-case-folding",
    file: `${RTK}/jsre.rs`,
    from: '    Ok(if multiline {\n        format!("(?m:{out})")',
    to: '    let out = if icase { format!("(?i:{out})") } else { out };\n    Ok(if multiline {\n        format!("(?m:{out})")',
  },
  // Detection and naming (lib.rs).
  {
    name: "multiline-probes-see-only-lf",
    file: `${RTK}/lib.rs`,
    from: "let sample = normalize_terminators(&sample);",
    to: "let sample = std::borrow::Cow::<str>::Borrowed(&sample);",
  },
  {
    name: "tool-name-ascii-lowercase",
    file: `${RTK}/lib.rs`,
    from: "let lower = name.to_lowercase();",
    to: "let lower = name.to_ascii_lowercase();",
    equivalent:
      "only U+212A KELVIN SIGN lowercases to an ASCII letter (k) and no shell or non-shell alias contains k",
  },
  {
    name: "input-cap-in-bytes",
    file: `${RTK}/lib.rs`,
    from: "|| utf16_len(&result.content) > MAX_INPUT",
    to: "|| result.content.len() > MAX_INPUT",
  },
  {
    name: "output-guard-in-bytes",
    file: `${RTK}/lib.rs`,
    from: "    let units = utf16_len(&candidate);\n    (units > 0 && units < utf16_len(original)",
    to: "    let units = candidate.len();\n    (units > 0 && units < original.len()",
  },
  // The full-request comparison: a rewrite that touches anything beyond a
  // tool result's text, which the content-only harness let through.
  {
    name: "rewrite-drops-untouched-trailing-message",
    file: `${RTK}/lib.rs`,
    from: "    let mut transformed = request.clone();\n",
    to: "    let mut transformed = request.clone();\n    if transformed.messages.len() > 2 {\n        transformed.messages.pop();\n    }\n",
  },
  {
    name: "rewrite-renames-tool-result-id",
    file: `${RTK}/lib.rs`,
    from: "            block.content = content;\n",
    to: "            block.content = content;\n            block.tool_use_id.push('_');\n",
  },
  {
    name: "rewrite-drops-text-blocks-in-rewritten-message",
    file: `${RTK}/lib.rs`,
    from: "fn apply(message: &mut Message, rewrite: Vec<(usize, String)>) {\n",
    to: "fn apply(message: &mut Message, rewrite: Vec<(usize, String)>) {\n    message.content.retain(|b| !matches!(b, ContentBlock::Text(_)));\n",
  },
  // Commands, filters and budgets.
  {
    name: "command-cap-in-bytes",
    file: `${RTK}/command.rs`,
    from: "if utf16_len(command) > MAX_COMMAND_UNITS",
    to: "if command.len() > MAX_COMMAND_UNITS",
  },
  {
    name: "npm-lowercase-ascii-only",
    file: `${RTK}/filters/packages.rs`,
    from: "let lower = line.to_lowercase();",
    to: "let lower = line.to_ascii_lowercase();",
  },
  {
    name: "package-identity-charge-skipped",
    file: `${RTK}/filters/packages.rs`,
    from: "        if !input.budget.charge_records(1) {\n            return None;\n        }\n        let identity",
    to: "        let identity",
  },
  {
    name: "tree-child-charge-skipped",
    file: `${RTK}/filters/listings.rs`,
    from: "                if !input.budget.charge_records(1) {\n                    return false;\n                }\n                if !retained {",
    to: "                if !retained {",
  },
  {
    name: "gated-path-rust-trim",
    file: `${RTK}/filters/listings.rs`,
    from: "    if line != line.trim_matches(is_js_whitespace) {",
    to: "    if line != line.trim() {",
  },
  {
    name: "listing-entry-quota-off-by-one",
    file: `${RTK}/filters/listings.rs`,
    from: "entry < 6 || entry >= group.entry_count - 6",
    to: "entry < 5 || entry >= group.entry_count - 6",
  },
  {
    name: "scan-row-cap-off-by-one",
    file: `${RTK}/filters/shared.rs`,
    from: "        total <= MAX_ROWS as u64\n",
    to: "        total < MAX_ROWS as u64\n",
  },
];

const logDir = process.argv[2];
if (logDir === undefined) {
  console.error("usage: rtk-mutants.ts <log-dir>");
  process.exit(2);
}
const ROOT = resolve(import.meta.dir, "../..");
mkdirSync(logDir, { recursive: true });

const sha256 = (bytes: string | Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const run = (cmd: string[]) => {
  const result = Bun.spawnSync(cmd, {
    cwd: ROOT,
    env: { ...process.env, CARGO_TARGET_DIR: "target" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
};

const head = run(["git", "rev-parse", "HEAD"]).output.trim();
const dirty = run(["git", "status", "--porcelain", "--", "crates/omni-rtk"]).output.trim();
const corpus = sha256(readFileSync(join(ROOT, "conformance/vectors/rtk.json.gz")));
const files = [...new Set(MUTANTS.map((m) => m.file))].sort();
const sources = Object.fromEntries(files.map((f) => [f, sha256(readFileSync(join(ROOT, f)))]));

const baseline = run(["cargo", "test", "-p", "omni-rtk", "--offline", "--test", "differential"]);
writeFileSync(join(logDir, "00-baseline.log"), baseline.output);
if (baseline.code !== 0) {
  console.error("baseline differential fails; refusing to judge mutants");
  process.exit(1);
}

type Verdict = {
  name: string;
  file: string;
  verdict: string;
  exit: number | null;
  failures: string[];
};
const verdicts: Verdict[] = [];
let bad = false;
MUTANTS.forEach((mutant, n) => {
  const path = join(ROOT, mutant.file);
  const original = readFileSync(path, "utf8");
  const occurrences = original.split(mutant.from).length - 1;
  if (occurrences !== 1) {
    verdicts.push({
      ...mutant,
      verdict: `snippet found ${occurrences}x`,
      exit: null,
      failures: [],
    });
    bad = true;
    return;
  }
  let result: { code: number | null; output: string };
  try {
    writeFileSync(path, original.replace(mutant.from, mutant.to));
    result = run(["cargo", "test", "-p", "omni-rtk", "--offline", "--test", "differential"]);
  } finally {
    writeFileSync(path, original);
  }
  const label = `${String(n + 1).padStart(2, "0")}-${mutant.name}`;
  writeFileSync(
    join(logDir, `${label}.log`),
    `# ${mutant.name}\n# file: ${mutant.file}\n# from:\n${mutant.from}\n# to:\n${mutant.to}\n# exit: ${result.code}\n\n${result.output}`,
  );
  const compiled = !/^error(\[E\d+\])?:/m.test(result.output) || /test result:/.test(result.output);
  const failures = result.output.match(/^\S+: \d+ of \d+ cases diverge from TS:$/gm) ?? [];
  const killed = result.code !== 0 && compiled && failures.length > 0;
  let verdict: string;
  if (!compiled) verdict = "BUILD ERROR (not a kill)";
  else if (killed) verdict = "killed";
  else if (result.code === 0 && mutant.equivalent !== undefined) verdict = "equivalent (survives)";
  else if (result.code === 0) verdict = "SURVIVED";
  else verdict = "FAILED WITHOUT A PARITY DIVERGENCE";
  if (verdict !== "killed" && verdict !== "equivalent (survives)") bad = true;
  if (verdict === "killed" && mutant.equivalent !== undefined) {
    verdict = "killed (listed equivalent: revisit)";
    bad = true;
  }
  verdicts.push({ name: mutant.name, file: mutant.file, verdict, exit: result.code, failures });
  console.log(`${label}: ${verdict} ${failures.join("; ")}`);
});

const restored = Object.fromEntries(files.map((f) => [f, sha256(readFileSync(join(ROOT, f)))]));
for (const f of files)
  if (restored[f] !== sources[f]) {
    console.error(`NOT RESTORED: ${f}`);
    bad = true;
  }

writeFileSync(
  join(logDir, "summary.json"),
  `${JSON.stringify(
    {
      head,
      treeDirty: dirty.length > 0 ? dirty.split("\n") : [],
      corpusSha256: corpus,
      sourceSha256: sources,
      restoredSha256: restored,
      mutants: MUTANTS.map((m, i) => ({ ...m, ...verdicts[i] })),
    },
    null,
    2,
  )}\n`,
);
const killed = verdicts.filter((v) => v.verdict === "killed").length;
const equivalent = verdicts.filter((v) => v.verdict.startsWith("equivalent")).length;
console.log(
  `${killed} killed, ${equivalent} equivalent, ${MUTANTS.length} total; ${bad ? "FAIL" : "ok"}`,
);
process.exit(bad ? 1 : 0);
