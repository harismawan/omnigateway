import type { ProviderId } from "@omni/ir";
import type { SQL } from "bun";
import { decrypt, encrypt } from "../encryption.ts";
import type {
  AuthType,
  BreakerState,
  Credential,
  CredentialHealth,
  CredentialRepo,
  CredentialSecrets,
  CredentialView,
  DisabledReason,
  InferenceSecrets,
  QuotaSample,
  QuotaSampleQuery,
  QuotaWindow,
  RefreshSecrets,
  RoutingChange,
  UsageSecrets,
  WindowType,
} from "../types.ts";
import { sameWindow } from "../types.ts";
import { type Conn, num, numOrNull, type Rows } from "./db.ts";

type Row = {
  id: string;
  provider: string;
  label: string;
  auth_type: string;
  enabled: boolean;
  tier: number;
  weight: number;
  expires_at: string | null;
  account_email: string | null;
  provider_data: string;
  disabled_reason: string | null;
  disabled_at: string | null;
  access_token: string | null;
  refresh_token: string | null;
  api_key: string | null;
  id_token: string | null;
  created_at: string;
  updated_at: string;
  token_version: number;
};

type HealthRow = {
  credential_id: string;
  model: string;
  breaker_state: string;
  consecutive_failures: number;
  opened_at: string | null;
  rate_limited_until: string | null;
  ewma_ttft_ms: number | null;
  last_used_at: string | null;
};

function toHealth(r: HealthRow): CredentialHealth {
  return {
    credentialId: r.credential_id,
    model: r.model,
    breakerState: r.breaker_state as BreakerState,
    consecutiveFailures: r.consecutive_failures,
    openedAt: numOrNull(r.opened_at),
    rateLimitedUntil: numOrNull(r.rate_limited_until),
    ewmaTtftMs: r.ewma_ttft_ms,
    lastUsedAt: numOrNull(r.last_used_at),
  };
}

const UPSERT_HEALTH = `INSERT INTO credential_health
   (credential_id, model, breaker_state, consecutive_failures, opened_at,
    rate_limited_until, ewma_ttft_ms, last_used_at)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
 ON CONFLICT (credential_id, model) DO UPDATE SET
   breaker_state = EXCLUDED.breaker_state,
   consecutive_failures = EXCLUDED.consecutive_failures,
   opened_at = EXCLUDED.opened_at,
   rate_limited_until = EXCLUDED.rate_limited_until,
   ewma_ttft_ms = EXCLUDED.ewma_ttft_ms,
   last_used_at = EXCLUDED.last_used_at`;

const healthValues = (r: CredentialHealth) => [
  r.credentialId,
  r.model,
  r.breakerState,
  r.consecutiveFailures,
  r.openedAt,
  r.rateLimitedUntil,
  r.ewmaTtftMs,
  r.lastUsedAt,
];

type SecretRow = Pick<Row, "access_token" | "refresh_token" | "api_key" | "id_token">;

export function createCredentialRepo(
  sql: SQL,
  key: CryptoKey,
  emit: (change: RoutingChange) => void,
): CredentialRepo {
  const open = async (v: string | null): Promise<string | null> =>
    v === null ? null : decrypt(key, v);
  const secretsFrom = async (row: SecretRow): Promise<CredentialSecrets> => ({
    accessToken: await open(row.access_token),
    refreshToken: await open(row.refresh_token),
    apiKey: await open(row.api_key),
    idToken: await open(row.id_token),
  });
  const requiredRow = async <T>(conn: Conn, columns: string, id: string): Promise<T> => {
    const rows = await conn.unsafe<Rows<T>>(`SELECT ${columns} FROM credentials WHERE id = $1`, [
      id,
    ]);
    const row = rows[0];
    if (row === undefined) throw new Error(`credential ${id} no longer exists`);
    return row;
  };
  const currentSecrets = async (id: string): Promise<CredentialSecrets> =>
    secretsFrom(
      await requiredRow<SecretRow>(sql, "access_token, refresh_token, api_key, id_token", id),
    );
  const currentInferenceSecrets = async (
    id: string,
    authType: AuthType,
  ): Promise<InferenceSecrets> => {
    if (authType === "oauth") {
      const row = await requiredRow<Pick<Row, "access_token">>(sql, "access_token", id);
      return { accessToken: await open(row.access_token), apiKey: null };
    }
    const row = await requiredRow<Pick<Row, "api_key">>(sql, "api_key", id);
    return { accessToken: null, apiKey: await open(row.api_key) };
  };
  const currentRefreshSecrets = async (id: string): Promise<RefreshSecrets> => {
    const row = await requiredRow<Pick<Row, "refresh_token">>(sql, "refresh_token", id);
    return { refreshToken: await open(row.refresh_token) };
  };
  const currentUsageSecrets = async (id: string): Promise<UsageSecrets> => {
    const row = await requiredRow<Pick<Row, "access_token">>(sql, "access_token", id);
    return { accessToken: await open(row.access_token) };
  };

  /** Decrypts lazily, so ranking N candidates costs zero decryptions. */
  const view = (row: Row, loadCurrentSecrets = false): CredentialView => ({
    id: row.id,
    provider: row.provider as ProviderId,
    label: row.label,
    authType: row.auth_type as AuthType,
    enabled: row.enabled,
    tier: row.tier,
    weight: row.weight,
    expiresAt: numOrNull(row.expires_at),
    accountEmail: row.account_email,
    providerData: JSON.parse(row.provider_data) as Record<string, unknown>,
    disabledReason: row.disabled_reason as DisabledReason | null,
    disabledAt: numOrNull(row.disabled_at),
    hasRefreshToken: row.refresh_token !== null,
    tokenVersion: row.token_version,
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
    secrets: () => (loadCurrentSecrets ? currentSecrets(row.id) : secretsFrom(row)),
    openForInference: async () => {
      if (loadCurrentSecrets) return currentInferenceSecrets(row.id, row.auth_type as AuthType);
      if (row.auth_type === "oauth") {
        return { accessToken: await open(row.access_token), apiKey: null };
      }
      return { accessToken: null, apiKey: await open(row.api_key) };
    },
    openForRefresh: async () =>
      loadCurrentSecrets
        ? currentRefreshSecrets(row.id)
        : { refreshToken: await open(row.refresh_token) },
    openForUsage: async () =>
      loadCurrentSecrets
        ? currentUsageSecrets(row.id)
        : { accessToken: await open(row.access_token) },
  });

  const seal = async (v: string | null | undefined): Promise<string | null> =>
    v === null || v === undefined ? null : encrypt(key, v);

  return {
    async list() {
      const rows = await sql.unsafe<Rows<Row>>("SELECT * FROM credentials ORDER BY tier, label");
      return rows.map((row) => view(row));
    },

    async listRouting() {
      const rows = await sql.unsafe<Rows<Row>>(
        `SELECT id, provider, label, auth_type, enabled, tier, weight, expires_at,
                account_email, provider_data, disabled_reason, disabled_at,
                NULL AS access_token,
                CASE WHEN refresh_token IS NULL THEN NULL ELSE 'present' END AS refresh_token,
                NULL AS api_key, NULL AS id_token, created_at, updated_at, token_version
           FROM credentials
          ORDER BY tier, label`,
      );
      return rows.map((row) => view(row, true));
    },

    async get(id) {
      const rows = await sql.unsafe<Rows<Row>>("SELECT * FROM credentials WHERE id = $1", [id]);
      const row = rows[0];
      return row === undefined ? null : view(row);
    },

    async create(input) {
      const now = Date.now();
      await sql.unsafe(
        `INSERT INTO credentials
           (id, provider, label, auth_type, enabled, tier, weight, expires_at, account_email,
            provider_data, disabled_reason, disabled_at, access_token, refresh_token, api_key,
            id_token, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          input.id,
          input.provider,
          input.label,
          input.authType,
          input.enabled,
          input.tier,
          input.weight,
          input.expiresAt,
          input.accountEmail,
          JSON.stringify(input.providerData),
          input.disabledReason,
          input.disabledAt,
          await seal(input.accessToken),
          await seal(input.refreshToken),
          await seal(input.apiKey),
          await seal(input.idToken),
          now,
          now,
        ],
      );
      const { accessToken, refreshToken, apiKey, idToken, ...meta } = input;
      emit({ type: "credentialsChanged" });
      return {
        ...meta,
        hasRefreshToken: refreshToken != null,
        tokenVersion: 0,
        createdAt: now,
        updatedAt: now,
      } satisfies Credential;
    },

    async update(id, patch) {
      const sets: string[] = [];
      const vals: (string | number | boolean | null)[] = [];
      const put = (col: string, v: string | number | boolean | null) => {
        vals.push(v);
        sets.push(`${col} = $${vals.length}`);
      };
      if (patch.label !== undefined) put("label", patch.label);
      if (patch.enabled !== undefined) put("enabled", patch.enabled);
      if (patch.tier !== undefined) put("tier", patch.tier);
      if (patch.weight !== undefined) put("weight", patch.weight);
      if (patch.expiresAt !== undefined) put("expires_at", patch.expiresAt);
      if (patch.accountEmail !== undefined) put("account_email", patch.accountEmail);
      if (patch.providerData !== undefined)
        put("provider_data", JSON.stringify(patch.providerData));
      if (patch.disabledReason !== undefined) put("disabled_reason", patch.disabledReason);
      if (patch.disabledAt !== undefined) put("disabled_at", patch.disabledAt);
      if (sets.length === 0) return;
      put("updated_at", Date.now());
      await sql.unsafe(`UPDATE credentials SET ${sets.join(", ")} WHERE id = $${vals.length + 1}`, [
        ...vals,
        id,
      ]);
      emit({ type: "credentialsChanged" });
    },

    async updateSecrets(id, secrets, expiresAt, expectedVersion) {
      const sets: string[] = [];
      const vals: (string | number | null)[] = [];
      const put = (col: string, v: string | number | null) => {
        vals.push(v);
        sets.push(`${col} = $${vals.length}`);
      };
      if (secrets.accessToken !== undefined) put("access_token", await seal(secrets.accessToken));
      if (secrets.refreshToken !== undefined)
        put("refresh_token", await seal(secrets.refreshToken));
      if (secrets.apiKey !== undefined) put("api_key", await seal(secrets.apiKey));
      if (secrets.idToken !== undefined) put("id_token", await seal(secrets.idToken));
      put("expires_at", expiresAt);
      put("updated_at", Date.now());
      sets.push("token_version = token_version + 1");
      vals.push(id);
      let where = `WHERE id = $${vals.length}`;
      if (expectedVersion !== undefined) {
        vals.push(expectedVersion);
        where += ` AND token_version = $${vals.length}`;
      }
      const result = await sql.unsafe(`UPDATE credentials SET ${sets.join(", ")} ${where}`, vals);
      if (result.count > 0) emit({ type: "credentialsChanged" });
      return result.count > 0;
    },

    async remove(id) {
      await sql.unsafe("DELETE FROM credentials WHERE id = $1", [id]);
      emit({ type: "credentialsChanged" });
    },

    async listHealth() {
      const rows = await sql.unsafe<Rows<HealthRow>>("SELECT * FROM credential_health");
      return rows.map(toHealth);
    },

    async saveHealth(rows: CredentialHealth[]) {
      await sql.begin(async (tx) => {
        for (const r of rows) await tx.unsafe(UPSERT_HEALTH, healthValues(r));
      });
      emit({ type: "healthSaved", rows });
    },

    async updateHealth(credentialId, model, apply) {
      // Read and write in one transaction, with the row locked for the
      // duration: a caller computing from a row it read earlier would
      // otherwise overwrite whatever arrived in the meantime, and here another
      // replica can land between the two.
      const written = await sql.begin(async (tx): Promise<CredentialHealth> => {
        // `FOR UPDATE` locks nothing where no row exists, so the first-ever
        // write for a pair on two replicas would be last-writer-wins. One
        // advisory lock on the pair covers the absent-row case.
        await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [`${credentialId}|${model}`]);
        const rows = await tx.unsafe<Rows<HealthRow>>(
          "SELECT * FROM credential_health WHERE credential_id = $1 AND model = $2 FOR UPDATE",
          [credentialId, model],
        );
        const row = rows[0];
        const next = apply(row === undefined ? null : toHealth(row));
        await tx.unsafe(UPSERT_HEALTH, healthValues(next));
        return next;
      });

      // The row that reached disk, not the one proposed: the snapshot cache
      // patches its map from this without re-reading.
      emit({ type: "healthSaved", rows: [written] });
      return written;
    },

    async listQuota() {
      type Q = {
        credential_id: string;
        window_type: string;
        starts_at: string;
        used: string;
        limit_value: string | null;
        resets_at: string | null;
        observed_at: string;
        window_ms: string | null;
      };
      const rows = await sql.unsafe<Rows<Q>>("SELECT * FROM quota_windows");
      return rows.map((r) => ({
        credentialId: r.credential_id,
        windowType: r.window_type as WindowType,
        startsAt: num(r.starts_at),
        used: num(r.used),
        limit: numOrNull(r.limit_value),
        resetsAt: numOrNull(r.resets_at),
        observedAt: num(r.observed_at),
        windowMs: numOrNull(r.window_ms),
      }));
    },

    /**
     * Replaces the reported window set for every credential named in `rows`.
     *
     * A probe reports a credential's whole set at once, so a window absent from
     * it is one the provider no longer has — a plan that drops its five-hour
     * cap, for instance. Upserting alone would leave that row behind forever,
     * drawing a bar for a limit that does not exist and letting the router
     * price against it. Credentials not named here are untouched, because this
     * call carries no evidence about them.
     *
     * The same transaction appends to `quota_samples` whatever moved. This is
     * the sole write path for quota data, so history cannot drift from the
     * snapshot it describes.
     */
    async saveQuota(rows: QuotaWindow[]) {
      type Newest = {
        used: string;
        limit_value: string | null;
        resets_at: string | null;
        window_ms: string | null;
      };
      const kept = new Map<string, string[]>();
      for (const r of rows) {
        const types = kept.get(r.credentialId);
        if (types === undefined) kept.set(r.credentialId, [r.windowType]);
        else types.push(r.windowType);
      }

      await sql.begin(async (tx) => {
        for (const r of rows) {
          await tx.unsafe(
            `INSERT INTO quota_windows
               (credential_id, window_type, starts_at, used, limit_value, resets_at, observed_at,
                window_ms)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (credential_id, window_type) DO UPDATE SET
               starts_at = EXCLUDED.starts_at,
               used = EXCLUDED.used,
               limit_value = EXCLUDED.limit_value,
               resets_at = EXCLUDED.resets_at,
               observed_at = EXCLUDED.observed_at,
               window_ms = EXCLUDED.window_ms`,
            [
              r.credentialId,
              r.windowType,
              r.startsAt,
              r.used,
              r.limit,
              r.resetsAt,
              r.observedAt,
              r.windowMs,
            ],
          );

          // An idle account is re-read every poll interval and moves nothing,
          // so only a changed reading is worth a row.
          //
          // `resets_at` is in the comparison because a rollover that lands on
          // the same `used` would otherwise be dropped, and the chart would
          // draw one continuous window where there were two. It is compared
          // through `sameWindow` rather than exactly: a provider stating a
          // whole-second countdown has its absolute reset rederived per probe
          // and jitters by milliseconds while standing still, and an exact
          // comparison never matches for it. `starts_at` is not in the
          // comparison at all: it is our own observation time, so it moves
          // every poll and would defeat the dedup entirely.
          //
          // `limit_value` is here because a plan change can lift the ceiling
          // while `used` sits still, and every percentage drawn afterwards
          // would stay on the old denominator until traffic moved `used`.
          const previous = (
            await tx.unsafe<Rows<Newest>>(
              `SELECT used, limit_value, resets_at, window_ms
                 FROM quota_samples
                WHERE credential_id = $1 AND window_type = $2
                ORDER BY observed_at DESC
                LIMIT 1`,
              [r.credentialId, r.windowType],
            )
          )[0];
          const unchanged =
            previous !== undefined &&
            num(previous.used) === r.used &&
            numOrNull(previous.limit_value) === r.limit &&
            sameWindow(numOrNull(previous.resets_at), r.resetsAt) &&
            numOrNull(previous.window_ms) === r.windowMs;
          if (unchanged) continue;

          // Two readings of the same window at the same instant are the same
          // reading; the newer one wins rather than aborting the whole save.
          await tx.unsafe(
            `INSERT INTO quota_samples
               (credential_id, window_type, observed_at, used, limit_value, resets_at, window_ms)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (credential_id, window_type, observed_at) DO UPDATE SET
               used = EXCLUDED.used,
               limit_value = EXCLUDED.limit_value,
               resets_at = EXCLUDED.resets_at,
               window_ms = EXCLUDED.window_ms`,
            [r.credentialId, r.windowType, r.observedAt, r.used, r.limit, r.resetsAt, r.windowMs],
          );
        }
        for (const [credentialId, types] of kept) {
          await tx.unsafe(
            `DELETE FROM quota_windows
              WHERE credential_id = $1
                AND window_type NOT IN (SELECT jsonb_array_elements_text($2::jsonb))`,
            [credentialId, types],
          );
        }
      });
      emit({ type: "quotaSaved", rows });
    },

    async listQuotaSamples(q: QuotaSampleQuery) {
      type S = {
        credential_id: string;
        window_type: string;
        observed_at: string;
        used: string;
        limit_value: string | null;
        resets_at: string | null;
        window_ms: string | null;
      };
      // Both bounds inclusive, matching how `UsageQuery` reads a span.
      //
      // A limited read orders by `observed_at DESC` so the rows it keeps are the
      // newest, then sorts back into the caller's order below. Applying `LIMIT`
      // to the default ordering would cut the alphabetical tail instead, which
      // is whole accounts missing rather than every account's history being
      // shorter.
      const newestFirst = q.limit !== undefined;
      const args: Array<number | string> = [q.since, q.until];
      let extra = "";
      if (q.credentialId !== undefined) {
        args.push(q.credentialId);
        extra = ` AND credential_id = $${args.length}`;
      }
      let limit = "";
      if (q.limit !== undefined) {
        args.push(q.limit);
        limit = `LIMIT $${args.length}`;
      }
      const rows = await sql.unsafe<Rows<S>>(
        `SELECT * FROM quota_samples
          WHERE observed_at >= $1 AND observed_at <= $2${extra}
          ORDER BY ${newestFirst ? "observed_at DESC" : 'credential_id COLLATE "C", window_type COLLATE "C", observed_at'}
          ${limit}`,
        args,
      );
      const samples = rows.map(
        (r): QuotaSample => ({
          credentialId: r.credential_id,
          windowType: r.window_type as WindowType,
          observedAt: num(r.observed_at),
          used: num(r.used),
          limit: numOrNull(r.limit_value),
          resetsAt: numOrNull(r.resets_at),
          windowMs: numOrNull(r.window_ms),
        }),
      );
      if (newestFirst) {
        // Compared with `<`/`>` rather than `localeCompare`, and the unlimited
        // read orders under `COLLATE "C"` for the same reason: code-point
        // order is what both paths reproduce, so the limited and unlimited
        // reads agree for the same rows whatever locale the database was
        // created under.
        const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
        samples.sort(
          (a, b) =>
            order(a.credentialId, b.credentialId) ||
            order(a.windowType, b.windowType) ||
            a.observedAt - b.observedAt,
        );
      }
      return samples;
    },

    async pruneQuotaSamples(olderThan: number) {
      const result = await sql.unsafe("DELETE FROM quota_samples WHERE observed_at < $1", [
        olderThan,
      ]);
      return result.count;
    },
  };
}
