import type { Database } from "bun:sqlite";
import { checkPromptReferences } from "../promptAssignments.ts";
import type {
  ConfigRepo,
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

export function createConfigRepo(
  db: Database,
  emit: (change: import("../types.ts").RoutingChange) => void = () => {},
): ConfigRepo {
  const readRaw = (key: string): string | null =>
    db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key)
      ?.value ?? null;

  const writeRaw = (key: string, value: string): void => {
    db.run(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [key, value],
    );
  };

  const readSettings = (): Settings => {
    const raw = readRaw(SETTINGS_KEY);
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
        // Two different questions, kept apart. *Absence* means on, and that
        // is decided by `DEFAULT_SETTINGS` above, not here. What this line
        // decides is what a *malformed* value means, and it answers the same
        // way as its neighbours: off. This feature rewrites outbound
        // requests, so a value nobody typed with that meaning must not switch
        // it on — while a garbled row merely returning the installation to
        // its pre-feature behaviour costs an operator nothing they did not
        // already have.
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
  };

  /**
   * Read, merge and write as one synchronous `IMMEDIATE` transaction: the write
   * lock is taken before the read, so neither another connection (the CLI, a
   * sibling store) nor an interleaved call on this one can land a write between
   * them and have it overwritten — which would lose `logRetentionLoweredAt`.
   */
  const putSettings = db.transaction((patch: Partial<Settings>): Settings => {
    const current = readSettings();
    const next = mergeSettings(current, patch, Date.now());
    checkPromptReferences(
      next.prompts,
      current.prompts,
      new Set(
        db
          .query<{ id: string }, []>("SELECT id FROM prompts")
          .all()
          .map((r) => r.id),
      ),
    );
    writeRaw(SETTINGS_KEY, JSON.stringify(next));
    return next;
  }).immediate;

  return {
    async listModels() {
      type R = { id: string; targets: string; strategy: string; is_alias: number };
      return db
        .query<R, []>("SELECT * FROM virtual_models ORDER BY id")
        .all()
        .map((r) => ({
          id: r.id,
          targets: JSON.parse(r.targets) as Target[],
          strategy: r.strategy as Strategy,
          isAlias: r.is_alias === 1,
        }));
    },

    async putModel(model: VirtualModel) {
      db.run(
        `INSERT INTO virtual_models (id, targets, strategy, is_alias) VALUES (?,?,?,?)
         ON CONFLICT (id) DO UPDATE SET
           targets = excluded.targets,
           strategy = excluded.strategy,
           is_alias = excluded.is_alias`,
        [model.id, JSON.stringify(model.targets), model.strategy, model.isAlias ? 1 : 0],
      );
      emit({ type: "modelsChanged" });
    },

    async removeModel(id: string) {
      db.run("DELETE FROM virtual_models WHERE id = ?", [id]);
      emit({ type: "modelsChanged" });
    },

    async getSettings() {
      return readSettings();
    },

    async putSettings(patch: Partial<Settings>) {
      const next = putSettings(patch);
      emit({ type: "settingsChanged" });
      return next;
    },

    async getAdminPasswordHash() {
      return readRaw(ADMIN_HASH_KEY);
    },

    async setAdminPasswordHashIfAbsent(hash: string) {
      const result = db.run(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING",
        [ADMIN_HASH_KEY, hash],
      );
      return result.changes === 1;
    },

    async setAdminPasswordHash(hash: string) {
      writeRaw(ADMIN_HASH_KEY, hash);
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
        db.run("DELETE FROM settings WHERE key = ?", [VIEWER_HASH_KEY]);
        return;
      }
      writeRaw(VIEWER_HASH_KEY, hash);
    },
  };
}
