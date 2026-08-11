import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { compressListing } from "../src/filters/listings.ts";
import { type BoundedText, ParserBudget, scanText } from "../src/filters/shared.ts";
import { transformRequest } from "../src/index.ts";

type Charge = { kind: "records" | "codeUnits"; count: number };

class RecordingBudget extends ParserBudget {
  readonly charges: Charge[] = [];

  override chargeRecords(count: number): boolean {
    this.charges.push({ kind: "records", count });
    return super.chargeRecords(count);
  }

  override chargeCodeUnits(count: number): boolean {
    this.charges.push({ kind: "codeUnits", count });
    return super.chargeCodeUnits(count);
  }
}

function totalRecords(charges: readonly Charge[]): number {
  return charges.reduce((sum, charge) => (charge.kind === "records" ? sum + charge.count : sum), 0);
}

function recordCharges(
  text: string,
  parse: (input: BoundedText) => string,
): { charges: readonly Charge[]; output: string } {
  const scanned = scanText(text);
  if (scanned === undefined) throw new Error("unscannable fixture");
  const budget = new RecordingBudget(text.length * 8);
  const output = parse({ text, lines: scanned.lines, budget });
  return { charges: budget.charges, output };
}

function run(command: string, lines: string[], name = "bash") {
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
  return { input, output, content: block.content };
}

function attempt(text: string, codeUnits: number, parse: (input: BoundedText) => string): string {
  const scanned = scanText(text);
  if (scanned === undefined) throw new Error("unscannable fixture");
  return parse({ text, lines: scanned.lines, budget: new ParserBudget(codeUnits) });
}

function minimalCodeUnits(text: string, parse: (input: BoundedText) => string): number {
  let low = 0;
  let high = text.length * 8;
  if (attempt(text, high, parse) === text) throw new Error("fixture never compresses");
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (attempt(text, middle, parse) === text) low = middle + 1;
    else high = middle;
  }
  return low;
}

describe("fourteenth audit regressions", () => {
  test("unknown-origin unprefixed nested listing compresses without losing middle groups", () => {
    const lines: string[] = [];
    for (let directory = 0; directory < 30; directory++)
      for (let file = 0; file < 20; file++)
        lines.push(`apps/gateway/src/module-${directory}/handler-${file}.ts`);
    const fixture = run("ignored", lines, "mystery");
    expect(fixture.output.request).not.toBe(fixture.input);
    expect(fixture.output.report.filters).toContain("path-list");
    expect(fixture.content.length).toBeLessThan(lines.join("\n").length);
    expect(fixture.content).toContain("apps/gateway/src/module-15/handler-0.ts");
    expect(fixture.content).toContain("apps/gateway/src/module-15/handler-19.ts");
    expect(fixture.content).toContain("... 8 entries omitted from apps/gateway/src/module-15 ...");
  });

  test("command-gated listings keep space, tab, and Unicode filenames in middle groups", () => {
    const middle = [
      "docs/release/release notes.md",
      "docs/release/build\tlog summary.md",
      "docs/release/日本語の設計資料.md",
      "docs/release/ünïcodé nàme.md",
    ];
    const lines: string[] = [];
    for (let directory = 0; directory < 12; directory++)
      for (let file = 0; file < 20; file++)
        lines.push(`docs/section-${directory}/chapter-${file}.md`);
    lines.push(...middle);
    for (let directory = 12; directory < 24; directory++)
      for (let file = 0; file < 20; file++)
        lines.push(`docs/section-${directory}/chapter-${file}.md`);
    const fixture = run("find . -type f", lines);
    expect(fixture.output.request).not.toBe(fixture.input);
    expect(fixture.output.report.filters).toContain("path-list");
    for (const entry of middle) expect(fixture.content).toContain(entry);
  });

  test("command-gated listings keep Windows paths containing spaces in middle groups", () => {
    const middle = [
      "C:\\proj\\docs\\My Reports\\quarter one.md",
      "C:\\proj\\docs\\My Reports\\quarter two.md",
    ];
    const lines: string[] = [];
    for (let directory = 0; directory < 8; directory++)
      for (let file = 0; file < 20; file++)
        lines.push(`C:\\proj\\src\\module-${directory}\\source-${file}.ts`);
    lines.push(...middle);
    for (let directory = 8; directory < 16; directory++)
      for (let file = 0; file < 20; file++)
        lines.push(`C:\\proj\\src\\module-${directory}\\source-${file}.ts`);
    const fixture = run("find . -type f", lines);
    expect(fixture.output.request).not.toBe(fixture.input);
    for (const entry of middle) expect(fixture.content).toContain(entry);
  });

  test("command-gated listings still reject prose, tables, JSON, and coordinates", () => {
    // 20 entries per group so the valid fixture is above the 12-entry retention limit and therefore
    // genuinely compressible; a fixture that never compresses makes every rejection below vacuous.
    const valid: string[] = [];
    for (let directory = 0; directory < 12; directory++)
      for (let file = 0; file < 20; file++)
        valid.push(`docs/section-${directory}/chapter-${file}.md`);
    for (const invalid of [
      "Build failed because dependency missing",
      "NAME VALUE",
      "src/index.ts:10:error",
      '{"path":"src/index.ts"}',
      "```",
      "| name | size |",
      "find: 'docs/private': Permission denied",
    ]) {
      const middled = [...valid.slice(0, 120), invalid, ...valid.slice(120)];
      const fixture = run("find . -type f", middled);
      expect(fixture.output.request).toBe(fixture.input);
      expect(fixture.content).toContain(invalid);
    }
    // Positive control. Without this the rejections above pass vacuously against any code that
    // never compresses this shape at all; the same fixture minus the invalid row must compress and
    // must drop middle entries, which is exactly what the rejection is protecting.
    const control = run("find . -type f", valid);
    expect(control.output.request).not.toBe(control.input);
    expect(control.output.report.filters).toContain("path-list");
    expect(control.content.length).toBeLessThan(valid.join("\n").length);
    expect(control.content).toContain("... 8 entries omitted from docs/section-6 ...");
  });

  test("long ls parsing charges its header before allocating rows", () => {
    const rows = Array.from(
      { length: 60 },
      (_, index) =>
        `-rw-r--r--  1 dev  staff  ${1000 + index} Aug  1 09:15 report-${index}-with-long-name.txt`,
    );
    const header = "total 4096";
    const text = [header, ...rows].join("\n");
    const parse = (input: BoundedText): string => compressListing(input, "ls", "long");
    const rendered = attempt(text, text.length * 8, parse);
    expect(rendered).not.toBe(text);
    expect(rendered.startsWith(`${header}\n`)).toBe(true);
    expect(rendered).toContain("... 48 entries omitted from . ...");

    // A row that fails the long-list grammar must be rejected without ever paying to materialize
    // the rows that preceded it. Filtering the whole input first charges nothing at all here.
    const malformed = [header, ...rows.slice(0, 40), "locale specific row", ...rows.slice(40)];
    const rejected = recordCharges(malformed.join("\n"), parse);
    expect(rejected.output).toBe(malformed.join("\n"));
    expect(totalRecords(rejected.charges)).toBeGreaterThanOrEqual(40);
  });

  test("long ls parsing is stable at and past its budget limit", () => {
    const rows = Array.from(
      { length: 60 },
      (_, index) =>
        `-rw-r--r--  1 dev  staff  ${1000 + index} Aug  1 09:15 report-${index}-with-long-name.txt`,
    );
    const text = ["total 4096", ...rows].join("\n");
    const parse = (input: BoundedText): string => compressListing(input, "ls", "long");
    const minimal = minimalCodeUnits(text, parse);
    const generous = attempt(text, text.length * 8, parse);
    expect(attempt(text, minimal, parse)).toBe(generous);
    expect(attempt(text, minimal + 1, parse)).toBe(generous);
    expect(attempt(text, minimal - 1, parse)).toBe(text);
    expect(generous).toContain(
      "-rw-r--r--  1 dev  staff  1000 Aug  1 09:15 report-0-with-long-name.txt",
    );
    expect(generous).toContain("... 48 entries omitted from . ...");
  });

  test("tree parsing is stable at and past its budget limit", () => {
    const lines = ["project"];
    for (let directory = 0; directory < 20; directory++) {
      const last = directory === 19;
      lines.push(`${last ? "└── " : "├── "}module-${directory}/`);
      for (let file = 0; file < 20; file++)
        lines.push(
          `${last ? " ".repeat(4) : "│   "}${file === 19 ? "└── " : "├── "}source-${file}.ts`,
        );
    }
    lines.push("21 directories, 400 files");
    const text = lines.join("\n");
    const parse = (input: BoundedText): string =>
      compressListing(input, "tree", "classified", true);
    const minimal = minimalCodeUnits(text, parse);
    const generous = attempt(text, text.length * 8, parse);
    expect(attempt(text, minimal, parse)).toBe(generous);
    expect(attempt(text, minimal + 1, parse)).toBe(generous);
    expect(attempt(text, minimal - 1, parse)).toBe(text);
    expect(generous).toContain("... 8 directories omitted containing 160 entries ...");
    expect(generous).toContain("├── module-14/");
    expect(generous).toContain("... 8 entries omitted from project/module-14 ...");
    expect(generous).toContain("21 directories, 400 files");

    // The nonempty-line pass that feeds the tree parser must charge each line it keeps. This input
    // is rejected on its missing summary row, so the scan pass is the only thing that can charge;
    // a parser that builds a filtered array first charges nothing before bailing out.
    const unsummarized = lines.slice(0, -1).join("\n");
    const charged = recordCharges(unsummarized, parse);
    expect(charged.output).toBe(unsummarized);
    expect(totalRecords(charged.charges)).toBeGreaterThanOrEqual(lines.length - 1);
  });
});
