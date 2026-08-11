import {
  type BoundedText,
  diagnosticBlocks,
  MAX_OUTPUT,
  type ParsedBlock,
  renderGaps,
  selectBlock,
} from "./shared.ts";

const PRIMARY =
  /^(?:[^\n]+\(\d+,\d+\):\s+(?:error|warning)\s+TS\d+:|[^\n]+:\d+:\d+(?::|\s).+|[^\n]+\n\s*\d+:\d+\s+(?:error|warning)\s|\s*\d+:\d+\s+(?:error|warning)\s|(?:error|warning)(?:\[[^\]]+\])?:)/i;
// Real summary rows, not the shapes the regex used to imagine: eslint prints
// `✖ 31 problems (1 error, 30 warnings)` and tsc prints `Found 40 errors in 12 files.`, so both the
// parenthesised breakdown and the ` in N files` tail must be part of the row, not text after it.
const SUMMARY =
  /(?:Found \d+ errors?(?: and \d+ warnings?)?(?: in \d+ files?)?|\d+ problems?(?: \([^)\n]*\))?|Checked \d+ files?|could not compile|\d+ issues?)\.?$/i;

export function compressDiagnostics(input: BoundedText): string {
  const { text, lines } = input;
  const blocks = diagnosticBlocks(input, PRIMARY);
  if (blocks === undefined || blocks.length === 0) return text;
  const summary = lines.findLastIndex((line) => SUMMARY.test(line));
  if (summary < 0) return text;
  const selected = new Set<number>([0, summary]);
  const errors = blocks.filter((block) => block.severity === "error");
  const warningByIdentity = new Map<string, ParsedBlock>();
  for (const block of blocks)
    if (block.severity === "warning" && !warningByIdentity.has(block.identity))
      warningByIdentity.set(block.identity, block);
  const warnings = [...warningByIdentity.values()];
  for (const block of [...errors, ...warnings.slice(0, 20)])
    if (!selectBlock(input, selected, block)) return text;
  // Rows of a unique warning the 20-entry cap dropped. Each such block is attributed to the gap
  // holding its first row and counted once under the warning unit; every other omitted row —
  // including duplicate-identity warning blocks, which the cap never counted — is counted once under
  // the line unit. A block a retained row splits is not a whole-block omission, so its leftover rows
  // also stay under the line unit rather than being counted twice.
  const omittedWarningRows = new Set<number>();
  const omittedWarningStarts = new Set<number>();
  for (const block of warnings.slice(20)) {
    if (!input.budget.chargeRecords(block.end - block.start + 1)) return text;
    let whole = true;
    for (let index = block.start; index <= block.end; index++) whole &&= !selected.has(index);
    if (!whole) continue;
    omittedWarningStarts.add(block.start);
    for (let index = block.start; index <= block.end; index++) omittedWarningRows.add(index);
  }
  const describe = (from: number, to: number): string | undefined => {
    let warningBlocks = 0;
    let otherRows = 0;
    for (let index = from; index < to; index++) {
      if (omittedWarningStarts.has(index)) warningBlocks++;
      if (!omittedWarningRows.has(index)) otherRows++;
    }
    const parts: string[] = [];
    if (warningBlocks > 0) parts.push(`... ${warningBlocks} warnings omitted ...`);
    if (otherRows > 0) parts.push(`... ${otherRows} lines omitted ...`);
    return parts.length === 0 ? undefined : parts.join("\n");
  };
  let rendered = renderGaps(input, selected, (start, end) => describe(start, end + 1));
  if (rendered === undefined) return text;
  // Rows before the first and after the last selected index never reach a gap. An epilogue after the
  // final summary — a clippy `generated N warnings` roll-up, a `Finished` timing row, an eslint
  // fixability line — is still an omitted row and must be stated under the same units.
  const indexes = [...selected];
  const leading = describe(0, Math.min(...indexes));
  const trailing = describe(Math.max(...indexes) + 1, lines.length);
  if (leading !== undefined) rendered = `${leading}\n${rendered}`;
  if (trailing !== undefined) rendered = `${rendered}\n${trailing}`;
  if (rendered.length > MAX_OUTPUT) return text;
  // Errors are preserved intact until the output cap, so an error row missing from the rendered
  // output means the candidate lost a required anchor and must be rejected.
  for (const block of errors)
    for (let index = block.start; index <= block.end; index++)
      if (!rendered.includes(lines[index] ?? "")) return text;
  return rendered;
}
