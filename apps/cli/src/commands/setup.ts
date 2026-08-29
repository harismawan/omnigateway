import { join } from "node:path";
import {
  type AgentModelMapping,
  claudeSettings,
  describeModelsForSetup,
  KEY_PLACEHOLDER,
  opencodeConfig,
  type SetupFile,
} from "@omni/control";
import { boolFlag, stringFlag } from "../args.ts";
import type { Command } from "../command.ts";
import { CliError, type Context } from "../context.ts";
import type { Writer } from "../output.ts";
import { emit, note, paint } from "../output.ts";
import { pluginProviders } from "./plugins.ts";

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

async function described(ctx: Context, writer: Writer) {
  // With the plugin-supplied providers, because the number this produces is
  // written into an agent's own configuration file. Without them a
  // plugin-supplied model resolved to no limits at all and
  // `CLAUDE_CODE_MAX_CONTEXT_TOKENS` was simply omitted — the agent then used
  // its own default while the gateway advertised the real window, and nothing
  // said so.
  const { descriptors, failures } = await pluginProviders(ctx.root.root);
  // Reported, not discarded. A plugin that failed to read is the likeliest
  // reason a limit below is about to be missing, and this command writes a file
  // that outlives it — so a silent omission is the original bug one step
  // earlier: the agent falls back to its own default while the gateway
  // advertises the real window, and nothing anywhere says why.
  for (const failure of failures) {
    note(ctx, writer, paint(ctx, "yellow", `plugin ${failure.id}: ${failure.reason}`));
  }
  const models = await describeModelsForSetup(await ctx.store(), descriptors);
  if (models.length === 0) {
    throw new CliError("no virtual models configured; add one with `omni models put`");
  }
  return { models, failures };
}

/** The gateway's own origin, which is what a client has to be pointed at. */
function baseUrl(ctx: Context): string {
  if (ctx.configError !== null) throw new CliError(ctx.configError);
  return ctx.config().baseUrl;
}

function finish(
  ctx: Context,
  writer: Writer,
  files: { path: string; contents: string }[],
  dryRun: boolean,
  key: string | undefined,
  write: (path: string, contents: string) => void,
  // In the payload, not only on stderr. `note()` is a no-op under `--json`, so
  // a provisioning script saw a config with no `limit` and nothing saying why —
  // which is the original bug exactly, on the path whose output outlives the
  // command. `dry-run` was given this and `setup` was not, in the same commit.
  pluginFailures: readonly { id: string; reason: string }[] = [],
): void {
  if (!dryRun) {
    for (const file of files) write(file.path, file.contents);
  }
  emit(ctx, writer, { files, pluginFailures }, () =>
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

async function promptMapping(
  models: Awaited<ReturnType<typeof described>>["models"],
  prompt: { input?: (question: string) => Promise<string> },
): Promise<AgentModelMapping> {
  const choices = models.map(({ model }) => model.id).join(", ");
  if (prompt.input === undefined) {
    throw new CliError("model mapping requires an interactive terminal");
  }
  const ask = async (label: string, required: boolean): Promise<string | undefined> => {
    const answer = await prompt.input?.(
      `${label} model${required ? "" : " (blank to omit)"} [${choices}]: `,
    );
    if (required && answer === "") throw new CliError("default model is required");
    return answer === "" ? undefined : answer;
  };
  const defaultModel = await ask("Default", true);
  if (defaultModel === undefined) throw new CliError("default model is required");
  const fableModel = await ask("Fable", false);
  const opusModel = await ask("Opus", false);
  const sonnetModel = await ask("Sonnet", false);
  const haikuModel = await ask("Haiku", false);
  return {
    defaultModel,
    ...(fableModel === undefined ? {} : { fableModel }),
    ...(opusModel === undefined ? {} : { opusModel }),
    ...(sonnetModel === undefined ? {} : { sonnetModel }),
    ...(haikuModel === undefined ? {} : { haikuModel }),
  };
}

/** One settings file with the operator's explicit mapping for each Claude model class. */
export const setupClaude: Command = {
  usage: "setup claude [--dir <path>] [--key <key>] [--dry-run]",
  summary: "Write Claude Code settings for this gateway",
  options: OPTIONS,
  async run(args, { ctx, writer, prompt, setupFs }) {
    const { models, failures } = await described(ctx, writer);
    const dir = stringFlag(args.values, "dir") ?? join(setupFs.homeDir, ".claude");
    const key = stringFlag(args.values, "key");
    const dryRun = boolFlag(args.values, "dry-run");
    const mapping = await promptMapping(models, prompt);
    const path = join(dir, "settings.json");

    const file = claudeSettings(
      models,
      {
        baseUrl: baseUrl(ctx),
        ...(key === undefined ? {} : { apiKey: key }),
      },
      mapping,
      setupFs.read(path) ?? undefined,
    );

    finish(ctx, writer, [at(dir, file)], dryRun, key, setupFs.write, failures);
  },
};

/** One file for the whole catalog: opencode names a window per model itself. */
export const setupOpencode: Command = {
  usage: "setup opencode [--dir <path>] [--key <key>] [--dry-run]",
  summary: "Write an opencode.json provider entry for this gateway",
  options: OPTIONS,
  async run(args, { ctx, writer, prompt, setupFs }) {
    const { models, failures } = await described(ctx, writer);
    const dir = stringFlag(args.values, "dir") ?? setupFs.cwd;
    const key = stringFlag(args.values, "key");
    const dryRun = boolFlag(args.values, "dry-run");
    const mapping = await promptMapping(models, prompt);

    const file = opencodeConfig(
      models,
      {
        baseUrl: baseUrl(ctx),
        ...(key === undefined ? {} : { apiKey: key }),
      },
      mapping,
    );

    finish(ctx, writer, [at(dir, file)], dryRun, key, setupFs.write, failures);
  },
};

export { KEY_PLACEHOLDER };
