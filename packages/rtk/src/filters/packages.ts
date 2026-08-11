import { type BoundedText, MAX_OUTPUT, renderGaps } from "./shared.ts";

type PackageBlock = { start: number; end: number; severity: "error" | "warning"; identity: string };

const MUTATION =
  /(?:^|\s)(?:added|removed|updated|upgraded|downgraded|installed)\s+\S|lockfile|package-lock|blocked.*script|postinstall|lifecycle|vulnerabilit|peer.*conflict|resolution.*conflict|generated\s+\S/i;
const SUMMARY =
  /(?:installed|added|removed|updated|audited) \d+ packages?|found \d+ vulnerabilities|Saved lockfile/i;
const PROGRESS =
  /^(?:download|Resolving|Progress:|Packages:|Fetching|Downloaded|Using cached|Collecting)\b/i;

function diagnosticStart(line: string, executable: string): "error" | "warning" | undefined {
  const lower = line.toLowerCase();
  if (executable === "npm" && /^npm (?:warn|warning|error)\b/.test(lower))
    return lower.startsWith("npm error") ? "error" : "warning";
  if (executable === "pnpm" && /^(?:warn(?:ing)?\b|err_pnpm_|error\b)/i.test(line))
    return /^(?:err_pnpm_|error\b)/i.test(line) ? "error" : "warning";
  if (executable === "yarn" && /^YN\d{4}:/.test(line))
    return /^YN(?:0009|0018|0028):/.test(line) ? "error" : "warning";
  if (["cargo", "uv", "bun"].includes(executable) && /^(?:warning|error):/i.test(line))
    return /^error:/i.test(line) ? "error" : "warning";
  if (executable === "pip" && /^(?:WARNING|ERROR):/.test(line))
    return line.startsWith("ERROR") ? "error" : "warning";
  return undefined;
}

function stableIdentity(line: string, executable: string, severity: "error" | "warning"): string {
  let normalized = line;
  if (executable === "npm") {
    normalized = normalized
      .replace(/^npm (?:warn|warning|error)\s+/i, "")
      .replace(/^\[\d+\/\d+\]\s+/, "")
      .replace(/^workspace\s+[^:]+:\s*/i, "");
  } else if (executable === "pnpm") {
    normalized = normalized.replace(/^(?:WARN(?:ING)?|ERR_PNPM_[A-Z_]+|ERROR)\s+/i, "");
  } else if (executable === "yarn") {
    normalized = normalized.replace(/^(YN\d{4}:)\s*(?:\[[^\]]+\]\s*)?/, "$1 ");
  } else {
    normalized = normalized.replace(/^(?:warning|error):\s*/i, "");
  }
  return `${executable}\u0000${severity}\u0000${normalized}`;
}

function blocks(input: BoundedText, executable: string): PackageBlock[] | undefined {
  const { lines } = input;
  const result: PackageBlock[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const severity = diagnosticStart(line, executable);
    if (severity === undefined) {
      if (
        /^(?:DIAGNOSTIC|WARN(?:ING)?|ERR(?:OR)?|npm (?!install\b)|YN\d{4}:)/i.test(line) &&
        !PROGRESS.test(line)
      )
        return undefined;
      continue;
    }
    let end = index;
    while (end + 1 < lines.length) {
      const continuation = lines[end + 1] ?? "";
      if (SUMMARY.test(continuation) || PROGRESS.test(continuation)) break;
      const nextSeverity = diagnosticStart(continuation, executable);
      if (nextSeverity !== undefined) {
        const continuationMessage = continuation.replace(/^npm (?:warn|error)\s+/i, "");
        if (!/^(?:required by|While resolving|Found:|Could not resolve)/i.test(continuationMessage))
          break;
      } else if (!/^(?:\s|Caused by:|note:|help:)/i.test(continuation)) {
        break;
      }
      end++;
    }
    if (!input.budget.chargeRecords(1)) return undefined;
    const identity = stableIdentity(line, executable, severity);
    if (!input.budget.chargeCodeUnits(identity.length)) return undefined;
    result.push({ start: index, end, severity, identity });
    index = end;
  }
  return result;
}

export function compressPackages(input: BoundedText, executable: string): string {
  const { text, lines } = input;
  const parsed = blocks(input, executable);
  if (parsed === undefined) return text;
  const byIdentity = new Map<string, PackageBlock>();
  for (const block of parsed) {
    if (byIdentity.has(block.identity)) continue;
    if (!input.budget.chargeRecords(1)) return text;
    byIdentity.set(block.identity, block);
  }
  if (!input.budget.chargeRecords(byIdentity.size)) return text;
  const unique = [...byIdentity.values()];
  const errors = unique.filter((block) => block.severity === "error");
  const warnings = unique.filter((block) => block.severity === "warning");
  const selected = new Set<number>();
  for (const block of [...errors, ...warnings.slice(0, 20)])
    for (let index = block.start; index <= block.end; index++) {
      if (!input.budget.chargeRecords(1)) return text;
      selected.add(index);
    }
  const diagnosticRows = new Set<number>();
  for (const block of parsed)
    for (let index = block.start; index <= block.end; index++) {
      if (!input.budget.chargeRecords(1)) return text;
      diagnosticRows.add(index);
    }
  for (let index = 0; index < lines.length; index++)
    if (
      !diagnosticRows.has(index) &&
      (MUTATION.test(lines[index] ?? "") || SUMMARY.test(lines[index] ?? ""))
    )
      selected.add(index);
  if (selected.size === 0 || !lines.some((line) => SUMMARY.test(line))) return text;
  // Rows of a unique warning the 20-entry cap dropped. Each such block is counted once under the
  // warning unit at the gap holding its first row; every other omitted row — duplicate-identity
  // blocks the cap never counted, progress chatter, funding epilogues — counts once under the line
  // unit. Previously the gap labeller reported those rows as lines and an appended marker reported
  // the same rows again as warnings.
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
  // Rows before the first and after the last selected index never reach a gap. Trailing funding or
  // audit-advice chatter after the manager summary is still omitted and must be stated.
  const indexes = [...selected];
  const leading = describe(0, Math.min(...indexes));
  const trailing = describe(Math.max(...indexes) + 1, lines.length);
  if (leading !== undefined) rendered = `${leading}\n${rendered}`;
  if (trailing !== undefined) rendered = `${rendered}\n${trailing}`;
  if (rendered.length > MAX_OUTPUT) return text;
  for (const block of errors)
    for (let index = block.start; index <= block.end; index++)
      if (!rendered.includes(lines[index] ?? "")) return text;
  return rendered;
}
