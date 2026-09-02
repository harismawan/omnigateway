import type { Logger } from "@omni/ir";
import { type LimitConfig, parseLimitConfig } from "@omni/ratelimit/catalog";
import type { SQL } from "bun";
import type { ApiKey, KeyRepo } from "../types.ts";
import { num, numOrNull, type Rows } from "./db.ts";

type Row = {
  id: string;
  label: string;
  prefix: string;
  hash: string;
  model_allowlist: string | null;
  limits: string;
  body_logging_opt_out: boolean;
  created_at: string;
  revoked_at: string | null;
};

/**
 * An unreadable `limits` value marks the key rather than being discarded — and
 * rather than throwing.
 *
 * A limit dropped silently reads as "no limit" and fails open on a ceiling the
 * operator explicitly set, so `null` is returned as its own state and refused
 * later at the auth chokepoint. Throwing here would be the wrong blast radius:
 * `toKey` serves `list` as well as `findByHash`, so one meddled row would take
 * away the very listing an operator would use to find it. Refuse at auth,
 * degrade at list.
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
  bodyLoggingOptOut: r.body_logging_opt_out,
  createdAt: num(r.created_at),
  revokedAt: numOrNull(r.revoked_at),
});

export function createKeyRepo(sql: SQL, logger: Logger): KeyRepo {
  const one = async (where: string, arg: string): Promise<ApiKey | null> => {
    const rows = await sql.unsafe<Rows<Row>>(`SELECT * FROM api_keys WHERE ${where} = $1`, [arg]);
    const row = rows[0];
    return row === undefined ? null : toKey(row, logger);
  };
  return {
    async list() {
      const rows = await sql.unsafe<Rows<Row>>("SELECT * FROM api_keys ORDER BY created_at DESC");
      return rows.map((row) => toKey(row, logger));
    },

    findByHash: (hash) => one("hash", hash),

    // `toKey` here as everywhere else, so a row with unparseable limits reads
    // back as `limits: null` rather than throwing. A revocation check that
    // threw on a broken row would lock a session out for the wrong reason.
    get: (id) => one("id", id),

    async create(input) {
      const now = Date.now();
      await sql.unsafe(
        `INSERT INTO api_keys (id, label, prefix, hash, model_allowlist, limits,
                               body_logging_opt_out, created_at, revoked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL)`,
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
          input.bodyLoggingOptOut,
          now,
        ],
      );
      return { ...input, createdAt: now, revokedAt: null };
    },

    async importRow(row) {
      if (row.limits === null) throw new Error(`api key ${row.id} has unreadable limits`);
      await sql.unsafe(
        `INSERT INTO api_keys (id, label, prefix, hash, model_allowlist, limits,
                               body_logging_opt_out, created_at, revoked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          row.id,
          row.label,
          row.prefix,
          row.hash,
          row.modelAllowlist === null ? null : JSON.stringify(row.modelAllowlist),
          JSON.stringify(parseLimitConfig(row.limits)),
          row.bodyLoggingOptOut,
          row.createdAt,
          row.revokedAt,
        ],
      );
    },

    async setLimits(id: string, limits: LimitConfig) {
      // Same guard as `create`, and for the same reason: an edit that reached
      // past the control schema must not be able to write a matrix the next
      // reader refuses, which is a key locked out of `/v1` by its own repair.
      await sql.unsafe("UPDATE api_keys SET limits = $1 WHERE id = $2", [
        JSON.stringify(parseLimitConfig(limits)),
        id,
      ]);
    },

    async setModelAllowlist(id: string, modelAllowlist: string[] | null) {
      // Same encoding as `create`. No parse guard here, unlike `limits`: any
      // JSON array of names reads back fine, and an entry no configured model
      // matches simply denies those requests — per-request fail closed, not
      // the whole-key lockout the limits guard exists to prevent.
      await sql.unsafe("UPDATE api_keys SET model_allowlist = $1 WHERE id = $2", [
        modelAllowlist === null ? null : JSON.stringify(modelAllowlist),
        id,
      ]);
    },

    async revoke(id: string) {
      await sql.unsafe("UPDATE api_keys SET revoked_at = $1 WHERE id = $2", [Date.now(), id]);
    },
  };
}
