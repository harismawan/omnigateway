import { hash, verify } from "@node-rs/argon2";
import type { Store } from "@omni/store";

export const ADMIN_COOKIE = "omni_admin";
const MIN_PASSWORD_LENGTH = 12;

export type AdminAuth = {
  isConfigured(): Promise<boolean>;
  setPassword(password: string): Promise<void>;
  setInitialPassword(password: string): Promise<boolean>;
  login(password: string): Promise<string | null>;
  verify(token: string): Promise<boolean>;
  logout(token: string): void;
};

export type AdminAuthOptions = {
  now: () => number;
  sessionTtlMs: number;
};

/**
 * Argon2id, not SHA-256.
 *
 * This is the one secret in the system a human chooses, so it is the one place
 * where a slow hash buys anything. Parameters are the OWASP baseline: 19 MiB of
 * memory, 2 passes, 1 lane.
 */
const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function createAdminAuth(store: Store, opts: AdminAuthOptions): AdminAuth {
  // Sessions live in memory only: a restart logs the operator out, and there is
  // nothing on disk for an attacker with the database file to replay.
  const sessions = new Map<string, number>();

  async function currentHash(): Promise<string | null> {
    return store.config.getAdminPasswordHash();
  }

  return {
    async isConfigured() {
      return (await currentHash()) !== null;
    },

    async setPassword(password) {
      if (password.length < MIN_PASSWORD_LENGTH) {
        throw new Error(`admin password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      }
      await store.config.setAdminPasswordHash(await hash(password, ARGON2));
      // A password change is also a "log everyone out" event.
      sessions.clear();
    },

    async setInitialPassword(password) {
      if (password.length < MIN_PASSWORD_LENGTH) {
        throw new Error(`admin password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      }
      return store.config.setAdminPasswordHashIfAbsent(await hash(password, ARGON2));
    },

    async login(password) {
      const stored = await currentHash();
      if (stored === null) return null;

      let ok = false;
      try {
        ok = await verify(stored, password);
      } catch {
        ok = false;
      }
      if (!ok) return null;

      const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
      sessions.set(token, opts.now() + opts.sessionTtlMs);
      return token;
    },

    async verify(token) {
      const expiresAt = sessions.get(token);
      if (expiresAt === undefined) return false;
      if (expiresAt <= opts.now()) {
        sessions.delete(token);
        return false;
      }
      return true;
    },

    logout(token) {
      sessions.delete(token);
    },
  };
}
