import { hash, verify } from "@node-rs/argon2";
import { type Coord, memoryCoord } from "@omni/coord";
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
  logout(token: string): Promise<void>;
  /**
   * Ends every session without changing any password.
   *
   * For the caller that replaced the database rather than a credential: a
   * restore can bring different hashes in without going through `setPassword`,
   * and the sessions in memory were issued against the hashes that just left.
   */
  invalidateSessions(): Promise<void>;
  /** Ends the sessions of one kind, leaving the others alone. */
  invalidateKind(kind: Principal["kind"]): Promise<void>;
};

export type AdminAuthOptions = {
  now: () => number;
  sessionTtlMs: number;
  /** Where sessions live. In-memory when absent. */
  coord?: Coord;
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

/** Where a session lives: `sess:<kind>:<sha256(token)>`. */
const PREFIX = "sess:";

/**
 * The token never reaches the store: what is keyed on is its digest, so a
 * dump of whatever holds sessions yields nothing a browser could present.
 */
function sessionKey(kind: Principal["kind"], token: string): string {
  return `${PREFIX}${kind}:${new Bun.CryptoHasher("sha256").update(token).digest("hex")}`;
}

export function createAdminAuth(store: Store, opts: AdminAuthOptions): AdminAuth {
  // Sessions live behind `coord.kv` with a TTL. In memory that is a map a
  // restart empties, so nothing on disk can be replayed; in a fleet it is
  // whatever the coordinator holds, so a cookie issued by one process is
  // known to every other and a password change ends it everywhere.
  const coord = opts.coord ?? memoryCoord({ now: opts.now });

  const issue = async (principal: Principal): Promise<string> => {
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const session: Session = { expiresAt: opts.now() + opts.sessionTtlMs, principal };
    await coord.kv.set(
      sessionKey(principal.kind, token),
      JSON.stringify(session),
      opts.sessionTtlMs,
    );
    return token;
  };

  const dropKind = (kind: Principal["kind"]): Promise<void> =>
    coord.kv.delPrefix(`${PREFIX}${kind}:`);

  /**
   * The session behind a token, looked up under each kind in turn.
   *
   * The token does not say which kind it is, and three reads per verify is
   * the price of `delPrefix` being able to end one kind without a scan.
   */
  const lookup = async (token: string): Promise<{ key: string; session: Session } | null> => {
    for (const kind of ["admin", "viewer", "client"] as const) {
      const key = sessionKey(kind, token);
      const raw = await coord.kv.get(key);
      if (raw !== null) return { key, session: JSON.parse(raw) as Session };
    }
    return null;
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
    await coord.kv.delPrefix(PREFIX);
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
      await dropKind("viewer");
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
      const found = await lookup(token);
      if (found === null) return null;
      const { key, session } = found;
      // The TTL already bounds this; checked again against the injected clock
      // so the answer is the same whichever clock the coordinator expires on.
      if (session.expiresAt <= opts.now()) {
        await coord.kv.del(key);
        return null;
      }
      if (session.principal.kind === "client") {
        if (!(await keyStillValid(session.principal.apiKeyId))) {
          await coord.kv.del(key);
          return null;
        }
      }
      return session.principal;
    },

    async logout(token) {
      const found = await lookup(token);
      if (found !== null) await coord.kv.del(found.key);
    },

    invalidateSessions() {
      return coord.kv.delPrefix(PREFIX);
    },

    invalidateKind(kind) {
      return dropKind(kind);
    },
  };
}
