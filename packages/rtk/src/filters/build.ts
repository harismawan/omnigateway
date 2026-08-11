import { type BoundedText, MAX_OUTPUT, renderGaps } from "./shared.ts";

const DIAGNOSTIC =
  /^(?:[^\n]+:\d+:\d+.*(?:error|warning)|(?:error|warning)(?:\[[^\]]+\])?:|panic:|\s*--> \S+:\d+:\d+)/i;
const SEMANTIC =
  /^(?:bun build v|Compiling \S|Checking \S|Downloading \S|Downloaded \S|Running `.+`|Finished .+ target|Build (?:completed|failed)|Bundled |\S*(?:dist|build|target)[/\\]\S+|\S+\.(?:js|css|map|wasm)\s+\d|sourcemap)/i;
const PROGRESS = /^progress \d+$|^(?:Compiling|Downloading) repeated\b/i;
const CONTINUATION = /^(?:\s|\||\^|~|help:|note:|Caused by:|at\s)/;

export function compressBuild(input: BoundedText): string {
  const { text, lines } = input;
  const selected = new Set<number>();
  const compileRows = new Set<number>();
  let inDiagnostic = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.length === 0 || PROGRESS.test(line)) {
      if (/^(?:Compiling|Downloading) repeated/.test(line)) compileRows.add(index);
      continue;
    }
    if (DIAGNOSTIC.test(line)) inDiagnostic = true;
    else if (inDiagnostic && CONTINUATION.test(line)) {
      selected.add(index);
      continue;
    } else inDiagnostic = false;
    if (!DIAGNOSTIC.test(line) && !SEMANTIC.test(line)) return text;
    if (!input.budget.chargeRecords(1)) return text;
    selected.add(index);
  }
  if (selected.size === 0 || !lines.some((line) => /^(?:Finished|Build |Bundled )/.test(line)))
    return text;
  // Each omitted row is reported exactly once. A gap is split into its collapsed compile/download
  // rows and everything else, so the same rows never appear under both units.
  let rendered = renderGaps(input, selected, (start, end) => {
    let compile = 0;
    for (let index = start; index <= end; index++) if (compileRows.has(index)) compile++;
    const others = end - start + 1 - compile;
    const parts: string[] = [];
    if (compile > 0) parts.push(`... ${compile} compile/download rows omitted ...`);
    if (others > 0) parts.push(`... ${others} lines omitted ...`);
    return parts.length === 0 ? undefined : parts.join("\n");
  });
  if (rendered === undefined) return text;
  // Rows outside the selected range never reach a gap, so account for them here with the same split
  // the gap labeller uses. Blank and progress rows dropped ahead of or behind the range are still
  // omitted rows and must be stated, not silently discarded.
  const indexes = [...selected];
  const first = Math.min(...indexes);
  const last = Math.max(...indexes);
  const describeOutside = (from: number, to: number): string | undefined => {
    let compile = 0;
    for (let index = from; index < to; index++) if (compileRows.has(index)) compile++;
    const others = to - from - compile;
    const parts: string[] = [];
    if (compile > 0) parts.push(`... ${compile} compile/download rows omitted ...`);
    if (others > 0) parts.push(`... ${others} lines omitted ...`);
    return parts.length === 0 ? undefined : parts.join("\n");
  };
  const leading = describeOutside(0, first);
  const trailing = describeOutside(last + 1, lines.length);
  if (leading !== undefined) rendered = `${leading}\n${rendered}`;
  if (trailing !== undefined) rendered = `${rendered}\n${trailing}`;
  return rendered.length > MAX_OUTPUT ? text : rendered;
}
