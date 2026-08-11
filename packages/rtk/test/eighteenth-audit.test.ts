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

const MARKER = /^\.\.\. (\d+) ([^\n]*?) omitted \.\.\.$/;

// Sums every omission marker's stated count per unit so a fixture can prove each omitted row is
// reported exactly once rather than under two competing units. A `warnings` marker counts blocks,
// not rows, so a fixture with warning markers must convert using its own known block size.
function omittedByUnit(content: string): { lines: number; warnings: number } {
  let lines = 0;
  let warnings = 0;
  for (const line of content.split("\n")) {
    const match = MARKER.exec(line);
    if (match === null) continue;
    const count = Number(match[1] ?? "0");
    if (match[2] === "warnings") warnings += count;
    else lines += count;
  }
  return { lines, warnings };
}

// Total stated omissions for filters that only ever emit row-counted units.
function omittedTotal(content: string): number {
  const { lines, warnings } = omittedByUnit(content);
  return lines + warnings;
}

// Counts rows the filter actually kept, so a fixture can compare stated omissions against the real
// number of rows the filter dropped instead of trusting the markers to be self-consistent.
function retainedRows(content: string): number {
  return content.split("\n").filter((line) => !MARKER.test(line)).length;
}

function realOmitted(fixture: ReturnType<typeof run>): number {
  return fixture.lines.length - retainedRows(fixture.content);
}

// Every fixture below asserts compression really ran and really shrank before checking content:
// a `toContain` against untouched input proves nothing.
function expectCompressed(fixture: ReturnType<typeof run>, id: RtkFilterId) {
  expect(fixture.output.report.applied).toBe(true);
  expect(fixture.output.report.filters).toContain(id);
  expect(fixture.content.length).toBeLessThan(fixture.original.length);
}

// A realistic `git diff -U3` patch: three context rows either side of every changed row, so roughly
// three quarters of the block is context rather than a `+`/`-` marker.
function unifiedPatch(hunks: number): string[] {
  const lines = [
    "diff --git a/src/engine.ts b/src/engine.ts",
    "index 1111111..2222222 100644",
    "--- a/src/engine.ts",
    "+++ b/src/engine.ts",
  ];
  for (let hunk = 0; hunk < hunks; hunk++) {
    lines.push(`@@ -${hunk * 20 + 1},7 +${hunk * 20 + 1},7 @@ export function region${hunk}() {`);
    for (let row = 0; row < 3; row++) lines.push(`   const beforeContext${hunk}_${row} = ${row};`);
    lines.push(`-  const changedCritical${hunk} = "old value ${hunk}";`);
    lines.push(`+  const changedCritical${hunk} = "new value ${hunk}";`);
    for (let row = 0; row < 3; row++) lines.push(`   const afterContext${hunk}_${row} = ${row};`);
  }
  return lines;
}

// A realistic `git log --stat --show-signature` with commit bodies: merge trailers, blank
// separators, wrapped body paragraphs, per-file stat rows, and `gpg:` verification chatter. None of
// the log rows were anchors before, so the measured density was 0.47 and the gate handed a genuine
// log to the numbered-read truncator.
// The `gpg:` rows are the only rows here the log retainer may drop. Every other row is genuine log
// content the retainer must keep, so without them this block is 100% anchor rows, no candidate can
// be strictly shorter, and the acceptance guard rejects it — which would make the fixture prove
// nothing about routing. They are also what `--show-signature` really prints.
function commitLog(commits: number): string[] {
  const lines: string[] = [];
  for (let index = 0; index < commits; index++) {
    lines.push(`commit ${index.toString(16).padStart(40, "0")}`);
    if (index % 3 === 0) lines.push(`Merge: ${index}aaaaaa ${index}bbbbbb`);
    lines.push(`gpg: Signature made Mon 10 Aug 2026 07:43:${index % 60} PM WIB`);
    lines.push(`gpg:                using RSA key ${index.toString(16).padStart(40, "F")}`);
    lines.push('gpg: Good signature from "Example Developer <developer@example.com>" [ultimate]');
    lines.push("Author: Example Developer <developer@example.com>");
    lines.push("Date:   Mon Aug 10 19:43:18 2026 +0700");
    lines.push("");
    lines.push(`    fix(area${index}): the important commit subject number ${index}`);
    lines.push("    ");
    lines.push(`    Body paragraph explaining the change made in commit ${index} at some length.`);
    lines.push("");
    for (let file = 0; file < 4; file++)
      lines.push(` packages/module${file}/src/file-${index}-${file}.ts | ${file + 3} +++--`);
    lines.push(" 4 files changed, 12 insertions(+), 8 deletions(-)");
    lines.push("");
  }
  return lines;
}

describe("eighteenth audit: a classified command owns the family, shape never overrides it", () => {
  test("a -U3 patch read with cat is a numbered read, giving up per-hunk diff retention", () => {
    // Given up: the changed rows of hunks in the truncated middle. `cat` says nothing about the
    // bytes, and no density threshold could separate this patch from the five documents below
    // without hijacking one of them, so the classification wins and the file truncates head/tail.
    const lines = unifiedPatch(60);
    const fixture = run("cat feature.patch", lines);
    expectCompressed(fixture, "numbered-read");
    expect(fixture.output.report.filters).not.toContain("git-diff");
    expect(fixture.content).toContain('-  const changedCritical0 = "old value 0";');
    expect(fixture.content).toContain('+  const changedCritical59 = "new value 59";');
    expect(omittedTotal(fixture.content)).toBe(realOmitted(fixture));
  });

  test("the same -U3 patch from a git diff command keeps every changed row", () => {
    const lines = unifiedPatch(60);
    const fixture = run("git diff", lines);
    expectCompressed(fixture, "git-diff");
    for (let hunk = 0; hunk < 60; hunk++) {
      expect(fixture.content).toContain(`-  const changedCritical${hunk} = "old value ${hunk}";`);
      expect(fixture.content).toContain(`+  const changedCritical${hunk} = "new value ${hunk}";`);
    }
    expect(omittedTotal(fixture.content)).toBe(realOmitted(fixture));
  });

  test("a git log carrying commit bodies routes to git-log and keeps every subject", () => {
    const lines = commitLog(40);
    const fixture = run("git log", lines);
    expectCompressed(fixture, "git-log");
    expect(fixture.output.report.filters).not.toContain("numbered-read");
    for (let index = 0; index < 40; index++)
      expect(fixture.content).toContain(
        `    fix(area${index}): the important commit subject number ${index}`,
      );
    expect(omittedTotal(fixture.content)).toBe(realOmitted(fixture));
  });

  test("a log read with cat is a numbered read, giving up per-commit subject retention", () => {
    // Given up: commit subjects in the truncated middle. Same trade as the patch above.
    const lines = commitLog(40);
    const fixture = run("cat /tmp/history.txt", lines);
    expectCompressed(fixture, "numbered-read");
    expect(fixture.output.report.filters).not.toContain("git-log");
    expect(fixture.content).toContain("    fix(area0): the important commit subject number 0");
    expect(fixture.content).toContain("    fix(area39): the important commit subject number 39");
    expect(omittedTotal(fixture.content)).toBe(realOmitted(fixture));
  });

  test("an unknown-origin log with no command still routes to git-log from shape alone", () => {
    // The capability being preserved: with no correlated command there is no classification to own
    // the block, so the spec-sanctioned output-shape inference is the only signal and must remain.
    const lines = commitLog(40);
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
    expect(output.report.applied).toBe(true);
    expect(output.report.filters).toContain("git-log");
    expect(block.content.length).toBeLessThan(lines.join("\n").length);
    for (let index = 0; index < 40; index++)
      expect(block.content).toContain(
        `    fix(area${index}): the important commit subject number ${index}`,
      );
  });

  test("an unknown-origin patch with no command still routes to git-diff from shape alone", () => {
    const lines = unifiedPatch(60);
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
    expect(output.report.applied).toBe(true);
    expect(output.report.filters).toContain("git-diff");
    expect(block.content.length).toBeLessThan(lines.join("\n").length);
    for (let hunk = 0; hunk < 60; hunk++)
      expect(block.content).toContain(`+  const changedCritical${hunk} = "new value ${hunk}";`);
  });

  test("prose quoting a diff hunk stays a numbered read", () => {
    // The round-16 discrimination: a handful of Git-shaped rows must not hand a prose document to a
    // Git line filter. Extending the anchors must not weaken this side of the gate.
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
    expect(omittedTotal(fixture.content)).toBe(realOmitted(fixture));
  });

  test("prose quoting a commit header stays a numbered read", () => {
    const lines = [
      "# Contribution guide",
      "commit 4f3a1c9d2b8e7a6f5c4d3b2a1908f7e6d5c4b3a2",
      "Author: Example Developer <developer@example.com>",
      "Date:   Mon Aug 10 19:43:18 2026 +0700",
    ];
    for (let index = 0; index < 300; index++)
      lines.push(`GUIDANCE ROW ${index}: contributors must sign every commit before pushing.`);
    const fixture = run("cat docs/CONTRIBUTING.md", lines);
    expectCompressed(fixture, "numbered-read");
    expect(fixture.output.report.filters).not.toContain("git-log");
    expect(omittedTotal(fixture.content)).toBe(realOmitted(fixture));
  });
});

describe("eighteenth audit: rows outside the selected range are stated", () => {
  test("clippy epilogue rows after the final error are counted, not dropped", () => {
    const lines = ["    Checking omnigateway v0.1.0 (/work/omnigateway) building the workspace"];
    for (let index = 0; index < 30; index++) {
      lines.push(`warning: unused variable \`value${index}\` found in this scope of the crate`);
      lines.push(`  --> src/module${index}.rs:${index + 2}:9`);
    }
    lines.push("error[E0308]: mismatched types in the gateway dispatch routine");
    lines.push("  --> src/dispatch.rs:42:17");
    lines.push("Found 1 error");
    for (let index = 0; index < 38; index++)
      lines.push(`note: epilogue advisory row number ${index} that must be counted`);
    lines.push("warning: `omnigateway` (lib) generated 26 warnings");
    lines.push("    Finished `dev` profile [unoptimized + debuginfo] target(s) in 12.34s");
    const fixture = run("cargo clippy", lines);
    expectCompressed(fixture, "lint-output");
    // Warning markers count blocks; each clippy warning block here is exactly its header plus one
    // `-->` row, so two rows per stated warning plus the row-counted markers must equal every row
    // the filter actually dropped — including the 40-row epilogue after `Found 1 error`.
    const stated = omittedByUnit(fixture.content);
    expect(stated.lines + stated.warnings * 2).toBe(realOmitted(fixture));
    // The 40-row epilogue is 38 plain note rows plus the roll-up warning block (its header and the
    // indented `Finished` row), so all 40 are stated: 38 as lines and one as a two-row warning.
    expect(stated.lines).toBeGreaterThanOrEqual(38);
    expect(fixture.content).toContain("error[E0308]: mismatched types in the gateway dispatch");
    expect(fixture.content).toContain("Found 1 error");
  });

  test("bun test coverage rows after the summary are counted, not dropped", () => {
    const lines = ["bun test v1.4.0 running the omnigateway suite from the repository root"];
    for (let index = 0; index < 60; index++)
      lines.push(`(pass) suite alpha > passing scenario number ${index} completed successfully`);
    for (let index = 0; index < 8; index++) {
      lines.push(`FAIL test/beta-${index}.test.ts > failing scenario number ${index}`);
      lines.push(`  at test/beta-${index}.test.ts:${index + 10}:7 in the assertion helper`);
    }
    lines.push("8 fail");
    lines.push("Ran 68 tests across 4 files.");
    for (let index = 0; index < 30; index++)
      lines.push(`File src/module${index}.ts | 88.10 | 72.40 | line coverage row ${index} here`);
    const fixture = run("bun test", lines);
    expectCompressed(fixture, "test-output");
    expect(omittedTotal(fixture.content)).toBe(realOmitted(fixture));
    for (let index = 0; index < 8; index++)
      expect(fixture.content).toContain(
        `FAIL test/beta-${index}.test.ts > failing scenario number ${index}`,
      );
  });

  test("npm install funding rows after the summary are counted, not dropped", () => {
    const lines: string[] = [];
    // 35 unique warnings past the 20-entry cap and 13 trailing funding rows, deliberately unequal so
    // the two defects cannot cancel: double-counting the cap-dropped warnings and dropping the
    // trailing rows both shift the total in ways this fixture can tell apart.
    for (let index = 0; index < 55; index++)
      lines.push(`npm warn deprecated pkg-${index}@1.0.0: package ${index} is no longer supported`);
    lines.push("added 120 packages, and audited 900 packages in 12s");
    lines.push("found 3 vulnerabilities (1 moderate, 2 high)");
    for (let index = 0; index < 13; index++)
      lines.push(`  funding advisory line number ${index} describing sponsorship options here`);
    const fixture = run("npm install", lines);
    expectCompressed(fixture, "package-output");
    // Each npm warn block is one row, so stated warnings and stated lines together must equal every
    // dropped row — including the funding rows trailing the summary.
    const stated = omittedByUnit(fixture.content);
    expect(stated.lines + stated.warnings).toBe(realOmitted(fixture));
    expect(stated.warnings).toBe(35);
    expect(stated.lines).toBe(13);
    expect(fixture.content).toContain("found 3 vulnerabilities (1 moderate, 2 high)");
  });

  test("docker progress rows before and after the semantic range are counted", () => {
    const lines = ["#1 [internal] load build definition from Dockerfile"];
    for (let index = 0; index < 6; index++) lines.push(`#1 transferring dockerfile: ${index}00B`);
    for (let index = 0; index < 12; index++)
      lines.push(`#${index + 2} [${index + 1}/12] RUN build step number ${index} of the image`);
    lines.push("#20 exporting layers to the local image store now");
    lines.push("#20 naming to docker.io/library/omnigateway:latest done");
    for (let index = 0; index < 6; index++) lines.push(`#21 transferring context: ${index}00kB`);
    const fixture = run("docker build .", lines);
    expectCompressed(fixture, "docker-build");
    expect(omittedTotal(fixture.content)).toBe(realOmitted(fixture));
    expect(fixture.content).toContain("#20 naming to docker.io/library/omnigateway:latest done");
  });

  test("git transfer progress rows before and after the semantic range are counted", () => {
    const lines: string[] = [];
    for (let index = 0; index < 5; index++)
      lines.push(`remote: Counting objects: ${index * 20}% (${index}/5)`);
    lines.push("From github.com:example/omnigateway");
    for (let index = 0; index < 12; index++)
      lines.push(
        `ff${index}0000..aa${index}0000  feature/branch-${index} -> origin/branch-${index}`,
      );
    lines.push("Fast-forward");
    for (let index = 0; index < 5; index++)
      lines.push(`remote: Compressing objects: ${index * 20}% (${index}/5)`);
    const fixture = run("git pull", lines);
    expectCompressed(fixture, "git-operation");
    expect(omittedTotal(fixture.content)).toBe(realOmitted(fixture));
    expect(fixture.content).toContain("From github.com:example/omnigateway");
    expect(fixture.content).toContain("Fast-forward");
  });

  test("real eslint output compresses and its trailing fixability row is stated", () => {
    // Verbatim eslint stylish output. The previous fixture wrote `✖ 31 problems` — a string eslint
    // never emits, because it always appends the `(N errors, M warnings)` breakdown. The summary
    // regex was anchored so tightly that the real row did not match at all and this family never
    // compressed genuine eslint output.
    const lines: string[] = ["/work/src/all.ts"];
    for (let index = 0; index < 30; index++)
      lines.push(
        `  ${index + 1}:9  warning  'unused${index}' is assigned a value but never used  no-unused-vars`,
      );
    lines.push("  99:3  error  Parsing error: unexpected token in the module body  parse");
    lines.push("");
    lines.push("✖ 31 problems (1 error, 30 warnings)");
    lines.push("  0 errors and 30 warnings potentially fixable with the `--fix` option.");
    const fixture = run("eslint .", lines);
    expectCompressed(fixture, "lint-output");
    // Each eslint block is one row here, so stated warnings plus stated lines equal every dropped
    // row. The fixability row trails the summary and previously vanished with no marker at all.
    const stated = omittedByUnit(fixture.content);
    expect(stated.lines + stated.warnings).toBe(realOmitted(fixture));
    expect(fixture.content).toContain("✖ 31 problems (1 error, 30 warnings)");
    expect(fixture.content).toContain(
      "  99:3  error  Parsing error: unexpected token in the module body  parse",
    );
    // The explicit summary remains the last retained row, with the trailing row accounted for.
    expect(
      fixture.content.endsWith("✖ 31 problems (1 error, 30 warnings)\n... 1 lines omitted ..."),
    ).toBe(true);
  });
});
