import { type BoundedText, MAX_OUTPUT } from "./shared.ts";

const LONG =
  /^[bcdlps-][rwxStTs-]{9}\s+\d+\s+\S+\s+\S+\s+\d+\s+\S+\s+\d+\s+(?:\d{2}:\d{2}|\d{4})\s+.+$/;
const SUMMARY = /^\d+ director(?:y|ies), \d+ files?$/;
const TREE_ROW = /^((?:│ {3}| {4})*)(├── |└── )(.+)$/;

type Group = { key: string; rows: string[]; entryCount: number };
type TreeNode = {
  key: string;
  line: string;
  classifiedDirectory: boolean;
  children: TreeNode[];
};
type TreeCount = { directories: number; entries: number; ambiguous: boolean };

function renderGroups(input: BoundedText, groups: readonly Group[]): string | undefined {
  const output: string[] = [];
  let omittedGroups = 0;
  let omittedEntries = 0;
  const append = (fragment: string): boolean => {
    if (!input.budget.chargeRecords(1) || !input.budget.chargeCodeUnits(fragment.length))
      return false;
    output.push(fragment);
    return true;
  };
  const flushOmitted = (): boolean => {
    if (omittedGroups === 0) return true;
    const marker = `... ${omittedGroups} ${omittedGroups === 1 ? "directory" : "directories"} omitted containing ${omittedEntries} ${omittedEntries === 1 ? "entry" : "entries"} ...`;
    omittedGroups = 0;
    omittedEntries = 0;
    return append(marker);
  };
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const group = groups[groupIndex];
    if (group === undefined || !input.budget.chargeRecords(1)) return undefined;
    const retain = groups.length <= 40 || groupIndex < 20 || groupIndex >= groups.length - 20;
    if (!retain) {
      omittedGroups++;
      omittedEntries += group.entryCount;
      continue;
    }
    if (!flushOmitted()) return undefined;
    const prefixCount = group.rows.length - group.entryCount;
    for (let rowIndex = 0; rowIndex < group.rows.length; rowIndex++) {
      const row = group.rows[rowIndex];
      if (row === undefined || !input.budget.chargeRecords(1)) return undefined;
      const entryIndex = rowIndex - prefixCount;
      const retainEntry =
        entryIndex < 0 ||
        group.entryCount <= 12 ||
        entryIndex < 6 ||
        entryIndex >= group.entryCount - 6;
      if (retainEntry && !append(row)) return undefined;
    }
    if (group.entryCount > 12) {
      const count = group.entryCount - 12;
      if (
        !append(`... ${count} ${count === 1 ? "entry" : "entries"} omitted from ${group.key} ...`)
      )
        return undefined;
    }
  }
  if (!flushOmitted()) return undefined;
  const rendered = output.join("\n");
  return rendered.length <= MAX_OUTPUT ? rendered : undefined;
}

function subtreeCounts(
  input: BoundedText,
  node: TreeNode,
  classified: boolean,
): TreeCount | undefined {
  if (!input.budget.chargeRecords(1)) return undefined;
  if (node.children.length === 0)
    return {
      directories: node.classifiedDirectory ? 1 : 0,
      entries: node.classifiedDirectory ? 0 : 1,
      ambiguous: !classified,
    };
  let directories = 1;
  let entries = 0;
  let ambiguous = false;
  for (const child of node.children) {
    const count = subtreeCounts(input, child, classified);
    if (count === undefined) return undefined;
    directories += count.directories;
    entries += count.entries;
    ambiguous ||= count.ambiguous;
  }
  return { directories, entries, ambiguous };
}

function appendSubtree(
  input: BoundedText,
  output: string[],
  node: TreeNode,
  classified: boolean,
): boolean {
  if (!input.budget.chargeRecords(1) || !input.budget.chargeCodeUnits(node.line.length))
    return false;
  output.push(node.line);
  const retainedValues =
    node.children.length <= 12
      ? node.children
      : [...node.children.slice(0, 6), ...node.children.slice(-6)];
  if (!input.budget.chargeRecords(retainedValues.length)) return false;
  const retained = new Set(retainedValues);
  let omitted: TreeNode[] = [];
  const flushOmitted = (): boolean => {
    if (omitted.length === 0) return true;
    let directories = 0;
    let entries = 0;
    let ambiguous = false;
    for (const child of omitted) {
      const count = subtreeCounts(input, child, classified);
      if (count === undefined) return false;
      directories += count.directories;
      entries += count.entries;
      ambiguous ||= count.ambiguous;
    }
    if (ambiguous) return false;
    const marker =
      directories === 0
        ? `... ${entries} ${entries === 1 ? "entry" : "entries"} omitted from ${node.key} ...`
        : `... ${directories} ${directories === 1 ? "directory" : "directories"} omitted containing ${entries} ${entries === 1 ? "entry" : "entries"} ...`;
    if (!input.budget.chargeCodeUnits(marker.length)) return false;
    output.push(marker);
    omitted = [];
    return true;
  };
  for (const child of node.children) {
    if (!input.budget.chargeRecords(1)) return false;
    if (!retained.has(child)) {
      omitted.push(child);
      continue;
    }
    if (!flushOmitted() || !appendSubtree(input, output, child, classified)) return false;
  }
  return flushOmitted();
}

function tree(input: BoundedText, lines: readonly string[], classified: boolean): string {
  const root = lines[0];
  const summary = lines.at(-1);
  if (
    lines.length < 3 ||
    root === undefined ||
    /[│├└]/.test(root) ||
    summary === undefined ||
    !SUMMARY.test(summary)
  )
    return input.text;
  if (!input.budget.chargeRecords(1) || !input.budget.chargeCodeUnits(root.length))
    return input.text;
  const rootNode: TreeNode = { key: root, line: root, classifiedDirectory: true, children: [] };
  const stack = [rootNode];
  for (const line of lines.slice(1, -1)) {
    const match = line.match(TREE_ROW);
    const depth = (match?.[1]?.length ?? -1) / 4;
    const parent = stack[depth];
    const name = match?.[3];
    if (!Number.isInteger(depth) || parent === undefined || name === undefined) return input.text;
    const plainName = name.replace(/ -> .+$/, "").replace(/[/@*=>|]$/, "");
    const key = `${parent.key}/${plainName}`;
    if (!input.budget.chargeRecords(3) || !input.budget.chargeCodeUnits(key.length))
      return input.text;
    const node: TreeNode = {
      key,
      line,
      classifiedDirectory: classified && name.endsWith("/"),
      children: [],
    };
    parent.children.push(node);
    stack.length = depth + 1;
    stack.push(node);
  }
  const output: string[] = [];
  if (!appendSubtree(input, output, rootNode, classified)) return input.text;
  if (!input.budget.chargeRecords(1) || !input.budget.chargeCodeUnits(summary.length))
    return input.text;
  output.push(summary);
  const rendered = output.join("\n");
  return rendered.length <= MAX_OUTPUT ? rendered : input.text;
}

function recursiveLs(input: BoundedText, long: boolean): string {
  const groups: Group[] = [];
  let current: Group | undefined;
  let sawTotal = false;
  for (const line of input.lines) {
    if (line.length === 0) continue;
    if (/^.+:$/.test(line)) {
      if (current !== undefined && ((long && !sawTotal) || current.entryCount === 0))
        return input.text;
      const key = line.slice(0, -1);
      if (!input.budget.chargeRecords(3) || !input.budget.chargeCodeUnits(key.length + line.length))
        return input.text;
      current = { key, rows: [line], entryCount: 0 };
      groups.push(current);
      sawTotal = false;
      continue;
    }
    if (current === undefined) return input.text;
    if (/^total \d+$/.test(line)) {
      if (!long || sawTotal || current.entryCount > 0) return input.text;
      if (!input.budget.chargeRecords(1) || !input.budget.chargeCodeUnits(line.length))
        return input.text;
      current.rows.push(line);
      sawTotal = true;
      continue;
    }
    if ((long && (!sawTotal || !LONG.test(line))) || (!long && !/^[^/\\:\n]+$/.test(line)))
      return input.text;
    if (!input.budget.chargeRecords(1) || !input.budget.chargeCodeUnits(line.length))
      return input.text;
    current.rows.push(line);
    current.entryCount++;
  }
  if (current === undefined || (long && !sawTotal) || current.entryCount === 0) return input.text;
  return renderGroups(input, groups) ?? input.text;
}

const RELATIVE_PATH = /^(?![[{`|])(?!.+:\d+(?::|$))[^\s:\n]+(?:[/\\][^\s:\n]+)*$/;
// Command-gated listings treat spaces, tabs, and Unicode as filename data, so the strict
// whitespace-free grammar above cannot be reused. These guards reject everything that could be
// mistaken for a path once whitespace is legal.
const GATED_PROSE = /\s(?:is|are|the|this|that|because|and|with|from|into|were)\s/i;
const GATED_TABLE = /^\|.*\|$/;
const GATED_STRUCTURE = /^(?:```|\{|\[|`|\|)/;
const GATED_DRIVE = /^[A-Za-z]:[/\\]/;

// Tab is the only control character legal as filename data; anything else means the row is not a
// plain listing entry. Scanned rather than matched so no control literal enters a regex.
function hasIllegalControl(line: string): boolean {
  for (let index = 0; index < line.length; index++) {
    const code = line.charCodeAt(index);
    if (code === 9) continue;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function gatedPath(line: string): boolean {
  if (line.length === 0 || hasIllegalControl(line)) return false;
  if (line !== line.trim()) return false;
  if (GATED_STRUCTURE.test(line) || GATED_TABLE.test(line) || GATED_PROSE.test(line)) return false;
  // A colon is only ever legal as a Windows drive separator; anything else is a diagnostic
  // coordinate, a recursive-listing heading, or a locale-specific message.
  const drive = GATED_DRIVE.test(line);
  if (line.indexOf(":", drive ? 2 : 0) >= 0) return false;
  // Whitespace is only filename data inside a path; a bare whitespace-separated phrase is prose or
  // a table row, not a listing entry.
  const separator = line.search(/[/\\]/);
  if (separator < 0) return !/\s/.test(line);
  // The leading segment becomes part of the group key, so it must be a single path component. Prose
  // that merely mentions a path ("Permission denied for /var/log") has whitespace ahead of its first
  // separator and would otherwise be grouped under a nonsense dirname.
  return !/\s/.test(line.slice(0, separator));
}

function paths(input: BoundedText, commandGated: boolean): string {
  const groups = new Map<string, Group>();
  const ordered: Group[] = [];
  for (const line of input.lines) {
    if (line.length === 0) continue;
    if (!(commandGated ? gatedPath(line) : RELATIVE_PATH.test(line))) return input.text;
    const separator = Math.max(line.lastIndexOf("/"), line.lastIndexOf("\\"));
    const key = separator < 0 ? "." : line.slice(0, separator) || ".";
    let group = groups.get(key);
    if (group === undefined) {
      // Charge the group key once, when it is actually retained, instead of on every row that
      // resolves to it. Charging per row cost the parser its whole budget on nested listings.
      if (!input.budget.chargeRecords(2) || !input.budget.chargeCodeUnits(key.length))
        return input.text;
      group = { key, rows: [], entryCount: 0 };
      groups.set(key, group);
      ordered.push(group);
    }
    if (!input.budget.chargeRecords(1)) return input.text;
    group.rows.push(line);
    group.entryCount++;
  }
  if (ordered.length === 0) return input.text;
  return renderGroups(input, ordered) ?? input.text;
}

function longLs(input: BoundedText): string {
  let header: string | undefined;
  const rows: string[] = [];
  for (const line of input.lines) {
    if (line.length === 0) continue;
    if (/^total \d+$/.test(line)) {
      if (header !== undefined || rows.length > 0) return input.text;
      if (!input.budget.chargeRecords(1) || !input.budget.chargeCodeUnits(line.length))
        return input.text;
      header = line;
      continue;
    }
    if (header === undefined || !LONG.test(line)) return input.text;
    if (!input.budget.chargeRecords(1)) return input.text;
    rows.push(line);
  }
  if (header === undefined || rows.length === 0) return input.text;
  const rendered = renderGroups(input, [{ key: ".", rows, entryCount: rows.length }]);
  if (rendered === undefined) return input.text;
  const output = `${header}\n${rendered}`;
  return output.length <= MAX_OUTPUT ? output : input.text;
}

function nonemptyLines(input: BoundedText): readonly string[] | undefined {
  const lines: string[] = [];
  for (const line of input.lines) {
    if (line.length === 0) continue;
    if (!input.budget.chargeRecords(1)) return undefined;
    lines.push(line);
  }
  return lines;
}

export function compressListing(
  input: BoundedText,
  executable: string,
  subcommand?: string,
  commandGated = false,
): string {
  if (executable === "ls" && subcommand === "recursive-long") return recursiveLs(input, true);
  if (executable === "ls" && subcommand === "recursive-plain") return recursiveLs(input, false);
  if (executable === "ls") return longLs(input);
  if (executable === "tree") {
    const lines = nonemptyLines(input);
    if (lines === undefined) return input.text;
    return tree(input, lines, subcommand === "classified");
  }
  return paths(input, commandGated);
}
