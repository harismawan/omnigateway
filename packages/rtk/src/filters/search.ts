import type { GrepMode } from "../command.ts";
import { type BoundedText, MAX_OUTPUT } from "./shared.ts";

type Record = { kind: "heading" | "match" | "context" | "separator"; text: string };
type MatchGroup = { file: string; records: Record[]; matches: number };
const FULL = /^((?:[A-Za-z]:\\[^\n:]+|[^\n:]+)):(\d+):(.+)$/;
const CONTEXT = /^((?:[A-Za-z]:\\[^\n]+|[^\n]+))-(\d+)-(.+)$/;
const HEADING_MATCH = /^\d+:.+$/;
const HEADING_CONTEXT = /^\d+-.+$/;
const PATH = /^(?:[A-Za-z]:\\|[./~])?[^\n:]+$/;

function retainedRecords(
  group: MatchGroup,
  mode: GrepMode,
): { records: Record[]; omittedMatches: number } {
  const matches = group.records.flatMap((record, index) =>
    record.kind === "match" ? [index] : [],
  );
  const retained = new Set(
    matches.length <= 12 ? matches : [...matches.slice(0, 6), ...matches.slice(-6)],
  );
  const selected = new Set<number>();
  for (const match of retained) {
    selected.add(match);
    for (let index = match - 1; index >= 0; index--) {
      const record = group.records[index];
      if (record?.kind === "match") break;
      if (record?.kind === "separator") selected.add(index);
    }
    for (let index = match + 1; index < group.records.length; index++) {
      const record = group.records[index];
      if (record?.kind === "match") break;
      if (record?.kind === "separator") selected.add(index);
    }
    let before = mode.beforeContext;
    for (let index = match - 1; index >= 0 && before > 0; index--) {
      const record = group.records[index];
      if (record?.kind === "match") break;
      if (record?.kind === "context") before--;
      if (record !== undefined) selected.add(index);
    }
    let after = mode.afterContext;
    for (let index = match + 1; index < group.records.length && after > 0; index++) {
      const record = group.records[index];
      if (record?.kind === "match") break;
      if (record?.kind === "context") after--;
      if (record !== undefined) selected.add(index);
    }
  }
  for (let index = 0; index < group.records.length; index++)
    if (group.records[index]?.kind === "heading") selected.add(index);
  return {
    records: group.records.filter((_, index) => selected.has(index)),
    omittedMatches: matches.length - retained.size,
  };
}

function render(
  input: BoundedText,
  groups: readonly MatchGroup[],
  mode: GrepMode,
): string | undefined {
  if (!input.budget.chargeRecords(groups.length)) return undefined;
  const base = groups.length <= 40 ? groups : [...groups.slice(0, 20), ...groups.slice(-20)];
  const retained = new Set(base);
  for (const group of groups) if (group.matches === 1) retained.add(group);
  const output: string[] = [];
  let omitted: MatchGroup[] = [];
  const flushOmitted = () => {
    if (omitted.length === 0) return;
    const matches = omitted.reduce((sum, group) => sum + group.matches, 0);
    output.push(
      `... ${omitted.length} ${omitted.length === 1 ? "file" : "files"} omitted containing ${matches} ${matches === 1 ? "match" : "matches"} ...`,
    );
    omitted = [];
  };
  for (const group of groups) {
    if (!retained.has(group)) {
      omitted.push(group);
      continue;
    }
    flushOmitted();
    const selection = retainedRecords(group, mode);
    if (!input.budget.chargeRecords(selection.records.length)) return undefined;
    output.push(...selection.records.map((record) => record.text));
    if (selection.omittedMatches > 0) {
      const unit = selection.omittedMatches === 1 ? "match" : "matches";
      output.push(`... ${selection.omittedMatches} ${unit} omitted from ${group.file} ...`);
    }
  }
  flushOmitted();
  const content = output.join("\n");
  return input.budget.chargeCodeUnits(content.length) && content.length <= MAX_OUTPUT
    ? content
    : undefined;
}

export function compressGrep(input: BoundedText, mode: GrepMode): string {
  const groups = new Map<string, MatchGroup>();
  let heading: string | undefined;
  let activeFile: string | undefined;
  let pendingSeparator = false;
  for (const line of input.lines) {
    if (line === "--") {
      if (activeFile === undefined || pendingSeparator) return input.text;
      pendingSeparator = true;
      continue;
    }
    if (
      mode.heading &&
      PATH.test(line) &&
      !HEADING_MATCH.test(line) &&
      !HEADING_CONTEXT.test(line)
    ) {
      heading = line;
      activeFile = line;
      const group = groups.get(line) ?? { file: line, records: [], matches: 0 };
      if (!input.budget.chargeRecords(1)) return input.text;
      group.records.push({ kind: "heading", text: line });
      groups.set(line, group);
      continue;
    }
    const full = line.match(FULL);
    const context = mode.beforeContext > 0 || mode.afterContext > 0 ? line.match(CONTEXT) : null;
    const file = mode.heading ? heading : (full?.[1] ?? context?.[1]);
    const matched = mode.heading ? HEADING_MATCH.test(line) : full !== null;
    const validContext = mode.heading
      ? (mode.beforeContext > 0 || mode.afterContext > 0) && HEADING_CONTEXT.test(line)
      : context !== null;
    if (file === undefined || (!matched && !validContext)) return input.text;
    if (pendingSeparator && file !== activeFile) return input.text;
    const group = groups.get(file) ?? { file, records: [], matches: 0 };
    const addedRecords = pendingSeparator ? 2 : 1;
    if (!input.budget.chargeRecords(addedRecords)) return input.text;
    if (pendingSeparator) group.records.push({ kind: "separator", text: "--" });
    group.records.push({ kind: matched ? "match" : "context", text: line });
    if (matched) group.matches++;
    groups.set(file, group);
    activeFile = file;
    pendingSeparator = false;
  }
  if (groups.size === 0 || pendingSeparator) return input.text;
  return render(input, [...groups.values()], mode) ?? input.text;
}
