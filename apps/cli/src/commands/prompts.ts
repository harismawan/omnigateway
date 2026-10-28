import {
  activatePromptVersion,
  createPrompt,
  duplicatePrompt,
  listPrompts,
  type PromptView,
  readPrompt,
  removePrompt,
  savePromptVersion,
} from "@omni/control";
import {
  boolFlag,
  listFlag,
  type Parsed,
  requirePositional,
  stringFlag,
  UsageError,
} from "../args.ts";
import type { Command, CommandEnv } from "../command.ts";
import { CliError } from "../context.ts";
import { emit, fields, table } from "../output.ts";

// Do not quote surplus arguments: a mistaken positional may be prompt text.
function positionals(args: Parsed, count: number): void {
  if (args.positionals.length > count) throw new UsageError("unexpected positional arguments");
}

function version(raw: string): number {
  const value = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) {
    throw new UsageError("version must be a positive decimal integer");
  }
  return value;
}

async function readText(args: Parsed, env: CommandEnv): Promise<string> {
  const files = listFlag(args.values, "file") ?? [];
  if (files.length > 1) throw new UsageError("provide only one --file source");
  const file = files[0];
  try {
    return file === undefined || file === "-"
      ? await env.promptInput.readStdin()
      : await env.promptInput.readFile(file);
  } catch (error) {
    // Only this fixed runtime refusal is safe to carry through. Input effects
    // may throw errors containing the body; neither those nor paths are echoed.
    if (error instanceof CliError && error.message === "provide --file or pipe prompt text") {
      throw new CliError("provide --file or pipe prompt text");
    }
    throw new CliError("could not read prompt text; provide --file or pipe prompt text");
  }
}

function summary({ versions: _versions, ...entry }: PromptView) {
  return entry;
}

function describe(prompt: ReturnType<typeof summary>): string {
  return fields([
    ["id", prompt.id],
    ["name", prompt.name],
    ["active version", String(prompt.activeVersion ?? "draft")],
    ["global", prompt.assignments.global ? "yes" : "no"],
    ["keys", String(prompt.assignments.keyIds.length)],
  ]);
}

const INPUT_HELP =
  "Read literal text from --file <path>, --file - (stdin), or stdin when omitted. Pipe text or provide --file at a terminal. Leading whitespace is preserved; trailing whitespace is trimmed by control. Prompt text is never accepted as an argument. --draft saves without activating.";

export const promptsList: Command = {
  usage: "prompts list",
  summary: "List built-in and user prompts with assignment counts (no text)",
  async run(args, { ctx, writer }) {
    positionals(args, 0);
    const prompts = await listPrompts(await ctx.store());
    emit(ctx, writer, { prompts }, () =>
      table(
        [
          { header: "ID" },
          { header: "NAME" },
          { header: "BUILTIN" },
          { header: "ACTIVE" },
          { header: "GLOBAL" },
          { header: "KEYS", align: "right" },
        ],
        prompts.map((p) => [
          p.id,
          p.name,
          p.builtin ? "yes" : "no",
          String(p.activeVersion ?? "draft"),
          p.assignments.global ? "yes" : "no",
          String(p.assignments.keyIds.length),
        ]),
      ),
    );
  },
};

export const promptsShow: Command = {
  usage: "prompts show <id> [--version n]",
  summary: "Show exact version text (defaults to active, or latest draft)",
  help: "Versions are positive decimal integers. Built-in prompts accept --version v4.9.0. Missing/pruned versions are refused, never replaced with current text.",
  options: { version: { type: "string" } },
  async run(args, { ctx, writer }) {
    positionals(args, 1);
    const id = requirePositional(args, 0, "prompt id");
    const raw = stringFlag(args.values, "version");
    const requested =
      raw === undefined
        ? undefined
        : id.startsWith("ponytail-") && raw === "v4.9.0"
          ? raw
          : version(raw);
    const detail = await readPrompt(await ctx.store(), id);
    const selected = requested ?? detail.activeVersion ?? detail.versions[0]?.version;
    const saved = detail.versions.find((v) => v.version === selected);
    if (saved === undefined) throw new CliError("no such prompt version");
    const prompt: PromptView = { ...detail, versions: [saved] };
    emit(
      ctx,
      writer,
      { prompt },
      () => `${describe(summary(prompt))}\nversion: ${saved.version}\n\n${saved.text}`,
    );
  },
};

export const promptsCreate: Command = {
  usage: "prompts create <id> --name <name> [--file <path>|--file -] [--draft]",
  summary: "Create a prompt from file or stdin",
  help: INPUT_HELP,
  options: {
    name: { type: "string" },
    file: { type: "string", multiple: true },
    draft: { type: "boolean" },
  },
  async run(args, env) {
    positionals(args, 1);
    const id = requirePositional(args, 0, "prompt id");
    const name = stringFlag(args.values, "name");
    if (name === undefined) throw new UsageError("--name is required");
    const text = await readText(args, env);
    const prompt = await createPrompt(await env.ctx.store(), {
      id,
      name,
      text,
      activate: !boolFlag(args.values, "draft"),
    });
    const entry = summary(prompt);
    emit(env.ctx, env.writer, entry, () => describe(entry));
  },
};

export const promptsSave: Command = {
  usage: "prompts save <id> [--file <path>|--file -] [--note <note>] [--draft]",
  summary: "Save a new immutable version, activating unless --draft",
  help: INPUT_HELP,
  options: {
    file: { type: "string", multiple: true },
    note: { type: "string" },
    draft: { type: "boolean" },
  },
  async run(args, env) {
    positionals(args, 1);
    const id = requirePositional(args, 0, "prompt id");
    const text = await readText(args, env);
    const store = await env.ctx.store();
    const saved = await savePromptVersion(store, id, {
      text,
      note: stringFlag(args.values, "note"),
      activate: !boolFlag(args.values, "draft"),
    });
    const entry = { ...summary(await readPrompt(store, id)), version: saved.version };
    emit(env.ctx, env.writer, entry, () => `${describe(entry)}\nsaved version: ${saved.version}`);
  },
};

export const promptsActivate: Command = {
  usage: "prompts activate <id> <version>",
  summary: "Activate a saved version, including rollback to an older one",
  async run(args, { ctx, writer }) {
    positionals(args, 2);
    const id = requirePositional(args, 0, "prompt id");
    const selected = version(requirePositional(args, 1, "version"));
    const entry = summary(
      await activatePromptVersion(await ctx.store(), id, { version: selected }),
    );
    emit(ctx, writer, entry, () => describe(entry));
  },
};

export const promptsDuplicate: Command = {
  usage: "prompts duplicate <source> <id> [--name <name>]",
  summary: "Copy active text (or latest draft), defaulting to the source name",
  options: { name: { type: "string" } },
  async run(args, { ctx, writer }) {
    positionals(args, 2);
    const source = requirePositional(args, 0, "source prompt id");
    const id = requirePositional(args, 1, "new prompt id");
    const store = await ctx.store();
    const name = stringFlag(args.values, "name") ?? (await readPrompt(store, source)).name;
    const entry = summary(await duplicatePrompt(store, source, { id, name }));
    emit(ctx, writer, entry, () => describe(entry));
  },
};

export const promptsRemove: Command = {
  usage: "prompts remove <id>",
  summary: "Remove an unassigned user prompt and its versions",
  async run(args, { ctx, writer }) {
    positionals(args, 1);
    const id = requirePositional(args, 0, "prompt id");
    await removePrompt(await ctx.store(), id);
    emit(ctx, writer, { id, removed: true }, () => `${id} removed`);
  },
};
