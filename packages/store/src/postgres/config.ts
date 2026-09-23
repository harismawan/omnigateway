import { isPonytailMode } from "@omni/ponytail/catalog";
import type { SQL } from "bun";
import type {
  ConfigRepo,
  RoutingChange,
  ScoringWeights,
  Settings,
  Strategy,
  Target,
  VirtualModel,
} from "../types.ts";
import { DEFAULT_SETTINGS } from "../types.ts";
import type { Rows } from "./db.ts";

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

export function createConfigRepo(sql: SQL, emit: (change: RoutingChange) => void): ConfigRepo {
  const readRaw = async (key: string): Promise<string | null> =>
    (
      await sql.unsafe<Rows<{ value: string }>>("SELECT value FROM settings WHERE key = $1", [key])
    )[0]?.value ?? null;

  const writeRaw = async (key: string, value: string): Promise<void> => {
    await sql.unsafe(
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
      const raw = await readRaw(SETTINGS_KEY);
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
          rtkEnabled: stored.rtkEnabled === true,
          // Absence means on, decided by `DEFAULT_SETTINGS`; a malformed value
          // means off, the same answer as its neighbours.
          autoCacheEnabled:
            stored.autoCacheEnabled === undefined ? true : stored.autoCacheEnabled === true,
          // The same question its neighbours ask, put to a union instead of a
          // boolean: anything that is not one of the four names means off.
          ponytailMode: isPonytailMode(stored.ponytailMode) ? stored.ponytailMode : "off",
          bodyLoggingEnabled: stored.bodyLoggingEnabled === true,
          bodyLoggingCaptureStreamChunks: stored.bodyLoggingCaptureStreamChunks === true,
          weights: knownWeights(stored.weights),
        };
      } catch {
        return DEFAULT_SETTINGS;
      }
    },

    async putSettings(patch: Partial<Settings>) {
      const current = await this.getSettings();
      const next: Settings = {
        ...current,
        ...patch,
        weights: { ...current.weights, ...patch.weights },
      };
      await writeRaw(SETTINGS_KEY, JSON.stringify(next));
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
