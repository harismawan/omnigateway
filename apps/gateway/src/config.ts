export type Config = {
  port: number;
  host: string;
  databasePath: string;
  encryptionKey: string;
  /** Origin the OAuth callback is registered under. */
  baseUrl: string;
};

const MIN_KEY_LENGTH = 16;

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

  const host = env.OMNI_HOST ?? "127.0.0.1";

  const rawPort = env.OMNI_PORT ?? "8787";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`OMNI_PORT must be an integer between 1 and 65535, got "${rawPort}"`);
  }

  const baseUrl = (env.OMNI_BASE_URL ?? `http://${host}:${port}`).replace(/\/+$/, "");

  return {
    port,
    host,
    databasePath: env.OMNI_DB_PATH ?? "./omnigateway.db",
    encryptionKey,
    baseUrl,
  };
}
