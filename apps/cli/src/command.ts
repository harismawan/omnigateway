import type { ConnectFlows } from "@omni/control";
import type { ProviderId } from "@omni/ir";
import { PROVIDER_DESCRIPTORS } from "@omni/providers/descriptors";
import type { Store } from "@omni/store";
import type { OptionSpec, Parsed } from "./args.ts";
import type { Context } from "./context.ts";
import type { Writer } from "./output.ts";
import { paint, type Tone } from "./output.ts";
import type { Prompt } from "./prompt.ts";
import type { ServiceDeps } from "./service.ts";

export type SetupFs = {
  homeDir: string;
  cwd: string;
  /** Null means the file does not exist. */
  read: (path: string) => string | null;
  write: (path: string, contents: string) => void;
};

export type CommandEnv = {
  ctx: Context;
  writer: Writer;
  prompt: Prompt;
  /** Filesystem effects used only by generated client setup commands. */
  setupFs: SetupFs;
  /** Built on demand: most commands never touch the process. */
  service: () => ServiceDeps;
  /** Built on demand, and injected by tests so no test ever reaches a provider. */
  connect: (store: Store) => ConnectFlows;
  /**
   * Which providers an authorization can be started for.
   *
   * Separate from `connect` because it is asked **before** a store is opened:
   * an unknown provider is refused without touching a database, which is
   * asserted and easy to lose by reading the set off the flows instead.
   */
  connectable: () => Promise<readonly string[]>;
  /** Runs the gateway attached to this terminal, returning its exit code. */
  foreground: (input: {
    argv: readonly string[];
    cwd: string;
    env: Record<string, string | undefined>;
  }) => Promise<number>;
};

export type Command = {
  /** `omni <usage>`, shown in help. */
  usage: string;
  summary: string;
  options?: OptionSpec;
  run: (args: Parsed, env: CommandEnv) => Promise<void>;
};

/**
 * Every tone this CLI can paint, as a total record.
 *
 * Provider identity is one of the two things colour is allowed to mean. The tone
 * is stated on the provider's descriptor as a name; this file owns the mapping
 * from that name to an escape code, which is why the descriptor types it as a
 * plain string rather than importing `Tone` from here.
 *
 * `Record<Tone, true>` rather than a `Set` with `satisfies Tone[]`: a set
 * literal satisfies the array type while omitting members, so the first version
 * of this silently left out `dim` — a descriptor naming it would have fallen
 * back to `cyan` with nothing to say so. A total record cannot be short a key.
 */
const TONES: Record<Tone, true> = {
  dim: true,
  red: true,
  green: true,
  yellow: true,
  blue: true,
  magenta: true,
  cyan: true,
  orange: true,
};

function isTone(name: string): name is Tone {
  return Object.hasOwn(TONES, name);
}

function toneOf(id: ProviderId): Tone {
  // Two ways to reach the fallback, and the same answer serves both. A
  // descriptor naming a tone this terminal cannot paint is a bug in that
  // descriptor; an id with no descriptor at all is a stored target naming a
  // provider this installation does not have, which `omni doctor` reports.
  // Neither is worth failing a command over — the id still prints, uncoloured,
  // which is what a non-TTY gets anyway.
  const named = PROVIDER_DESCRIPTORS[id]?.presentation.tone;
  return named !== undefined && isTone(named) ? named : "cyan";
}

export function provider(ctx: Context, id: ProviderId): string {
  return paint(ctx, toneOf(id), id);
}

/** The other: state. */
export function state(ctx: Context, ok: boolean, text: string): string {
  return paint(ctx, ok ? "green" : "red", text);
}
