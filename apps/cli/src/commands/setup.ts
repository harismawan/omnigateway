import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  claudeProfiles,
  describeModelsForSetup,
  KEY_PLACEHOLDER,
  opencodeConfig,
  type SetupFile,
} from "@omni/control";
import { boolFlag, stringFlag } from "../args.ts";
import type { Command } from "../command.ts";
import { CliError, type Context } from "../context.ts";
import type { Writer } from "../output.ts";
import { emit, note } from "../output.ts";

/**
 * Writes the configuration an agent reads at startup.
 *
 * The content comes from `@omni/control`, which is what keeps these files
 * saying the same thing as `GET /v1/models` and as the console. All this module
 * decides is where they land and what the terminal is told.
 */

const OPTIONS = {
  dir: { type: "string" },
  key: { type: "string" },
  "dry-run": { type: "boolean" },
} as const;

async function described(ctx: Context) {
  const models = await describeModelsForSetup(await ctx.store());
  if (models.length === 0) {
    throw new CliError("no virtual models configured; add one with `omni models put`");
  }
  return models;
}

/** The gateway's own origin, which is what a client has to be pointed at. */
function baseUrl(ctx: Context): string {
  if (ctx.configError !== null) throw new CliError(ctx.configError);
  return ctx.config().baseUrl;
}

function write(files: readonly { path: string; contents: string }[]): void {
  for (const file of files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.contents);
  }
}

function finish(
  ctx: Context,
  writer: Writer,
  files: { path: string; contents: string }[],
  dryRun: boolean,
  key: string | undefined,
): void {
  if (!dryRun) write(files);
  emit(ctx, writer, { files }, () =>
    dryRun
      ? files.map((f) => `--- ${f.path}\n${f.contents}`).join("\n")
      : files.map((f) => f.path).join("\n"),
  );
  if (key === undefined) {
    note(ctx, writer, "no --key given: the files carry a placeholder, so paste your key over it");
  }
}

/** Resolves a client-relative path from a generated file against the target directory. */
function at(dir: string, file: SetupFile): { path: string; contents: string } {
  return { path: join(dir, file.path), contents: file.contents };
}

/**
 * One profile per model, because `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is one number
 * for one process.
 */
export const setupClaude: Command = {
  usage: "setup claude [--dir <path>] [--key <key>] [--dry-run]",
  summary: "Write a Claude Code profile per virtual model",
  options: OPTIONS,
  async run(args, { ctx, writer }) {
    const models = await described(ctx);
    const dir = stringFlag(args.values, "dir") ?? join(homedir(), ".claude", "profiles");
    const key = stringFlag(args.values, "key");
    const dryRun = boolFlag(args.values, "dry-run");

    const files = claudeProfiles(models, {
      baseUrl: baseUrl(ctx),
      ...(key === undefined ? {} : { apiKey: key }),
    }).map((file) => at(dir, file));

    finish(ctx, writer, files, dryRun, key);
    if (!dryRun) {
      note(ctx, writer, `run one with: CLAUDE_CONFIG_DIR=${dirname(files[0]?.path ?? dir)} claude`);
    }
  },
};

/** One file for the whole catalog: opencode names a window per model itself. */
export const setupOpencode: Command = {
  usage: "setup opencode [--dir <path>] [--key <key>] [--dry-run]",
  summary: "Write an opencode.json provider entry for this gateway",
  options: OPTIONS,
  async run(args, { ctx, writer }) {
    const models = await described(ctx);
    const dir = stringFlag(args.values, "dir") ?? process.cwd();
    const key = stringFlag(args.values, "key");
    const dryRun = boolFlag(args.values, "dry-run");

    const file = opencodeConfig(models, {
      baseUrl: baseUrl(ctx),
      ...(key === undefined ? {} : { apiKey: key }),
    });

    finish(ctx, writer, [at(dir, file)], dryRun, key);
  },
};

export { KEY_PLACEHOLDER };
