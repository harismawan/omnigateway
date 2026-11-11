#!/usr/bin/env bun
/**
 * Exports RTK differential vectors from the frozen TS build.
 *
 *   bun conformance/vectors/rtk-export.ts conformance/vectors/rtk.json.gz
 *
 * Every expected value is computed by calling the frozen function, never by
 * restating it. Four sources feed the file:
 *
 * - `suite`: every `transformRequest`, `classifyCommand` and `extractCommand`
 *   call the frozen `packages/rtk/test` suite makes, captured by running a
 *   scratch copy of that suite against `rtk-recorder.ts` (the copy must still
 *   pass, so the inputs are exactly the ones the suite asserts on);
 * - `corpus`: seeded random and adversarial requests, commands and outputs,
 *   including UTF-16 edge cases (astral characters, U+2028/2029, CR/CRLF,
 *   U+FEFF, U+0085, NUL, combining marks);
 * - `limit`: inputs at and one past every size limit (1,000,000-unit input,
 *   100,000-row scan, 250,000-unit output, 16,384-unit command, 256 tokens);
 * - `filters`: each filter called directly over the corpus with a budget
 *   pre-charged or shrunk so it fails at a sampled point mid-parse, which pins
 *   the order budgets are charged in, not just the happy-path output.
 *
 * Lone surrogates cannot reach the Rust port (its strings are UTF-8 and the IR
 * ingress replaces them with U+FFFD), so cases carrying one are skipped and
 * counted under `skipped`.
 *
 * Case ids are content hashes, so regeneration is order-independent. Re-run
 * only on purpose, then `bun conformance/vectors/rtk-check-additive.ts old new`:
 * an existing case whose expected value changes is a behaviour change in the
 * frozen build.
 *
 * Never generates `a/a/…/a ` path rows with more than a handful of segments:
 * the frozen `RELATIVE_PATH` backtracks exponentially on them (the Rust port is
 * linear), and the export would hang.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ChatRequest, ContentBlock } from "../../packages/ir/src/index.ts";
import { classifyCommand, type GrepMode } from "../../packages/rtk/src/command.ts";
import { compressBuild } from "../../packages/rtk/src/filters/build.ts";
import { compressDiagnostics } from "../../packages/rtk/src/filters/diagnostics.ts";
import { compressDocker } from "../../packages/rtk/src/filters/docker.ts";
import { compressGitOperation } from "../../packages/rtk/src/filters/git.ts";
import { compressListing } from "../../packages/rtk/src/filters/listings.ts";
import { compressPackages } from "../../packages/rtk/src/filters/packages.ts";
import { compressGrep } from "../../packages/rtk/src/filters/search.ts";
import { type BoundedText, ParserBudget, scanText } from "../../packages/rtk/src/filters/shared.ts";
import { compressGitStatus } from "../../packages/rtk/src/filters/status.ts";
import { compressTests } from "../../packages/rtk/src/filters/tests.ts";
import { extractCommand, transformRequest } from "../../packages/rtk/src/index.ts";

const out = process.argv[2];
if (out === undefined) {
  console.error("usage: rtk-export.ts <out.json.gz>");
  process.exit(2);
}
const ROOT = resolve(import.meta.dir, "../..");
const skipped = { loneSurrogate: 0, duplicate: 0 };

// ---------------------------------------------------------------- utilities

const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
function hasLone(value: unknown): boolean {
  return LONE.test(JSON.stringify(value) ?? "");
}

function caseId(input: unknown): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 20);
}

/** mulberry32: small, seeded, deterministic. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = {
  next: () => number;
  int: (lo: number, hi: number) => number;
  pick: <T>(items: readonly T[]) => T;
  chance: (p: number) => boolean;
};

function rand(seed: number): Rand {
  const next = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  return {
    next,
    int,
    pick: <T>(items: readonly T[]): T => items[int(0, items.length - 1)] as T,
    chance: (p: number) => next() < p,
  };
}

// ------------------------------------------------------------ suite capture

function captureSuite(): unknown[] {
  const scratch = mkdtempSync(join(tmpdir(), "rtk-suite-"));
  const record = join(scratch, "record.jsonl");
  const recorder = join(ROOT, "conformance/vectors/rtk-recorder.ts");
  const src = join(ROOT, "packages/rtk/src");
  try {
    for (const name of readdirSync(join(ROOT, "packages/rtk/test"))) {
      if (!name.endsWith(".test.ts")) continue;
      const text = readFileSync(join(ROOT, "packages/rtk/test", name), "utf8")
        .replaceAll('"../src/index.ts"', JSON.stringify(recorder))
        .replaceAll('"../src/command.ts"', JSON.stringify(recorder))
        .replaceAll('"../src/', `"${src}/`);
      writeFileSync(join(scratch, name), text);
    }
    const run = Bun.spawnSync(["bun", "test"], {
      cwd: scratch,
      env: { ...process.env, RTK_RECORD: record },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (run.exitCode !== 0) {
      console.error(run.stderr.toString());
      throw new Error("the copied frozen suite failed; refusing to record from it");
    }
    return readFileSync(record, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------- expectation

type Change = [number, number, string];

function expectTransform(request: ChatRequest) {
  const before = JSON.stringify(request);
  const result = transformRequest(request, { enabled: true });
  if (JSON.stringify(request) !== before) throw new Error("transformRequest mutated its input");
  const changes: Change[] = [];
  if (result.request !== request)
    result.request.messages.forEach((message, m) => {
      message.content.forEach((block, b) => {
        const original = request.messages[m]?.content[b];
        if (block.type === "toolResult" && original?.type === "toolResult")
          if (block.content !== original.content) changes.push([m, b, block.content]);
      });
    });
  return { unchanged: result.request === request, changes, report: result.report };
}

function expectClassify(command: string) {
  const c = classifyCommand(command);
  return c === undefined ? null : c;
}

// ----------------------------------------------------------------- corpus

const EDGE = [
  "😀",
  "👨‍👩‍👧",
  "日本語",
  "é",
  "e\u0301",
  "\u2028",
  "\u2029",
  "\ufeff",
  "\u0085",
  "\u0000",
  "\u00a0",
  "\u3000",
  "\t",
  "Ω",
  "ſ",
  "K",
  "İ",
  "Σ",
  "𝔘𝔫𝔦",
];

const COMMANDS: Record<string, readonly string[]> = {
  git: [
    "git diff",
    "git diff --cached",
    "git diff -c HEAD^!",
    "git diff --binary",
    "git log",
    "git log --stat",
    "git log -p",
    "git log --abbrev=4",
    "git status",
    "git status --short --branch",
    "git status -sb",
    "git push",
    "git push --all",
    "git pull",
    "git fetch",
    "git branch -a",
    "git switch main",
    "git checkout -b x",
    "git ls-files",
    "git show HEAD",
    "git different-command",
  ],
  grep: [
    "rg -n foo src",
    "rg --heading -n foo",
    "rg -n -C 2 foo .",
    "grep -n -A3 foo file",
    "rg -B1 -A 4 x y",
    "rg --context=3 -n x .",
    "grep -rn x .",
    "rg -i -w -F x .",
    "rg --no-heading x",
    "rg x",
    "rg -C x y",
    "rg --heading -C 1 x src",
    "rg -n -C 99999999999999999999 x .",
    "grep -P x y",
    "rg --json x",
  ],
  listing: [
    "find . -type f",
    "find src",
    "glob '**/*.ts'",
    "tree",
    "tree -F",
    "tree --classify",
    "tree -a",
    "ls -la",
    "ls -l",
    "ls -R",
    "ls -lR",
    "ls -lh",
    "ls",
    "ls -x",
    "ls --R",
  ],
  read: [
    "cat file.ts",
    "sed -n '1,300p' a.ts",
    "head -n 400 x",
    "tail -f log",
    "nl x",
    "awk '{print}' x",
  ],
  lint: [
    "tsc --noEmit",
    "eslint .",
    "biome check .",
    "biome lint",
    "ruff check .",
    "cargo clippy",
    "golangci-lint run",
    "eslint --format json .",
    "biome check --reporter=json",
    "ruff format",
  ],
  test: [
    "bun test",
    "bunx vitest run",
    "npx jest",
    "pytest -q",
    "go test ./...",
    "npm test",
    "cargo test",
    "vitest",
    "jest --ci",
    "bun run test:unit",
    "npm run test",
    "bun run -- lint",
  ],
  packages: [
    "bun install",
    "bun add x",
    "npm install",
    "npm audit",
    "pnpm install",
    "yarn install",
    "yarn up x",
    "cargo add x",
    "cargo fetch",
    "pip install x",
    "uv sync",
    "pip list",
  ],
  build: ["bun build src/index.ts", "cargo build", "cargo check", "bun run build", "npm run build"],
  docker: ["docker build .", "docker buildx build .", "docker compose build", "docker run x"],
  other: ["echo x", "make", "python x.py", "", "  ", "cd a && cd b && x", "cd a || x"],
};

const PREFIXES = [
  "cd 'dir x' && ",
  "cd src && ",
  "NODE_ENV=test ",
  "A=1 B=2 ",
  "env -i CI=1 -- ",
  "env -u HOME ",
  "env -u ",
  "env --unset=X ",
  "timeout 30s ",
  "timeout -s TERM 30s ",
  "timeout --signal=KILL 5 ",
  "timeout -x 5 ",
  "timeout ",
  "bunx ",
  "bunx --bun ",
  "npx -y ",
  "npx --yes -- ",
  "bun x --bun ",
  "bun x -- ",
];
const SUFFIXES = [
  " | cat",
  " > log",
  " >> log",
  " && echo",
  " 2>&1",
  "; ls",
  " --json",
  " $(x)",
  " `x`",
  "\n echo",
  "\r",
  " <(x)",
  " &",
  " --sarif",
  " --format=json",
  " --reporter",
  " 'unterminated",
  ' "q \\" uote"',
];

function mutateCommand(r: Rand, base: string): string {
  let command = base;
  if (r.chance(0.25)) command = r.pick(PREFIXES) + command;
  if (r.chance(0.12)) command += r.pick(SUFFIXES);
  if (r.chance(0.08)) command = command.replace(/ /g, () => r.pick([" ", "  ", "\t", "\u00a0"]));
  if (r.chance(0.06)) command = command.replace(/[a-z]/, (c) => c.toUpperCase());
  if (r.chance(0.06)) command += ` ${r.pick(EDGE)}`;
  if (r.chance(0.05)) command = command.replace(/ (\S+)/, ' "$1"');
  return command;
}

const hex = (r: Rand, n: number) =>
  Array.from({ length: n }, () => "0123456789abcdef"[r.int(0, 15)]).join("");
const word = (r: Rand) =>
  r.pick(["alpha", "beta", "gamma", "delta", "module", "handler", "config", "router", "store"]);
const path = (r: Rand) =>
  `${r.pick(["src", "packages/rtk/src", "apps/gateway/src", "test", "C:\\repo\\src", "./lib"])}/${word(r)}-${r.int(0, 40)}.${r.pick(["ts", "rs", "go", "py", "md"])}`;

type Theme = (r: Rand, i: number) => string;

const THEMES: Record<string, Theme> = {
  diff: (r, i) =>
    r.pick([
      `diff --git a/${path(r)} b/${path(r)}`,
      `diff --cc ${path(r)}`,
      `diff --combined f${i}.txt`,
      `index ${hex(r, 7)}..${hex(r, 7)} 100644`,
      `index ${hex(r, 7)},${hex(r, 7)}..${hex(r, 7)}`,
      "--- a/x.ts",
      "+++ b/x.ts",
      `@@ -${i},3 +${i},4 @@ fn x()`,
      `@@@ -${i},3 -${i},3 +${i},9 @@@`,
      `-removed ${word(r)} ${i}`,
      `+added ${word(r)} ${i}`,
      `   context ${word(r)} ${i}`,
      ` +OURS-${i}`,
      `+ THEIRS-${i}`,
      "++<<<<<<< HEAD",
      `rename from ${path(r)}`,
      `similarity index ${r.int(0, 100)}%`,
      "Binary files a/x.png and b/x.png differ",
      "GIT binary patch",
      `literal ${r.int(0, 999)}`,
      "\\ No newline at end of file",
      ` ${r.int(1, 9)} files changed, ${r.int(0, 99)} insertions(+)`,
      `${" ".repeat(r.int(0, 20))}-${word(r)}`,
    ]),
  log: (r, i) =>
    r.pick([
      `commit ${hex(r, r.pick([4, 7, 40]))}`,
      `commit ${hex(r, 40)} (HEAD -> main, tag: v1.${i})`,
      "Author: Dev <dev@example.test>",
      "Date:   Mon Aug 10 19:43:18 2026 +0700",
      `Merge: ${hex(r, 7)} ${hex(r, 7)}`,
      "AuthorDate: Mon Aug 10 2026",
      `    fix(${word(r)}): subject ${i}`,
      `      - bullet ${i}`,
      `    \ttab body ${i}`,
      "",
      "    ",
      ` ${path(r)} | ${r.int(1, 40)} +++--`,
      `gpg: Signature made ${i}`,
      `prose about commit ${i}`,
    ]),
  statusShort: (r, i) =>
    r.pick([
      "## main...origin/main [ahead 1]",
      `${r.pick([" M", "M ", "MM", "??", "UU", "A ", " D", "R ", "C ", "ZZ", "!!"])} ${path(r)}`,
      `R  old-${i}.ts -> new-${i}.ts`,
      `R  missing-arrow-${i}.ts`,
      "rebase in progress; onto abc1234",
      "  (use git add to update what will be committed)",
    ]),
  statusLong: (r, i) =>
    r.pick([
      "On branch main",
      "HEAD detached at abc1234",
      "Changes to be committed:",
      "Changes not staged for commit:",
      "Untracked files:",
      "Unmerged paths:",
      `\t${r.pick(["modified", "deleted", "new file", "renamed", "both modified"])}:   ${path(r)}`,
      `\tuntracked-${i}.ts`,
      '  (use "git add <file>..." to include in what will be committed)',
      "Your branch is ahead of 'origin/main' by 2 commits.",
      'no changes added to commit (use "git add" and/or "git commit -a")',
      "nothing to commit, working tree clean",
      "",
    ]),
  grep: (r, i) =>
    r.pick([
      `${path(r)}:${i + 1}:match ${word(r)}`,
      `${path(r)}-${i + 1}-context ${word(r)}`,
      `C:\\repo\\a.ts:${i}:windows ${word(r)}`,
      "--",
      `${i + 1}:heading match`,
      `${i + 1}-heading context`,
      `src/${word(r)}.ts`,
      `key:value:${i}:prose`,
    ]),
  paths: (r, i) =>
    r.pick([
      `${path(r)}`,
      `./${word(r)}/${word(r)}-${i}.ts`,
      `docs/My Reports/quarter ${i}.md`,
      `docs/${r.pick(EDGE)}-${i}.md`,
      `C:\\proj\\${word(r)}\\f${i}.ts`,
      "README.md",
      "This is prose about the path",
      "| a | b |",
      '{"path":"x"}',
      `src/x.ts:${i}:error`,
      ` leading-space-${i}.ts`,
    ]),
  tree: (r, i) =>
    r.pick([
      `├── dir-${i}/`,
      `│   ├── file-${i}.ts`,
      `│   └── last-${i}.ts`,
      `    ├── deep-${i}.ts`,
      `│   │   └── deeper-${i}.ts`,
      `└── link@ -> src`,
      `├── exe-${i}*`,
    ]),
  lsLong: (r, i) =>
    r.pick([
      `-rw-r--r-- 1 u g ${r.int(0, 9999)} Aug 10 12:00 file-${i}.ts`,
      `drwxr-xr-x 2 u g 4096 Aug 10 2024 dir-${i}`,
      `lrwxrwxrwx 1 u g 3 Aug 10 12:00 link-${i} -> dir`,
      "total 120",
      `./dir-${i}:`,
      `plain-${i}.ts`,
      "",
      "locale specific row",
    ]),
  build: (r, i) =>
    r.pick([
      "bun build v1.4.0",
      `Compiling ${word(r)} v1.${i}.0`,
      "Compiling repeated v1",
      `Checking ${word(r)} v0.1.0`,
      "Running `rustc src/main.rs`",
      `dist/chunk-${i}.js  ${r.int(1, 9999)}`,
      `target/debug/app-${i}`,
      `${path(r)}:${i}:${r.int(1, 80)} error TS2322: mismatch`,
      `error[E0308]: mismatched types ${i}`,
      `  --> src/a.rs:${i}:9`,
      "  | ^^^ help: here",
      `warning: unused ${word(r)}`,
      "Finished dev target(s) in 1.2s",
      "Build completed in 1s",
      "Bundled 12 modules",
      `progress ${i}`,
      "CUSTOM row",
      "",
    ]),
  tests: (r, i) =>
    r.pick([
      "bun test v1.4.0",
      `(pass) suite > case ${i}`,
      `FAIL test/a-${i}.test.ts > case`,
      ` FAIL  test/a.test.ts > named ${i}`,
      `  ● suite > case ${i}`,
      `    --- FAIL: TestX${i} (0.00s)`,
      `FAILED test_a.py::test_${i}`,
      "=========== FAILURES ===========",
      `    at test/a.ts:${i}:3`,
      `${r.int(0, 9)} pass`,
      `${r.int(0, 3)} fail`,
      `Ran ${i} tests across 3 files`,
      "Test Files 1 failed | 2 passed",
      "Tests: 1 failed, 2 passed",
      `${r.int(0, 9)} passed, ${r.int(0, 2)} failed in 1.2s`,
      "ok example/pkg 1.2s",
      "FAIL example/pkg 1.0s",
      "# example/pkg",
      "UnhandledPromiseRejection: x",
      "error: 1 unhandled rejection",
      `progress ${i}`,
      `File src/m${i}.ts | 88.1 | coverage`,
    ]),
  lint: (r, i) =>
    r.pick([
      `src/a${i}.ts(${i},5): error TS2322: bad ${i}`,
      `src/w${i % 7}.ts(1,1): warning TS6133: unused`,
      `src/a.ts:${i}:3 lint/x ERROR`,
      `  ${i}:9  warning  'x${i}' is unused  no-unused-vars`,
      `  ${i}:3  error  Parsing error  parse`,
      `error[E0308]: mismatch ${i}`,
      `warning: unused variable \`v${i}\``,
      "  --> src/a.rs:2:3",
      "  detail row",
      "  ^ caret",
      "Found 3 errors in 2 files.",
      "✖ 31 problems (1 error, 30 warnings)",
      "Checked 4 files in 2ms. Found 1 error.",
      "error: could not compile",
      `${r.int(1, 9)} issues`,
      `note: epilogue ${i}`,
      "",
    ]),
  packages: (r, i) =>
    r.pick([
      `npm warn deprecated pkg-${i % 30}@1.0.0: unsupported`,
      `npm warn [${i}/40] workspace app: ERESOLVE peer`,
      "npm warn While resolving: app@1",
      "npm error code ERESOLVE",
      `WARN deprecated p@${i}`,
      "ERR_PNPM_PEER_DEP_ISSUES unmet peer",
      `YN00${r.pick(["09", "60", "18"])}: [x] y ${i}`,
      `warning: spurious ${i}`,
      "error: failed to get crate",
      "WARNING: dependency conflict",
      "ERROR: Could not build wheels",
      `Resolving package ${i}`,
      `added ${i} packages in 2s`,
      "installed 1 package",
      "found 3 vulnerabilities (1 moderate, 2 high)",
      "Saved lockfile",
      `  funding row ${i}`,
      "DIAGNOSTIC maybe",
      "npm install",
      "  required by package-b@2",
    ]),
  docker: (r, i) =>
    r.pick([
      "#1 [internal] load build definition from Dockerfile",
      `#${i} [${i}/9] RUN step ${i}`,
      `#${i} ${r.int(0, 9)}.${r.int(0, 9)} 50% transferring`,
      `#${i} transferring context: ${i}00kB`,
      `#${i} CACHED`,
      `#${i} 1.2 ERROR: failed`,
      `#${i}   caused by missing`,
      "  command: bun build",
      "Dockerfile:14",
      `#${i} naming to docker.io/acme/app:latest`,
      `#${i} DONE 1.2s`,
      "Step 1/5 : FROM alpine",
      "Successfully built abc",
      "CUSTOM artifact",
    ]),
  operation: (r, i) =>
    r.pick([
      "From github.com:acme/app",
      `   ${hex(r, 7)}..${hex(r, 7)}  b${i} -> origin/b${i}`,
      ` * [new branch]      f${i} -> f${i}`,
      " ! [rejected]        main -> main (non-fast-forward)",
      "error: failed to push some refs",
      `remote: Counting objects: ${i}% (${i}/9)`,
      `Total ${i} (delta 0), reused 0`,
      "Fast-forward",
      ` ${path(r)} | ${i} ++--`,
      "Already on 'main'",
      "Everything up-to-date",
      "hint: Updates were rejected",
      "* main",
      "  feature",
    ]),
  numbered: (r, i) => r.pick([`${i + 1} | source ${word(r)}`, `${i + 1}\tline`, `  ${i}: x`]),
  prose: (r, i) =>
    r.pick([
      `The ${word(r)} is ready ${i}.`,
      `same line`,
      `line ${i}`,
      `2026-08-11T00:00:0${i % 10}Z INFO same`,
      `${r.pick(EDGE)} ${word(r)} ${r.pick(EDGE)}`,
      "",
    ]),
};

const THEME_COMMANDS: Record<string, readonly string[]> = {
  diff: [...(COMMANDS.git ?? []), ...(COMMANDS.read ?? [])],
  log: COMMANDS.git ?? [],
  statusShort: COMMANDS.git ?? [],
  statusLong: COMMANDS.git ?? [],
  grep: COMMANDS.grep ?? [],
  paths: COMMANDS.listing ?? [],
  tree: COMMANDS.listing ?? [],
  lsLong: COMMANDS.listing ?? [],
  build: COMMANDS.build ?? [],
  tests: COMMANDS.test ?? [],
  lint: COMMANDS.lint ?? [],
  packages: COMMANDS.packages ?? [],
  docker: COMMANDS.docker ?? [],
  operation: COMMANDS.git ?? [],
  numbered: COMMANDS.read ?? [],
  prose: [...(COMMANDS.other ?? []), ...(COMMANDS.read ?? [])],
};

const THEME_NAMES = Object.keys(THEMES);
const ROW_COUNTS = [0, 1, 3, 12, 20, 25, 40, 60, 120, 260, 520, 900];

/** Grammatical blocks each specialized parser accepts, so accept paths run. */
const WELL_FORMED: Record<string, (r: Rand) => string[]> = {
  grep: (r) => {
    const heading = r.chance(0.3);
    const context = r.chance(0.4) ? r.int(1, 3) : 0;
    const lines: string[] = [];
    const files = r.pick([1, 3, 12, 41, 45, 60]);
    for (let f = 0; f < files; f++) {
      const file = r.chance(0.1) ? `C:\\repo\\src\\f${f}.ts` : `src/dir-${f % 7}/file-${f}.ts`;
      if (heading) lines.push(file);
      const matches = r.pick([1, 1, 2, 5, 13, 20]);
      for (let m = 0; m < matches; m++) {
        const at = m * 10 + 1;
        if (context > 0 && m > 0 && r.chance(0.5)) lines.push("--");
        for (let c = context; c > 0; c--)
          lines.push(heading ? `${at - c + 5}-ctx ${m}` : `${file}-${at - c + 5}-ctx ${m}`);
        lines.push(heading ? `${at + 5}:match ${m} ${word(r)}` : `${file}:${at + 5}:match ${m}`);
        for (let c = 1; c <= context; c++)
          lines.push(heading ? `${at + 5 + c}-after ${m}` : `${file}-${at + 5 + c}-after ${m}`);
      }
    }
    return lines;
  },
  paths: (r) => {
    const lines: string[] = [];
    const dirs = r.pick([1, 5, 30, 41, 50]);
    for (let d = 0; d < dirs; d++) {
      const count = r.pick([1, 3, 12, 13, 20]);
      const dir = r.chance(0.1) ? `docs/My Reports ${d}` : `apps/gateway/src/module-${d}`;
      for (let n = 0; n < count; n++) lines.push(`${dir}/${word(r)}-${n}.ts`);
    }
    if (r.chance(0.2)) lines.push("README.md");
    return lines;
  },
  tree: (r) => {
    const classified = r.chance(0.7);
    const lines = ["project"];
    let directories = 0;
    let files = 0;
    const walk = (prefix: string, depth: number) => {
      const children = r.pick([0, 1, 3, 13, 20, 42]);
      for (let c = 0; c < children; c++) {
        const last = c === children - 1;
        const branch = last ? "└── " : "├── ";
        const directory = depth < 3 && r.chance(0.25);
        if (directory) directories++;
        else files++;
        lines.push(
          `${prefix}${branch}${directory ? `dir-${depth}-${c}${classified ? "/" : ""}` : `file-${c}.ts`}`,
        );
        if (directory) walk(prefix + (last ? "    " : "│   "), depth + 1);
        if (lines.length > 3_000) return;
      }
    };
    walk("", 0);
    lines.push(`${directories} directories, ${files} files`);
    return lines;
  },
  lsLong: (r) => {
    const recursive = r.chance(0.5);
    const long = r.chance(0.7);
    const entry = (n: number) =>
      long ? `-rw-r--r-- 1 u g ${n} Aug 10 12:00 file-${n}.ts` : `file-${n}.ts`;
    if (!recursive)
      return ["total 120", ...Array.from({ length: r.pick([3, 13, 60]) }, (_, n) => entry(n))];
    const lines: string[] = [];
    const groups = r.pick([2, 12, 41, 45]);
    for (let g = 0; g < groups; g++) {
      lines.push(`./dir-${g}:`);
      if (long) lines.push(`total ${g}`);
      for (let n = 0; n < r.pick([1, 3, 13, 20]); n++) lines.push(entry(n));
      lines.push("");
    }
    return lines;
  },
  statusShort: (r) => {
    const lines = ["## main...origin/main"];
    for (let n = 0; n < r.pick([3, 40, 120]); n++)
      lines.push(
        r.chance(0.1)
          ? `R  old-${n}.ts -> new-${n}.ts`
          : `${r.pick([" M", "M ", "??", "UU", "A ", " D"])} src/f-${n}.ts`,
      );
    if (r.chance(0.5)) lines.splice(1, 0, ...Array(30).fill("  (use git add to update)"));
    return lines;
  },
  statusLong: (r) => {
    const lines = ["On branch main", "Your branch is ahead of 'origin/main' by 2 commits."];
    for (const section of [
      "Changes to be committed:",
      "Changes not staged for commit:",
      "Untracked files:",
    ]) {
      lines.push(section, '  (use "git add <file>..." to update what will be committed)');
      for (let n = 0; n < r.pick([1, 20, 60]); n++)
        lines.push(
          section === "Untracked files:" ? `\tnew-${n}.ts` : `\tmodified:   src/f-${n}.ts`,
        );
      lines.push("");
    }
    lines.push('no changes added to commit (use "git add" and/or "git commit -a")');
    return lines;
  },
  docker: (r) => {
    const lines = ["#1 [internal] load build definition from Dockerfile"];
    for (let s = 2; s < r.pick([4, 12, 30]); s++) {
      lines.push(`#${s} [${s}/9] RUN step ${s}`);
      for (let p = 0; p < r.pick([0, 5, 40]); p++) lines.push(`#${s} 1.${p} ${p}% transferring`);
      if (r.chance(0.3)) lines.push(`#${s} CACHED`, `#${s} CACHED`);
    }
    if (r.chance(0.4)) lines.push("#9 1.2 ERROR: failed", "#9   caused by missing input");
    lines.push("#20 naming to docker.io/acme/app:latest", "#20 DONE 1.2s");
    return lines;
  },
  operation: (r) => {
    const lines: string[] = [];
    for (let p = 0; p < r.pick([0, 5, 60]); p++)
      lines.push(`remote: Counting objects: ${p}% (${p}/9)`);
    lines.push("From github.com:acme/app");
    for (let n = 0; n < r.pick([2, 20, 80]); n++)
      lines.push(`   ${hex(r, 7)}..${hex(r, 7)}  b${n} -> origin/b${n}`);
    lines.push("Fast-forward");
    for (let p = 0; p < r.pick([0, 5]); p++) lines.push(`Total ${p} (delta 0), reused 0`);
    return lines;
  },
  build: (r) => {
    const cargo = r.chance(0.5);
    const lines = [cargo ? "Compiling app v0.1.0" : "bun build v1.4.0"];
    for (let n = 0; n < r.pick([3, 40, 200]); n++)
      lines.push(cargo ? r.pick([`Compiling c${n} v1`, "Compiling repeated v1"]) : `progress ${n}`);
    if (r.chance(0.5))
      lines.push("src/a.ts:4:2 error TS2322: mismatch", "  source frame", "  ^ caret");
    lines.push(cargo ? "target/debug/app" : "dist/index.js 42 KB");
    lines.push(cargo ? "Finished dev target(s) in 1s" : "Build completed in 1s");
    if (r.chance(0.3)) lines.push("", "progress 99");
    return lines;
  },
  lint: (r) => {
    const lines = ["Version 7"];
    const unique = r.pick([1, 5, 25, 60]);
    for (let n = 0; n < unique; n++) {
      const severity = r.chance(0.2) ? "error" : "warning";
      lines.push(
        `src/w${n}.ts(${n + 1},1): ${severity} TS${2000 + n}: issue ${n}`,
        `  detail ${n}`,
      );
      if (r.chance(0.2))
        lines.push(`src/w${n}.ts(${n + 1},1): ${severity} TS${2000 + n}: issue ${n}`, "  dup");
      if (r.chance(0.2)) lines.push(`progress ${n}`);
    }
    lines.push(
      r.pick([
        "Found 3 errors in 2 files.",
        "✖ 31 problems (1 error, 30 warnings)",
        "Found 1 error.",
      ]),
    );
    if (r.chance(0.3)) lines.push("  0 errors potentially fixable with --fix.");
    return lines;
  },
  packages: (r) => {
    const manager = r.pick(["npm", "pnpm", "yarn", "cargo", "pip", "bun"]);
    const warn = (n: number) =>
      ({
        npm: `npm warn deprecated pkg-${n}@1: old`,
        pnpm: `WARN deprecated pkg-${n}@1`,
        yarn: `YN0060: [pkg-${n}] peer warning`,
        cargo: `warning: spurious ${n}`,
        pip: `WARNING: conflict ${n}`,
        bun: `warning: peer conflict ${n}`,
      })[manager] as string;
    const lines = [`${manager} start`];
    for (let n = 0; n < r.pick([3, 40]); n++) lines.push(`Resolving package ${n}`);
    for (let n = 0; n < r.pick([1, 21, 35]); n++) lines.push(warn(r.chance(0.2) ? 0 : n));
    lines.push(r.pick(["added 120 packages in 2s", "installed 1 package", "Saved lockfile"]));
    for (let n = 0; n < r.pick([0, 5]); n++) lines.push(`  funding ${n}`);
    return lines;
  },
  tests: (r) => {
    const lines = ["bun test v1.4.0"];
    for (let n = 0; n < r.pick([5, 60, 300]); n++) lines.push(`(pass) suite > case ${n}`);
    const fails = r.pick([0, 1, 8]);
    for (let n = 0; n < fails; n++)
      lines.push(`FAIL test/a-${n}.test.ts > case ${n}`, `  at test/a-${n}.test.ts:${n}:3`);
    lines.push(`${fails} fail`, `Ran ${fails + 5} tests across 3 files`);
    for (let n = 0; n < r.pick([0, 20]); n++) lines.push(`File src/m${n}.ts | 88.1 | coverage`);
    return lines;
  },
};

function block(r: Rand, theme: string): string {
  const generate = THEMES[theme] as Theme;
  const rows = r.pick(ROW_COUNTS) + r.int(0, 8);
  const wellFormed = WELL_FORMED[theme];
  if (wellFormed !== undefined && r.chance(0.6)) {
    const lines = wellFormed(r);
    // Occasionally perturb one row so near-miss rejections are exercised.
    if (r.chance(0.15) && lines.length > 0)
      lines[r.int(0, lines.length - 1)] = (THEMES[r.pick(THEME_NAMES)] as Theme)(r, 0);
    if (r.chance(0.05) && lines.length > 0) lines[r.int(0, lines.length - 1)] += r.pick(EDGE);
    return lines.join(r.chance(0.92) ? "\n" : r.pick(["\r\n", "\r"]));
  }
  const lines: string[] = [];
  if (theme === "tree" && r.chance(0.8)) lines.push("project");
  if (theme === "lsLong" && r.chance(0.6)) lines.push("total 120");
  // Most blocks stay on-theme so the specialized parsers accept them; the
  // rest are polluted with foreign rows, edge characters and repeats.
  const noisy = r.chance(0.35);
  for (let i = 0; i < rows; i++) {
    let line = generate(r, i);
    if (noisy && r.chance(0.04)) line = (THEMES[r.pick(THEME_NAMES)] as Theme)(r, i);
    if (noisy && r.chance(0.03)) line += r.pick(EDGE);
    if (noisy && r.chance(0.01)) line = r.pick(EDGE) + line;
    lines.push(line);
    if (r.chance(0.05)) for (let k = r.int(1, 30); k > 0; k--) lines.push(line);
  }
  if (theme === "tree" && r.chance(0.8))
    lines.push(`${r.int(0, 40)} directories, ${r.int(0, 400)} files`);
  if (r.chance(0.1)) lines.reverse();
  const separator = r.chance(0.9) ? "\n" : r.pick(["\r\n", "\r", "\n\r", "\u2028"]);
  return lines.join(separator) + (r.chance(0.1) ? separator : "");
}

const TOOL_NAMES = [
  "bash",
  "Bash",
  "BASH",
  "run-command",
  "execute.command",
  "Run Command",
  "shell",
  "terminal",
  "exec",
  "mystery",
  "read",
  "Read_File",
  "web.search",
  "grep_search",
];

function toolInput(r: Rand, command: string): unknown {
  return r.pick<unknown>([
    { command },
    { command },
    { command },
    command,
    { cmd: command },
    { script: command },
    { command: 1, cmd: command },
    { command: "", script: command },
    [command],
    null,
    {},
  ]);
}

function corpusRequest(r: Rand): ChatRequest {
  const messages: ChatRequest["messages"] = [];
  const results = r.chance(0.85) ? 1 : r.int(2, 3);
  for (let n = 0; n < results; n++) {
    const theme = r.pick(THEME_NAMES);
    const base = r.chance(0.8)
      ? r.pick(THEME_COMMANDS[theme] ?? [])
      : r.pick(Object.values(COMMANDS).flat());
    const command = mutateCommand(r, base);
    const id = r.chance(0.9) ? `call-${n}` : "shared";
    const orphan = r.chance(0.08);
    if (!orphan)
      messages.push({
        role: "assistant",
        content: [{ type: "toolUse", id, name: r.pick(TOOL_NAMES), input: toolInput(r, command) }],
      });
    const result: ContentBlock = {
      type: "toolResult",
      toolUseId: orphan ? `orphan-${n}` : id,
      content: block(r, theme),
    };
    if (r.chance(0.03)) result.isError = true;
    if (r.chance(0.03)) result.cacheControl = { type: "ephemeral" };
    messages.push({ role: "user", content: [result] });
  }
  return { model: "fast", stream: false, messages };
}

// ----------------------------------------------------------------- limits

function shellRequest(command: string, content: string, name = "bash"): ChatRequest {
  return {
    model: "fast",
    stream: false,
    messages: [
      { role: "assistant", content: [{ type: "toolUse", id: "x", name, input: { command } }] },
      { role: "user", content: [{ type: "toolResult", toolUseId: "x", content }] },
    ],
  };
}

function limitRequests(): ChatRequest[] {
  const requests: ChatRequest[] = [];
  // MAX_INPUT: 1,000,000 code units, in astral characters so bytes != units.
  for (const units of [999_999, 1_000_000, 1_000_001]) {
    const row = "😀😀 same row\n";
    const body = row.repeat(Math.floor(units / row.length));
    const content = body + "x".repeat(units - body.length);
    requests.push(shellRequest("echo x", content));
  }
  // scanText: 100,000 rows is the last that scans.
  for (const rows of [99_999, 100_000, 100_001])
    requests.push(shellRequest("echo x", Array.from({ length: rows }, () => "r").join("\n")));
  // MAX_OUTPUT: a deduplicated candidate of exactly 249,999 / 250,000 / 250,001 units.
  for (const target of [249_999, 250_000, 250_001]) {
    // Deduplicated to `head\nx\n<marker>\ny`.
    const repeats = 30;
    const marker = `... ${repeats - 1} lines omitted ...`;
    const fixed = "\nx\n".length + marker.length + "\ny".length;
    const head = "😀".repeat(Math.floor((target - fixed) / 2)) + "h".repeat((target - fixed) % 2);
    const content = [head, ...Array.from({ length: repeats }, () => "x"), "y"].join("\n");
    requests.push(shellRequest("echo x", content));
  }
  // Command bounds: 16,384 code units and 256 tokens.
  const rows = Array.from({ length: 300 }, (_, i) => `${i + 1} | source`).join("\n");
  for (const units of [16_384, 16_385]) {
    const filler = "😀".repeat(Math.floor((units - 4) / 2)) + "x".repeat((units - 4) % 2);
    requests.push(shellRequest(`cat ${filler}`, rows));
  }
  for (const tokens of [256, 257])
    requests.push(
      shellRequest(["cat", ...Array.from({ length: tokens - 1 }, () => "a")].join(" "), rows),
    );
  // The 4,096-unit detection sample cut through a surrogate pair.
  const cut = `${"y".repeat(4_095)}😀\ncommit abcd\nAuthor: x\n${"z\n".repeat(200)}`;
  requests.push({
    model: "fast",
    stream: false,
    messages: [{ role: "user", content: [{ type: "toolResult", toolUseId: "o", content: cut }] }],
  });
  // Deep tree near the input cap.
  const deep = ["root"];
  for (let depth = 0; depth < 600; depth++) deep.push(`${"    ".repeat(depth)}└── d${depth}/`);
  deep.push("600 directories, 0 files");
  requests.push(shellRequest("tree -F", deep.join("\n")));
  return requests;
}

/**
 * Blocks aimed at the places a non-`u` JS regex and a naive Rust port part
 * ways. Each is placed so the difference flips the outcome, and the export
 * asserts it really does (against a twin without the edge character), so a
 * mutation-tested Rust port fails here rather than passing by luck.
 */
function semanticEdgeRequests(): ChatRequest[] {
  const orphan = (content: string): ChatRequest => ({
    model: "fast",
    stream: false,
    messages: [{ role: "user", content: [{ type: "toolResult", toolUseId: "o", content }] }],
  });
  const requests: ChatRequest[] = [];
  const statusRows = Array.from({ length: 40 }, (_, i) => ` M src/f-${i}.ts`);
  const chatter = Array(30).fill("  (use git add to update)");
  for (const edge of ["😀", "é", "x", "_", "\u2028", "\u2029", "\u0085", "\ufeff"]) {
    // `.` stops at U+2028/2029; `$` without `m` is end of input.
    requests.push(
      shellRequest("git status -sb", [`## main${edge}x`, ...chatter, ...statusRows].join("\n")),
    );
    // `^\t\S.+$`: one astral character is two code units, so `\S.+` holds.
    requests.push(
      shellRequest(
        "git status",
        [
          "On branch main",
          "Untracked files:",
          `\t${edge}`,
          ...chatter.map(() => '  (use "git add <file>..." to include)'),
          ...Array.from({ length: 30 }, (_, i) => `\tnew-${i}.ts`),
        ].join("\n"),
      ),
    );
    // `\s+\S.+\|\s+\d+` in the operation grammar.
    requests.push(
      shellRequest(
        "git pull",
        [
          "From github.com:acme/app",
          ...Array.from({ length: 40 }, (_, i) => `remote: Counting objects: ${i}% (${i}/9)`),
          ` ${edge}| 3 ++-`,
          "Fast-forward",
        ].join("\n"),
      ),
    );
    // `m`-flag `^` also matches after U+2028/2029 inside one scanned row.
    requests.push(
      orphan(
        [
          `preamble${edge}diff --git a/x b/x`,
          `prose${edge}--- a/x`,
          ...Array.from({ length: 80 }, (_, i) => `   context row ${i}`),
        ].join("\n"),
      ),
    );
    requests.push(
      orphan(
        [
          `preamble${edge}commit abcd1234`,
          `prose${edge}Author: Dev <d@x>`,
          ...Array.from({ length: 80 }, (_, i) => `   detail row ${i}`),
        ].join("\n"),
      ),
    );
    // `\b` is ASCII: `é` is not a word character to a JS regex.
    const warnings = Array.from({ length: 25 }, (_, i) => [
      `src/w${i}.ts:${i + 1}:2 ${edge}warning${edge} w ${i}`,
      `  detail ${i}`,
    ]).flat();
    requests.push(
      shellRequest(
        "tsc --noEmit",
        [
          "Version 7",
          ...Array.from({ length: 60 }, (_, i) => `progress ${i}`),
          ...warnings,
          "Found 1 error.",
        ].join("\n"),
      ),
    );
    requests.push(
      shellRequest(
        "docker build .",
        [
          "#1 [internal] load build definition from Dockerfile",
          ...Array.from({ length: 30 }, () => `#2 CACHED${edge}`),
          ...Array.from({ length: 30 }, () => `#3 ${edge}CACHED`),
          "#20 naming to docker.io/acme/app:latest",
        ].join("\n"),
      ),
    );
    // Astral characters inside counted quantifiers and code-unit limits.
    requests.push(
      shellRequest(
        "ls -la",
        [
          "total 120",
          ...Array.from(
            { length: 30 },
            (_, i) => `-rw-r--r-- 1 u${edge} g 10 Aug 10 12:00 f${edge}-${i}.ts`,
          ),
        ].join("\n"),
      ),
    );
    requests.push(
      shellRequest(
        "rg -n x .",
        Array.from({ length: 60 }, (_, i) => `src/${edge}${i % 3}.ts:${i + 1}:${edge}`).join("\n"),
      ),
    );
    requests.push(
      shellRequest(
        "npm install",
        [
          ...Array.from({ length: 30 }, (_, i) => `npm warn ${edge}deprecated p${i}`),
          `NPM WARN ${edge}upper`,
          "added 1 package",
        ].join("\n"),
      ),
    );
    requests.push(
      shellRequest(
        `cat ${edge}`,
        Array.from({ length: 300 }, (_, i) => `${i} | ${edge}`).join("\n"),
      ),
    );
  }
  // `\d` is ASCII; `i` folds ASCII only (U+017F `ſ` and U+212A `K` fold to
  // `s`/`k` under Unicode rules); `toLowerCase` maps U+0130 to `i̇`.
  const buildWith = (row: string) =>
    shellRequest(
      "bun build src/index.ts",
      [
        "bun build v1.4.0",
        ...Array.from({ length: 40 }, (_, i) => `progress ${i}`),
        row,
        "dist/a.js 1 KB",
        "Build completed in 1s",
      ].join("\n"),
    );
  for (const row of [
    "progress \u0663",
    "progress \uff11",
    "progre\u017fs 1",
    "Compiling repeated\u212a",
    "PROGRESS 7",
  ])
    requests.push(buildWith(row));
  for (const row of ["Te\u017ft Files 1 passed", "\u212aTests 1 passed", "TEST FILES 1 passed"])
    requests.push(
      shellRequest(
        "vitest run",
        [
          "runner",
          ...Array.from({ length: 60 }, (_, i) => `noise ${i}`),
          row,
          " FAIL  test/a.test.ts > x",
          "  at a.ts:1:1",
        ].join("\n"),
      ),
    );
  // Tool names lowercase with full Unicode rules. Only U+212A lowercases to an
  // ASCII letter (`k`), and no alias contains one, so these pin the rule
  // rather than distinguish it.
  const dedupRows = Array.from({ length: 40 }, () => "same row").join("\n");
  for (const name of ["BASH", "B\u0130SH", "Bash", "EXEC", "\u0130", "R\u0130ad", "\u212a"])
    requests.push(shellRequest("echo x", dedupRows, name));
  for (const row of ["npm warn\u0130ng x", "npm WARN\u0130 x", "npm warn x"])
    requests.push(
      shellRequest(
        "npm install",
        [
          ...Array.from({ length: 30 }, (_, i) => `npm warn deprecated p${i}@1`),
          row,
          "added 1 package in 1s",
        ].join("\n"),
      ),
    );
  return requests;
}

// ----------------------------------------------------------------- filters

type FilterCall = {
  fn: string;
  executable?: string;
  subcommand?: string;
  gated?: boolean;
  mode?: GrepMode;
};

function runFilter(call: FilterCall, input: BoundedText): string {
  switch (call.fn) {
    case "build":
      return compressBuild(input);
    case "diagnostics":
      return compressDiagnostics(input);
    case "docker":
      return compressDocker(input);
    case "gitOperation":
      return compressGitOperation(input);
    case "gitStatus":
      return compressGitStatus(input);
    case "listing":
      return compressListing(input, call.executable ?? "find", call.subcommand, call.gated);
    case "packages":
      return compressPackages(input, call.executable ?? "unknown");
    case "grep":
      return compressGrep(input, call.mode as GrepMode);
    case "tests":
      return compressTests(input, call.executable);
    default:
      throw new Error(`unknown filter ${call.fn}`);
  }
}

const THEME_FILTERS: Record<string, readonly FilterCall[]> = {
  build: [{ fn: "build" }],
  lint: [{ fn: "diagnostics" }],
  docker: [{ fn: "docker" }],
  operation: [{ fn: "gitOperation" }],
  statusShort: [{ fn: "gitStatus" }],
  statusLong: [{ fn: "gitStatus" }],
  paths: [
    { fn: "listing", executable: "find", gated: true },
    { fn: "listing", executable: "find", gated: false },
  ],
  tree: [
    { fn: "listing", executable: "tree", subcommand: "classified", gated: true },
    { fn: "listing", executable: "tree", gated: true },
  ],
  lsLong: [
    { fn: "listing", executable: "ls", subcommand: "long", gated: true },
    { fn: "listing", executable: "ls", subcommand: "recursive-long", gated: true },
    { fn: "listing", executable: "ls", subcommand: "recursive-plain", gated: true },
  ],
  packages: ["npm", "pnpm", "yarn", "cargo", "uv", "bun", "pip", "other"].map((executable) => ({
    fn: "packages",
    executable,
  })),
  tests: ["bun", "vitest", "jest", "pytest", "go", "unknown"].map((executable) => ({
    fn: "tests",
    executable,
  })),
  grep: [
    { heading: false, lineNumber: true, beforeContext: 0, afterContext: 0 },
    { heading: true, lineNumber: true, beforeContext: 2, afterContext: 2 },
    { heading: false, lineNumber: true, beforeContext: 1, afterContext: 3 },
  ].map((mode) => ({ fn: "grep", mode })),
};

class CountingBudget extends ParserBudget {
  records = 0;
  units = 0;
  override chargeRecords(count: number): boolean {
    this.records += count;
    return super.chargeRecords(count);
  }
  override chargeCodeUnits(count: number): boolean {
    this.units += count;
    return super.chargeCodeUnits(count);
  }
}

/**
 * One text, every filter its theme reaches, each under a generous budget and
 * under budgets that fail at a sampled point mid-parse. `expected` is null
 * when the filter returned its input unchanged.
 */
function filterVectors(r: Rand, text: string, theme: string) {
  const calls = THEME_FILTERS[theme];
  const scanned = scanText(text);
  if (calls === undefined || scanned === undefined) return [];
  const vectors = [];
  const run = (call: FilterCall, budget: ParserBudget) => {
    const result = runFilter(call, { text, lines: scanned.lines, budget });
    return result === text ? null : result;
  };
  for (const call of calls) {
    const counting = new CountingBudget(text.length);
    vectors.push({ ...call, units: text.length, preCharge: 0, expected: run(call, counting) });
    // Fail the record allowance at a sampled point inside the parse.
    if (counting.records > 0) {
      const preCharge = 100_000 - Math.floor(counting.records * r.next());
      const budget = new ParserBudget(text.length);
      budget.chargeRecords(preCharge);
      vectors.push({ ...call, units: text.length, preCharge, expected: run(call, budget) });
    }
    // And the allocation allowance (three times `units`).
    if (counting.units > 0) {
      const units = Math.floor((counting.units * r.next()) / 3);
      vectors.push({ ...call, units, preCharge: 0, expected: run(call, new ParserBudget(units)) });
    }
  }
  return vectors;
}

// ----------------------------------------------------------------- assembly

type Entry = { id: string; source: string } & Record<string, unknown>;
const sections: Record<string, Entry[]> = {
  transform: [],
  classify: [],
  extract: [],
  scan: [],
  filters: [],
};
const seen = new Set<string>();

function add(section: string, source: string, input: Record<string, unknown>, expected: unknown) {
  if (hasLone(input)) {
    skipped.loneSurrogate++;
    return;
  }
  const id = caseId({ section, ...input });
  if (seen.has(id)) {
    skipped.duplicate++;
    return;
  }
  seen.add(id);
  sections[section]?.push({ id, source, ...input, expected });
}

function addTransform(source: string, request: ChatRequest) {
  add("transform", source, { request }, expectTransform(request));
}

for (const entry of captureSuite()) {
  const e = entry as { kind: string; request?: ChatRequest; command?: string; input?: unknown };
  if (e.kind === "transformRequest" && e.request !== undefined) addTransform("suite", e.request);
  else if (e.kind === "classifyCommand" && e.command !== undefined)
    add("classify", "suite", { command: e.command }, expectClassify(e.command));
  else if (e.kind === "extractCommand")
    add("extract", "suite", { input: e.input ?? null }, extractCommand(e.input) ?? null);
}

const r = rand(0x5eed_2026);
for (let n = 0; n < 1_800; n++) addTransform("corpus", corpusRequest(r));
for (const request of limitRequests()) addTransform("limit", request);
for (const request of semanticEdgeRequests()) addTransform("edge", request);

const allCommands = Object.values(COMMANDS).flat();
for (const command of allCommands) add("classify", "corpus", { command }, expectClassify(command));
for (let n = 0; n < 3_000; n++) {
  const command = mutateCommand(r, r.pick(allCommands));
  add("classify", "corpus", { command }, expectClassify(command));
}
for (const command of [
  "x ".repeat(256).trim(),
  "x ".repeat(257).trim(),
  "😀".repeat(8_192),
  `${"😀".repeat(8_192)}x`,
  "rg -A 1e3 x .",
  "rg -A -1 x .",
  "rg -C007 x .",
  "ls -Rl -h",
  "ls ---l",
  "env -u",
  "timeout -s",
  "timeout --",
  "timeout 5",
  "cd a && b && c",
  "cd a; b",
  "a=1",
  "_A=1 cat x",
  "1A=1 cat x",
]) {
  add("classify", "limit", { command }, expectClassify(command));
}

for (const input of [
  "git status",
  "",
  null,
  1,
  true,
  [],
  ["x"],
  {},
  { command: "a" },
  { cmd: "b" },
  { script: "c" },
  { command: "", cmd: "", script: "s" },
  { command: 1, cmd: ["x"], script: "s" },
  { command: null },
  { COMMAND: "upper" },
]) {
  add("extract", "corpus", { input }, extractCommand(input) ?? null);
}

for (const text of [
  "",
  "a",
  "\n",
  "\r",
  "\r\n",
  "\n\r",
  "a\r\nb\rc\nd",
  "a\r\r\nb",
  "\u2028a\u2029",
  "😀\n😀",
  "x\n".repeat(5),
]) {
  add("scan", "corpus", { text }, scanText(text)?.lines ?? null);
}

const f = rand(0xf11_7e75);
for (let n = 0; n < 900; n++) {
  const theme = f.pick(Object.keys(THEME_FILTERS));
  const text = block(f, theme);
  const calls = filterVectors(f, text, theme);
  if (calls.length > 0) add("filters", "corpus", { text, calls }, null);
}

const sourceHashes: Record<string, string> = {};
for (const dir of ["packages/rtk/src", "packages/rtk/src/filters"]) {
  for (const name of readdirSync(join(ROOT, dir)).sort()) {
    if (!name.endsWith(".ts")) continue;
    sourceHashes[`${dir}/${name}`] = new Bun.CryptoHasher("sha256")
      .update(readFileSync(join(ROOT, dir, name)))
      .digest("hex");
  }
}

const document = {
  generator: "conformance/vectors/rtk-export.ts",
  frozenSources: sourceHashes,
  skipped,
  ...sections,
};
const json = JSON.stringify(document);
writeFileSync(out, Bun.gzipSync(new TextEncoder().encode(json), { level: 9 }));
const counts = Object.entries(sections)
  .map(([name, entries]) => `${name}=${entries.length}`)
  .join(" ");
console.log(
  `wrote ${out}: ${counts}; skipped ${JSON.stringify(skipped)}; ${json.length} bytes raw`,
);
