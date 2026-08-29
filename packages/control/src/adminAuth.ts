import { hash, verify } from "@node-rs/argon2";
import { hashApiKey, type Store } from "@omni/store";
import type { Principal } from "./principal.ts";

export const ADMIN_COOKIE = "omni_admin";
const MIN_PASSWORD_LENGTH = 12;

/**
 * The gateway's session authority.
 *
 * Named for the admin because the operator was once the only caller, and kept
 * under that name because renaming it touches fifty-odd call sites for no
 * behavioural gain. It now issues sessions for three principals: the operator,
 * a read-only administrator, and the holder of one API key. `verify` is what
 * says which — it returns the principal rather than a boolean, because a caller
 * that forgets to check the kind then gets a value it cannot mistake for
 * permission.
 */
export type AdminAuth = {
  isConfigured(): Promise<boolean>;
  setPassword(password: string): Promise<void>;
  setInitialPassword(password: string): Promise<boolean>;
  login(password: string): Promise<string | null>;

  /**
   * Replaces the admin password, having been shown the current one.
   *
   * Returns false when `current` does not match, and changes nothing. The check
   * is here rather than at the route because it is the same Argon2 verify
   * `login` performs, and a caller that compared hashes itself would be a
   * second place that decides what a correct password is.
   *
   * Re-authenticating is the point: an admin session is a cookie in a browser
   * that may be sitting unattended, and a session cookie alone should not be
   * able to lock the operator out of their own gateway.
   */
  changePassword(current: string, next: string): Promise<boolean>;

  /** Whether a read-only password has been set. */
  isViewerConfigured(): Promise<boolean>;
  /**
   * Sets or clears the read-only password.
   *
   * Clearing ends viewer sessions and leaves admin sessions alone: the operator
   * withdrawing someone else's access has not changed their own credential.
   */
  setViewerPassword(password: string | null): Promise<void>;
  /** A read-only session, or null if the password is wrong or unset. */
  loginViewer(password: string): Promise<string | null>;

  /**
   * A session for the holder of a raw gateway API key.
   *
   * The raw key is hashed and looked up by the same path `/v1/*` uses, and only
   * the resulting id is kept. A revoked key is refused here and, more
   * importantly, on every later `verify`.
   */
  loginClient(rawKey: string): Promise<string | null>;

  /**
   * The principal behind a token, or null where there is none.
   *
   * Returns the principal rather than a boolean so that authorization is a
   * decision the caller has to make explicitly. A `boolean` here was what let
   * every `/api/*` route mean "the operator" without saying so.
   */
  verify(token: string): Promise<Principal | null>;
  logout(token: string): void;
  /**
   * Ends every session without changing any password.
   *
   * For the caller that replaced the database rather than a credential: a
   * restore can bring different hashes in without going through `setPassword`,
   * and the sessions in memory were issued against the hashes that just left.
   */
  invalidateSessions(): void;
  /** Ends the sessions of one kind, leaving the others alone. */
  invalidateKind(kind: Principal["kind"]): void;
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

type Session = { expiresAt: number; principal: Principal };

export function createAdminAuth(store: Store, opts: AdminAuthOptions): AdminAuth {
  // Sessions live in memory only: a restart logs everyone out, and there is
  // nothing on disk for an attacker with the database file to replay.
  const sessions = new Map<string, Session>();

  const issue = (principal: Principal): string => {
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    sessions.set(token, { expiresAt: opts.now() + opts.sessionTtlMs, principal });
    return token;
  };

  const dropKind = (kind: Principal["kind"]): void => {
    for (const [token, session] of sessions) {
      if (session.principal.kind === kind) sessions.delete(token);
    }
  };

  /** Verifies a password against a stored hash, treating absent as "no". */
  const passwordMatches = async (stored: string | null, password: string): Promise<boolean> => {
    if (stored === null) return false;
    try {
      return await verify(stored, password);
    } catch {
      return false;
    }
  };

  /**
   * Whether a client session's key is still usable.
   *
   * Read on every verify, not only at login. A session that checked once would
   * outlive a revocation by up to the session TTL, which is a revocation that
   * did not revoke — the operator pulls a key precisely because they want it to
   * stop working now.
   *
   * `keys.get` rather than scanning `keys.list()`: this runs on every request a
   * client dashboard makes, and `list` reads and JSON-parses every key in the
   * installation to look at one of them. `bun:sqlite` is synchronous, so that
   * cost lands on the whole event loop rather than on this request.
   */
  const keyStillValid = async (apiKeyId: string): Promise<boolean> => {
    const key = await store.keys.get(apiKeyId);
    return key !== null && key.revokedAt === null;
  };

  /**
   * Writes a new admin password and ends every session.
   *
   * A local function rather than a method both entry points reach through the
   * returned object: `changePassword` would otherwise depend on how it was
   * called, and one destructured `const { changePassword } = admin` would
   * silently stop clearing sessions.
   */
  const applyPassword = async (password: string): Promise<void> => {
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`admin password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    await store.config.setAdminPasswordHash(await hash(password, ARGON2));
    // A password change is also a "log everyone out" event — every kind of
    // session, because the operator changing their own password is the one
    // action that should not leave someone else's window open.
    sessions.clear();
  };

  return {
    async isConfigured() {
      return (await store.config.getAdminPasswordHash()) !== null;
    },

    setPassword: applyPassword,

    async setInitialPassword(password) {
      if (password.length < MIN_PASSWORD_LENGTH) {
        throw new Error(`admin password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      }
      return store.config.setAdminPasswordHashIfAbsent(await hash(password, ARGON2));
    },

    async changePassword(current, next) {
      // The length rule is checked **before** the current password, and the
      // order is the whole security property.
      //
      // Reversed, the two failures answer differently — a wrong current
      // password with a short new one is refused as unauthorised, a *correct*
      // one with the same short new password is refused as a bad request — so
      // `{current: guess, password: "x"}` becomes a free, unlimited,
      // non-destructive oracle for the admin password against a stolen cookie.
      // Rejecting the new password first collapses both to the same answer.
      //
      // It also equalises the work: the verify below is the only Argon2 either
      // path runs, so a wrong guess and a right one take the same time. Leaving
      // the length check after the verify would keep a ~2x latency split even
      // once both returned the same status.
      if (next.length < MIN_PASSWORD_LENGTH) {
        throw new Error(`admin password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      }
      const stored = await store.config.getAdminPasswordHash();
      if (!(await passwordMatches(stored, current))) return false;
      await applyPassword(next);
      return true;
    },

    async login(password) {
      const stored = await store.config.getAdminPasswordHash();
      if (!(await passwordMatches(stored, password))) return null;
      return issue({ kind: "admin" });
    },

    async isViewerConfigured() {
      return (await store.config.getViewerPasswordHash()) !== null;
    },

    async setViewerPassword(password) {
      if (password !== null && password.length < MIN_PASSWORD_LENGTH) {
        throw new Error(`viewer password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      }
      await store.config.setViewerPasswordHash(
        password === null ? null : await hash(password, ARGON2),
      );
      // Viewer sessions only. Changing who else may look does not log the
      // operator out of their own console.
      dropKind("viewer");
    },

    async loginViewer(password) {
      const stored = await store.config.getViewerPasswordHash();
      if (!(await passwordMatches(stored, password))) return null;
      return issue({ kind: "viewer" });
    },

    async loginClient(rawKey) {
      // Same lookup `/v1/*` performs, so a key that cannot serve a request
      // cannot open a dashboard either.
      const key = await store.keys.findByHash(await hashApiKey(rawKey));
      if (key === null || key.revokedAt !== null) return null;
      // Only the id is kept. The raw key never enters the session map, so a heap
      // dump of a running gateway yields no usable credential.
      return issue({ kind: "client", apiKeyId: key.id });
    },

    async verify(token) {
      const session = sessions.get(token);
      if (session === undefined) return null;
      if (session.expiresAt <= opts.now()) {
        sessions.delete(token);
        return null;
      }
      if (session.principal.kind === "client") {
        if (!(await keyStillValid(session.principal.apiKeyId))) {
          sessions.delete(token);
          return null;
        }
      }
      return session.principal;
    },

    logout(token) {
      sessions.delete(token);
    },

    invalidateSessions() {
      sessions.clear();
    },

    invalidateKind(kind) {
      dropKind(kind);
    },
  };
}
