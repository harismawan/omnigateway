import type { Database } from "bun:sqlite";
import type { ProviderId } from "@omni/ir";
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
  QuotaWindow,
  RefreshSecrets,
  UsageSecrets,
  WindowType,
} from "../types.ts";

type Row = {
  id: string;
  provider: string;
  label: string;
  auth_type: string;
  enabled: number;
  tier: number;
  weight: number;
  expires_at: number | null;
  account_email: string | null;
  provider_data: string;
  disabled_reason: string | null;
  disabled_at: number | null;
  access_token: string | null;
  refresh_token: string | null;
  api_key: string | null;
  id_token: string | null;
  created_at: number;
  updated_at: number;
};

export function createCredentialRepo(
  db: Database,
  key: CryptoKey,
  emit: (change: import("../types.ts").RoutingChange) => void = () => {},
): CredentialRepo {
  const open = async (v: string | null): Promise<string | null> =>
    v === null ? null : decrypt(key, v);
  const secretsFrom = async (
    row: Pick<Row, "access_token" | "refresh_token" | "api_key" | "id_token">,
  ): Promise<CredentialSecrets> => ({
    accessToken: await open(row.access_token),
    refreshToken: await open(row.refresh_token),
    apiKey: await open(row.api_key),
    idToken: await open(row.id_token),
  });
  const requiredRow = <T>(row: T | null, id: string): T => {
    if (row === null) throw new Error(`credential ${id} no longer exists`);
    return row;
  };
  const currentSecrets = async (id: string): Promise<CredentialSecrets> => {
    const row = requiredRow(
      db
        .query<Pick<Row, "access_token" | "refresh_token" | "api_key" | "id_token">, [string]>(
          "SELECT access_token, refresh_token, api_key, id_token FROM credentials WHERE id = ?",
        )
        .get(id),
      id,
    );
    return secretsFrom(row);
  };
  const currentInferenceSecrets = async (
    id: string,
    authType: AuthType,
  ): Promise<InferenceSecrets> => {
    if (authType === "oauth") {
      const row = requiredRow(
        db
          .query<Pick<Row, "access_token">, [string]>(
            "SELECT access_token FROM credentials WHERE id = ?",
          )
          .get(id),
        id,
      );
      return { accessToken: await open(row.access_token), apiKey: null };
    }
    const row = requiredRow(
      db
        .query<Pick<Row, "api_key">, [string]>("SELECT api_key FROM credentials WHERE id = ?")
        .get(id),
      id,
    );
    return { accessToken: null, apiKey: await open(row.api_key) };
  };
  const currentRefreshSecrets = async (id: string): Promise<RefreshSecrets> => {
    const row = requiredRow(
      db
        .query<Pick<Row, "refresh_token">, [string]>(
          "SELECT refresh_token FROM credentials WHERE id = ?",
        )
        .get(id),
      id,
    );
    return { refreshToken: await open(row.refresh_token) };
  };
  const currentUsageSecrets = async (id: string): Promise<UsageSecrets> => {
    const row = requiredRow(
      db
        .query<Pick<Row, "access_token">, [string]>(
          "SELECT access_token FROM credentials WHERE id = ?",
        )
        .get(id),
      id,
    );
    return { accessToken: await open(row.access_token) };
  };

  /** Decrypts lazily, so ranking N candidates costs zero decryptions. */
  const view = (row: Row, loadCurrentSecrets = false): CredentialView => ({
    id: row.id,
    provider: row.provider as ProviderId,
    label: row.label,
    authType: row.auth_type as AuthType,
    enabled: row.enabled === 1,
    tier: row.tier,
    weight: row.weight,
    expiresAt: row.expires_at,
    accountEmail: row.account_email,
    providerData: JSON.parse(row.provider_data) as Record<string, unknown>,
    disabledReason: row.disabled_reason as DisabledReason | null,
    disabledAt: row.disabled_at,
    hasRefreshToken: row.refresh_token !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
      return db
        .query<Row, []>("SELECT * FROM credentials ORDER BY tier, label")
        .all()
        .map((row) => view(row));
    },

    async listRouting() {
      return db
        .query<Row, []>(
          `SELECT id, provider, label, auth_type, enabled, tier, weight, expires_at,
                  account_email, provider_data, disabled_reason, disabled_at,
                  NULL AS access_token,
                  CASE WHEN refresh_token IS NULL THEN NULL ELSE 'present' END AS refresh_token,
                  NULL AS api_key, NULL AS id_token, created_at, updated_at
             FROM credentials
            ORDER BY tier, label`,
        )
        .all()
        .map((row) => view(row, true));
    },

    async get(id) {
      const row = db.query<Row, [string]>("SELECT * FROM credentials WHERE id = ?").get(id);
      return row ? view(row) : null;
    },

    async create(input) {
      const now = Date.now();
      db.run(
        `INSERT INTO credentials
           (id, provider, label, auth_type, enabled, tier, weight, expires_at, account_email,
            provider_data, disabled_reason, disabled_at, access_token, refresh_token, api_key,
            id_token, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          input.id,
          input.provider,
          input.label,
          input.authType,
          input.enabled ? 1 : 0,
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
        createdAt: now,
        updatedAt: now,
      } satisfies Credential;
    },

    async update(id, patch) {
      const sets: string[] = [];
      const vals: (string | number | null)[] = [];
      const put = (col: string, v: string | number | null) => {
        sets.push(`${col} = ?`);
        vals.push(v);
      };
      if (patch.label !== undefined) put("label", patch.label);
      if (patch.enabled !== undefined) put("enabled", patch.enabled ? 1 : 0);
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
      db.run(`UPDATE credentials SET ${sets.join(", ")} WHERE id = ?`, [...vals, id]);
      emit({ type: "credentialsChanged" });
    },

    async updateSecrets(id, secrets, expiresAt) {
      const sets: string[] = [];
      const vals: (string | number | null)[] = [];
      if (secrets.accessToken !== undefined) {
        sets.push("access_token = ?");
        vals.push(await seal(secrets.accessToken));
      }
      if (secrets.refreshToken !== undefined) {
        sets.push("refresh_token = ?");
        vals.push(await seal(secrets.refreshToken));
      }
      if (secrets.apiKey !== undefined) {
        sets.push("api_key = ?");
        vals.push(await seal(secrets.apiKey));
      }
      if (secrets.idToken !== undefined) {
        sets.push("id_token = ?");
        vals.push(await seal(secrets.idToken));
      }
      sets.push("expires_at = ?", "updated_at = ?");
      vals.push(expiresAt, Date.now());
      db.run(`UPDATE credentials SET ${sets.join(", ")} WHERE id = ?`, [...vals, id]);
      emit({ type: "credentialsChanged" });
    },

    async remove(id) {
      db.run("DELETE FROM credentials WHERE id = ?", [id]);
      emit({ type: "credentialsChanged" });
    },

    async listHealth() {
      type H = {
        credential_id: string;
        model: string;
        breaker_state: string;
        consecutive_failures: number;
        opened_at: number | null;
        rate_limited_until: number | null;
        ewma_ttft_ms: number | null;
        last_used_at: number | null;
      };
      return db
        .query<H, []>("SELECT * FROM credential_health")
        .all()
        .map((r) => ({
          credentialId: r.credential_id,
          model: r.model,
          breakerState: r.breaker_state as BreakerState,
          consecutiveFailures: r.consecutive_failures,
          openedAt: r.opened_at,
          rateLimitedUntil: r.rate_limited_until,
          ewmaTtftMs: r.ewma_ttft_ms,
          lastUsedAt: r.last_used_at,
        }));
    },

    async saveHealth(rows: CredentialHealth[]) {
      const stmt = db.prepare(
        `INSERT INTO credential_health
           (credential_id, model, breaker_state, consecutive_failures, opened_at,
            rate_limited_until, ewma_ttft_ms, last_used_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT (credential_id, model) DO UPDATE SET
           breaker_state = excluded.breaker_state,
           consecutive_failures = excluded.consecutive_failures,
           opened_at = excluded.opened_at,
           rate_limited_until = excluded.rate_limited_until,
           ewma_ttft_ms = excluded.ewma_ttft_ms,
           last_used_at = excluded.last_used_at`,
      );
      db.transaction(() => {
        for (const r of rows) {
          stmt.run(
            r.credentialId,
            r.model,
            r.breakerState,
            r.consecutiveFailures,
            r.openedAt,
            r.rateLimitedUntil,
            r.ewmaTtftMs,
            r.lastUsedAt,
          );
        }
      })();
      emit({ type: "healthSaved", rows });
    },

    async listQuota() {
      type Q = {
        credential_id: string;
        window_type: string;
        starts_at: number;
        used: number;
        limit_value: number | null;
        resets_at: number | null;
        observed_at: number;
      };
      return db
        .query<Q, []>("SELECT * FROM quota_windows")
        .all()
        .map((r) => ({
          credentialId: r.credential_id,
          windowType: r.window_type as WindowType,
          startsAt: r.starts_at,
          used: r.used,
          limit: r.limit_value,
          resetsAt: r.resets_at,
          observedAt: r.observed_at,
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
     */
    async saveQuota(rows: QuotaWindow[]) {
      const stmt = db.prepare(
        `INSERT INTO quota_windows
           (credential_id, window_type, starts_at, used, limit_value, resets_at, observed_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT (credential_id, window_type) DO UPDATE SET
           starts_at = excluded.starts_at,
           used = excluded.used,
           limit_value = excluded.limit_value,
           resets_at = excluded.resets_at,
           observed_at = excluded.observed_at`,
      );
      const prune = db.prepare(
        "DELETE FROM quota_windows WHERE credential_id = ? AND window_type NOT IN (SELECT value FROM json_each(?))",
      );

      const kept = new Map<string, string[]>();
      for (const r of rows) {
        const types = kept.get(r.credentialId);
        if (types === undefined) kept.set(r.credentialId, [r.windowType]);
        else types.push(r.windowType);
      }

      db.transaction(() => {
        for (const r of rows) {
          stmt.run(
            r.credentialId,
            r.windowType,
            r.startsAt,
            r.used,
            r.limit,
            r.resetsAt,
            r.observedAt,
          );
        }
        for (const [credentialId, types] of kept) {
          prune.run(credentialId, JSON.stringify(types));
        }
      })();
      emit({ type: "quotaSaved", rows });
    },
  };
}
