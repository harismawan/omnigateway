import {
  type ChatRequest,
  type ContentBlock,
  estimateInputTokens,
  type ToolUseBlock,
} from "@omni/ir";
import type { RtkFilterId } from "./catalog.ts";
import { type CommandClassification, classifyCommand } from "./command.ts";
import { inferBuildOrTest } from "./detect.ts";
import { compressBuild } from "./filters/build.ts";
import { compressDiagnostics } from "./filters/diagnostics.ts";
import { compressDocker } from "./filters/docker.ts";
import {
  compressGitOperation,
  GIT_DIFF_ANCHOR,
  GIT_DIFF_EVIDENCE_HEADER,
  GIT_DIFF_EVIDENCE_PAIR,
  GIT_LOG_ANCHOR,
  GIT_LOG_EVIDENCE_BODY,
  GIT_LOG_EVIDENCE_COMMIT,
} from "./filters/git.ts";
import { compressListing } from "./filters/listings.ts";
import { compressPackages } from "./filters/packages.ts";
import { compressGrep } from "./filters/search.ts";
import { type BoundedText, renderSelection, scanText } from "./filters/shared.ts";
import { compressGitStatus } from "./filters/status.ts";
import { compressTests } from "./filters/tests.ts";

export type { RtkFilterId } from "./catalog.ts";

export type RtkConfig = { enabled: boolean };
export type RtkReport = {
  applied: boolean;
  filterHits: number;
  originalCodeUnits: number;
  compressedCodeUnits: number;
  estimatedTokensSaved: number;
  filters: RtkFilterId[];
  skippedInternalErrors: number;
};
export type RtkTransformResult = { request: ChatRequest; report: RtkReport };

type Origin = "shell" | "non-shell" | "unknown";
type FilterResult = { content: string; filters: RtkFilterId[] };

const MIN_INPUT = 500;
const MAX_INPUT = 1_000_000;
const MAX_OUTPUT = 250_000;
const SHELL = new Set(["bash", "shell", "terminal", "exec", "run_command", "execute_command"]);
const NON_SHELL = new Set([
  "read",
  "edit",
  "write",
  "glob",
  "grep_search",
  "search",
  "web_search",
  "web_fetch",
  "read_file",
  "list_directory",
  "find_files",
  "code_search",
  "apply_patch",
]);

function emptyReport(errors = 0): RtkReport {
  return {
    applied: false,
    filterHits: 0,
    originalCodeUnits: 0,
    compressedCodeUnits: 0,
    estimatedTokensSaved: 0,
    filters: [],
    skippedInternalErrors: errors,
  };
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-./\s]+/g, "_");
}

function originOf(tool: ToolUseBlock | undefined): Origin {
  if (tool === undefined) return "unknown";
  const name = normalizeName(tool.name);
  if (SHELL.has(name)) return "shell";
  if (NON_SHELL.has(name)) return "non-shell";
  return "unknown";
}

export function extractCommand(input: unknown): string | undefined {
  if (typeof input === "string") return input.length === 0 ? undefined : input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  if (Object.getPrototypeOf(input) !== Object.prototype) return undefined;
  const object = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "script"] as const) {
    if (!Object.hasOwn(object, key)) continue;
    const value = object[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function prefix(lines: readonly string[]): string {
  return lines.slice(0, 64).join("\n").slice(0, 4_096);
}

function sampleRows(lines: readonly string[]): readonly string[] {
  return lines.length <= 128 ? lines : [...lines.slice(0, 64), ...lines.slice(-64)];
}

type Detection = { id: RtkFilterId; classification?: CommandClassification };

function detect(
  input: BoundedText,
  command: string | undefined,
  origin: Origin,
): Detection | undefined {
  const { lines } = input;
  const sample = prefix(lines);
  const classification =
    origin === "shell" && command !== undefined ? classifyCommand(command) : undefined;
  if (origin === "shell" && command !== undefined && classification === undefined) return undefined;
  // A successful classification owns the family outright — including for the generic reads (`cat`,
  // `sed`, `head`, `tail`, `awk`, `nl`, `find`, `git ls-files`), whose commands say nothing about
  // what the bytes mean. Deciding "is this block a diff?" from shape alone is genuinely ambiguous:
  // every threshold tried misclassified some real document (YAML, stack traces, indented Markdown
  // code, tree text, pipe tables) into a Git retainer that keeps only its own anchor rows. So
  // `cat patch.diff` now compresses as a numbered read, or not at all, and never as `git-diff`.
  // Output-shape Git detection below remains for unknown-origin blocks, where no command exists to
  // own the decision and the spec explicitly sanctions inference.
  if (classification !== undefined) return { id: classification.family, classification };
  if (GIT_DIFF_EVIDENCE_HEADER.test(sample) && GIT_DIFF_EVIDENCE_PAIR.test(sample))
    return { id: "git-diff" };
  if (
    /^(?:On branch |## |Changes |Untracked files:)/m.test(sample) &&
    /^(?:[ MADRCU?!]{2} |\s+(?:modified|deleted|new file):)/m.test(sample)
  )
    return { id: "git-status" };
  if (GIT_LOG_EVIDENCE_COMMIT.test(sample) && GIT_LOG_EVIDENCE_BODY.test(sample))
    return { id: "git-log" };

  if (origin === "unknown") {
    const inferred = inferBuildOrTest(sampleRows(lines));
    if (inferred !== undefined) return { id: inferred };
  }
  const inferredGrepRows = lines.filter((line) => /^(?:[A-Za-z]:\\.+|[^\n:]+):\d+:.+$/.test(line));
  if (
    origin === "unknown" &&
    inferredGrepRows.length >= 3 &&
    inferredGrepRows.length / Math.max(1, lines.filter((line) => line.length > 0).length) >= 0.8
  )
    return {
      id: "grep",
      classification: {
        family: "grep",
        executable: "inferred",
        grepMode: { heading: false, lineNumber: true, beforeContext: 0, afterContext: 0 },
      },
    };
  let candidates = 0;
  let pathLines = 0;
  let conflicts = 0;
  for (const line of lines) {
    if (line.length === 0) continue;
    candidates++;
    if (/^(?![[{`|])(?!.+:\d+(?::|$))[^\s:\n]+(?:[/\\][^\s:\n]+)*$/.test(line)) pathLines++;
    if (/\s(?:is|are|the|this|that)\s/i.test(line) || /^(?:```|\{|\[)|\|.+\|$/.test(line))
      conflicts++;
  }
  // Every branch below this point is unreachable with a classification in hand, so no shape branch
  // can carry one; they are unknown-origin inference only.
  if (candidates >= 10 && pathLines / candidates >= 0.8 && conflicts / candidates <= 0.1)
    return { id: "path-list" };
  if (origin === "shell" && (sample.match(/^\s*\d+[\t |:].+$/gm)?.length ?? 0) >= 10)
    return { id: "numbered-read" };
  return undefined;
}

function keepRegions(input: BoundedText, head: number, tail: number): string {
  const selected = new Set<number>();
  if (!input.budget.chargeRecords(head + tail)) return input.text;
  for (let index = 0; index < Math.min(head, input.lines.length); index++) selected.add(index);
  for (let index = Math.max(head, input.lines.length - tail); index < input.lines.length; index++)
    selected.add(index);
  return renderSelection(input, selected) ?? input.text;
}

function deduplicate(input: BoundedText): string {
  const selected = new Set<number>();
  let previous: string | undefined;
  for (let index = 0; index < input.lines.length; index++) {
    const line = input.lines[index] ?? "";
    if (line === previous) continue;
    if (!input.budget.chargeRecords(1)) return input.text;
    selected.add(index);
    previous = line;
  }
  return renderSelection(input, selected) ?? input.text;
}

function keepAnchors(
  input: BoundedText,
  isAnchor: (line: string) => boolean,
  head: number,
  tail: number,
): string {
  const selected = new Set<number>();
  for (let index = 0; index < input.lines.length; index++) {
    if (index < head || index >= input.lines.length - tail || isAnchor(input.lines[index] ?? "")) {
      if (!input.budget.chargeRecords(1)) return input.text;
      selected.add(index);
    }
  }
  return renderSelection(input, selected) ?? input.text;
}

function specialized(
  input: BoundedText,
  id: RtkFilterId,
  classification?: CommandClassification,
): string {
  const { text: content, lines } = input;
  if (id === "git-status") return compressGitStatus(input);
  if (id === "lint-output") return compressDiagnostics(input);
  if (id === "build-output") return compressBuild(input);
  if (id === "test-output") return compressTests(input, classification?.executable);
  if (id === "package-output")
    return compressPackages(input, classification?.executable ?? "unknown");
  if (id === "git-operation") return compressGitOperation(input);
  if (id === "docker-build") return compressDocker(input);
  if (id === "tree-output" || id === "path-list")
    return compressListing(
      input,
      classification?.executable ?? "find",
      classification?.subcommand,
      classification !== undefined,
    );
  if (id === "grep" && classification?.grepMode !== undefined)
    return compressGrep(input, classification.grepMode);
  if (!input.budget.chargeRecords(lines.length)) return content;
  switch (id) {
    case "git-diff":
      return keepAnchors(input, (line) => GIT_DIFF_ANCHOR.test(line), 20, 12);
    case "git-log":
      return keepAnchors(input, (line) => GIT_LOG_ANCHOR.test(line), 20, 12);
    case "grep":
      return keepRegions(input, 40, 20);
    case "numbered-read":
      return lines.length >= 250 ? keepRegions(input, 100, 50) : content;
    case "deduplicate-log":
      return deduplicate(input);
    case "smart-truncate":
      return keepRegions(input, 200, 100);
  }
}

function accept(original: string, candidate: string): string | undefined {
  return candidate.length > 0 &&
    candidate.length < original.length &&
    candidate.length <= MAX_OUTPUT
    ? candidate
    : undefined;
}

function filter(
  input: BoundedText,
  origin: Origin,
  command: string | undefined,
): FilterResult | undefined {
  const { text: content, lines } = input;
  const detection = detect(input, command, origin);
  if (detection !== undefined) {
    const { id, classification } = detection;
    const first = accept(content, specialized(input, id, classification));
    if (first === undefined) return undefined;
    return { content: first, filters: [id] };
  }
  if (origin !== "shell") return undefined;
  if (lines.length >= 20) {
    const compact = accept(content, deduplicate(input));
    if (compact !== undefined) return { content: compact, filters: ["deduplicate-log"] };
  }
  if (lines.length >= 500) {
    const compact = accept(content, specialized(input, "smart-truncate"));
    if (compact !== undefined) return { content: compact, filters: ["smart-truncate"] };
  }
  return undefined;
}

export function transformRequest(request: ChatRequest, config: RtkConfig): RtkTransformResult {
  if (!config.enabled) return { request, report: emptyReport() };
  try {
    const uses = new Map<string, ToolUseBlock>();
    let changed = false;
    let originalCodeUnits = 0;
    let compressedCodeUnits = 0;
    let filterHits = 0;
    let skippedInternalErrors = 0;
    const filterOrder: RtkFilterId[] = [];
    const messages = request.messages.map((message) => {
      let messageChanged = false;
      const content = message.content.map((block): ContentBlock => {
        if (block.type === "toolUse") {
          uses.set(block.id, block);
          return block;
        }
        if (
          block.type !== "toolResult" ||
          block.isError === true ||
          block.cacheControl !== undefined ||
          block.content.length < MIN_INPUT ||
          block.content.length > MAX_INPUT
        )
          return block;
        const use = uses.get(block.toolUseId);
        const origin = originOf(use);
        if (origin === "non-shell") return block;
        try {
          const command =
            origin === "shell" && use !== undefined ? extractCommand(use.input) : undefined;
          const bounded = scanText(block.content);
          if (bounded === undefined) return block;
          const result = filter(bounded, origin, command);
          if (result === undefined) return block;
          changed = true;
          messageChanged = true;
          originalCodeUnits += block.content.length;
          compressedCodeUnits += result.content.length;
          filterHits += result.filters.length;
          for (const id of result.filters) if (!filterOrder.includes(id)) filterOrder.push(id);
          return { ...block, content: result.content };
        } catch {
          skippedInternalErrors++;
          return block;
        }
      });
      return messageChanged ? { ...message, content } : message;
    });
    if (!changed) return { request, report: { ...emptyReport(), skippedInternalErrors } };
    const transformed = { ...request, messages };
    return {
      request: transformed,
      report: {
        applied: true,
        filterHits,
        originalCodeUnits,
        compressedCodeUnits,
        estimatedTokensSaved: Math.max(
          0,
          estimateInputTokens(request) - estimateInputTokens(transformed),
        ),
        filters: filterOrder,
        skippedInternalErrors,
      },
    };
  } catch {
    return { request, report: emptyReport(1) };
  }
}
