import { type AdminAuth, type ConnectDeps, createConnectFlows } from "@omni/control";
import { Elysia } from "elysia";
import { apiErrorHandler, readJsonRecord, requireAdmin } from "./http.ts";

export type ConnectRouteDeps = ConnectDeps & { admin: AdminAuth };

/**
 * The HTTP half of provider authorization.
 *
 * The flow itself lives in `@omni/control`; what is here is the session check,
 * the JSON shapes the console expects, and the 202 that tells it to keep
 * polling.
 */
export function connectRoutes(deps: ConnectRouteDeps) {
  const flows = createConnectFlows(deps);

  return new Elysia()
    .onError(apiErrorHandler)
    .post("/api/connect/start", async ({ request }) => {
      await requireAdmin(request, deps.admin);
      const body = await readJsonRecord(request);
      return flows.start(body?.provider, body?.label);
    })

    .post("/api/connect/finish", async ({ request }) => {
      await requireAdmin(request, deps.admin);
      const body = await readJsonRecord(request);
      return flows.finish(body?.flowId, body?.code);
    })

    .post("/api/connect/poll", async ({ request, set }) => {
      await requireAdmin(request, deps.admin);
      const body = await readJsonRecord(request);
      const outcome = await flows.poll(body?.flowId);
      if (outcome.status === "pending") set.status = 202;
      return outcome;
    });
}
