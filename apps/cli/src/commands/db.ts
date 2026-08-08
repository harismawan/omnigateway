import { existsSync } from "node:fs";
import type { Command } from "../command.ts";
import { emit, fields } from "../output.ts";

export const dbMigrate: Command = {
  usage: "db migrate",
  summary: "Create or upgrade the database schema",
  async run(_args, { ctx, writer }) {
    const existed = existsSync(ctx.databasePath);
    // Opening the store runs every pending migration; there is no second code
    // path for it, which is what keeps the CLI and the gateway in step.
    const store = await ctx.store();
    await store.config.getSettings();

    emit(ctx, writer, { path: ctx.databasePath, created: !existed }, () =>
      fields([
        ["database", ctx.databasePath],
        ["schema", existed ? "up to date" : "created"],
      ]),
    );
  },
};
