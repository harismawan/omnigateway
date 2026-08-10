import type { Database } from "bun:sqlite";
import type { ConfigRepo, Settings, Strategy, Target, VirtualModel } from "../types.ts";
import { DEFAULT_SETTINGS } from "../types.ts";

const SETTINGS_KEY = "settings";
const ADMIN_HASH_KEY = "adminPasswordHash";

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
      const raw = readRaw(SETTINGS_KEY);
      if (raw === null) return DEFAULT_SETTINGS;
      try {
        const parsed: unknown = JSON.parse(raw);
        const stored =
          parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Partial<Settings>)
            : {};
        // Only literal true enables this lossy transform. This runtime boundary
        // must remain safe even if an old or manually-edited row is malformed.
        return {
          ...DEFAULT_SETTINGS,
          ...stored,
          rtkEnabled: stored.rtkEnabled === true,
          weights: { ...DEFAULT_SETTINGS.weights, ...stored.weights },
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
      writeRaw(SETTINGS_KEY, JSON.stringify(next));
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
  };
}
