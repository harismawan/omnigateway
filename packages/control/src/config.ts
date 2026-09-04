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
   * `OMNI_CLUSTER_MODE=true`: several replicas serve one installation. The
   * store is Postgres (`databaseUrl`) and the coordinator is Redis
   * (`redisUrl`), and both are required. False — the default — is one
   * process on SQLite, which is every install there was before cluster mode
   * existed, and then the two URLs must be unset: a URL present with the
   * switch off is a configuration that means one thing and does another.
   */
  clusterMode: boolean;
  /** `OMNI_DATABASE_URL`: the Postgres store of a cluster. Null single-node. */
  databaseUrl: string | null;
  /** `OMNI_REDIS_URL`: the coordinator every process of a cluster shares. Null single-node. */
  redisUrl: string | null;
  /**
   * Set when `OMNI_LOG_LEVEL` held something unrecognised.
   *
   * The boot line reports it, so a typo is visible rather than silent.
   */
  logLevelFallbackFrom: string | null;
  metricsToken: string | null;
  metricsMaxSeries: number;
  otlpEndpoint: string | null;
  otlpHeaders: string | null;
  traceSample: number;
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
  const clusterMode = TRUTHY.has((env.OMNI_CLUSTER_MODE ?? "").trim().toLowerCase());
  const databaseUrl = env.OMNI_DATABASE_URL?.trim() || undefined;
  const redisUrl = env.OMNI_REDIS_URL?.trim() || undefined;
  // One sentence each, at boot. A Postgres store with in-memory coordination
  // would be a fleet with N-fold limits and one working console, which is the
  // shape cluster mode exists to remove; and a URL set with the switch off is
  // an operator who believes they are clustered and is not.
  if (clusterMode) {
    if (databaseUrl === undefined || !databaseUrl.startsWith("postgres")) {
      throw new Error("OMNI_CLUSTER_MODE=true needs OMNI_DATABASE_URL to be a postgres:// URL");
    }
    if (redisUrl === undefined) throw new Error("OMNI_CLUSTER_MODE=true needs OMNI_REDIS_URL");
  } else if (databaseUrl !== undefined || redisUrl !== undefined) {
    throw new Error(
      "OMNI_DATABASE_URL and OMNI_REDIS_URL are cluster-mode settings; set OMNI_CLUSTER_MODE=true or unset them",
    );
  }

  const bodyLoggingAllowed = TRUTHY.has((env.OMNI_BODY_LOGGING_ALLOWED ?? "").trim().toLowerCase());

  // Deliberately not fatal, unlike OMNI_PORT: a typo in a log level is not a
  // reason to refuse to serve traffic. The boot line says which value was
  // ignored, so the mistake is still visible.
  const rawLogLevel = env.OMNI_LOG_LEVEL?.trim();
  const logLevel = parseLogLevel(rawLogLevel);
  const metricsToken = env.OMNI_METRICS_TOKEN?.trim() || null;
  const rawMaxSeries = env.OMNI_METRICS_MAX_SERIES ?? "5000";
  const metricsMaxSeries = Number(rawMaxSeries);
  if (!DECIMAL_INTEGER.test(rawMaxSeries) || metricsMaxSeries < 1) {
    throw new Error(`OMNI_METRICS_MAX_SERIES must be a positive integer, got "${rawMaxSeries}"`);
  }
  const otlpEndpoint = env.OMNI_OTLP_ENDPOINT?.trim().replace(/\/+$/, "") || null;
  const otlpHeaders = env.OMNI_OTLP_HEADERS?.trim() || null;
  const rawTraceSample = env.OMNI_TRACE_SAMPLE ?? "1.0";
  const traceSample = Number(rawTraceSample);
  if (!Number.isFinite(traceSample) || traceSample < 0 || traceSample > 1) {
    throw new Error(`OMNI_TRACE_SAMPLE must be between 0 and 1, got "${rawTraceSample}"`);
  }

  return {
    logLevel: logLevel ?? "info",
    logLevelFallbackFrom: logLevel === null && rawLogLevel ? rawLogLevel : null,
    port,
    host,
    databasePath: optionalText(env.OMNI_DB_PATH, "./omnigateway.db"),
    encryptionKey,
    baseUrl,
    staticDir: staticDir === undefined || staticDir.length === 0 ? null : staticDir,
    bodyLoggingAllowed,
    logFile: logFile === undefined || logFile.length === 0 ? null : logFile,
    clusterMode,
    databaseUrl: clusterMode ? (databaseUrl ?? null) : null,
    redisUrl: clusterMode ? (redisUrl ?? null) : null,
    metricsToken,
    metricsMaxSeries,
    otlpEndpoint,
    otlpHeaders,
    traceSample,
  };
}
