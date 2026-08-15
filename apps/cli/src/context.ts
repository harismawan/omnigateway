import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { type Config, loadConfig } from "@omni/control";
import { createStore, deriveKey, type Store } from "@omni/store";
import type { Parsed } from "./args.ts";
import { boolFlag, stringFlag } from "./args.ts";

export class CliError extends Error {
  /** 1 for anything the operator can fix; 3 when the gateway itself is the problem. */
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

/** Where the CLI looked, so `doctor` can say it out loud. */
export type RootResolution = {
  root: string;
  /** Which rule chose it. */
  source: "flag" | "env" | "cwd" | "default";
  envFile: string | null;
};

const DEFAULT_ROOT = join(homedir(), ".config", "omnigateway");

/** True when a directory looks like an installation rather than a random cwd. */
function looksLikeRoot(dir: string): boolean {
  return (
    existsSync(join(dir, ".env")) ||
    existsSync(join(dir, "omnigateway.db")) ||
    existsSync(join(dir, "apps", "gateway", "src", "index.ts"))
  );
}

/**
 * Picks the installation this invocation manages.
 *
 * The order is fixed and short on purpose: an explicit flag, then an explicit
 * environment variable, then the directory the operator is standing in if it
 * holds an installation, then the per-user default. Reading the wrong database
 * silently would be worse than refusing to run, so `doctor` prints the result.
 */
export function resolveRoot(
  flags: { root?: string | undefined },
  env: Record<string, string | undefined>,
  cwd: string,
): RootResolution {
  const withEnvFile = (root: string, source: RootResolution["source"]): RootResolution => {
    const envFile = join(root, ".env");
    return { root, source, envFile: existsSync(envFile) ? envFile : null };
  };

  if (flags.root !== undefined && flags.root.length > 0) {
    return withEnvFile(resolve(cwd, flags.root), "flag");
  }
  const fromEnv = env.OMNI_ROOT;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return withEnvFile(resolve(cwd, fromEnv), "env");
  }
  if (looksLikeRoot(cwd)) return withEnvFile(cwd, "cwd");
  return withEnvFile(DEFAULT_ROOT, "default");
}

/**
 * Reads a `.env` file into a record.
 *
 * Deliberately small: `KEY=value`, an optional `export` prefix, optional
 * matching quotes, `#` comments on their own line. Anything fancier belongs in
 * the shell that starts the gateway, not in a file two programs must agree on.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export type Context = {
  root: RootResolution;
  /** The env the gateway would see: the ambient environment, overridden by the root's `.env`. */
  env: Record<string, string | undefined>;
  /**
   * Things the operator must be told before the command's own output, because
   * this invocation did not do quite what it was asked. Formatted for stderr.
   */
  warnings: readonly string[];
  json: boolean;
  color: boolean;
  assumeYes: boolean;
  now: () => number;
  /** The parsed config, or the reason it could not be parsed. */
  config: () => Config;
  configError: string | null;
  databasePath: string;
  store: () => Promise<Store>;
  close: () => void;
};

export type ContextOptions = {
  env?: Record<string, string | undefined>;
  cwd?: string;
  now?: () => number;
  isTty?: boolean;
};

/**
 * Builds everything a command needs, without opening anything.
 *
 * The store is opened on first use so that commands which manage the process
 * — `service install`, `doctor`, `start` — still work on an installation whose
 * encryption key is missing or whose database has not been created yet.
 */
export function createContext(parsed: Parsed, options: ContextOptions = {}): Context {
  const processEnv = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const root = resolveRoot({ root: stringFlag(parsed.values, "root") }, processEnv, cwd);

  const fileEnv = root.envFile === null ? {} : parseEnvFile(readFileSync(root.envFile, "utf8"));
  // The root's own `.env` wins over the ambient environment.
  //
  // The tempting rule is the opposite one, but Bun loads the *current
  // directory's* `.env` into `process.env` before this process starts. Under
  // ambient-wins, running `omni --root /srv/omni` from a checkout would read
  // /srv/omni's database with the checkout's encryption key — and decrypt
  // nothing. The root is the operator's explicit statement of which
  // installation this is, so it decides. Everything the file does not name
  // (PATH, XDG_STATE_HOME, NO_COLOR) still comes from the environment.
  const env: Record<string, string | undefined> = { ...processEnv, ...fileEnv };

  // `--db` is the most specific statement there is, so it is read before the
  // environment is judged. A blank one is the flag being absent — `omni --db
  // "$DB"` with an unset variable is a shell handing us "", and an empty
  // configured path resolves to the root *directory*, which the store then
  // opens as if it were a file. A literal "0" is a path and stays one.
  const rawDbFlag = stringFlag(parsed.values, "db");
  const dbFlag = rawDbFlag === undefined || rawDbFlag.trim().length === 0 ? undefined : rawDbFlag;

  // An ambient OMNI_DB_PATH must not follow `--root` into another installation.
  //
  // The same Bun preload that motivates the rule above also puts the current
  // directory's OMNI_DB_PATH in the environment, and that one is usually
  // absolute — so a fresh root, which has no `.env` to displace it, would be
  // selected by the flag while its database was selected by an unrelated
  // checkout. `--root` is the most explicit signal in the invocation and cannot
  // lose to the most ambient one. The root's own `.env` still wins, because
  // that is the installation speaking about itself, and OMNI_ROOT is left alone
  // because two ambient values outranking each other surprises nobody.
  const ambientDbPath = processEnv.OMNI_DB_PATH?.trim();
  const suppressedDbPath =
    root.source === "flag" &&
    dbFlag === undefined &&
    fileEnv.OMNI_DB_PATH === undefined &&
    ambientDbPath !== undefined &&
    ambientDbPath.length > 0
      ? ambientDbPath
      : null;
  // Removed from the env rather than skipped at the point of use, so a gateway
  // this invocation starts is told the same thing the CLI decided.
  if (suppressedDbPath !== null) delete env.OMNI_DB_PATH;

  let config: Config | null = null;
  let configError: string | null = null;
  try {
    config = loadConfig(env);
  } catch (error) {
    configError = error instanceof Error ? error.message : "invalid configuration";
  }

  const configuredPath = dbFlag ?? config?.databasePath ?? "omnigateway.db";
  // Relative paths in `.env` are relative to the root, because that is the
  // working directory the gateway runs in.
  const databasePath = isAbsolute(configuredPath)
    ? configuredPath
    : resolve(root.root, configuredPath);

  // Silence would make this a second version of the same bug: the operator
  // would still be looking at a database they did not name.
  const warnings =
    suppressedDbPath === null
      ? []
      : [
          `ignoring OMNI_DB_PATH=${suppressedDbPath} from the environment because --root was given; using ${databasePath}`,
        ];

  let opened: Promise<Store> | null = null;
  let store: Store | null = null;

  const noColor =
    boolFlag(parsed.values, "no-color") ||
    (typeof processEnv.NO_COLOR === "string" && processEnv.NO_COLOR.length > 0);

  return {
    root,
    env,
    warnings,
    json: boolFlag(parsed.values, "json"),
    color: !noColor && (options.isTty ?? process.stdout.isTTY === true),
    assumeYes: boolFlag(parsed.values, "yes"),
    now: options.now ?? (() => Date.now()),
    configError,
    databasePath,

    config() {
      if (config === null) throw new CliError(configError ?? "invalid configuration");
      return config;
    },

    store() {
      if (opened === null) {
        const current = config;
        if (current === null) throw new CliError(configError ?? "invalid configuration");
        opened = deriveKey(current.encryptionKey)
          .then((key) => createStore({ path: databasePath, encryptionKey: key }))
          .then((created) => {
            store = created;
            return created;
          });
      }
      return opened;
    },

    close() {
      store?.close();
      store = null;
      opened = null;
    },
  };
}
