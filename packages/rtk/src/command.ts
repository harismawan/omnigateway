import type { RtkFilterId } from "./catalog.ts";

export type GrepMode = {
  heading: boolean;
  lineNumber: boolean;
  beforeContext: number;
  afterContext: number;
};

export type CommandClassification = {
  family: Exclude<RtkFilterId, "deduplicate-log" | "smart-truncate">;
  executable: string;
  subcommand?: string;
  grepMode?: GrepMode;
};

type Token = { kind: "word"; value: string } | { kind: "operator"; value: string };

const UNSUPPORTED_OUTPUT = new Set(["--json", "--sarif"]);

function tokenize(command: string): Token[] | undefined {
  if (
    command.length > 16_384 ||
    /[\r\n`]/.test(command) ||
    command.includes("$(") ||
    command.includes("<(") ||
    command.includes(">(")
  )
    return undefined;
  const tokens: Token[] = [];
  let word = "";
  let wordStarted = false;
  let quote: "'" | '"' | undefined;
  const pushWord = () => {
    if (wordStarted) tokens.push({ kind: "word", value: word });
    word = "";
    wordStarted = false;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === undefined) continue;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && command[i + 1] !== undefined) word += command[++i];
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      wordStarted = true;
      continue;
    }
    if (/\s/.test(char)) {
      pushWord();
      continue;
    }
    if (";&|<>".includes(char) || (char === "$" && command[i + 1] === "(")) {
      pushWord();
      const next = command[i + 1];
      const value =
        next !== undefined && (next === char || (char === ">" && next === ">"))
          ? char + command[++i]
          : char;
      tokens.push({ kind: "operator", value });
      continue;
    }
    word += char;
    wordStarted = true;
  }
  if (quote !== undefined) return undefined;
  pushWord();
  return tokens.length <= 256 ? tokens : undefined;
}

function unwrap(tokens: Token[]): string[] | undefined {
  let words = tokens;
  const operatorIndexes = words.flatMap((token, index) =>
    token.kind === "operator" ? [index] : [],
  );
  if (operatorIndexes.length > 1) return undefined;
  if (operatorIndexes.length === 1) {
    const index = operatorIndexes[0];
    if (
      index === undefined ||
      words[index]?.value !== "&&" ||
      words[0]?.kind !== "word" ||
      words[0].value !== "cd" ||
      index !== 2
    )
      return undefined;
    words = words.slice(index + 1);
  }
  if (words.some((token) => token.kind === "operator")) return undefined;
  const values = words.map((token) => token.value);
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(values[0] ?? "")) values.shift();
  if (values[0] === "env") {
    values.shift();
    while (values.length > 0) {
      const value: string | undefined = values.at(0);
      if (
        value === "-i" ||
        value === "--ignore-environment" ||
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(value ?? "")
      )
        values.shift();
      else if (value === "-u") {
        if (values[1] === undefined) return undefined;
        values.splice(0, 2);
      } else if (value?.startsWith("--unset=")) values.shift();
      else if (value === "--") values.shift();
      else break;
    }
  }
  if (values[0] === "timeout") {
    values.shift();
    while (values[0]?.startsWith("-")) {
      const option = values.shift();
      if (option === "--") break;
      if (option === "-s" || option === "-k") {
        if (values.shift() === undefined) return undefined;
      } else if (!option?.startsWith("--signal=") && !option?.startsWith("--kill-after="))
        return undefined;
    }
    if (values.shift() === undefined) return undefined;
  }
  return values.length > 0 ? values : undefined;
}

function scriptFamily(name: string): "test-output" | "lint-output" | "build-output" {
  if (
    ["test", "test:unit", "test:integration", "test:e2e"].includes(name) ||
    name.startsWith("test:")
  )
    return "test-output";
  if (
    ["lint", "typecheck", "check"].includes(name) ||
    name.startsWith("lint:") ||
    name.startsWith("typecheck:")
  )
    return "lint-output";
  return "build-output";
}

function classifyGrep(
  executable: string,
  args: readonly string[],
): CommandClassification | undefined {
  let heading = false;
  let beforeContext = 0;
  let afterContext = 0;
  let lineNumber = false;
  let operands = 0;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index] ?? "";
    if (argument === "--") {
      operands += args.length - index - 1;
      break;
    }
    if (!argument.startsWith("-")) {
      operands++;
      continue;
    }
    if (
      ["--json", "--files", "--replace", "-r", "--files-with-matches", "-l", "-P"].includes(
        argument,
      )
    )
      return undefined;
    if (argument === "--heading") heading = true;
    else if (argument === "--no-heading") heading = false;
    else if (argument === "-n" || argument === "--line-number") lineNumber = true;
    else if (
      ["-C", "-A", "-B", "--context", "--after-context", "--before-context"].includes(argument)
    ) {
      const count = args[++index];
      if (count === undefined || !/^\d+$/.test(count)) return undefined;
      const value = Number(count);
      if (argument === "-C" || argument === "--context") {
        beforeContext = value;
        afterContext = value;
      } else if (argument === "-A" || argument === "--after-context") afterContext = value;
      else beforeContext = value;
    } else if (/^-[CAB]\d+$/.test(argument)) {
      const value = Number(argument.slice(2));
      if (argument[1] === "C") {
        beforeContext = value;
        afterContext = value;
      } else if (argument[1] === "A") afterContext = value;
      else beforeContext = value;
    } else if (/^--(?:context|after-context|before-context)=\d+$/.test(argument)) {
      const value = Number(argument.slice(argument.indexOf("=") + 1));
      if (argument.startsWith("--context=")) {
        beforeContext = value;
        afterContext = value;
      } else if (argument.startsWith("--after-context=")) afterContext = value;
      else beforeContext = value;
    } else if (
      !["-i", "--ignore-case", "-F", "--fixed-strings", "-w", "--word-regexp"].includes(argument)
    )
      return undefined;
  }
  if (operands === 0) return undefined;
  return {
    family: "grep",
    executable,
    grepMode: { heading, lineNumber, beforeContext, afterContext },
  };
}

function direct(executable: string, args: string[]): CommandClassification | undefined {
  if (executable.length === 0) return undefined;
  if (executable === "rg" || executable === "grep") return classifyGrep(executable, args);
  const subcommand = args[0];
  if (executable === "git") {
    if (subcommand === "diff") return { family: "git-diff", executable, subcommand };
    if (subcommand === "status") return { family: "git-status", executable, subcommand };
    if (subcommand === "log") return { family: "git-log", executable, subcommand };
    if (["branch", "switch", "checkout", "push", "pull", "fetch"].includes(subcommand ?? ""))
      return { family: "git-operation", executable, subcommand: subcommand ?? "" };
    if (subcommand === "ls-files") return { family: "path-list", executable, subcommand };
  }
  if (
    executable === "docker" &&
    (subcommand === "build" ||
      (subcommand === "buildx" && args[1] === "build") ||
      (subcommand === "compose" && args[1] === "build"))
  )
    return { family: "docker-build", executable, subcommand };
  if (executable === "tree") {
    const options = args.filter((argument) => argument.startsWith("-"));
    if (options.some((option) => option !== "-F" && option !== "--classify")) return undefined;
    return {
      family: "tree-output",
      executable,
      ...(options.length === 0 ? {} : { subcommand: "classified" }),
    };
  }
  if (executable === "ls") {
    const options = args.filter((arg) => arg.startsWith("-"));
    if (options.some((option) => !/^-+[alRh]+$/.test(option))) return undefined;
    const recursive = options.some((option) => option.includes("R"));
    const long = options.some((option) => option.includes("l"));
    if (!recursive && !long) return undefined;
    return {
      family: "tree-output",
      executable,
      subcommand: recursive ? (long ? "recursive-long" : "recursive-plain") : "long",
    };
  }
  if (["find", "glob"].includes(executable)) return { family: "path-list", executable };
  if (["sed", "cat", "head", "tail", "awk", "nl"].includes(executable))
    return { family: "numbered-read", executable };
  if (
    executable === "tsc" ||
    executable === "eslint" ||
    executable === "golangci-lint" ||
    (executable === "biome" && ["check", "lint"].includes(subcommand ?? "")) ||
    (executable === "ruff" && subcommand === "check") ||
    (executable === "cargo" && subcommand === "clippy")
  )
    return {
      family: "lint-output",
      executable,
      ...(subcommand === undefined ? {} : { subcommand }),
    };
  if (
    ["vitest", "jest", "pytest"].includes(executable) ||
    (executable === "go" && subcommand === "test")
  )
    return {
      family: "test-output",
      executable,
      ...(subcommand === undefined ? {} : { subcommand }),
    };
  if (
    (executable === "bun" && ["add", "install", "update", "remove"].includes(subcommand ?? "")) ||
    (executable === "npm" && ["install", "update", "audit"].includes(subcommand ?? "")) ||
    (executable === "pnpm" && ["install", "update"].includes(subcommand ?? "")) ||
    (executable === "yarn" && ["install", "up"].includes(subcommand ?? "")) ||
    (executable === "cargo" && ["add", "update", "fetch"].includes(subcommand ?? "")) ||
    (executable === "pip" && subcommand === "install") ||
    (executable === "uv" && ["sync", "add", "remove"].includes(subcommand ?? ""))
  )
    return { family: "package-output", executable, subcommand: subcommand ?? "" };
  if (
    (executable === "bun" && subcommand === "test") ||
    (executable === "npm" && subcommand === "test") ||
    (executable === "cargo" && subcommand === "test")
  )
    return { family: "test-output", executable, subcommand };
  if (
    (executable === "bun" && subcommand === "build") ||
    (executable === "cargo" && ["build", "check"].includes(subcommand ?? ""))
  )
    return { family: "build-output", executable, subcommand: subcommand ?? "" };
  return undefined;
}

export function classifyCommand(command: string): CommandClassification | undefined {
  const tokens = tokenize(command);
  if (tokens === undefined) return undefined;
  const words = unwrap(tokens);
  if (words === undefined) return undefined;
  if (
    words.some(
      (word) =>
        UNSUPPORTED_OUTPUT.has(word) || /^(?:--format|--output-format|--reporter)=/.test(word),
    )
  )
    return undefined;
  for (let index = 0; index < words.length; index++) {
    if (!["--format", "--output-format", "--reporter"].includes(words[index] ?? "")) continue;
    if (words[index + 1] === undefined) return undefined;
    return undefined;
  }
  const executable = words[0];
  if (executable === undefined) return undefined;
  if (
    (executable === "bun" && words[1] === "run") ||
    (executable === "npm" && words[1] === "run")
  ) {
    let index = 2;
    if (words[index] === "--") index++;
    const script = words[index];
    return script === undefined || script.length === 0
      ? undefined
      : { family: scriptFamily(script), executable, subcommand: "run" };
  }
  if ((executable === "bun" && words[1] === "x") || executable === "bunx") {
    let index = executable === "bun" ? 2 : 1;
    let sawBun = false;
    let sawSeparator = false;
    while (words[index]?.startsWith("-")) {
      const option = words[index++];
      if (option === "--bun" && !sawBun && !sawSeparator) sawBun = true;
      else if (option === "--" && !sawSeparator) sawSeparator = true;
      else return undefined;
    }
    const wrapped = words[index];
    return wrapped === undefined || wrapped.length === 0 || wrapped === "--"
      ? undefined
      : direct(wrapped, words.slice(index + 1));
  }
  if (executable === "npx") {
    let index = 1;
    let sawYes = false;
    let sawSeparator = false;
    while (words[index]?.startsWith("-")) {
      const option = words[index++];
      if ((option === "--yes" || option === "-y") && !sawYes && !sawSeparator) sawYes = true;
      else if (option === "--" && !sawSeparator) sawSeparator = true;
      else return undefined;
    }
    const wrapped = words[index];
    return wrapped === undefined || wrapped.length === 0 || wrapped === "--"
      ? undefined
      : direct(wrapped, words.slice(index + 1));
  }
  return direct(executable, words.slice(1));
}
