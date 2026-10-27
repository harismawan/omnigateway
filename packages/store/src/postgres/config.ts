import type { SQL } from "bun";
import { checkPromptReferences } from "../promptAssignments.ts";
import type {
  ConfigRepo,
  RoutingChange,
  ScoringWeights,
  Settings,
  Strategy,
  Target,
  VirtualModel,
} from "../types.ts";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  readGuardrailSettings,
  readPromptSettings,
  readRetentionLoweredAt,
  readSmartRouterSettings,
} from "../types.ts";
import type { Conn, Rows } from "./db.ts";
import { lockPromptManagement } from "./promptLock.ts";

const SETTINGS_KEY = "settings";
const ADMIN_HASH_KEY = "adminPasswordHash";
/**
 * The read-only administrator's password, kept in its own row.
 *
 * Its own row and not a field inside `settings`, because `putSettings` merges a
 * patch over the stored object and is reachable from the settings API — a
 * password hash living in there would be readable by anything that reads
 * settings and clearable by anything that writes them.
 */
const VIEWER_HASH_KEY = "viewerPasswordHash";

/**
 * Takes only the weights the router still scores, defaulting the rest.
 *
 * Spreading the stored object instead would carry a retired term forward
 * forever — `recency` was dropped when the load term replaced it — and the
 * settings schema is strict, so a stale key would fail validation on the next
 * edit rather than being quietly ignored.
 */
function knownWeights(stored: Partial<ScoringWeights> | undefined): ScoringWeights {
  const d = DEFAULT_SETTINGS.weights;
  const pick = (key: keyof ScoringWeights): number => {
    const value = stored?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : d[key];
  };
  return {
    tier: pick("tier"),
    health: pick("health"),
    quota: pick("quota"),
    load: pick("load"),
    cost: pick("cost"),
    latency: pick("latency"),
  };
}

/**
 * A stored settings row as `getSettings` returns it, whatever it holds. A pure
 * function of the raw text so `putSettings` can parse the row it locked.
 */
function parseSettings(raw: string | null): Settings {
  if (raw === null) return DEFAULT_SETTINGS;
  try {
    const parsed: unknown = JSON.parse(raw);
    const stored =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Partial<Settings>)
        : {};
    // Only literal true enables this lossy transform, or either half of body
    // capture. This runtime boundary must remain safe even if an old or
    // manually-edited row is malformed: a truthy-but-not-true value must not
    // start retaining prompts any more than it may start rewriting them.
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      ...readPromptSettings(stored),
      rtkEnabled: stored.rtkEnabled === true,
      // Absence means on, decided by `DEFAULT_SETTINGS`; a malformed value
      // means off, the same answer as its neighbours.
      autoCacheEnabled:
        stored.autoCacheEnabled === undefined ? true : stored.autoCacheEnabled === true,
      bodyRetentionDays:
        Number.isInteger(stored.bodyRetentionDays) &&
        (stored.bodyRetentionDays ?? 0) >= 1 &&
        (stored.bodyRetentionDays ?? 0) <= 3_650
          ? (stored.bodyRetentionDays as number)
          : DEFAULT_SETTINGS.bodyRetentionDays,
      logRetentionLoweredAt: readRetentionLoweredAt(stored.logRetentionLoweredAt),
      bodyLoggingEnabled: stored.bodyLoggingEnabled === true,
      bodyLoggingCaptureStreamChunks: stored.bodyLoggingCaptureStreamChunks === true,
      weights: knownWeights(stored.weights),
      // Malformed reads as unconfigured, which refuses a key carrying a
      // policy rather than serving it unjudged. One copy for both backends.
      ...readGuardrailSettings(stored),
      // Malformed reads as off and unset, so a bad row never routes a
      // request anywhere. One copy for both backends.
      ...readSmartRouterSettings(stored),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function createConfigRepo(sql: SQL, emit: (change: RoutingChange) => void): ConfigRepo {
  const readRaw = async (key: string): Promise<string | null> =>
    (
      await sql.unsafe<Rows<{ value: string }>>("SELECT value FROM settings WHERE key = $1", [key])
    )[0]?.value ?? null;

  const writeRaw = async (key: string, value: string, conn: Conn = sql): Promise<void> => {
    await conn.unsafe(
      "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [key, value],
    );
  };

  return {
    async listModels() {
      type R = { id: string; targets: string; strategy: string; is_alias: boolean };
      const rows = await sql.unsafe<Rows<R>>("SELECT * FROM virtual_models ORDER BY id");
      return rows.map((r) => ({
        id: r.id,
        targets: JSON.parse(r.targets) as Target[],
        strategy: r.strategy as Strategy,
        isAlias: r.is_alias,
      }));
    },

    async putModel(model: VirtualModel) {
      await sql.unsafe(
        `INSERT INTO virtual_models (id, targets, strategy, is_alias) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET
           targets = EXCLUDED.targets,
           strategy = EXCLUDED.strategy,
           is_alias = EXCLUDED.is_alias`,
        [model.id, JSON.stringify(model.targets), model.strategy, model.isAlias],
      );
      emit({ type: "modelsChanged" });
    },

    async removeModel(id: string) {
      await sql.unsafe("DELETE FROM virtual_models WHERE id = $1", [id]);
      emit({ type: "modelsChanged" });
    },

    async getSettings() {
      return parseSettings(await readRaw(SETTINGS_KEY));
    },

    /**
     * Read, merge and write in one transaction holding the settings row
     * `FOR UPDATE`, so two replicas' writes serialise rather than each merging
     * over the same read and the later erasing the earlier — which would lose
     * `logRetentionLoweredAt` along with any other field. A fresh install has
     * no row to lock, so one is inserted first (doing nothing if it exists);
     * the insert itself waits on a concurrent first write's key.
     */
    async putSettings(patch: Partial<Settings>) {
      const next = await sql.begin(async (tx): Promise<Settings> => {
        await lockPromptManagement(tx);
        await tx.unsafe(
          "INSERT INTO settings (key, value) VALUES ($1, '{}') ON CONFLICT (key) DO NOTHING",
          [SETTINGS_KEY],
        );
        const raw = (
          await tx.unsafe<Rows<{ value: string }>>(
            "SELECT value FROM settings WHERE key = $1 FOR UPDATE",
            [SETTINGS_KEY],
          )
        )[0]?.value;
        const current = parseSettings(raw ?? null);
        const merged = mergeSettings(current, patch, Date.now());
        checkPromptReferences(
          merged.prompts,
          current.prompts,
          new Set(
            (await tx.unsafe<Rows<{ id: string }>>("SELECT id FROM prompts")).map((r) => r.id),
          ),
        );
        await writeRaw(SETTINGS_KEY, JSON.stringify(merged), tx);
        return merged;
      });
      emit({ type: "settingsChanged" });
      return next;
    },

    async getAdminPasswordHash() {
      return readRaw(ADMIN_HASH_KEY);
    },

    async setAdminPasswordHashIfAbsent(hash: string) {
      const result = await sql.unsafe(
        "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING",
        [ADMIN_HASH_KEY, hash],
      );
      return result.count === 1;
    },

    async setAdminPasswordHash(hash: string) {
      await writeRaw(ADMIN_HASH_KEY, hash);
    },

    async getViewerPasswordHash() {
      return readRaw(VIEWER_HASH_KEY);
    },

    async setViewerPasswordHash(hash: string | null) {
      // Nullable where the admin hash is not: the read-only password is an
      // optional feature an operator turns off again, and deleting the row is
      // what "off" is. An empty string would be a hash that verifies against
      // nothing while `isConfigured` still reported it as set.
      if (hash === null) {
        await sql.unsafe("DELETE FROM settings WHERE key = $1", [VIEWER_HASH_KEY]);
        return;
      }
      await writeRaw(VIEWER_HASH_KEY, hash);
    },
  };
}
