import {
  type ChatRequest,
  type ContentBlock,
  estimateInputTokens,
  type ToolUseBlock,
} from "@omni/ir";

export type RtkFilterId =
  | "git-diff"
  | "git-status"
  | "git-log"
  | "grep"
  | "path-list"
  | "numbered-read"
  | "build-output"
  | "test-output"
  | "deduplicate-log"
  | "smart-truncate";

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

function prefix(content: string): string {
  return content.slice(0, 4_096).split(/\r?\n/, 64).join("\n");
}

function hasAtLeast(sample: string, patterns: readonly RegExp[], count: number): boolean {
  let matches = 0;
  for (const pattern of patterns) {
    if (pattern.test(sample)) matches++;
    if (matches >= count) return true;
  }
  return false;
}

function detect(
  content: string,
  command: string | undefined,
  origin: Origin,
): RtkFilterId | undefined {
  const sample = prefix(content);
  const cmd = command?.trim().toLowerCase() ?? "";
  if (cmd.startsWith("git diff") || /^diff --git /m.test(sample)) return "git-diff";
  if (
    cmd.startsWith("git status") ||
    /^On branch |^Changes (?:not staged|to be committed)/m.test(sample)
  )
    return "git-status";
  if (cmd.startsWith("git log") || /^commit [0-9a-f]{7,}/m.test(sample)) return "git-log";

  const buildCommand =
    /^(?:bun (?:run|build|install)|npm (?:run|install)|cargo (?:build|check)|tsc\b)/.test(cmd);
  const buildOutput = hasAtLeast(
    sample,
    [
      /^\$?\s*bun (?:run|build|install)\b/m,
      /(?:^|\n)(?:Bundled |Compiling |installed \d+ packages)/m,
      /(?:^|\n)(?:error(?:\[|:)|warning:)/m,
      /(?:build (?:failed|completed|finished)|Finished .+ target)/m,
    ],
    2,
  );
  if (buildCommand || buildOutput) return "build-output";

  const testCommand = /^(?:bun test|npm test|cargo test)\b/.test(cmd);
  const testOutput = hasAtLeast(
    sample,
    [
      /(?:^|\n)(?:bun test|npm test|cargo test|TAP version)\b/m,
      /(?:^|\n)(?:\d+ pass|Tests?:\s+\d+|test result:)/m,
      /(?:^|\n)(?:\d+ fail|FAIL\b|failed tests?)/m,
    ],
    2,
  );
  if (testCommand || testOutput) return "test-output";
  if ((sample.match(/^[^\n:]+:\d+:.+$/gm)?.length ?? 0) >= 3) return "grep";
  if ((sample.match(/^(?:[./~]|[A-Za-z]:\\)[^\n]+$/gm)?.length ?? 0) >= 5) return "path-list";
  if (origin === "shell" && (sample.match(/^\s*\d+[\t |:].+$/gm)?.length ?? 0) >= 10)
    return "numbered-read";
  return undefined;
}

function marker(count: number): string {
  return `... ${count} lines omitted ...`;
}

function keepRegions(lines: string[], head: number, tail: number): string {
  if (lines.length <= head + tail + 1) return lines.join("\n");
  return [...lines.slice(0, head), marker(lines.length - head - tail), ...lines.slice(-tail)].join(
    "\n",
  );
}

function deduplicate(content: string): string {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  let run = 0;
  let previous: string | undefined;
  for (const line of lines) {
    if (line === previous) {
      run++;
      continue;
    }
    if (run > 0) out.push(marker(run));
    if (!(line.length === 0 && previous?.length === 0)) out.push(line);
    previous = line;
    run = 0;
  }
  if (run > 0) out.push(marker(run));
  return out.join("\n");
}

function keepAnchors(
  lines: string[],
  isAnchor: (line: string) => boolean,
  head: number,
  tail: number,
): string {
  if (lines.length <= head + tail + 1) return lines.join("\n");
  const kept = new Set<number>();
  for (let i = 0; i < head; i++) kept.add(i);
  for (let i = Math.max(head, lines.length - tail); i < lines.length; i++) kept.add(i);
  for (let i = head; i < lines.length - tail; i++) {
    const line = lines[i];
    if (line === undefined || !isAnchor(line)) continue;
    kept.add(i);
    if (i > 0) kept.add(i - 1);
    if (i + 1 < lines.length) kept.add(i + 1);
  }

  const output: string[] = [];
  let previous = -1;
  for (const index of [...kept].sort((a, b) => a - b)) {
    if (previous >= 0 && index > previous + 1) output.push(marker(index - previous - 1));
    const line = lines[index];
    if (line !== undefined) output.push(line);
    previous = index;
  }
  return output.join("\n");
}

function specialized(content: string, id: RtkFilterId): string {
  const lines = content.split(/\r?\n/);
  switch (id) {
    case "git-diff":
      return keepAnchors(
        lines,
        (line) => /^(?:diff --git |--- |\+\+\+ |@@ |[-+](?![-+])| .+files? changed)/.test(line),
        20,
        12,
      );
    case "git-status":
      return keepAnchors(
        lines,
        (line) =>
          /^(?:On branch |Changes |Untracked files:|\s+(?:modified|deleted|new file):)/.test(line),
        20,
        12,
      );
    case "git-log":
      return keepAnchors(
        lines,
        (line) => /^(?:commit [0-9a-f]+|Author:|Date:|\s{4}\S| .+files? changed)/.test(line),
        20,
        12,
      );
    case "grep":
    case "path-list":
      return keepRegions(lines, 40, 20);
    case "numbered-read":
      return lines.length >= 250 ? keepRegions(lines, 100, 50) : content;
    case "build-output":
      return keepAnchors(
        lines,
        (line) => /(?:\berror(?:\[|:)|\bwarning:|failed|panic|at .+?:\d+|.+?:\d+:\d+)/i.test(line),
        35,
        20,
      );
    case "test-output":
      return keepAnchors(
        lines,
        (line) => /(?:\bFAIL\b|\bfail(?:ed)?\b|\berror\b|at .+?:\d+|\d+ (?:pass|fail))/i.test(line),
        35,
        20,
      );
    case "deduplicate-log":
      return deduplicate(content);
    case "smart-truncate":
      return keepRegions(lines, 200, 100);
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
  content: string,
  origin: Origin,
  command: string | undefined,
): FilterResult | undefined {
  const id = detect(content, command, origin);
  if (id !== undefined) {
    const first = accept(content, specialized(content, id));
    if (first === undefined) return undefined;
    const filters: RtkFilterId[] = [id];
    if (id === "build-output" || id === "test-output") {
      const post = accept(first, deduplicate(first));
      if (post !== undefined) return { content: post, filters: [...filters, "deduplicate-log"] };
    }
    return { content: first, filters };
  }
  if (origin !== "shell") return undefined;
  const lines = content.split(/\r?\n/);
  if (lines.length >= 20) {
    const compact = accept(content, deduplicate(content));
    if (compact !== undefined) return { content: compact, filters: ["deduplicate-log"] };
  }
  if (lines.length >= 500) {
    const compact = accept(content, specialized(content, "smart-truncate"));
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
          const result = filter(block.content, origin, command);
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
