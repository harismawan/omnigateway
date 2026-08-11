import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import type { RtkFilterId } from "../src/catalog.ts";
import { transformRequest } from "../src/index.ts";

function run(command: string, lines: readonly string[], name = "bash") {
  const input: ChatRequest = {
    model: "fast",
    stream: false,
    messages: [
      { role: "assistant", content: [{ type: "toolUse", id: "x", name, input: { command } }] },
      {
        role: "user",
        content: [{ type: "toolResult", toolUseId: "x", content: lines.join("\n") }],
      },
    ],
  };
  const output = transformRequest(input, { enabled: true });
  const block = output.request.messages[1]?.content[0];
  if (block?.type !== "toolResult") throw new Error("expected tool result");
  return { input, output, content: block.content, original: lines.join("\n"), lines };
}

// Same block with no correlated tool use at all, so origin is unknown and only output-shape
// inference can classify it. This is the capability Task 1 must leave untouched.
function runOrphan(lines: readonly string[]) {
  const input: ChatRequest = {
    model: "fast",
    stream: false,
    messages: [
      {
        role: "user",
        content: [{ type: "toolResult", toolUseId: "orphan", content: lines.join("\n") }],
      },
    ],
  };
  const output = transformRequest(input, { enabled: true });
  const block = output.request.messages[0]?.content[0];
  if (block?.type !== "toolResult") throw new Error("expected tool result");
  return { output, content: block.content, original: lines.join("\n"), lines };
}

const MARKER = /^\.\.\. (\d+) ([^\n]*?) omitted \.\.\.$/;

function omittedTotal(content: string): number {
  let total = 0;
  for (const line of content.split("\n")) {
    const match = MARKER.exec(line);
    if (match !== null) total += Number(match[1] ?? "0");
  }
  return total;
}

function retainedRows(content: string): number {
  return content.split("\n").filter((line) => !MARKER.test(line)).length;
}

function expectCompressed(fixture: ReturnType<typeof run>, id: RtkFilterId) {
  expect(fixture.output.report.applied).toBe(true);
  expect(fixture.output.report.filters).toContain(id);
  expect(fixture.content.length).toBeLessThan(fixture.original.length);
}

// The five documents the round-18 anchor set hijacked into the Git-diff retainer, each read through
// a generic-read command. All are ordinary files whose rows happen to start with a space, a `-`, or
// a `+`; the diff anchors matched them, retention collapsed from ~145 rows to ~28, and the middle of
// each document was destroyed. With classification owning the family they are plain numbered reads.
// Each document quotes a short patch — a `git diff` example in a chart README, a diff in a crash
// report, a shell patch in a runbook. That is the pair of independent diff anchors the detector
// needs; the round-18 "leading space" context-row alternative then matched the document's own body
// rows, pushed density over the gate, and handed all five to the Git-diff retainer.
function quotedPatch(path: string): string[] {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,2 +1,2 @@"];
}

function yamlValues(): string[] {
  const lines = ["# values.yaml for the gateway chart", ...quotedPatch("values.yaml")];
  for (let index = 0; index < 250; index++)
    lines.push(`  limitEntry${index}: "the important configured value number ${index}"`);
  return lines;
}

function javaStackTrace(): string[] {
  const lines = [
    'Exception in thread "main" java.lang.IllegalStateException: broken',
    ...quotedPatch("Frame.java"),
  ];
  for (let index = 0; index < 250; index++)
    lines.push(`    at com.example.gateway.Frame${index}.invoke(Frame${index}.java:${index + 10})`);
  return lines;
}

function markdownWithCodeBlock(): string[] {
  const lines = ["# Runbook", ...quotedPatch("runbook.sh"), "Indented code block follows:", ""];
  for (let index = 0; index < 250; index++)
    lines.push(`    const importantRunbookStep${index} = "operator action ${index}";`);
  return lines;
}

function treeText(): string[] {
  const lines = ["packages/", ...quotedPatch("tree.txt")];
  for (let index = 0; index < 250; index++)
    lines.push(` |-- module-${index}/  containing the important source file ${index}`);
  return lines;
}

function pipeTable(): string[] {
  const lines = [
    " | Setting | Default | Description |",
    ...quotedPatch("settings.md"),
    " |---|---|---|",
  ];
  for (let index = 0; index < 250; index++)
    lines.push(` | option${index} | off | the important documented behaviour ${index} |`);
  return lines;
}

const HIJACK_FIXTURES: ReadonlyArray<{
  readonly name: string;
  readonly command: string;
  readonly lines: string[];
  readonly middle: string;
}> = [
  {
    name: "a YAML values file",
    command: "cat charts/gateway/values.yaml",
    lines: yamlValues(),
    middle: '  limitEntry90: "the important configured value number 90"',
  },
  {
    name: "a Java stack trace",
    command: "cat /tmp/crash.log",
    lines: javaStackTrace(),
    middle: "    at com.example.gateway.Frame90.invoke(Frame90.java:100)",
  },
  {
    name: "Markdown with an indented code block",
    command: "cat docs/RUNBOOK.md",
    lines: markdownWithCodeBlock(),
    middle: '    const importantRunbookStep90 = "operator action 90";',
  },
  {
    name: "a tree listing saved as text",
    command: "sed -n 1,400p tree.txt",
    lines: treeText(),
    middle: " |-- module-90/  containing the important source file 90",
  },
  {
    name: "a one-space-indented pipe table",
    command: "cat docs/settings.md",
    lines: pipeTable(),
    middle: " | option90 | off | the important documented behaviour 90 |",
  },
];

describe("nineteenth audit: generic reads are never hijacked by Git output shape", () => {
  for (const fixture of HIJACK_FIXTURES)
    test(`${fixture.name} read with a generic-read command stays a numbered read`, () => {
      const result = run(fixture.command, fixture.lines);
      expectCompressed(result, "numbered-read");
      expect(result.output.report.filters).not.toContain("git-diff");
      expect(result.output.report.filters).not.toContain("git-log");
      expect(result.output.report.filters).not.toContain("git-status");
      // A numbered read keeps a 100-row head and a 50-row tail. The Git retainer keeping only its
      // own anchors is what collapsed these documents to roughly 28 rows.
      expect(retainedRows(result.content)).toBe(150);
      expect(result.content).toContain(fixture.middle);
      expect(result.content).toContain(fixture.lines[0] ?? "");
      expect(result.content).toContain(fixture.lines[fixture.lines.length - 1] ?? "");
      expect(omittedTotal(result.content)).toBe(fixture.lines.length - 150);
    });

  test("prose quoting a diff hunk still stays a numbered read", () => {
    // The round-16 case, now trivial: the command classified, so nothing else is consulted.
    const lines = [
      "# Release notes",
      "diff --git a/deploy.sh b/deploy.sh",
      "--- a/deploy.sh",
      "+++ b/deploy.sh",
      "@@ -10,6 +10,6 @@",
    ];
    for (let index = 0; index < 300; index++)
      lines.push(`IMPORTANT MIDDLE NOTE ${index}: operators must rotate the key.`);
    const fixture = run("cat docs/RELEASE.md", lines);
    expectCompressed(fixture, "numbered-read");
    expect(fixture.output.report.filters).not.toContain("git-diff");
    expect(omittedTotal(fixture.content)).toBe(
      fixture.lines.length - retainedRows(fixture.content),
    );
  });
});

describe("nineteenth audit: unknown-origin Git inference is unchanged", () => {
  test("an uncorrelated diff still infers git-diff and keeps every changed row", () => {
    const lines = ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts"];
    for (let hunk = 0; hunk < 40; hunk++) {
      lines.push(`@@ -${hunk * 10 + 1},4 +${hunk * 10 + 1},4 @@`);
      lines.push(`   context row before hunk ${hunk} carrying no marker at all`);
      lines.push(`-const removedCritical${hunk} = ${hunk};`);
      lines.push(`+const addedCritical${hunk} = ${hunk};`);
      lines.push(`   context row after hunk ${hunk} carrying no marker at all`);
    }
    const fixture = runOrphan(lines);
    expect(fixture.output.report.applied).toBe(true);
    expect(fixture.output.report.filters).toContain("git-diff");
    expect(fixture.content.length).toBeLessThan(fixture.original.length);
    for (let hunk = 0; hunk < 40; hunk++) {
      expect(fixture.content).toContain(`-const removedCritical${hunk} = ${hunk};`);
      expect(fixture.content).toContain(`+const addedCritical${hunk} = ${hunk};`);
    }
  });

  test("an uncorrelated status block still infers git-status", () => {
    const lines = ["On branch main", "Changes not staged for commit:"];
    lines.push('  (use "git add <file>..." to update what will be committed)');
    for (let index = 0; index < 60; index++) {
      lines.push(`\tmodified:   packages/module-${index}/src/index.ts`);
      lines.push("");
    }
    lines.push('no changes added to commit (use "git add" and/or "git commit -a")');
    const fixture = runOrphan(lines);
    expect(fixture.output.report.applied).toBe(true);
    expect(fixture.output.report.filters).toContain("git-status");
    expect(fixture.content.length).toBeLessThan(fixture.original.length);
    for (let index = 0; index < 60; index++)
      expect(fixture.content).toContain(`\tmodified:   packages/module-${index}/src/index.ts`);
  });

  test("the same YAML with no command still infers git-diff, exactly as before", () => {
    // Deliberately pinning the asymmetry rather than hiding it. This is the same document the
    // correlated case above proves is no longer hijacked; with no command there is nothing to own
    // the block, so the two independent diff anchors it quotes are the only signal available and
    // shape inference claims it. That behaviour predates this change and is left untouched — the
    // fix is scoped strictly to blocks a command already classified.
    const fixture = runOrphan(yamlValues());
    expect(fixture.output.report.filters).toContain("git-diff");
  });
});

// The durable invariant three rounds violated in a row: the detector's anchor is also the retainer's
// anchor, so no row can be counted as Git evidence and then silently dropped. Over a generated
// corpus of Git-shaped blocks, every anchor-matching row is either present in the output or covered
// by an omission marker whose stated counts equal the real number of dropped rows.
// Non-anchor bulk the retainer is allowed to collapse. Without it a block is 100% anchor rows, the
// candidate cannot be strictly shorter, and the acceptance guard correctly rejects it — which would
// make the invariant vacuous rather than prove it.
function filler(count: number, label: string): string[] {
  return Array.from({ length: count }, (_, index) => `   ${label} context row ${index}`);
}

function generatedDiffCorpus(): string[][] {
  const corpus: string[][] = [];
  // Rename-only patch: 400 `rename` rows, the exact case measured at 12 kept.
  const renames = ["diff --git a/old/a0.ts b/new/a0.ts", "--- a/old/a0.ts", "+++ b/new/a0.ts"];
  for (let index = 0; index < 200; index++) {
    renames.push(`rename from packages/old/module-${index}.ts`);
    renames.push(`rename to packages/new/module-${index}.ts`);
  }
  corpus.push([...renames, ...filler(120, "rename")]);
  // Binary patch: 150 `Binary files … differ` rows, measured at 8 kept.
  const binary = ["diff --git a/assets/i0.png b/assets/i0.png", "--- a/assets/i0.png"];
  binary.push("+++ b/assets/i0.png");
  for (let index = 0; index < 150; index++)
    binary.push(`Binary files a/assets/image-${index}.png and b/assets/image-${index}.png differ`);
  corpus.push([...binary, ...filler(120, "binary")]);
  // Mode, index, and similarity rows interleaved with unmarked context that may be collapsed.
  const modes = ["diff --git a/src/m.ts b/src/m.ts", "@@ -1,2 +1,2 @@"];
  for (let index = 0; index < 120; index++) {
    modes.push(`old mode 100644`);
    modes.push(`new mode 100755`);
    modes.push(`index ${index.toString(16).padStart(7, "0")}..${index}bbbbbb 100644`);
    modes.push(`similarity index ${index % 100}%`);
    modes.push(`   plain context row ${index} that carries no anchor whatsoever`);
  }
  corpus.push(modes);
  corpus.push([...conflictedMergeCorpus(), ...filler(120, "conflict")]);
  corpus.push([...octopusCorpus(), ...filler(120, "octopus")]);
  corpus.push([...binaryPatchCorpus(), ...filler(120, "binary-patch")]);
  corpus.push([...wideOctopusCorpus(5, 3), ...filler(120, "octopus-5")]);
  corpus.push([...wideOctopusCorpus(6, 3), ...filler(120, "octopus-6")]);
  corpus.push([...wideOctopusCorpus(8, 2), ...filler(120, "octopus-8")]);
  return corpus;
}

// Transcribed from `git diff` in a scratch repository during a real conflicted merge: 12 files
// edited on both sides, `git merge` left every path unmerged, and plain `git diff` printed combined
// grammar for all of them. Counts are deliberately asymmetric — 7 conflicted files, 21 OURS rows,
// 14 THEIRS rows, 7 `diff --cc` headers, 7 `@@@` hunk headers — so a loss on one side cannot be
// cancelled by an equal gain on the other in the stated omission total. The pre-fix measurement on
// the 12-file version of this exact output: 10/12 `diff --cc`, 9/12 `@@@`, 10/12 combined `index`
// and 30/36 OURS rows dropped, against 0/36 THEIRS rows.
function conflictedMergeCorpus(): string[] {
  const lines: string[] = [];
  for (let index = 0; index < 7; index++) {
    lines.push(`diff --cc conflicted-${index}.txt`);
    lines.push(`index 78bce4f,45d560${index}..0000000`);
    if (index === 2) lines.push("mode 100644,100755..100644");
    lines.push(`--- a/conflicted-${index}.txt`);
    lines.push(`+++ b/conflicted-${index}.txt`);
    lines.push(`@@@ -${index * 10 + 1},3 -${index * 10 + 1},3 +${index * 10 + 1},9 @@@`);
    lines.push("++<<<<<<< HEAD");
    lines.push(` +OURS-${index}-alpha`);
    lines.push(` +OURS-${index}-beta`);
    lines.push(` +OURS-${index}-gamma`);
    lines.push("++=======");
    lines.push(`+ THEIRS-${index}-alpha`);
    if (index < 7) lines.push(`+ THEIRS-${index}-gamma`);
    lines.push("++>>>>>>> theirs");
    lines.push(`   shared context row ${index} present in both parents`);
  }
  return lines;
}

// Transcribed from `git show -c` on a real three-parent octopus merge: the header is
// `diff --combined`, the hunk header carries four `@` characters, and content rows carry three
// prefix columns (`---a`, `+++THREEWAY`, `   b`).
function octopusCorpus(): string[] {
  const lines: string[] = [];
  for (let index = 0; index < 9; index++) {
    lines.push(`diff --combined octopus-${index}.txt`);
    lines.push(`index de9804${index},de9804${index},de9804${index}..4d0dc1f`);
    lines.push(`--- a/octopus-${index}.txt`);
    lines.push(`+++ b/octopus-${index}.txt`);
    lines.push(`@@@@ -${index + 1},3 -${index + 1},3 -${index + 1},3 +${index + 1},3 @@@@`);
    lines.push(`---removed-from-every-parent-${index}`);
    lines.push(`+++THREEWAY-RESOLUTION-${index}`);
    lines.push(`   unchanged tail row ${index}`);
  }
  return lines;
}

// Transcribed byte-for-byte from `git diff -c HEAD^!` on real octopus merges built in scratch
// repositories with `git commit-tree -p <base> -p b1 … -p bN`. The generator below reproduces the
// observed layout exactly, so `wideOctopusCorpus(5, 3)` equals the captured 5-parent output and
// `wideOctopusCorpus(6, 3)` the 6-parent one:
//
//     diff --combined file0.txt
//     index 57a68f1,1641557,a69d707,fc8c8d8,df0b721,8acb920..5fe71e7
//     --- a/file0.txt
//     +++ b/file0.txt
//     @@@@@@@ -5,4 -5,5 -5,5 -5,5 -5,5 -5,5 +5,9 @@@@@@@ BASE-
//           BASE-5
//     -     BASE-8
//      ---- SHARED-BY-EARLY-0
//          -ONLY-IN-LAST-0
//     ++++++MERGED-0
//     + ++++TIP-1-0
//     +++++ TIP-5-0
//
// Every content row carries exactly PARENTS columns and the `@` run is PARENTS+1. The two rows
// `     -ONLY-IN-LAST-0` and ` ---- SHARED-BY-EARLY-0` are the two removed sides of one hunk, and a
// four-column production bound dropped both while keeping the hunk header that claims they exist.
function wideOctopusCorpus(parents: number, files: number): string[] {
  const lines: string[] = [];
  const column = (marked: number): string =>
    Array.from({ length: parents }, (_, index) => (index === marked ? "-" : " ")).join("");
  for (let file = 0; file < files; file++) {
    const hashes = Array.from({ length: parents }, (_, index) => `${index}${file}bcdef`).join(",");
    lines.push(`diff --combined file${file}.txt`);
    lines.push(`index ${hashes}..a${file}00000`);
    lines.push(`--- a/file${file}.txt`);
    lines.push(`+++ b/file${file}.txt`);
    const at = "@".repeat(parents + 1);
    const ranges = Array.from({ length: parents }, () => "-5,5").join(" ");
    lines.push(`${at} -5,4 ${ranges} +5,${parents + 3} ${at} BASE-`);
    for (let row = 5; row <= 7; row++) lines.push(`${" ".repeat(parents)}BASE-${row}`);
    // Removed from the base only: marker in the first column.
    lines.push(`-${" ".repeat(parents - 1)}BASE-8`);
    // Removed from parents 2..N-1: an interior run of markers.
    lines.push(
      ` ${"-".repeat(Math.max(1, parents - 2))}${parents > 2 ? " " : ""}SHARED-BY-EARLY-${file}`,
    );
    // Removed from the LAST parent only: the marker sits in the final column, which is exactly the
    // column a bound sized for the `@` run rejects.
    lines.push(`${column(parents - 1)}ONLY-IN-LAST-${file}`);
    lines.push(`${"+".repeat(parents)}MERGED-${file}`);
    for (let tip = 1; tip <= parents; tip++)
      lines.push(
        `${"+".repeat(tip - 1)} ${"+".repeat(parents - tip)}TIP-${tip}-${file}`.replace(/ +$/, " "),
      );
  }
  return lines;
}

// Transcribed from `git diff --binary`: each changed blob prints `GIT binary patch`, a forward
// `literal N` row, base85 payload, a blank row, the reverse `literal N`/`delta N` row, and more
// payload. The payload is legitimate bulk and may collapse; the markers may not, because without
// them the output claims only the text file changed.
function binaryPatchCorpus(): string[] {
  const lines: string[] = [];
  for (let index = 0; index < 6; index++) {
    lines.push(`diff --git a/asset-${index}.bin b/asset-${index}.bin`);
    lines.push(`index 553605b${index}..928a0e1${index} 100644`);
    lines.push("GIT binary patch");
    lines.push(`literal ${900 + index}`);
    for (let row = 0; row < 14; row++)
      lines.push(`zcmV-~1AF{HFCiR!Xi~8ETUD!L@sG2Rx9+VT+jsMLy5+@cgXR$(b_i1nu&cZ6Ls${index}${row}`);
    lines.push("");
    lines.push(index % 2 === 0 ? `literal ${800 + index}` : `delta ${80 + index}`);
    for (let row = 0; row < 9; row++)
      lines.push(`zv?9}2^wtlQOD4W6i<hkko~1_r@MWzsZU<oDS))pVj%rsw-DGD\`Shk6Xu${index}${row}`);
    lines.push("");
  }
  return lines;
}

function generatedLogCorpus(): string[][] {
  const corpus: string[][] = [];
  // `git log --format=fuller`: 40 `AuthorDate:`/`CommitDate:` rows, measured at 4 kept.
  const fuller: string[] = [];
  for (let index = 0; index < 40; index++) {
    fuller.push(`commit ${index.toString(16).padStart(40, "0")}`);
    fuller.push("Author:     Example Developer <developer@example.com>");
    fuller.push("AuthorDate: Mon Aug 10 19:43:18 2026 +0700");
    fuller.push("Commit:     Example Maintainer <maintainer@example.com>");
    fuller.push("CommitDate: Tue Aug 11 08:02:00 2026 +0700");
    fuller.push("");
    fuller.push(`    subject line for commit number ${index} in the fuller format`);
    fuller.push("");
  }
  corpus.push([...fuller, ...filler(120, "fuller")]);
  // Merge trailers, reflog selectors, tags, and stat rows in one block.
  const decorated: string[] = [];
  for (let index = 0; index < 40; index++) {
    decorated.push(`commit ${index.toString(16).padStart(40, "0")}`);
    decorated.push(`Merge: ${index}aaaaaa ${index}bbbbbb`);
    decorated.push(`Reflog: HEAD@{${index}} (Example Developer <developer@example.com>)`);
    decorated.push(`Tag: v1.${index}.0`);
    decorated.push("Author: Example Developer <developer@example.com>");
    decorated.push("Date:   Mon Aug 10 19:43:18 2026 +0700");
    decorated.push("");
    decorated.push(`    subject line for decorated commit ${index}`);
    decorated.push(` packages/module/src/file-${index}.ts | ${index % 9} +++--`);
    decorated.push(" 1 file changed, 3 insertions(+), 2 deletions(-)");
    decorated.push("");
  }
  corpus.push([...decorated, ...filler(120, "decorated")]);
  corpus.push(abbreviatedLogCorpus());
  return corpus;
}

// `git log --abbrev-commit --abbrev=4 --decorate` with bodies that indent themselves. Every header
// is four hex characters, every bullet sits at six spaces and every snippet at eight, so a `{7,}`
// hash floor or a ` {4}\S` body rule drops them while `Author:` still routes the block to the log
// retainer. Deliberately asymmetric: 17 headers, 23 bullets, 11 snippets and 5 tab-rendered rows, so
// no pair of opposing losses can cancel in the stated omission total.
function abbreviatedLogCorpus(): string[] {
  const lines: string[] = [];
  for (let index = 0; index < 17; index++) {
    lines.push(
      `commit ${index.toString(16).padStart(4, "0")}${index === 3 ? " (HEAD -> main, tag: v1.0)" : ""}`,
    );
    lines.push("Author: Example Developer <developer@example.com>");
    lines.push("Date:   Mon Aug 10 19:43:18 2026 +0700");
    lines.push("");
    lines.push(`    fix(area${index}): abbreviated subject ${index}`);
    lines.push("");
    lines.push("    Rationale:");
    lines.push(`      - first critical bullet ${index}`);
    if (index < 6) lines.push(`      - second critical bullet ${index}`);
    if (index < 11) lines.push(`        indentedCodeSnippet${index}();`);
    if (index < 5) lines.push(`    \ttab rendered body line ${index}`);
    lines.push(`    Refs: #${index}`);
    lines.push("");
  }
  return [...lines, ...filler(120, "abbrev")];
}

// The grammar below is written out here on purpose and is NOT imported from `src/filters/git.ts`.
// The previous version of this test imported the production anchors and then asserted that every row
// they matched was retained — but the retainer selects rows with those same symbols, so the demanded
// set equalled the selected set by construction and the assertion could never fail. Reverting the
// production anchors to a narrower set left the test green while rename, binary, mode and log-stat
// rows silently vanished. These literals are an independent statement of what a Git diff/log row is,
// taken from git's own output forms, so narrowing the production anchors now fails the test.
// Restated from what `git` was observed to print, not from the production fragments. The forms were
// enumerated by running real commands in scratch repositories and reading every distinct row prefix:
//
//   `git diff` during a conflicted 2-parent merge  -> `diff --cc F`, `index <hex>,<hex>..<hex>`,
//        `mode <oct>,<oct>..<oct>`, `--- a/F`, `+++ b/F`, `@@@ -1,3 -1,3 +1,9 @@@`, and content rows
//        carrying one prefix column PER PARENT: ` +ours`, `+ theirs`, `++<<<<<<< HEAD`, `  shared`.
//   `git diff -c HEAD^!` on real 3-, 5-, 6- and 7-parent octopus merges built with
//        `git commit-tree -p …`  -> `diff --combined F`, `index <h>,…,<h>..<h>`, a hunk header whose
//        `@` run is PARENTS+1 (`@@@@@@@ -7,4 … +7,10 @@@@@@@@` for seven parents), and content rows
//        carrying exactly PARENTS columns: ` ---- SHARED`, `     -ONLY-IN-LAST`, `++++ +TIP-4`.
//   `git diff --binary`                            -> `GIT binary patch`, `literal 900`, `delta N`,
//        then base85 payload rows, which are genuine bulk and are NOT claimed here.
//
// The previous version of this literal enumerated the content column as one-to-four columns, which
// is character-for-character `[ +-]{0,3}[-+]` — the production form transcribed longhand, not an
// independent claim — and its comment justified that with the false rule "N parents means N+1
// columns". It therefore agreed with production's off-by-one in both directions and could not see
// it. The two runs are restated below directly from the observed output and deliberately UNBOUNDED
// (`[ +-]*[-+]` for content, `@@+ ` for the header), because git itself imposes no parent limit.
// A production anchor narrower than git's real grammar now fails the invariant at whatever width it
// stops. Payload rows are excluded on purpose: the invariant claims the markers that say a binary
// file changed, not the encoded bytes underneath them.
const DIFF_DOCUMENT_ROW =
  /^(?:diff --(?:git|cc|combined) |--- |\+\+\+ |@@+ |index [0-9a-f]+(?:,[0-9a-f]+)*\.\.|mode [0-7]+(?:,[0-7]+)*\.\.|(?:old|new|new file|deleted file) mode |(?:similarity|dissimilarity) index |(?:rename|copy) (?:from|to) |Binary files |GIT binary patch$|(?:literal|delta) \d+$|\\ No newline|[ +-]*[-+]| .+files? changed)/;
// `commit [0-9a-f]{4,}` and ` {4}[ \t]*\S` are what git really prints, and both were wider than the
// production fragments: `--abbrev=4..6` and `core.abbrev=4` print four-to-six-character hashes, and
// a commit body's own indentation is additive on top of git's four spaces, so bullets land at six
// and snippets at eight. The narrower literals here agreed with the narrower production anchors, so
// the invariant could not see either loss.
const LOG_DOCUMENT_ROW =
  /^(?:commit [0-9a-f]{4,}|Author:|AuthorDate:|Commit:|CommitDate:|Date:|Merge: |Reflog:|Tag:| {4}[ \t]*\S| \S.*\|\s+\d+| .+files? changed)/;

// A `git log --stat` block: the per-file stat rows name the files the roll-up counts. Dropping them
// leaves output that states "2 files changed" while naming neither file.
function statLogCorpus(): string[] {
  const lines: string[] = [];
  for (let index = 0; index < 40; index++) {
    lines.push(`commit ${index.toString(16).padStart(40, "0")}`);
    lines.push("Author: Example Developer <developer@example.com>");
    lines.push("Date:   Mon Aug 10 19:43:18 2026 +0700");
    lines.push("");
    lines.push(`    subject line for stat commit ${index}`);
    lines.push("");
    lines.push(` apps/gateway/src/critical-file-${index}.ts | ${index + 2} ++++++++-----`);
    lines.push(` packages/store/src/schema-${index}.ts      | ${(index % 7) + 1} +++--`);
    lines.push(" 2 files changed, 9 insertions(+), 4 deletions(-)");
    lines.push("");
  }
  return [...lines, ...filler(120, "stat")];
}

describe("nineteenth audit: every detected Git anchor row survives retention", () => {
  const cases: ReadonlyArray<{
    label: string;
    command: string;
    id: RtkFilterId;
    row: RegExp;
    blocks: string[][];
  }> = [
    {
      label: "git diff",
      command: "git diff",
      id: "git-diff",
      row: DIFF_DOCUMENT_ROW,
      blocks: generatedDiffCorpus(),
    },
    {
      label: "git log",
      command: "git log",
      id: "git-log",
      row: LOG_DOCUMENT_ROW,
      blocks: [...generatedLogCorpus(), statLogCorpus()],
    },
  ];
  for (const entry of cases)
    for (const [index, lines] of entry.blocks.entries())
      test(`${entry.label} corpus block ${index} retains every anchor row and states the rest`, () => {
        const fixture = run(entry.command, lines);
        expectCompressed(fixture, entry.id);
        // Counted as a multiset, not a set. A set says "this text appears somewhere", which a
        // repeated row such as `++=======` satisfies from a single surviving copy while the other
        // eleven are dropped — exactly how the combined-diff loss stayed invisible.
        const kept = new Map<string, number>();
        for (const line of fixture.content.split("\n")) kept.set(line, (kept.get(line) ?? 0) + 1);
        // No row this file independently calls Git content may be missing from the output.
        const missing: string[] = [];
        for (const line of lines) {
          if (!entry.row.test(line)) continue;
          const remaining = kept.get(line) ?? 0;
          if (remaining === 0) missing.push(line);
          else kept.set(line, remaining - 1);
        }
        expect(missing).toEqual([]);
        // And whatever was dropped is stated exactly, so nothing vanishes unaccounted for.
        expect(omittedTotal(fixture.content)).toBe(lines.length - retainedRows(fixture.content));
      });
});

describe("twenty-second audit: combined diffs keep both sides of every conflict", () => {
  test("plain git diff during a conflicted merge keeps ours, theirs, and the --cc headers", () => {
    const lines = [...conflictedMergeCorpus(), ...filler(120, "conflict")];
    const fixture = run("git diff", lines);
    expectCompressed(fixture, "git-diff");
    for (let index = 0; index < 7; index++) {
      // The header that says this hunk is a conflict at all.
      expect(fixture.content).toContain(`diff --cc conflicted-${index}.txt`);
      expect(fixture.content).toContain(`index 78bce4f,45d560${index}..0000000`);
      expect(fixture.content).toContain(`@@@ -${index * 10 + 1},3 -${index * 10 + 1},3 `);
      // Both sides. Dropping only the space-prefixed OURS side is what made the output read as a
      // coherent resolved patch instead of a conflict.
      expect(fixture.content).toContain(` +OURS-${index}-alpha`);
      expect(fixture.content).toContain(` +OURS-${index}-beta`);
      expect(fixture.content).toContain(` +OURS-${index}-gamma`);
      expect(fixture.content).toContain(`+ THEIRS-${index}-alpha`);
      expect(fixture.content).toContain(`+ THEIRS-${index}-gamma`);
    }
    expect(fixture.content).toContain("mode 100644,100755..100644");
    expect(omittedTotal(fixture.content)).toBe(lines.length - retainedRows(fixture.content));
  });

  test("a three-parent octopus combined diff keeps its four-@ hunks and three-column rows", () => {
    const lines = [...octopusCorpus(), ...filler(120, "octopus")];
    const fixture = run("git diff", lines);
    expectCompressed(fixture, "git-diff");
    for (let index = 0; index < 9; index++) {
      expect(fixture.content).toContain(`diff --combined octopus-${index}.txt`);
      expect(fixture.content).toContain(`@@@@ -${index + 1},3 -${index + 1},3 `);
      expect(fixture.content).toContain(`---removed-from-every-parent-${index}`);
      expect(fixture.content).toContain(`+++THREEWAY-RESOLUTION-${index}`);
    }
    expect(omittedTotal(fixture.content)).toBe(lines.length - retainedRows(fixture.content));
  });
});

describe("twenty-third audit: wide octopus combined diffs keep every prefix column", () => {
  // The sweep deliberately runs past any width a previous round chose as a bound (4, then 16), so a
  // reintroduced bound fails here instead of merely relocating the defect above the sweep's ceiling.
  for (const parents of [3, 5, 6, 7, 8, 12, 17, 18, 20]) {
    test(`a ${parents}-parent combined diff keeps both sides of every hunk`, () => {
      const body = wideOctopusCorpus(parents, 3);
      const lines = [...body, ...filler(120, `octopus-${parents}`)];
      const fixture = run("git diff", lines);
      expectCompressed(fixture, "git-diff");
      for (let file = 0; file < 3; file++) {
        expect(fixture.content).toContain(`diff --combined file${file}.txt`);
        expect(fixture.content).toContain(`${"@".repeat(parents + 1)} -5,4 `);
        // Both removed sides of the same hunk. The marker in the LAST column is the one a bound
        // sized for the `@` run rejects; keeping only its partner leaves the hunk header claiming a
        // change whose rows are gone.
        expect(fixture.content).toContain(`ONLY-IN-LAST-${file}`);
        expect(fixture.content).toContain(`SHARED-BY-EARLY-${file}`);
        expect(fixture.content).toContain(`${"+".repeat(parents)}MERGED-${file}`);
        for (let tip = 1; tip <= parents; tip++)
          expect(fixture.content).toContain(`TIP-${tip}-${file}`);
      }
      expect(omittedTotal(fixture.content)).toBe(lines.length - retainedRows(fixture.content));
    });
  }
});

// A filter may collapse a paired or symmetric structure, but it may not keep one half and drop the
// other: the survivor then reads as the whole truth. Both the round-22 combined-diff defect (30/36
// OURS rows dropped against 0/36 THEIRS rows) and the round-23 column bound (35/40 wide-column rows
// dropped, including both removed sides of one hunk) are invisible to the accounting invariant,
// because every dropped row is still counted exactly. They are visible here.
//
// For combined diffs the pairing is stated structurally and without knowing the column bound: a
// content row's first PARENTS characters are its prefix columns, and its information content is the
// number of `-` and `+` markers it carries, NOT which columns they sit in. So rows sharing a
// (parents, minus-count, plus-count) class must share a fate. `+ THEIRS` and ` +OURS` are one class;
// `-    BASE-8` and `    -ONLY-IN-LAST` are another.
//
// What this invariant does NOT protect, stated so a later round does not mistake a green run here
// for proof of retention. It caught the round-24 seventeen-column defect that no fixture exercised,
// but it is blind to all of the following:
//   1. A class dropped WHOLLY. `kept === 0` is read as legitimate collapse, so a filter that drops
//      every `2-:0+` row and keeps every other class passes. Only a partial loss is visible.
//   2. Classes of size one. The rule needs a survivor and a casualty in the SAME class to fire, so a
//      fixture carrying one row per class is vacuous under it — add repeats, not just widths.
//   3. Parent counts. `parents` is supplied by the fixture, not inferred from the output, so a
//      filter that mangles or loses a prefix column is invisible: the classes simply shift together.
//   4. Other filters. The prefix-column pairing is diff-specific and does not generalize itself; the
//      push/status/unmerged pairs below are separate hand-written statements, not instances of it.
type ColumnClass = { readonly parents: number; readonly minus: number; readonly plus: number };

function columnClass(line: string, parents: number): ColumnClass | undefined {
  if (/^(?:diff |index |mode |--- |\+\+\+ |@@|Binary files |GIT binary patch)/.test(line))
    return undefined;
  const prefix = line.slice(0, parents);
  if (prefix.length < parents || /[^ +-]/.test(prefix)) return undefined;
  const minus = [...prefix].filter((character) => character === "-").length;
  const plus = [...prefix].filter((character) => character === "+").length;
  // A row with no marker at all is pure shared context and is legitimately collapsible.
  return minus + plus === 0 ? undefined : { parents, minus, plus };
}

function classKey(entry: ColumnClass): string {
  return `${entry.parents}p:${entry.minus}-:${entry.plus}+`;
}

// Returns the classes where some rows survived and others did not, with the counts, so a failure
// names the asymmetry instead of just asserting false.
function asymmetricClasses(
  lines: readonly string[],
  content: string,
  parents: number,
): Array<{ key: string; kept: number; total: number }> {
  const remaining = new Map<string, number>();
  for (const line of content.split("\n")) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  const totals = new Map<string, number>();
  const kept = new Map<string, number>();
  for (const line of lines) {
    const entry = columnClass(line, parents);
    if (entry === undefined) continue;
    const key = classKey(entry);
    totals.set(key, (totals.get(key) ?? 0) + 1);
    const left = remaining.get(line) ?? 0;
    if (left > 0) {
      remaining.set(line, left - 1);
      kept.set(key, (kept.get(key) ?? 0) + 1);
    }
  }
  const broken: Array<{ key: string; kept: number; total: number }> = [];
  for (const [key, total] of totals) {
    const survived = kept.get(key) ?? 0;
    if (survived !== 0 && survived !== total) broken.push({ key, kept: survived, total });
  }
  return broken;
}

describe("twenty-third audit: a filter never keeps one half of a paired structure", () => {
  const combined: ReadonlyArray<{ label: string; parents: number; lines: string[] }> = [
    {
      label: "a conflicted two-parent merge",
      parents: 2,
      lines: [...conflictedMergeCorpus(), ...filler(120, "conflict")],
    },
    {
      label: "a three-parent octopus",
      parents: 3,
      lines: [...octopusCorpus(), ...filler(120, "octopus")],
    },
    ...[3, 5, 6, 7, 8, 12, 17, 18, 20].map((parents) => ({
      label: `a ${parents}-parent octopus`,
      parents,
      lines: [...wideOctopusCorpus(parents, 3), ...filler(120, `octopus-${parents}`)],
    })),
  ];
  for (const entry of combined)
    test(`${entry.label} retains prefix-column classes whole`, () => {
      const fixture = run("git diff", entry.lines);
      expectCompressed(fixture, "git-diff");
      expect(asymmetricClasses(entry.lines, fixture.content, entry.parents)).toEqual([]);
    });

  // The round-22 statement in its original literal form, kept as a direct regression pin alongside
  // the structural generalization above.
  test("a conflicted merge retains as many ` +` rows as `+ ` rows", () => {
    const lines = [...conflictedMergeCorpus(), ...filler(120, "conflict")];
    const fixture = run("git diff", lines);
    expectCompressed(fixture, "git-diff");
    const rows = fixture.content.split("\n");
    const ours = rows.filter((line) => line.startsWith(" +")).length;
    const theirs = rows.filter((line) => line.startsWith("+ ")).length;
    expect(ours).toBe(21);
    expect(theirs).toBe(14);
    // Conflict markers, excluding the `+++ b/F` file-pair rows that also begin `++`.
    expect(rows.filter((line) => line.startsWith("++") && !line.startsWith("+++ ")).length).toBe(
      21,
    );
  });

  // Other paired structures the package already covers, locked in here rather than fixed: a push
  // ref line pairs local with remote, a status rename pairs source with destination, and an unmerged
  // path pairs the two sides that conflicted. None may survive half.
  // Row forms taken verbatim from a real `git push origin --all` and a real non-fast-forward
  // rejection against a local bare remote; only the branch names are parameterised.
  test("git push ref pairs survive whole", () => {
    const lines: string[] = [];
    for (let index = 0; index < 20; index++) lines.push(`Enumerating objects: ${index}, done.`);
    lines.push("To ../remote.git");
    for (let index = 0; index < 40; index++)
      lines.push(` * [new branch]      feat/local-${index} -> feat/remote-${index}`);
    for (let index = 0; index < 12; index++)
      lines.push(`   ${index}aaaaaa..${index}bbbbbb  main-${index} -> main-${index}`);
    for (let index = 0; index < 20; index++)
      lines.push(`Total ${index} (delta 0), reused 0 (delta 0)`);
    const fixture = run("git push --all", lines);
    expectCompressed(fixture, "git-operation");
    // 40 created pairs and 12 fast-forward pairs: asymmetric, so losing one class cannot be masked
    // by the other in the stated omission total.
    for (let index = 0; index < 40; index++)
      expect(fixture.content).toContain(`feat/local-${index} -> feat/remote-${index}`);
    for (let index = 0; index < 12; index++)
      expect(fixture.content).toContain(`main-${index} -> main-${index}`);
    expect(omittedTotal(fixture.content)).toBe(lines.length - retainedRows(fixture.content));
  });

  // Real `git push` prints its rejection line with a leading space (` ! [rejected]        …`) and
  // follows the error with `hint:` continuation rows. Neither is in the operation retainer's
  // semantic grammar, so the parser fails safe and keeps the block whole. That is the correct
  // outcome for the symmetry rule — the point here is that no half of it is dropped — and it is
  // pinned so a later widening of that grammar cannot start retaining accepted refs while leaving
  // the rejected ones to be collapsed.
  test("git push rejections keep every ref pair, by compression or by fail-safe retention", () => {
    const lines: string[] = ["To ../remote.git"];
    for (let index = 0; index < 20; index++)
      lines.push(` * [new branch]      feat/ok-${index} -> feat/ok-${index}`);
    for (let index = 0; index < 12; index++)
      lines.push(
        ` ! [rejected]        feat/blocked-${index} -> feat/blocked-${index} (non-fast-forward)`,
      );
    lines.push("error: failed to push some refs to '../remote.git'");
    lines.push("hint: Updates were rejected because the tip of your current branch is behind");
    lines.push("hint: its remote counterpart. If you want to integrate the remote changes,");
    for (let index = 0; index < 40; index++)
      lines.push(`Total ${index} (delta 0), reused 0 (delta 0)`);
    const fixture = run("git push --all", lines);
    for (let index = 0; index < 20; index++)
      expect(fixture.content).toContain(`feat/ok-${index} -> feat/ok-${index}`);
    for (let index = 0; index < 12; index++)
      expect(fixture.content).toContain(`feat/blocked-${index} -> feat/blocked-${index}`);
    if (fixture.output.report.applied)
      expect(omittedTotal(fixture.content)).toBe(lines.length - retainedRows(fixture.content));
    else expect(fixture.content).toBe(fixture.original);
  });

  test("git status rename and unmerged pairs survive whole", () => {
    const lines = ["On branch main", "Unmerged paths:"];
    for (let index = 0; index < 25; index++)
      lines.push(`\tboth modified:   src/conflict-${index}.ts`);
    lines.push("Changes to be committed:");
    for (let index = 0; index < 30; index++)
      lines.push(`\trenamed:    src/old-${index}.ts -> src/new-${index}.ts`);
    for (let index = 0; index < 15; index++)
      lines.push('  (use "git restore --staged <file>..." to unstage)');
    const fixture = run("git status", lines);
    expectCompressed(fixture, "git-status");
    for (let index = 0; index < 25; index++)
      expect(fixture.content).toContain(`\tboth modified:   src/conflict-${index}.ts`);
    for (let index = 0; index < 30; index++)
      expect(fixture.content).toContain(`src/old-${index}.ts -> src/new-${index}.ts`);
  });
});

describe("twenty-second audit: --binary output states that binary files changed", () => {
  test("every GIT binary patch and literal/delta marker survives while payload collapses", () => {
    const lines = [...binaryPatchCorpus(), ...filler(120, "binary-patch")];
    const fixture = run("git diff --binary", lines);
    expectCompressed(fixture, "git-diff");
    for (let index = 0; index < 6; index++) {
      expect(fixture.content).toContain(`diff --git a/asset-${index}.bin b/asset-${index}.bin`);
      expect(fixture.content).toContain(`literal ${900 + index}`);
      expect(fixture.content).toContain(
        index % 2 === 0 ? `literal ${800 + index}` : `delta ${80 + index}`,
      );
    }
    // Six blobs, so six markers, not one surviving copy standing in for all of them.
    expect(fixture.content.split("\n").filter((line) => line === "GIT binary patch")).toHaveLength(
      6,
    );
    // The base85 payload is genuine bulk and is expected to be collapsed, not retained.
    const payload = fixture.content
      .split("\n")
      .filter((line) => /^z[A-Za-z0-9]/.test(line) && line.length > 40);
    expect(payload.length).toBeLessThan(138);
    expect(omittedTotal(fixture.content)).toBe(lines.length - retainedRows(fixture.content));
  });
});

describe("nineteenth audit: git log --stat names the files its roll-up counts", () => {
  test("every per-file stat row survives alongside the files-changed roll-up", () => {
    const lines = statLogCorpus();
    const fixture = run("git log --stat", lines);
    expectCompressed(fixture, "git-log");
    for (let index = 0; index < 40; index++) {
      expect(fixture.content).toContain(`apps/gateway/src/critical-file-${index}.ts |`);
      expect(fixture.content).toContain(`packages/store/src/schema-${index}.ts      |`);
    }
    expect(fixture.content).toContain(" 2 files changed, 9 insertions(+), 4 deletions(-)");
    expect(omittedTotal(fixture.content)).toBe(lines.length - retainedRows(fixture.content));
  });
});

describe("twenty-first audit: abbreviated hashes and self-indented commit bodies survive", () => {
  test("every abbreviated commit header and indented body row is kept", () => {
    const lines = abbreviatedLogCorpus();
    const fixture = run("git log --abbrev-commit --abbrev=4 --decorate", lines);
    expectCompressed(fixture, "git-log");
    for (let index = 0; index < 17; index++)
      expect(fixture.content).toContain(`commit ${index.toString(16).padStart(4, "0")}`);
    expect(fixture.content).toContain("commit 0003 (HEAD -> main, tag: v1.0)");
    for (let index = 0; index < 17; index++)
      expect(fixture.content).toContain(`      - first critical bullet ${index}`);
    for (let index = 0; index < 11; index++)
      expect(fixture.content).toContain(`        indentedCodeSnippet${index}();`);
    for (let index = 0; index < 5; index++)
      expect(fixture.content).toContain(`    \ttab rendered body line ${index}`);
    expect(omittedTotal(fixture.content)).toBe(lines.length - retainedRows(fixture.content));
  });

  test("prose beginning with the word commit is still not log evidence", () => {
    // The length floor the header fragment used to carry existed to exclude prose; the row tail does
    // that job now, and does it better — `commit beadaebeef because …` passed the old floor.
    const lines = ["# Contributing", "commit a change to the parser before opening the review"];
    lines.push("commit beadaebeef because the hash prefix is followed by ordinary prose");
    lines.push("Author: names in prose are not a git log either");
    for (let index = 0; index < 300; index++)
      lines.push(`IMPORTANT MIDDLE GUIDANCE ${index}: never rewrite a published branch.`);
    const fixture = runOrphan(lines);
    expect(fixture.output.report.filters).not.toContain("git-log");
  });

  test("a tab-indented Makefile is still not a commit body", () => {
    const lines = ["all: build test", "commit 0000 is mentioned in this prose line only"];
    for (let index = 0; index < 300; index++) lines.push(`\tgo build ./cmd/tool-${index}`);
    const fixture = runOrphan(lines);
    expect(fixture.output.report.filters).not.toContain("git-log");
  });
});

// Widening the diff anchors also widens the two unknown-origin evidence probes, because both are
// built from the same fragments. Detection still needs a header AND a pair, and only the header and
// pair fragments feed it — the content-column and binary-marker widening is retention-only, so it
// cannot pull a new document in. These are the document shapes that plausibly carry the widened
// tokens; none may become a Git diff on shape alone.
describe("twenty-second audit: widened diff anchors do not widen unknown-origin detection", () => {
  const documents: ReadonlyArray<{ readonly name: string; readonly lines: string[] }> = [
    {
      // YAML uses `---` as a document separator and `- ` for sequence items, and the widened content
      // column matches leading-space-then-dash. Retention-only, and there is no header row.
      name: "a multi-document YAML manifest",
      lines: [
        "---",
        "apiVersion: apps/v1",
        "kind: Deployment",
        ...Array.from({ length: 120 }, (_, index) => `  - name: sidecar-${index}`),
        "---",
        ...Array.from({ length: 120 }, (_, index) => `  - name: volume-${index}`),
      ],
    },
    {
      // A fenced diff sample missing the header row: pair evidence alone is not enough.
      name: "Markdown with a fenced diff sample carrying no header",
      lines: [
        "# Upgrade guide",
        "```diff",
        "--- a/config.toml",
        "+++ b/config.toml",
        "@@@ -1,2 +1,2 @@@",
        "```",
        ...Array.from({ length: 200 }, (_, index) => `Step ${index}: rotate the signing key.`),
      ],
    },
    {
      name: "a Python traceback quoting dashes and pluses",
      lines: [
        "Traceback (most recent call last):",
        ...Array.from(
          { length: 200 },
          (_, index) => `  File "/srv/app/module_${index}.py", line ${index + 4}, in handler`,
        ),
        "ValueError: --- unexpected +++ token",
      ],
    },
    {
      name: "a changelog with horizontal rules",
      lines: [
        "# Changelog",
        "--- ",
        ...Array.from({ length: 200 }, (_, index) => `- fixed defect ${index} in the router`),
        "+++ ",
      ],
    },
    {
      name: "a Makefile with tab recipes and dash-prefixed commands",
      lines: [
        "all: build test",
        ...Array.from({ length: 200 }, (_, index) => `\t-rm -f build/artifact-${index}.o`),
        "\t@echo done",
      ],
    },
  ];
  for (const document of documents)
    test(`${document.name} is never inferred as a Git diff`, () => {
      const fixture = runOrphan(document.lines);
      expect(fixture.output.report.filters).not.toContain("git-diff");
    });

  test("combined-diff header plus pair is still real evidence when origin is unknown", () => {
    // The positive control for the negatives above: the widened header fragment must still work.
    const fixture = runOrphan([...conflictedMergeCorpus(), ...filler(120, "conflict")]);
    expect(fixture.output.report.filters).toContain("git-diff");
  });
});

describe("nineteenth audit: lint summaries match the forms the tools really emit", () => {
  test("verbatim tsc output with an ` in N files` tail compresses", () => {
    const lines: string[] = [];
    for (let index = 0; index < 40; index++)
      lines.push(
        `src/module${index}.ts(${index + 3},9): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`,
      );
    lines.push("");
    lines.push("Found 40 errors in 12 files.");
    lines.push("");
    lines.push("Errors  Files");
    for (let index = 0; index < 12; index++)
      lines.push(`     ${index + 1}  src/module${index}.ts:${index + 3}`);
    const fixture = run("tsc --noEmit", lines);
    expectCompressed(fixture, "lint-output");
    expect(fixture.content).toContain("Found 40 errors in 12 files.");
    for (let index = 0; index < 40; index++)
      expect(fixture.content).toContain(`src/module${index}.ts(${index + 3},9): error TS2345:`);
    expect(omittedTotal(fixture.content)).toBe(lines.length - retainedRows(fixture.content));
  });

  test("verbatim eslint stylish output with a parenthesised breakdown compresses", () => {
    const lines: string[] = ["/work/packages/gateway/src/index.ts"];
    for (let index = 0; index < 34; index++)
      lines.push(
        `  ${index + 4}:11  warning  '${`unused${index}`}' is defined but never used  @typescript-eslint/no-unused-vars`,
      );
    lines.push("  91:1  error  Unexpected console statement  no-console");
    lines.push("");
    lines.push("✖ 35 problems (1 error, 34 warnings)");
    lines.push("  0 errors and 34 warnings potentially fixable with the `--fix` option.");
    lines.push("");
    const fixture = run("eslint .", lines);
    expectCompressed(fixture, "lint-output");
    expect(fixture.content).toContain("✖ 35 problems (1 error, 34 warnings)");
    expect(fixture.content).toContain("  91:1  error  Unexpected console statement  no-console");
    // 34 unique warnings, 14 past the 20-entry cap: deliberately asymmetric so a double count and a
    // dropped trailing row cannot cancel in the total.
    expect(fixture.content).toContain("... 14 warnings omitted ...");
    // Each eslint block here is exactly one row, so stated counts under either unit sum to the real
    // number of dropped rows.
    expect(omittedTotal(fixture.content)).toBe(lines.length - retainedRows(fixture.content));
  });
});
