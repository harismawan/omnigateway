export const MAX_ROWS = 100_000;
export const MAX_OUTPUT = 250_000;

export class ParserBudget {
  private records = 0;
  private codeUnits = 0;
  constructor(private readonly inputCodeUnits: number) {}

  chargeRecords(count: number): boolean {
    this.records += count;
    return this.records <= 100_000;
  }

  chargeCodeUnits(count: number): boolean {
    this.codeUnits += count;
    return this.codeUnits <= this.inputCodeUnits * 3;
  }
}

export type BoundedText = {
  readonly text: string;
  readonly lines: readonly string[];
  readonly budget: ParserBudget;
};

export type ParsedBlock = {
  start: number;
  end: number;
  severity?: "error" | "warning";
  identity: string;
};

export type ParserResult = { content: string; safeDedupApplied?: boolean };

export function scanText(text: string): BoundedText | undefined {
  const lines: string[] = [];
  const budget = new ParserBudget(text.length);
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code !== 10 && code !== 13) continue;
    if (!budget.chargeRecords(1)) return undefined;
    const line = text.slice(start, index);
    if (!budget.chargeCodeUnits(line.length)) return undefined;
    lines.push(line);
    if (code === 13 && text.charCodeAt(index + 1) === 10) index++;
    start = index + 1;
  }
  if (!budget.chargeRecords(1)) return undefined;
  const line = text.slice(start);
  if (!budget.chargeCodeUnits(line.length)) return undefined;
  lines.push(line);
  return { text, lines, budget };
}

// Renders the selected rows, asking `describe` to label each gap of omitted rows. Returning
// undefined from `describe` emits no marker for that gap, which lets a caller report a run of rows
// once under a semantic unit instead of twice under two competing units.
export function renderGaps(
  input: BoundedText,
  selected: ReadonlySet<number>,
  describe: (start: number, end: number) => string | undefined,
): string | undefined {
  const output: string[] = [];
  if (!input.budget.chargeRecords(selected.size)) return undefined;
  let previous = -1;
  for (const index of [...selected].sort((left, right) => left - right)) {
    if (previous >= 0 && index > previous + 1) {
      const marker = describe(previous + 1, index - 1);
      if (marker !== undefined) {
        if (!input.budget.chargeCodeUnits(marker.length)) return undefined;
        output.push(marker);
      }
    }
    const line = input.lines[index];
    if (line !== undefined) {
      if (!input.budget.chargeCodeUnits(line.length)) return undefined;
      output.push(line);
    }
    previous = index;
  }
  return output.join("\n");
}

export function renderSelection(
  input: BoundedText,
  selected: ReadonlySet<number>,
  unit = "lines",
): string | undefined {
  return renderGaps(input, selected, (start, end) => `... ${end - start + 1} ${unit} omitted ...`);
}

export function selectBlock(
  input: BoundedText,
  selected: Set<number>,
  block: ParsedBlock,
): boolean {
  const count = block.end - block.start + 1;
  if (!input.budget.chargeRecords(count)) return false;
  for (let index = block.start; index <= block.end; index++) selected.add(index);
  return true;
}

export function diagnosticBlocks(input: BoundedText, primary: RegExp): ParsedBlock[] | undefined {
  const starts: number[] = [];
  for (let index = 0; index < input.lines.length; index++) {
    if (!primary.test(input.lines[index] ?? "")) continue;
    if (!input.budget.chargeRecords(1)) return undefined;
    starts.push(index);
  }
  const blocks: ParsedBlock[] = [];
  for (let offset = 0; offset < starts.length; offset++) {
    const start = starts[offset];
    if (start === undefined || !input.budget.chargeRecords(1)) return undefined;
    const next = starts[offset + 1] ?? input.lines.length;
    let end = start;
    while (end + 1 < next) {
      const line = input.lines[end + 1] ?? "";
      if (!/^(?:\s|\||\^|~|help:|note:|=|-->|Caused by:|at\s|detail$)/.test(line)) break;
      end++;
    }
    const header = input.lines[start] ?? "";
    blocks.push({
      start,
      end,
      severity: /\bwarning\b/i.test(header) ? "warning" : "error",
      identity: header,
    });
  }
  return blocks;
}
