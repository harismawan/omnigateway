import type { Database } from "bun:sqlite";
import { MAX_PROMPT_VERSIONS, MAX_USER_PROMPTS } from "@omni/prompts/catalog";
import { promptAssignments } from "../promptAssignments.ts";
import { type PromptRow, type PromptVersionRow, toPrompt, toPromptVersion } from "../promptRow.ts";
import {
  type PromptDetail,
  type PromptRepo,
  PromptStoreError,
  type RoutingChange,
} from "../types.ts";

export function createPromptRepo(db: Database, emit: (change: RoutingChange) => void): PromptRepo {
  const parent = (id: string) =>
    db.query<PromptRow, [string]>("SELECT * FROM prompts WHERE id = ?").get(id);
  const requireParent = (id: string) => {
    const row = parent(id);
    if (!row) throw new PromptStoreError("missing");
    return row;
  };
  const versions = (id: string) =>
    db
      .query<PromptVersionRow, [string]>(
        "SELECT * FROM prompt_versions WHERE prompt_id = ? ORDER BY version DESC",
      )
      .all(id)
      .map(toPromptVersion);
  const assignments = (id: string) =>
    promptAssignments(
      id,
      db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'settings'").get()
        ?.value ?? null,
      db
        .query<{ id: string; prompts: string | null }, []>("SELECT id, prompts FROM api_keys")
        .all(),
    );
  const room = (id: string) => {
    if (parent(id)) throw new PromptStoreError("exists");
    if (
      (db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM prompts").get()?.n ?? 0) >=
      MAX_USER_PROMPTS
    )
      throw new PromptStoreError("limit");
  };
  const insert = (row: PromptDetail) => {
    room(row.id);
    if (row.versions.length === 0 || row.versions.length > MAX_PROMPT_VERSIONS)
      throw new PromptStoreError("limit");
    if (row.activeVersion !== null && !row.versions.some((v) => v.version === row.activeVersion))
      throw new PromptStoreError("version-missing");
    db.run(
      "INSERT INTO prompts (id,name,description,active_version,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      [row.id, row.name, row.description, row.activeVersion, row.createdAt, row.updatedAt],
    );
    for (const v of row.versions) {
      if (v.promptId !== row.id) throw new PromptStoreError("missing");
      db.run(
        "INSERT INTO prompt_versions (prompt_id,version,text,note,created_at) VALUES (?,?,?,?,?)",
        [row.id, v.version, v.text, v.note, v.createdAt],
      );
    }
  };
  const mutate = <T>(fn: () => T): T => {
    const result = db.transaction(fn).immediate();
    emit({ type: "promptsChanged" });
    return result;
  };
  return {
    async list() {
      return db.query<PromptRow, []>("SELECT * FROM prompts ORDER BY id").all().map(toPrompt);
    },
    async get(id) {
      const row = parent(id);
      return row ? { ...toPrompt(row), versions: versions(id) } : null;
    },
    async listActive() {
      return db
        .query<PromptRow & { version: number; text: string }, []>(
          `SELECT p.*, v.version, v.text FROM prompts p JOIN prompt_versions v ON v.prompt_id = p.id AND v.version = p.active_version ORDER BY p.id`,
        )
        .all()
        .map((row) => ({ ...toPrompt(row), version: row.version, text: row.text }));
    },
    async assignments(id) {
      return assignments(id);
    },
    async create(input) {
      return mutate(() => {
        const now = Date.now();
        const row: PromptDetail = {
          id: input.id,
          name: input.name,
          description: input.description,
          activeVersion: input.activate ? 1 : null,
          createdAt: now,
          updatedAt: now,
          versions: [
            { promptId: input.id, version: 1, text: input.text, note: input.note, createdAt: now },
          ],
        };
        insert(row);
        return row;
      });
    },
    async update(id, input) {
      return mutate(() => {
        requireParent(id);
        db.run("UPDATE prompts SET name = ?, description = ?, updated_at = ? WHERE id = ?", [
          input.name,
          input.description,
          Date.now(),
          id,
        ]);
        return toPrompt(requireParent(id));
      });
    },
    async saveVersion(id, input) {
      return mutate(() => {
        requireParent(id);
        const version =
          (db
            .query<{ n: number }, [string]>(
              "SELECT MAX(version) AS n FROM prompt_versions WHERE prompt_id = ?",
            )
            .get(id)?.n ?? 0) + 1;
        const now = Date.now();
        db.run(
          "INSERT INTO prompt_versions (prompt_id,version,text,note,created_at) VALUES (?,?,?,?,?)",
          [id, version, input.text, input.note, now],
        );
        db.run(
          "UPDATE prompts SET active_version = CASE WHEN ? THEN ? ELSE active_version END, updated_at = ? WHERE id = ?",
          [input.activate ? 1 : 0, version, now, id],
        );
        const retained = versions(id);
        const active = requireParent(id).active_version;
        const remove = retained
          .filter((v) => v.version !== active)
          .reverse()
          .slice(0, Math.max(0, retained.length - MAX_PROMPT_VERSIONS));
        for (const v of remove)
          db.run("DELETE FROM prompt_versions WHERE prompt_id = ? AND version = ?", [
            id,
            v.version,
          ]);
        return { promptId: id, version, text: input.text, note: input.note, createdAt: now };
      });
    },
    async activate(id, version) {
      return mutate(() => {
        requireParent(id);
        if (!versions(id).some((v) => v.version === version))
          throw new PromptStoreError("version-missing");
        db.run("UPDATE prompts SET active_version = ?, updated_at = ? WHERE id = ?", [
          version,
          Date.now(),
          id,
        ]);
        return toPrompt(requireParent(id));
      });
    },
    async remove(id) {
      mutate(() => {
        requireParent(id);
        const refs = assignments(id);
        if (refs.global || refs.keyIds.length > 0) throw new PromptStoreError("assigned", refs);
        db.run("DELETE FROM prompts WHERE id = ?", [id]);
      });
    },
    async importRow(row) {
      mutate(() => insert(row));
    },
  };
}
