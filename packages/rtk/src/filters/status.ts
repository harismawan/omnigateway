import { type BoundedText, MAX_OUTPUT } from "./shared.ts";

const HEADER = /^(?:## .+|On branch .+|HEAD detached at .+|HEAD detached from .+)$/;
const OPERATION =
  /^(?:(?:(?:interactive )?rebase|merge|cherry-pick|revert|bisect)(?: in progress| currently|ing|ing in progress| .*)|You are currently rebasing .+|All conflicts fixed but you are still merging\.)/i;
const CHATTER = /^ {2}\((?:use |fix conflicts|all conflicts|no commands remaining).+\)$/i;
const RELATION =
  /^(?:Your branch (?:is ahead of|is behind|and .+ have diverged).*[,.]|and have \d+ and \d+ different commits each, respectively\.)$/;
const SECTION =
  /^(?:Changes to be committed|Changes not staged for commit|Unmerged paths|Untracked files):$/;
const FINAL =
  /^(?:nothing to commit, working tree clean|no changes added to commit .+|nothing added to commit but untracked files present .+)$/;
const LONG_RECORD =
  /^\t(?:modified|deleted|new file|renamed|copied|both modified|both added|added by us|added by them|deleted by us|deleted by them):\s+.+$/;
const XY = new Set([
  " M",
  "M ",
  "MM",
  " A",
  "A ",
  "AM",
  " D",
  "D ",
  "DM",
  " R",
  "R ",
  "RM",
  " C",
  "C ",
  "CM",
  "??",
  "!!",
  "DD",
  "AU",
  "UD",
  "UA",
  "DU",
  "AA",
  "UU",
]);

function statusRecord(line: string): boolean {
  if (line.length < 3 || !XY.has(line.slice(0, 2))) return false;
  const separator = line[2];
  if (separator !== " " && separator !== "\t") return false;
  const path = line.slice(3);
  if (path.length === 0) return false;
  if (line[0] === "R" || line[1] === "R" || line[0] === "C" || line[1] === "C")
    return /^.+ -> .+$/.test(path);
  return true;
}

function append(input: BoundedText, output: string[], line: string): boolean {
  if (!input.budget.chargeRecords(1) || !input.budget.chargeCodeUnits(line.length)) return false;
  output.push(line);
  return true;
}

export function compressGitStatus(input: BoundedText): string {
  const output: string[] = [];
  let section: "tracked" | "untracked" | undefined;
  let long = false;
  let sawRecord = false;
  for (const line of input.lines) {
    if (line.length === 0) continue;
    if (!input.budget.chargeRecords(1)) return input.text;
    if (SECTION.test(line)) {
      long = true;
      section = line === "Untracked files:" ? "untracked" : "tracked";
      if (!append(input, output, line)) return input.text;
      continue;
    }
    if (HEADER.test(line) || RELATION.test(line) || OPERATION.test(line) || FINAL.test(line)) {
      if (!append(input, output, line)) return input.text;
      continue;
    }
    if (CHATTER.test(line)) continue;
    if (long) {
      const record = section === "untracked" ? /^\t\S.+$/.test(line) : LONG_RECORD.test(line);
      if (!record) return input.text;
      sawRecord = true;
      if (!append(input, output, line)) return input.text;
      continue;
    }
    if (!statusRecord(line)) return input.text;
    sawRecord = true;
    if (!append(input, output, line)) return input.text;
  }
  if (!sawRecord) return input.text;
  const rendered = output.join("\n");
  return rendered.length <= MAX_OUTPUT ? rendered : input.text;
}
