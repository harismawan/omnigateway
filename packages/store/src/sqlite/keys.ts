import type { Database } from "bun:sqlite";
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
  rate_limit_per_min: number | null;
  body_logging_opt_out: number;
  created_at: number;
  revoked_at: number | null;
};

const toKey = (r: Row): ApiKey => ({
  id: r.id,
  label: r.label,
  prefix: r.prefix,
  hash: r.hash,
  modelAllowlist: r.model_allowlist === null ? null : (JSON.parse(r.model_allowlist) as string[]),
  rateLimitPerMin: r.rate_limit_per_min,
  // Only a stored 1 opts out; anything else leaves the key on the
  // installation-wide setting, which is itself off by default.
  bodyLoggingOptOut: r.body_logging_opt_out === 1,
  createdAt: r.created_at,
  revokedAt: r.revoked_at,
});

export function createKeyRepo(db: Database): KeyRepo {
  return {
    async list() {
      return db.query<Row, []>("SELECT * FROM api_keys ORDER BY created_at DESC").all().map(toKey);
    },

    async findByHash(hash: string) {
      const row = db.query<Row, [string]>("SELECT * FROM api_keys WHERE hash = ?").get(hash);
      return row ? toKey(row) : null;
    },

    async create(input) {
      const now = Date.now();
      db.run(
        `INSERT INTO api_keys (id, label, prefix, hash, model_allowlist, rate_limit_per_min,
                               body_logging_opt_out, created_at, revoked_at)
         VALUES (?,?,?,?,?,?,?,?,NULL)`,
        [
          input.id,
          input.label,
          input.prefix,
          input.hash,
          input.modelAllowlist === null ? null : JSON.stringify(input.modelAllowlist),
          input.rateLimitPerMin,
          input.bodyLoggingOptOut ? 1 : 0,
          now,
        ],
      );
      return { ...input, createdAt: now, revokedAt: null };
    },

    async revoke(id: string) {
      db.run("UPDATE api_keys SET revoked_at = ? WHERE id = ?", [Date.now(), id]);
    },
  };
}
