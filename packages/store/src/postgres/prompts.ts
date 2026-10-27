import { MAX_PROMPT_VERSIONS, MAX_USER_PROMPTS } from "@omni/prompts/catalog";
import type { SQL } from "bun";
import { promptAssignments } from "../promptAssignments.ts";
import { type PromptRow, type PromptVersionRow, toPrompt, toPromptVersion } from "../promptRow.ts";
import {
  type PromptDetail,
  type PromptRepo,
  PromptStoreError,
  type RoutingChange,
} from "../types.ts";
import type { Conn, Rows } from "./db.ts";
import { lockPromptManagement } from "./promptLock.ts";

export function createPromptRepo(sql: SQL, emit: (change: RoutingChange) => void): PromptRepo {
  const parent = async (conn: Conn, id: string) =>
    (await conn.unsafe<Rows<PromptRow>>("SELECT * FROM prompts WHERE id = $1", [id]))[0];
  const requireParent = async (conn: Conn, id: string) => {
    const row = (
      await conn.unsafe<Rows<PromptRow>>("SELECT * FROM prompts WHERE id = $1 FOR UPDATE", [id])
    )[0];
    if (!row) throw new PromptStoreError("missing");
    return row;
  };
  const versions = async (conn: Conn, id: string) =>
    (
      await conn.unsafe<Rows<PromptVersionRow>>(
        "SELECT * FROM prompt_versions WHERE prompt_id = $1 ORDER BY version DESC",
        [id],
      )
    ).map(toPromptVersion);
  const assignments = async (conn: Conn, id: string) =>
    promptAssignments(
      id,
      (
        await conn.unsafe<Rows<{ value: string }>>(
          "SELECT value FROM settings WHERE key = 'settings'",
        )
      )[0]?.value ?? null,
      await conn.unsafe<Rows<{ id: string; prompts: string | null }>>(
        "SELECT id, prompts FROM api_keys",
      ),
    );
  const insert = async (conn: Conn, row: PromptDetail) => {
    if (await parent(conn, row.id)) throw new PromptStoreError("exists");
    const count = (await conn.unsafe<Rows<{ n: string }>>("SELECT COUNT(*) AS n FROM prompts"))[0];
    if (
      Number(count?.n ?? 0) >= MAX_USER_PROMPTS ||
      row.versions.length === 0 ||
      row.versions.length > MAX_PROMPT_VERSIONS
    )
      throw new PromptStoreError("limit");
    if (row.activeVersion !== null && !row.versions.some((v) => v.version === row.activeVersion))
      throw new PromptStoreError("version-missing");
    await conn.unsafe(
      "INSERT INTO prompts (id,name,description,active_version,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [row.id, row.name, row.description, row.activeVersion, row.createdAt, row.updatedAt],
    );
    for (const v of row.versions) {
      if (v.promptId !== row.id) throw new PromptStoreError("missing");
      await conn.unsafe(
        "INSERT INTO prompt_versions (prompt_id,version,text,note,created_at) VALUES ($1,$2,$3,$4,$5)",
        [row.id, v.version, v.text, v.note, v.createdAt],
      );
    }
  };
  const mutate = async <T>(fn: (conn: Conn) => Promise<T>): Promise<T> => {
    const result = await sql.begin(async (tx) => {
      await lockPromptManagement(tx);
      return fn(tx);
    });
    emit({ type: "promptsChanged" });
    return result;
  };
  return {
    async list() {
      return (await sql.unsafe<Rows<PromptRow>>("SELECT * FROM prompts ORDER BY id")).map(toPrompt);
    },
    async get(id) {
      // One read transaction prevents a mixed metadata/history view during pruning.
      return sql.begin("isolation level repeatable read read only", async (tx) => {
        const row = await parent(tx, id);
        return row ? { ...toPrompt(row), versions: await versions(tx, id) } : null;
      });
    },
    async listActive() {
      return (
        await sql.unsafe<Rows<PromptRow & { version: number; text: string }>>(
          `SELECT p.*, v.version, v.text FROM prompts p JOIN prompt_versions v ON v.prompt_id = p.id AND v.version = p.active_version ORDER BY p.id`,
        )
      ).map((row) => ({ ...toPrompt(row), version: row.version, text: row.text }));
    },
    assignments: (id) => assignments(sql, id),
    create: (input) =>
      mutate(async (conn) => {
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
        await insert(conn, row);
        return row;
      }),
    update: (id, input) =>
      mutate(async (conn) => {
        await requireParent(conn, id);
        await conn.unsafe(
          "UPDATE prompts SET name = $1, description = $2, updated_at = $3 WHERE id = $4",
          [input.name, input.description, Date.now(), id],
        );
        return toPrompt(await requireParent(conn, id));
      }),
    saveVersion: (id, input) =>
      mutate(async (conn) => {
        await requireParent(conn, id);
        const version =
          Number(
            (
              await conn.unsafe<Rows<{ n: number }>>(
                "SELECT MAX(version) AS n FROM prompt_versions WHERE prompt_id = $1",
                [id],
              )
            )[0]?.n ?? 0,
          ) + 1;
        const now = Date.now();
        await conn.unsafe(
          "INSERT INTO prompt_versions (prompt_id,version,text,note,created_at) VALUES ($1,$2,$3,$4,$5)",
          [id, version, input.text, input.note, now],
        );
        await conn.unsafe(
          "UPDATE prompts SET active_version = CASE WHEN $1 THEN $2 ELSE active_version END, updated_at = $3 WHERE id = $4",
          [input.activate, version, now, id],
        );
        const retained = await versions(conn, id);
        const active = (await requireParent(conn, id)).active_version;
        const remove = retained
          .filter((v) => v.version !== active)
          .reverse()
          .slice(0, Math.max(0, retained.length - MAX_PROMPT_VERSIONS));
        for (const v of remove)
          await conn.unsafe("DELETE FROM prompt_versions WHERE prompt_id = $1 AND version = $2", [
            id,
            v.version,
          ]);
        return { promptId: id, version, text: input.text, note: input.note, createdAt: now };
      }),
    activate: (id, version) =>
      mutate(async (conn) => {
        await requireParent(conn, id);
        if (!(await versions(conn, id)).some((v) => v.version === version))
          throw new PromptStoreError("version-missing");
        await conn.unsafe("UPDATE prompts SET active_version = $1, updated_at = $2 WHERE id = $3", [
          version,
          Date.now(),
          id,
        ]);
        return toPrompt(await requireParent(conn, id));
      }),
    remove: (id) =>
      mutate(async (conn) => {
        await requireParent(conn, id);
        const refs = await assignments(conn, id);
        if (refs.global || refs.keyIds.length > 0) throw new PromptStoreError("assigned", refs);
        await conn.unsafe("DELETE FROM prompts WHERE id = $1", [id]);
      }),
    importRow: (row) => mutate((conn) => insert(conn, row)),
  };
}
