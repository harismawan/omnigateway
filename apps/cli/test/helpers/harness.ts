import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectFlows } from "@omni/control";
import { createStore, deriveKey, type Store } from "@omni/store";
import type { Writer } from "../../src/output.ts";
import type { Prompt } from "../../src/prompt.ts";
import { type RunOptions, run } from "../../src/run.ts";
import type { RunResult, ServiceDeps, Spawner } from "../../src/service.ts";

export const TEST_KEY = "test-encryption-key-0123456789";

/** Opens an installation's store the way the CLI would, for arranging state. */
export async function openStore(root: string): Promise<Store> {
  return createStore({
    path: join(root, "omnigateway.db"),
    encryptionKey: await deriveKey(TEST_KEY),
  });
}

/** A throwaway installation root with a `.env` the CLI will find. */
export function makeRoot(env: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "omni-cli-"));
  const lines = { OMNI_ENCRYPTION_KEY: TEST_KEY, ...env };
  writeFileSync(
    join(root, ".env"),
    Object.entries(lines)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
  );
  return root;
}

export type Captured = { out: string[]; err: string[]; writer: Writer };

export function capture(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    writer: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    },
  };
}

export type FakeService = {
  deps: ServiceDeps;
  /** Every command the CLI tried to run, in order. */
  commands: string[][];
  spawned: Array<Parameters<Spawner>[0]>;
  killed: Array<{ pid: number; signal: string }>;
};

/**
 * A service layer that touches nothing.
 *
 * No systemctl, no spawn, no signals: a test that starts the gateway asserts on
 * what the CLI *asked for*, which is the part that can be wrong.
 */
export function fakeService(input: {
  root: string;
  stateDir?: string;
  unitPath?: string;
  runResults?: Record<string, RunResult>;
  healthy?: boolean;
  alivePids?: Set<number>;
  pid?: number;
}): FakeService {
  const commands: string[][] = [];
  const spawned: Array<Parameters<Spawner>[0]> = [];
  const killed: Array<{ pid: number; signal: string }> = [];
  const alive = input.alivePids ?? new Set<number>();
  const stateDir = input.stateDir ?? join(input.root, "state");
  mkdirSync(stateDir, { recursive: true });

  const deps: ServiceDeps = {
    root: input.root,
    stateDir,
    scope: "user",
    // Points inside the temporary root: a test must never see, or write, the
    // operator's real unit.
    unitPath: input.unitPath ?? join(input.root, "no-unit", "omnigateway.service"),
    run: async (argv) => {
      commands.push([...argv]);
      return input.runResults?.[argv.join(" ")] ?? { code: 0, stdout: "", stderr: "" };
    },
    spawn: (spawnInput) => {
      spawned.push(spawnInput);
      const pid = input.pid ?? 4242;
      alive.add(pid);
      return pid;
    },
    probe: async () => input.healthy ?? true,
    alive: (pid) => alive.has(pid),
    kill: (pid, signal) => {
      killed.push({ pid, signal });
      alive.delete(pid);
    },
    sleep: async () => {},
    now: () => 1_000_000,
  };

  return { deps, commands, spawned, killed };
}

export const silentPrompt: Prompt = {
  isTty: false,
  secret: async () => "",
  confirm: async () => true,
};

/** Runs the CLI the way a terminal would, with nothing real underneath. */
export async function cli(
  argv: string[],
  input: {
    root: string;
    service?: FakeService;
    prompt?: Prompt;
    connect?: (store: Store) => ConnectFlows;
    foreground?: RunOptions["foreground"];
    env?: Record<string, string | undefined>;
    now?: () => number;
  },
): Promise<{ code: number; out: string; err: string; lines: string[] }> {
  const captured = capture();
  const options: RunOptions = {
    env: input.env ?? {},
    cwd: input.root,
    isTty: false,
    ...(input.now === undefined ? {} : { now: input.now }),
    prompt: input.prompt ?? silentPrompt,
    ...(input.service === undefined ? {} : { service: () => input.service?.deps as ServiceDeps }),
    ...(input.connect === undefined ? {} : { connect: input.connect }),
    ...(input.foreground === undefined ? {} : { foreground: input.foreground }),
  };

  const code = await run(["--root", input.root, ...argv], captured.writer, options);
  return {
    code,
    out: captured.out.join("\n"),
    err: captured.err.join("\n"),
    lines: captured.out,
  };
}
