import { type BoundedText, MAX_OUTPUT, renderGaps } from "./shared.ts";

function isFailureStart(line: string, executable: string): boolean {
  if (executable === "vitest") return /^\s*FAIL\s{2}\S.+\s>\s/.test(line);
  if (executable === "jest") return /^\s*●\s/.test(line);
  if (executable === "bun")
    return /^\s*(?:FAIL\s|UnhandledPromiseRejection|Uncaught exception|panic:|error:.*(?:hook|unhandled rejection))/.test(
      line,
    );
  if (executable === "pytest")
    return /^\s*(?:FAILED\s|={2,} FAILURES ={2,}|ERROR collecting)/.test(line);
  if (executable === "go") return /^\s*(?:--- FAIL:|# \S|FAIL\s+\S+\s+\[build failed\])/.test(line);
  return /^\s*(?:FAIL\b|--- FAIL:|FAILED\b|={2,} FAILURES ={2,}|panic:|ERROR collecting|● )/.test(
    line,
  );
}

function isSummary(line: string, executable: string): boolean {
  if (executable === "bun")
    return /^(?:\d+ (?:pass|fail|skip|todo)|Ran \d+ tests?|error: \d+ unhandled)/.test(line);
  if (executable === "vitest")
    return /^(?:Test Files|Tests |Snapshots |Snapshots:|Projects? |Shards? |Attachments? |Retries? )/i.test(
      line,
    );
  if (executable === "jest") return /^(?:Test Suites:|Tests:|Snapshots:)/.test(line);
  if (executable === "pytest")
    return (
      /(?:\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed))(?:,| in|$)/.test(line) ||
      /^=+ short test summary/.test(line)
    );
  if (executable === "go") return /^(?:--- SKIP:|(?:ok|FAIL)\s+\S)/.test(line);
  return /^(?:\d+ (?:pass|fail|skip|todo)|Ran \d+ tests?|Tests?:|Test Files|Snapshots:|test result:|(?:ok|FAIL)\s+\S|=+ .* (?:passed|failed|error|skipped))/i.test(
    line,
  );
}

function isFailureSummary(line: string, executable: string): boolean {
  if (executable === "bun") return /^(?:[1-9]\d* fail|error: [1-9]\d* unhandled)/.test(line);
  if (["vitest", "jest"].includes(executable)) return /(?:^|\s)[1-9]\d* failed/.test(line);
  if (executable === "pytest") return /[1-9]\d* (?:failed|errors?)/.test(line);
  if (executable === "go") return /^FAIL\s+\S/.test(line);
  return /(?:[1-9]\d* fail|[1-9]\d* failed|FAIL\s+\S)/.test(line);
}

export function compressTests(input: BoundedText, executable = "unknown"): string {
  const { text, lines } = input;
  const selected = new Set<number>();
  const starts: number[] = [];
  let hasFailureSummary = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (isFailureStart(line, executable)) starts.push(index);
    if (isSummary(line, executable)) selected.add(index);
    if (isFailureSummary(line, executable)) hasFailureSummary = true;
  }
  if (hasFailureSummary && starts.length === 0) return text;
  for (let offset = 0; offset < starts.length; offset++) {
    const start = starts[offset];
    if (start === undefined || !input.budget.chargeRecords(1)) return text;
    const nextFailure = starts[offset + 1] ?? lines.length;
    let end = start;
    while (end + 1 < nextFailure) {
      const line = lines[end + 1] ?? "";
      if (/^progress \d+$/.test(line) || isSummary(line, executable)) break;
      end++;
    }
    const count = end - start + 1;
    if (!input.budget.chargeRecords(count)) return text;
    for (let index = start; index <= end; index++) selected.add(index);
  }
  if (selected.size === 0) return text;
  let rendered = renderGaps(
    input,
    selected,
    (start, end) => `... ${end - start + 1} lines omitted ...`,
  );
  if (rendered === undefined) return text;
  // Passing rows before the first retained failure and trailing rows after the final summary — a
  // coverage table, a runner epilogue — never reach a gap. They are still omitted rows and must be
  // stated rather than silently discarded.
  const indexes = [...selected];
  const leading = Math.min(...indexes);
  const trailing = lines.length - 1 - Math.max(...indexes);
  if (leading > 0) rendered = `... ${leading} lines omitted ...\n${rendered}`;
  if (trailing > 0) rendered = `${rendered}\n... ${trailing} lines omitted ...`;
  if (rendered.length > MAX_OUTPUT) return text;
  for (const start of starts) if (!rendered.includes(lines[start] ?? "")) return text;
  return rendered;
}
