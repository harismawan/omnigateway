import {
  type AdminAuth,
  activatePromptVersion,
  createPrompt,
  duplicatePrompt,
  listPrompts,
  readPrompt,
  removePrompt,
  savePromptVersion,
  updatePrompt,
} from "@omni/control";
import type { Logger } from "@omni/ir";
import type { Store } from "@omni/store";
import { Elysia } from "elysia";
import type { Invalidator } from "../stream/broadcaster.ts";
import { apiErrorHandler, readJson, requireAdmin, requireReader } from "./http.ts";

export type PromptRouteDeps = {
  store: Store;
  admin: AdminAuth;
  broadcaster?: Invalidator;
  logger?: Logger;
};

/** Console library only. Holders poll their own summary, never this resource. */
export function promptsRoutes(deps: PromptRouteDeps) {
  const changed = (): void => deps.broadcaster?.invalidate("res:prompts");
  return new Elysia()
    .onError(apiErrorHandler)
    .get("/api/prompts", async ({ request }) => {
      await requireReader(request, deps.admin);
      return listPrompts(deps.store);
    })
    .get("/api/prompts/:id", async ({ request, params }) => {
      await requireReader(request, deps.admin);
      return readPrompt(deps.store, params.id);
    })
    .post("/api/prompts", async ({ request }) => {
      await requireAdmin(request, deps.admin);
      const result = await createPrompt(deps.store, await readJson(request));
      changed();
      return result;
    })
    .put("/api/prompts/:id", async ({ request, params }) => {
      await requireAdmin(request, deps.admin);
      const result = await updatePrompt(deps.store, params.id, await readJson(request));
      changed();
      return result;
    })
    .post("/api/prompts/:id/versions", async ({ request, params }) => {
      await requireAdmin(request, deps.admin);
      const result = await savePromptVersion(deps.store, params.id, await readJson(request));
      changed();
      return result;
    })
    .put("/api/prompts/:id/active", async ({ request, params }) => {
      await requireAdmin(request, deps.admin);
      const result = await activatePromptVersion(deps.store, params.id, await readJson(request));
      changed();
      return result;
    })
    .post("/api/prompts/:id/duplicate", async ({ request, params }) => {
      await requireAdmin(request, deps.admin);
      const result = await duplicatePrompt(deps.store, params.id, await readJson(request));
      changed();
      return result;
    })
    .delete("/api/prompts/:id", async ({ request, params }) => {
      await requireAdmin(request, deps.admin);
      await removePrompt(deps.store, params.id);
      changed();
      return { ok: true };
    });
}
