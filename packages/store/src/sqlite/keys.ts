import type { Database } from "bun:sqlite";
import { type Logger, noopLogger } from "@omni/ir";
import { type LimitConfig, parseLimitConfig } from "@omni/ratelimit/catalog";
import type { ApiKey, KeyRepo } from "../types.ts";

const PREFIX = "sk-omni-";

/** 32 bytes of entropy, base64url, prefixed for recognisability in logs. */
export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return PREFIX + b64;
}

/**
 * SHA-256, not Argon2id.
 *
 * Argon2 exists to slow brute force against low-entropy human passwords. An API
 * key is 256 bits of CSPRNG output, so there is nothing to brute force, and a
 * slow hash on the hot path of every proxied request would be a real cost. The
 * admin *password* does use Argon2id (Task 18) because it is human-chosen.
 */
export async function hashApiKey(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

type Row = {
  id: string;
  label: string;
  prefix: string;
  hash: string;
  model_allowlist: string | null;
  limits: string;
  body_logging_opt_out: number;
  created_at: number;
  revoked_at: number | null;
};

/**
 * An unreadable `limits` value marks the key rather than being discarded — and
 * rather than throwing.
 *
 * `parseRtkFilters` may drop an id it does not know because the worst outcome is
 * a gap in reported history. A limit dropped the same way reads as "no limit"
 * and fails open on a ceiling the operator explicitly set, so `null` is returned
 * as its own state and refused later at the auth chokepoint.
 *
 * Throwing here was the obvious first answer and the wrong blast radius: `toKey`
 * serves `list` as well as `findByHash`, so one meddled row took away the very
 * listing an operator would use to find it, in both the console and the CLI.
 * Refuse at auth, degrade at list.
 */
function parseLimits(id: string, raw: string, logger: Logger): LimitConfig | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parseLimitConfig(parsed);
  } catch {
    // Named, so the failure is not silent. The cause is deliberately not
    // rendered: it is a zod message built from the stored value, and `LogFields`
    // is a redaction boundary rather than a place to paste one.
    logger.error("api key limits unreadable", { apiKeyId: id });
    return null;
  }
}

const toKey = (r: Row, logger: Logger): ApiKey => ({
  id: r.id,
  label: r.label,
  prefix: r.prefix,
  hash: r.hash,
  modelAllowlist: r.model_allowlist === null ? null : (JSON.parse(r.model_allowlist) as string[]),
  limits: parseLimits(r.id, r.limits, logger),
  // Only a stored 1 opts out; anything else leaves the key on the
  // installation-wide setting, which is itself off by default.
  bodyLoggingOptOut: r.body_logging_opt_out === 1,
  createdAt: r.created_at,
  revokedAt: r.revoked_at,
});

export function createKeyRepo(db: Database, logger: Logger = noopLogger): KeyRepo {
  return {
    async list() {
      return db
        .query<Row, []>("SELECT * FROM api_keys ORDER BY created_at DESC")
        .all()
        .map((row) => toKey(row, logger));
    },

    async findByHash(hash: string) {
      const row = db.query<Row, [string]>("SELECT * FROM api_keys WHERE hash = ?").get(hash);
      return row ? toKey(row, logger) : null;
    },

    async get(id: string) {
      // `toKey` here as everywhere else, so a row with unparseable limits reads
      // back as `limits: null` rather than throwing. A revocation check that
      // threw on a broken row would lock a session out for the wrong reason.
      const row = db.query<Row, [string]>("SELECT * FROM api_keys WHERE id = ?").get(id);
      return row ? toKey(row, logger) : null;
    },

    async create(input) {
      const now = Date.now();
      db.run(
        `INSERT INTO api_keys (id, label, prefix, hash, model_allowlist, limits,
                               body_logging_opt_out, created_at, revoked_at)
         VALUES (?,?,?,?,?,?,?,?,NULL)`,
        [
          input.id,
          input.label,
          input.prefix,
          input.hash,
          input.modelAllowlist === null ? null : JSON.stringify(input.modelAllowlist),
          // Validated on the way in as well as on the way out, so a caller that
          // reached past the control schema cannot write a shape no reader can
          // parse and lock its own key out.
          JSON.stringify(parseLimitConfig(input.limits)),
          input.bodyLoggingOptOut ? 1 : 0,
          now,
        ],
      );
      return { ...input, createdAt: now, revokedAt: null };
    },

    async importRow(row) {
      if (row.limits === null) throw new Error(`api key ${row.id} has unreadable limits`);
      db.run(
        `INSERT INTO api_keys (id, label, prefix, hash, model_allowlist, limits,
                               body_logging_opt_out, created_at, revoked_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          row.id,
          row.label,
          row.prefix,
          row.hash,
          row.modelAllowlist === null ? null : JSON.stringify(row.modelAllowlist),
          JSON.stringify(parseLimitConfig(row.limits)),
          row.bodyLoggingOptOut ? 1 : 0,
          row.createdAt,
          row.revokedAt,
        ],
      );
    },

    async setLimits(id: string, limits: LimitConfig) {
      db.run("UPDATE api_keys SET limits = ? WHERE id = ?", [
        // Same guard as `create`, and for the same reason: an edit that reached
        // past the control schema must not be able to write a matrix the next
        // reader refuses, which is a key locked out of `/v1` by its own repair.
        JSON.stringify(parseLimitConfig(limits)),
        id,
      ]);
    },

    async setModelAllowlist(id: string, modelAllowlist: string[] | null) {
      db.run("UPDATE api_keys SET model_allowlist = ? WHERE id = ?", [
        // Same encoding as `create`. No parse guard here, unlike `limits`: any
        // JSON array of names reads back fine, and an entry no configured model
        // matches simply denies those requests — per-request fail closed, not
        // the whole-key lockout the limits guard exists to prevent.
        modelAllowlist === null ? null : JSON.stringify(modelAllowlist),
        id,
      ]);
    },

    async revoke(id: string) {
      db.run("UPDATE api_keys SET revoked_at = ? WHERE id = ?", [Date.now(), id]);
    },
  };
}
