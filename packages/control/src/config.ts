import { type LogLevel, parseLogLevel } from "@omni/ir";

export type Config = {
  port: number;
  host: string;
  databasePath: string;
  encryptionKey: string;
  /** Origin the OAuth callback is registered under. */
  baseUrl: string;
  /**
   * Explicit location of the built dashboard, when the operator has one.
   *
   * Null means "look in the usual places": the bundle beside the server in a
   * published package, or the workspace build in a checkout. A wrong path here
   * is worth reporting rather than silently falling back, so the bootstrap
   * takes this literally when it is set.
   */
  staticDir: string | null;
  /**
   * Whether `GET /v1/models` also advertises `claude/<id>` discovery mirrors.
   *
   * Claude Code's model picker lists only ids beginning with `claude` or
   * `anthropic`, so without this a pool named `opus` or `gpt-5.6-sol` never
   * appears there however well it routes. Off by default: an installation whose
   * clients are not Claude Code should not have its catalog doubled.
   */
  exposeClaudeCodeAliases: boolean;
  /**
   * Whether this installation is permitted to capture request and response
   * bodies at all.
   *
   * The first of two independent keys: `settings.bodyLoggingEnabled` is the
   * second, and capture happens only when both say yes. Read at boot and never
   * again, so a compromised admin session cannot by itself start recording
   * prompts — flipping the setting on an installation whose environment does not
   * permit it does nothing at all. The operator who does set this can still turn
   * capture on and off mid-incident without a restart.
   */
  bodyLoggingAllowed: boolean;
  /** Threshold for stdout logging. Read once, at boot. */
  logLevel: LogLevel;
  /**
   * Where something captured this process's stdout, when anything did.
   *
   * A process cannot read back what it wrote to stdout, so the console view
   * reads whatever captured it. Null means look for the systemd journal
   * instead, and then report that nothing captured it — which is the ordinary
   * state under `bun run dev`, not an error. Taken literally when set, like
   * `staticDir`.
   */
  logFile: string | null;
  /**
   * Set when `OMNI_LOG_LEVEL` held something unrecognised.
   *
   * The boot line reports it, so a typo is visible rather than silent.
   */
  logLevelFallbackFrom: string | null;
};

const MIN_KEY_LENGTH = 16;
/** Spellings of "on" a flag accepts. Anything else, including empty, is off. */
const TRUTHY = new Set(["1", "true", "yes", "on"]);
const DECIMAL_INTEGER = /^\d+$/;

function optionalText(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

/**
 * Pure function of an env object so boot configuration is testable.
 *
 * The encryption key has no default on purpose. A default would mean every
 * deployment that forgets to set it encrypts its credentials with a key printed
 * in this repository, which is worse than not booting.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const encryptionKey = env.OMNI_ENCRYPTION_KEY;
  if (typeof encryptionKey !== "string" || encryptionKey.length < MIN_KEY_LENGTH) {
    throw new Error(
      `OMNI_ENCRYPTION_KEY must be set to at least ${MIN_KEY_LENGTH} characters. ` +
        "Generate one with: openssl rand -base64 32",
    );
  }

  const host = optionalText(env.OMNI_HOST, "127.0.0.1");

  const rawPort = env.OMNI_PORT ?? "9000";
  const port = Number(rawPort);
  if (!DECIMAL_INTEGER.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`OMNI_PORT must be an integer between 1 and 65535, got "${rawPort}"`);
  }

  const derivedBaseUrl = `http://${host}:${port}`;
  const baseUrl =
    optionalText(env.OMNI_BASE_URL, derivedBaseUrl).replace(/\/+$/, "") || derivedBaseUrl;

  const staticDir = env.OMNI_STATIC_DIR?.trim();
  const logFile = env.OMNI_LOG_FILE?.trim();

  const exposeClaudeCodeAliases = TRUTHY.has(
    (env.OMNI_EXPOSE_CLAUDE_CODE_ALIASES ?? "").trim().toLowerCase(),
  );

  const bodyLoggingAllowed = TRUTHY.has((env.OMNI_BODY_LOGGING_ALLOWED ?? "").trim().toLowerCase());

  // Deliberately not fatal, unlike OMNI_PORT: a typo in a log level is not a
  // reason to refuse to serve traffic. The boot line says which value was
  // ignored, so the mistake is still visible.
  const rawLogLevel = env.OMNI_LOG_LEVEL?.trim();
  const logLevel = parseLogLevel(rawLogLevel);

  return {
    logLevel: logLevel ?? "info",
    logLevelFallbackFrom: logLevel === null && rawLogLevel ? rawLogLevel : null,
    port,
    host,
    databasePath: optionalText(env.OMNI_DB_PATH, "./omnigateway.db"),
    encryptionKey,
    baseUrl,
    staticDir: staticDir === undefined || staticDir.length === 0 ? null : staticDir,
    exposeClaudeCodeAliases,
    bodyLoggingAllowed,
    logFile: logFile === undefined || logFile.length === 0 ? null : logFile,
  };
}
