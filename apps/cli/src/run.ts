import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { type ConnectFlows, createConnectFlows, OAUTH_PROVIDERS } from "@omni/control";
import { GatewayError } from "@omni/ir";
import { nodeHttpClient } from "@omni/providers";
import type { Store } from "@omni/store";
import { boolFlag, parse, UsageError } from "./args.ts";
import type { CommandEnv } from "./command.ts";
import { CliError, type ContextOptions, createContext } from "./context.ts";
import { commandHelp, helpText } from "./help.ts";
import type { Writer } from "./output.ts";
import { createPrompt } from "./prompt.ts";
import { resolveCommand } from "./registry.ts";
import { createServiceDeps, runForeground } from "./runtime.ts";
import type { ServiceDeps } from "./service.ts";

export const VERSION = "0.0.0";

export type RunOptions = ContextOptions & {
  /** Overridden by tests, which must never spawn a process or call systemctl. */
  service?: (input: { root: string; env: Record<string, string | undefined> }) => ServiceDeps;
  prompt?: CommandEnv["prompt"];
  connect?: (store: Store) => ConnectFlows;
  foreground?: CommandEnv["foreground"];
  setupFs?: CommandEnv["setupFs"];
};

/**
 * Runs one invocation and returns its exit code.
 *
 * Exit codes: 0 success, 1 an operator error, 2 a usage error, 3 the gateway
 * itself. Everything a caller needs is injectable, so a test drives the same
 * path a terminal does.
 */
export async function run(
  argv: readonly string[],
  writer: Writer,
  options: RunOptions = {},
): Promise<number> {
  // `--help` and `--version` are answered by scanning, before anything is
  // parsed, resolved, or opened: they must work on a broken installation and
  // on an argv the command parser would reject.
  const wants = (...flags: string[]) => argv.some((token) => flags.includes(token));

  if (wants("--version")) {
    writer.out(VERSION);
    return 0;
  }

  const resolved = resolveCommand(argv);
  if (resolved === null) {
    const words = argv.filter((token) => !token.startsWith("-"));
    if (words.length > 0 && !wants("--help", "-h")) {
      writer.err(`unknown command: ${words.join(" ")}`);
      writer.err("run omni --help for the command list");
      return 2;
    }
    writer.out(helpText());
    return 0;
  }
  if (wants("--help", "-h")) {
    writer.out(commandHelp(resolved.name));
    return 0;
  }

  let args: ReturnType<typeof parse>;
  try {
    args = parse(resolved.rest, resolved.command.options ?? {});
  } catch (error) {
    writer.err(error instanceof Error ? error.message : "could not parse arguments");
    writer.err(`usage: omni ${resolved.command.usage}`);
    return 2;
  }

  const ctx = createContext(args, options);
  const prompt = options.prompt ?? createPrompt(ctx, writer);
  const scope = boolFlag(args.values, "system") ? ("system" as const) : ("user" as const);

  const env: CommandEnv = {
    ctx,
    writer,
    prompt,
    setupFs: options.setupFs ?? {
      homeDir: homedir(),
      cwd: process.cwd(),
      write: (path, contents) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, contents);
      },
    },
    service: () =>
      options.service?.({ root: ctx.root.root, env: ctx.env }) ??
      createServiceDeps({ root: ctx.root.root, env: ctx.env, scope, now: ctx.now }),
    foreground: options.foreground ?? runForeground,
    connect: (store) =>
      options.connect?.(store) ??
      createConnectFlows({
        store,
        providers: OAUTH_PROVIDERS,
        http: nodeHttpClient(),
        now: ctx.now,
      }),
  };

  try {
    await resolved.command.run(args, env);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      writer.err(error.message);
      writer.err(`usage: omni ${resolved.command.usage}`);
      return 2;
    }
    if (error instanceof CliError) {
      writer.err(error.message);
      return error.exitCode;
    }
    if (error instanceof GatewayError) {
      // The operations throw the gateway's own errors; the code is worth
      // keeping, because it is the same one the console would have shown.
      writer.err(`${error.code}: ${error.message}`);
      return 1;
    }
    writer.err(error instanceof Error ? error.message : "unknown error");
    return 1;
  } finally {
    ctx.close();
  }
}
