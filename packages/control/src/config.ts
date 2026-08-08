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
};

const MIN_KEY_LENGTH = 16;
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

  const rawPort = env.OMNI_PORT ?? "8787";
  const port = Number(rawPort);
  if (!DECIMAL_INTEGER.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`OMNI_PORT must be an integer between 1 and 65535, got "${rawPort}"`);
  }

  const derivedBaseUrl = `http://${host}:${port}`;
  const baseUrl =
    optionalText(env.OMNI_BASE_URL, derivedBaseUrl).replace(/\/+$/, "") || derivedBaseUrl;

  const staticDir = env.OMNI_STATIC_DIR?.trim();

  return {
    port,
    host,
    databasePath: optionalText(env.OMNI_DB_PATH, "./omnigateway.db"),
    encryptionKey,
    baseUrl,
    staticDir: staticDir === undefined || staticDir.length === 0 ? null : staticDir,
  };
}
